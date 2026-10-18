// App state (one store, read with useSyncExternalStore), actions, and one live connection per community.
import { create, fromJson } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Client, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { useSyncExternalStore } from "react";
import type { SettingsTab } from "./Admin";
import { AUTH_URL, fetchAppearance, fetchCommunities, fetchProfile, finishLogin, saveAppearance, saveCommunities, getToken, hasSession, SignedOutError, signOut as authSignOut, startLogin, type Profile } from "./auth";
import { loadEmoji } from "./CustomEmoji";
import { fakeTransport, fakeUpload, FAKE_URLS, startSimulation } from "./fake";
import {
  AttachmentSchema,
  BotService,
  ChannelKind,
  ChannelMode,
  ChatService,
  ReadStateSchema,
  MessageSchema,
  ServerService,
  type Attachment,
  type Channel,
  type Event,
  type GetServerInfoResponse,
  type MemberRole,
  type Message,
} from "./gen/sblurp/v1/sblurp_pb";
import {
  applyEvent,
  applySnapshot,
  backoffMs,
  STABLE_MS,
  channelLabel,
  emptyCommunity,
  formatHash,
  HEARTBEAT_TIMEOUT_MS,
  hostOf,
  isDM,
  landingChannel,
  listKey,
  mentionsMe,
  parseHash,
  parsePane,
  paneQuery,
  type Pane,
  plainText,
  upsertMessage,
  type Community,
  type Info,
  trimList,
  type MsgList,
  APPEARANCE,
  fitContrast,
  customTheme,
  themeString,
  toHex,
  parseAppearance,
  appearanceSync,
  communitiesSync,
  type Appearance,
  sentence,
  joinHashInput,
  readDelay,
  isExpired,
  type Permalink,
} from "./logic";

const params = new URLSearchParams(location.search);
export const FAKE = params.has("fake") || import.meta.env.VITE_FAKE === "1";
const DEFAULT_COMMUNITIES: string[] = (import.meta.env.VITE_COMMUNITIES ?? "http://localhost:8082,http://localhost:8083").split(",");
export const ACCOUNT_URL = `${AUTH_URL}/account`;
export const SELF_HOST_DOCS_URL = `${AUTH_URL}/docs/self-host`;

// ---------------------------------------------------------------------------
// Persistence (per-viewer conveniences only; every access may throw in private modes)
// ---------------------------------------------------------------------------

const ns = FAKE ? "sblurp.fake." : "sblurp.";
function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(ns + key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function save(key: string, v: unknown) {
  try {
    localStorage.setItem(ns + key, JSON.stringify(v));
  } catch {
    // storage full or blocked: the setting lasts for this session only
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type Modal =
  | null
  | { t: "settings" }
  | { t: "add"; input?: string }
  | { t: "switcher" }
  | { t: "info" }
  | { t: "invite" }
  | { t: "leave" }
  | { t: "delete"; id: string }
  | { t: "channel"; id?: string; category?: string; name?: string; focusTopic?: boolean }
  | { t: "community"; tab?: SettingsTab; focusDesc?: boolean }
  | { t: "newdm" }
  | { t: "browse" }
  | { t: "keys" }
  | { t: "profile"; focusPic?: boolean }
  | { t: "remove"; url: string; memberId: string; ban: boolean }
  | { t: "block"; url: string; memberId: string }
  | { t: "report"; url: string; message: Message }
  | { t: "reports" }
  | { t: "lightbox"; src: string; name: string; video?: boolean };

export interface State {
  auth: "loading" | "out" | "in";
  authError?: string;
  profile?: Profile;
  order: string[];
  cs: Record<string, Community>;
  url: string;
  channelId: string;
  pane: Pane;
  modal: Modal;
  popover: { url: string; memberId: string; rect: DOMRect } | null;
  look: Appearance;
  /** The page background as rgb(), for fitting role colors to it. */
  surfaces: string[]; // paper, msg-hover, mention-bg: what message text sits on
  notify: boolean;
  drawer: boolean;
  collapsed: Record<string, boolean>;
  drafts: Record<string, string>;
  /** Channel the person is looking at with the list at the bottom. */
  viewing: string | null;
  /** Read position captured when a channel was opened, for the "New" divider. */
  newMarker: Record<string, bigint | null>;
  editing: string | null;
}

let state: State = {
  auth: "loading",
  order: [],
  cs: {},
  url: "",
  channelId: "",
  pane: null,
  modal: null,
  popover: null,
  look: parseAppearance(load("appearance", APPEARANCE)),
  surfaces: [],
  notify: load("notify", false),
  drawer: false,
  collapsed: load("collapsed", {}),
  drafts: load("drafts", {}),
  viewing: null,
  newMarker: {},
  editing: null,
};
const subs = new Set<() => void>();
let queued = false;

export const get = () => state;
export function set(patch: Partial<State> | ((s: State) => Partial<State>)) {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  if (!queued) {
    queued = true;
    queueMicrotask(() => {
      queued = false;
      syncPaneHash();
      subs.forEach((f) => f());
    });
  }
}
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};
export const useApp = <T,>(sel: (s: State) => T): T => useSyncExternalStore(subscribe, () => sel(state));

function patchC(url: string, fn: (c: Community) => Community) {
  set((s) => (s.cs[url] ? { cs: { ...s.cs, [url]: fn(s.cs[url]) } } : {}));
}
function patchList(url: string, key: string, fn: (l: MsgList) => MsgList) {
  patchC(url, (c) => ({ ...c, lists: { ...c.lists, [key]: fn(c.lists[key] ?? { items: [], hasMore: true }) } }));
}

export function leaveList(url: string, key: string) {
  const l = state.cs[url]?.lists[key];
  const t = l && trimList(l);
  if (!l || t === l) return;
  patchC(url, (c) => {
    const lists = { ...c.lists };
    if (t) lists[key] = t;
    else delete lists[key];
    return { ...c, lists };
  });
}

// ---------------------------------------------------------------------------
// RPC clients
// ---------------------------------------------------------------------------

const authInterceptor =
  (aud: string): Interceptor =>
  (next) =>
  async (req) => {
    if (req.method.name !== "GetServerInfo") req.header.set("Authorization", `Bearer ${await getToken(aud)}`);
    return next(req);
  };

const clients = new Map<string, { server: Client<typeof ServerService>; chat: Client<typeof ChatService>; bot: Client<typeof BotService> }>();
export function api(url: string) {
  let c = clients.get(url);
  if (!c) {
    const transport =
      (FAKE && fakeTransport(url)) || createConnectTransport({ baseUrl: url, interceptors: FAKE ? [] : [authInterceptor(url)] });
    c = { server: createClient(ServerService, transport), chat: createClient(ChatService, transport), bot: createClient(BotService, transport) };
    clients.set(url, c);
  }
  return c;
}

export function errorText(e: unknown, name = "this community"): string {
  if (e instanceof SignedOutError) return "Your sign-in expired. Sign in again.";
  const ce = ConnectError.from(e);
  switch (ce.code) {
    case Code.Unavailable:
    case Code.Unknown:
      return `Can't reach ${name}. Check the address and your connection.`;
    case Code.Unauthenticated:
      return `${name} didn't accept your sign-in. It may not trust sblurp.chat.`;
    case Code.PermissionDenied:
      return `You don't have permission to do that in ${name}.`;
    case Code.NotFound:
      return "That no longer exists.";
    case Code.DeadlineExceeded:
      return `${name} took too long to answer. Try again.`;
    default:
      return ce.rawMessage ? sentence(ce.rawMessage) : "Something went wrong. Try again.";
  }
}

const toInfo = (i: GetServerInfoResponse): Info => ({
  name: i.name,
  description: i.description,
  iconUrl: i.iconUrl,
  accentColor: i.accentColor,
  memberCount: i.memberCount,
  inviteOnly: i.inviteOnly,
  bannerUrl: i.banner?.url,
  retentionDays: i.retentionDays,
});

/** Resolve an attachment or icon URL relative to its server. */
// Fake communities have made-up hosts; their files are served by this dev server.
export const absUrl = (base: string, u: string) => (u ? new URL(u, FAKE ? location.href : `${base}/`).href : "");

// ---------------------------------------------------------------------------
// Live connection
// ---------------------------------------------------------------------------

const conns = new Map<string, { ctl: AbortController; wake: () => void }>();

export function retryNow(url: string) {
  conns.get(url)?.wake();
}

function refreshInfo(url: string, signal?: AbortSignal) {
  api(url)
    .server.getServerInfo({}, { signal })
    .then((i) => {
      patchC(url, (c) => ({ ...c, info: toInfo(i) }));
      save("info", { ...load<Record<string, Info>>("info", {}), [url]: toInfo(i) });
    })
    .catch(() => {});
}

async function connect(url: string) {
  conns.get(url)?.ctl.abort();
  const ctl = new AbortController();
  const conn = { ctl, wake: () => {} };
  conns.set(url, conn);
  const { server } = api(url);
  refreshInfo(url, ctl.signal);
  let attempt = 0;
  let liveAt = 0;
  let snapshot = true;
  while (!ctl.signal.aborted) {
    try {
      if (snapshot) {
        const st = await server.getState({}, { signal: ctl.signal });
        patchC(url, (c) => applySnapshot(c, st));
        void loadEmoji(url);
        snapshot = false;
        ensureChannel(url);
      }
      const beat = new AbortController();
      const stop = () => beat.abort();
      ctl.signal.addEventListener("abort", stop);
      let timer = setTimeout(stop, HEARTBEAT_TIMEOUT_MS);
      try {
        for await (const ev of server.subscribe({ afterSeq: state.cs[url]?.seq ?? 0n }, { signal: beat.signal })) {
          clearTimeout(timer);
          timer = setTimeout(stop, HEARTBEAT_TIMEOUT_MS);
          liveAt ||= Date.now();
          // Live only once the server answers (it sends a heartbeat at once), so the banner does
          // not flicker off on every retry while the server is still down.
          if (state.cs[url]?.status !== "live") patchC(url, (c) => ({ ...c, status: "live", error: undefined, retryAt: undefined }));
          if (ev.kind.case === "resync") {
            snapshot = true;
            break;
          }
          if (ev.kind.case === "serverUpdated") refreshInfo(url, ctl.signal);
          if (ev.kind.case === "emojiChanged") void loadEmoji(url);
          dispatch(url, ev);
        }
      } finally {
        clearTimeout(timer);
        ctl.signal.removeEventListener("abort", stop);
      }
      if (snapshot) continue;
    } catch (e) {
      if (ctl.signal.aborted) return;
      if (e instanceof SignedOutError) {
        set({ auth: "out" });
        return;
      }
      // permission_denied means not a member: never joined, or kicked or banned (the server ends
      // the stream with resource_exhausted, and the reconnect is then denied). Stop either way.
      if (ConnectError.from(e).code === Code.PermissionDenied && (snapshot || state.cs[url]?.me)) {
        patchC(url, (c) => (c.me ? { ...emptyCommunity(url), info: c.info, status: "removed" } : { ...c, status: "join" }));
        return;
      }
      patchC(url, (c) => ({ ...c, error: errorText(e, c.info?.name) }));
    }
    if (liveAt && Date.now() - liveAt > STABLE_MS) attempt = 0;
    liveAt = 0;
    const delay = backoffMs(attempt++, Math.random());
    patchC(url, (c) => ({ ...c, status: "reconnecting", retryAt: Date.now() + delay }));
    await new Promise<void>((r) => {
      const t = setTimeout(r, delay);
      conn.wake = () => {
        clearTimeout(t);
        r();
      };
      ctl.signal.addEventListener("abort", () => r());
    });
  }
}

function dispatch(url: string, ev: Event) {
  const s = state;
  patchC(url, (c) => applyEvent(c, ev, Date.now(), s.url === url ? s.viewing : null));
  if (ev.kind.case === "messageCreated") maybeNotify(url, ev.kind.value);
  if (ev.kind.case === "channelDeleted" && s.url === url && s.channelId === ev.kind.value) ensureChannel(url, true);
}

function maybeNotify(url: string, m: Message) {
  const c = state.cs[url];
  const ch = c?.channels[m.channelId];
  if (!c || !ch || m.authorId === c.me?.id || !state.notify || !document.hidden) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (!isDM(ch) && !mentionsMe(m.text, c.me?.id)) return;
  const author = c.members[m.authorId]?.displayName ?? "Someone";
  const n = new Notification(isDM(ch) ? author : `${author} in #${ch.name}`, {
    body: plainText(m.text, c.members).slice(0, 180),
    tag: m.id,
  });
  n.onclick = () => {
    window.focus();
    selectChannel(url, ch.id);
  };
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/** Make sure the current community has a selected channel. */
function ensureChannel(url: string, force = false) {
  const s = state;
  if (s.url !== url) return;
  const c = s.cs[url];
  if (!force && s.channelId && c.channels[s.channelId]) return selectChannel(url, s.channelId, false);
  const last = load<Record<string, string>>("lastChannel", {})[url];
  const id = last && c.channels[last] ? last : landingChannel(c);
  if (id) selectChannel(url, id, false);
}

export function selectCommunity(url: string) {
  set({ url, channelId: "", pane: null });
  const c = state.cs[url];
  if (c?.status === "live" || Object.keys(c?.channels ?? {}).length) ensureChannel(url, true);
  else history.pushState(null, "", formatHash(url, ""));
}

export function selectChannel(url: string, channelId: string, push = true) {
  const c = state.cs[url];
  const rs = c?.reads[channelId];
  const keepPane = state.pane?.t === "members" ? state.pane : null;
  set((s) => ({
    url,
    channelId,
    drawer: false,
    pane: s.channelId === channelId && s.url === url ? s.pane : keepPane,
    editing: null,
    viewing: null,
    newMarker: { ...s.newMarker, [channelId]: rs && rs.unreadCount > 0 ? rs.lastReadSeq : null },
  }));
  save("lastChannel", { ...load("lastChannel", {}), [url]: channelId });
  const hash = formatHash(url, channelId);
  if (location.hash.split("?")[0] !== hash) history[push ? "pushState" : "replaceState"](null, "", hash);
}

function applyHash() {
  const r = parseHash(location.hash);
  if (!r) return;
  const url = state.order.find((u) => hostOf(u) === r.host);
  if (!url) return;
  if (r.messageId) jumpTo(url, { id: r.messageId, channelId: r.channelId, threadRootId: r.rootId });
  else if (r.channelId) {
    selectChannel(url, r.channelId, false);
    set({ pane: parsePane(location.hash) });
  } else selectCommunity(url);
}

// The open pane rides on the current route with replaceState, so a reload (or Back) reopens it.
// Only the ?pane part is touched; the route itself is pushed by selectChannel.
function syncPaneHash() {
  if (!state.url || !state.channelId) return;
  const base = formatHash(state.url, state.channelId);
  const hash = base + paneQuery(state.pane);
  if (location.hash !== hash && location.hash.split("?")[0] === base) history.replaceState(null, "", hash);
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

// page: "" loads the newest messages, "older" and "newer" extend the list, and "around" loads
// a window centred on focusId (a search jump).
export async function loadList(url: string, channelId: string, rootId = "", page: "" | "older" | "newer" | "around" = "", focusId = "") {
  const key = listKey(channelId, rootId);
  const l = state.cs[url]?.lists[key];
  if (page !== "around" && (l?.loading || (page === "older" && !l?.hasMore) || (page === "newer" && !l?.hasMoreAfter))) return;
  patchList(url, key, (x) => ({ ...x, loading: true, error: undefined }));
  const confirmed = l?.items.filter((m) => m.seq > 0n) ?? [];
  // The list is contiguous: past an expired message everything is gone too (1072).
  if (page === "older" && confirmed[0] && isExpired(confirmed[0], state.cs[url]?.info?.retentionDays)) {
    patchList(url, key, (x) => ({ ...x, hasMore: false, loading: false }));
    return;
  }
  try {
    const r = await api(url).chat.listMessages({
      channelId,
      threadRootId: rootId,
      beforeId: page === "older" ? confirmed[0]?.id ?? "" : "",
      afterId: page === "newer" ? confirmed.at(-1)?.id ?? "" : "",
      aroundId: page === "around" ? focusId : "",
      limit: 50,
    });
    patchList(url, key, (x) => {
      if (page === "older") return { ...x, items: [...r.messages, ...x.items], hasMore: r.hasMore, loading: false };
      if (page === "newer") return { ...x, items: [...x.items, ...r.messages], hasMoreAfter: r.hasMoreAfter, loading: false };
      if (page === "around") return { items: r.messages, hasMore: r.hasMore, hasMoreAfter: r.hasMoreAfter, focusId, loading: false };
      let items = r.messages;
      // Keep optimistic and live messages that arrived while loading.
      for (const m of x.hasMoreAfter ? [] : x.items) if (m.seq === 0n || !items.some((y) => y.id === m.id)) items = upsertMessage(items, m);
      return { items, hasMore: r.hasMore, loading: false };
    });
  } catch (e) {
    patchList(url, key, (x) => ({ ...x, loading: false, error: errorText(e, state.cs[url]?.info?.name) }));
  }
}

// Opens the channel (and thread) of a search hit and loads the messages around it.
// push: a new history entry even within the same channel, so Back returns to where the jump came from (1080).
export function jumpTo(url: string, m: Pick<Message, "id" | "channelId" | "threadRootId">, push = false) {
  void loadList(url, m.channelId, m.threadRootId, "around", m.id);
  if (push) history.pushState(null, "", location.hash);
  selectChannel(url, m.channelId, !push);
  if (m.threadRootId) set({ pane: { t: "thread", rootId: m.threadRootId } });
}

// Message link previews (1109). One fetch per linked message, shared by every row that links it,
// through the viewer's own connection so the server's access checks decide. Any failure (no
// access, private channel, deleted, expired) is null: the link stays a plain link.
// ponytail: kept for the session; an edit or delete of the linked message shows after a reload.
export const unfurled = new Map<string, Message | null>();
const unfurling = new Map<string, Promise<Message | null>>();
export const unfurlKey = (url: string, l: Permalink) => `${url}\n${l.messageId}`;
export function unfurl(url: string, l: Permalink): Promise<Message | null> {
  const k = unfurlKey(url, l);
  let p = unfurling.get(k);
  if (!p) {
    p = api(url)
      .chat.listMessages({ channelId: l.channelId, threadRootId: l.rootId, aroundId: l.messageId, limit: 1 })
      .then(
        (r) => r.messages.find((m) => m.id === l.messageId && !m.deleted) ?? null,
        () => null,
      )
      .then((m) => (unfurled.set(k, m), m));
    unfurling.set(k, p);
  }
  return p;
}

export async function send(url: string, channelId: string, rootId: string, text: string, attachments: Attachment[] = []) {
  const c = state.cs[url];
  if (!c?.me || (!text.trim() && !attachments.length)) return;
  const clientId = crypto.randomUUID();
  const m = create(MessageSchema, {
    id: `local:${clientId}`,
    clientId,
    channelId,
    threadRootId: rootId,
    authorId: c.me.id,
    text,
    attachments,
    createdAtMs: BigInt(Date.now()),
  });
  const key = listKey(channelId, rootId);
  // Sending from a search-jump window goes back to the newest messages first.
  const jumped = c.lists[key]?.hasMoreAfter;
  patchList(url, key, (l) => (jumped ? { items: [m], hasMore: true } : { ...l, items: upsertMessage(l.items, m) }));
  if (jumped) void loadList(url, channelId, rootId);
  await deliver(url, key, m);
}

async function deliver(url: string, key: string, m: Message) {
  patchC(url, (c) => {
    const { [m.clientId]: _, ...failed } = c.failed;
    return { ...c, failed };
  });
  try {
    const r = await api(url).chat.sendMessage({
      channelId: m.channelId,
      text: m.text,
      threadRootId: m.threadRootId,
      clientId: m.clientId,
      attachmentIds: m.attachments.map((a) => a.id),
    });
    if (r.message) {
      const sent = r.message;
      patchList(url, key, (l) => ({ ...l, items: upsertMessage(l.items, sent) }));
    }
  } catch {
    patchC(url, (c) => ({ ...c, failed: { ...c.failed, [m.clientId]: true } }));
  }
}

export function retrySend(url: string, m: Message) {
  void deliver(url, listKey(m.channelId, m.threadRootId), m);
}
export function discardSend(url: string, m: Message) {
  patchList(url, listKey(m.channelId, m.threadRootId), (l) => ({ ...l, items: l.items.filter((x) => x.id !== m.id) }));
}

const updateLocal = (url: string, m: Message | undefined) =>
  m && patchC(url, (c) => applyEvent(c, { seq: 0n, atMs: 0n, kind: { case: "messageUpdated", value: m } } as Event, Date.now(), null));

// Attachment URLs are signed and expire after one to two hours. A broken image asks the server
// for the message again (once a minute at most) to get fresh URLs.
const refreshedAt = new Map<string, number>();
export async function refreshMessage(url: string, m: Message) {
  const k = `${url} ${m.id}`;
  if (Date.now() - (refreshedAt.get(k) ?? 0) < 60_000) return;
  refreshedAt.set(k, Date.now());
  try {
    const r = await api(url).chat.listMessages({ channelId: m.channelId, threadRootId: m.threadRootId, aroundId: m.id, limit: 1 });
    updateLocal(url, r.messages.find((x) => x.id === m.id));
  } catch {
    // The image stays broken; the next error after a minute tries again.
  }
}

export async function edit(url: string, id: string, text: string) {
  const r = await api(url).chat.editMessage({ messageId: id, text });
  updateLocal(url, r.message);
}

export async function remove(url: string, m: Message) {
  await api(url).chat.deleteMessage({ messageId: m.id });
  patchC(url, (c) => applyEvent(c, { seq: 0n, atMs: 0n, kind: { case: "messageDeleted", value: m } } as Event, Date.now(), null));
  if (state.pane?.t === "thread" && state.pane.rootId === m.id && m.replyCount === 0) set({ pane: null });
}

export async function react(url: string, m: Message, emoji: string) {
  const meId = state.cs[url]?.me?.id ?? "";
  const remove = !!m.reactions.find((r) => r.emoji === emoji)?.memberIds.includes(meId);
  try {
    const r = await api(url).chat.react({ messageId: m.id, emoji, remove });
    updateLocal(url, r.message);
  } catch {
    // The reaction pill simply does not change; the person can try again.
  }
}

// Server-acknowledged read positions. Local state can already be read (a message arrived while
// the channel was in view), so the server still needs telling once.
const sentRead = new Map<string, bigint>();
export function markRead(url: string, channelId: string) {
  const c = state.cs[url];
  const ch = c?.channels[channelId];
  const rs = c?.reads[channelId];
  if (!ch) return;
  const last = rs?.lastReadSeq ?? 0n;
  const seq = ch.lastMessageSeq > last ? ch.lastMessageSeq : last;
  const k = `${url} ${channelId}`;
  if ((sentRead.get(k) ?? -1n) >= seq && !rs?.unreadCount && !rs?.mentionCount) return;
  sentRead.set(k, seq);
  patchC(url, (x) => ({
    ...x,
    reads: { ...x.reads, [channelId]: { ...(rs ?? create(ReadStateSchema, { channelId })), lastReadSeq: seq, unreadCount: 0, mentionCount: 0 } },
  }));
  const p = pendingRead.get(k);
  if (p) return void (p.seq = seq);
  const t = setTimeout(() => sendRead(k), readDelay(readSentAt.get(k), Date.now()));
  pendingRead.set(k, { url, channelId, seq, t });
}

// The local read state above changes at once; the server write waits (see readDelay, 1040).
const readSentAt = new Map<string, number>();
const pendingRead = new Map<string, { url: string; channelId: string; seq: bigint; t: ReturnType<typeof setTimeout> }>();
function sendRead(k: string) {
  const p = pendingRead.get(k);
  if (!p) return;
  clearTimeout(p.t);
  pendingRead.delete(k);
  readSentAt.set(k, Date.now());
  api(p.url).chat.markRead({ channelId: p.channelId, seq: p.seq }).catch(() => sentRead.delete(k));
}
/** Sends every waiting read now: on blur, channel switch and page hide, so none is lost. */
export function flushReads() {
  for (const k of [...pendingRead.keys()]) sendRead(k);
}

const lastTyping = new Map<string, number>();
export function typing(url: string, channelId: string, rootId: string) {
  const k = `${url} ${listKey(channelId, rootId)}`;
  if (Date.now() - (lastTyping.get(k) ?? 0) < 3000) return;
  lastTyping.set(k, Date.now());
  api(url).chat.setTyping({ channelId, threadRootId: rootId }).catch(() => {});
}

export async function upload(url: string, file: File): Promise<Attachment> {
  if (FAKE && fakeTransport(url)) return fakeUpload(url, file);
  const body = new FormData();
  body.append("file", file);
  const res = await fetch(`${url}/upload`, { method: "POST", body, headers: { Authorization: `Bearer ${await getToken(url)}` } });
  if (res.status === 404 || res.status === 405) throw new Error("This community doesn't accept uploads.");
  if (res.status === 413) throw new Error("That file is over this community's size limit.");
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error ? `Upload failed: ${j.error}` : `Upload failed (${res.status}). Try again.`);
  return fromJson(AttachmentSchema, j);
}

export async function openDM(url: string, memberIds: string | string[]) {
  const r = await api(url).chat.openDM({ memberIds: [memberIds].flat() });
  const ch = r.channel!;
  patchC(url, (c) => ({ ...c, channels: { ...c.channels, [ch.id]: ch } }));
  set({ popover: null });
  selectChannel(url, ch.id);
}

const local = (url: string, kind: Event["kind"]) => dispatch(url, { seq: 0n, atMs: 0n, kind } as Event);

export async function updateProfile(url: string, req: { displayName?: string; avatarUrl?: string; bio?: string; statusText?: string; statusEmoji?: string }) {
  const r = await api(url).server.updateProfile(req);
  if (r.member) local(url, { case: "memberUpdated", value: r.member });
}

export function markAllRead(url: string) {
  const c = state.cs[url];
  for (const [id, rs] of Object.entries(c?.reads ?? {})) if (rs.unreadCount || rs.mentionCount) markRead(url, id);
}

export async function createChannel(url: string, req: { name: string; kind: ChannelKind; topic: string; category: string }) {
  const r = await api(url).chat.createChannel(req);
  if (r.channel) {
    local(url, { case: "channelCreated", value: r.channel });
    selectChannel(url, r.channel.id);
  }
}
export async function updateChannel(url: string, req: { channelId: string; name?: string; topic?: string; category?: string; position?: number; headerImageId?: string }) {
  const r = await api(url).chat.updateChannel(req);
  if (r.channel) local(url, { case: "channelUpdated", value: r.channel });
}
export const createBot = (url: string, req: { username: string; displayName: string; bio: string }) =>
  api(url).bot.createBot({ ...req, avatarUrl: "" });
export const listBots = async (url: string) => (await api(url).bot.listBots({})).bots;
export const rotateBotToken = async (url: string, botId: string) => (await api(url).bot.rotateBotToken({ botId })).token;
export const deleteBot = (url: string, botId: string) => api(url).bot.deleteBot({ botId });
export const listPlugins = async (url: string) => (await api(url).bot.listPlugins({})).plugins;
export const installPlugin = (url: string, name: string, source: string) => api(url).bot.installPlugin({ name, source });
export const setPluginEnabled = (url: string, name: string, enabled: boolean) => api(url).bot.setPluginEnabled({ name, enabled });
export const deletePlugin = (url: string, name: string) => api(url).bot.deletePlugin({ name });

export async function addToChannel(url: string, channelId: string, memberIds: string[]) {
  const r = await api(url).chat.addChannelMembers({ channelId, memberIds });
  if (r.channel) local(url, { case: "channelUpdated", value: r.channel });
}

/** Your own id leaves the channel; the server then sends channelDeleted, applied here at once. */
export async function removeFromChannel(url: string, channelId: string, memberId: string) {
  const r = await api(url).chat.removeChannelMember({ channelId, memberId });
  if (memberId === state.cs[url]?.me?.id) local(url, { case: "channelDeleted", value: channelId });
  else if (r.channel) local(url, { case: "channelUpdated", value: r.channel });
}

/** Block or unblock a member (1118). Applied at once; the server's event to my other devices is a no-op here. */
export async function setBlocked(url: string, memberId: string, on: boolean) {
  if (on) await api(url).server.blockMember({ memberId });
  else await api(url).server.unblockMember({ memberId });
  local(url, on ? { case: "memberBlocked", value: memberId } : { case: "memberUnblocked", value: memberId });
}

export async function search(url: string, q: string) {
  return (await api(url).chat.search({ query: q, limit: 30 })).messages;
}

// ---------------------------------------------------------------------------
// Communities
// ---------------------------------------------------------------------------

export const getMe = (url: string) => api(url).server.getMe({});

export async function probe(url: string): Promise<GetServerInfoResponse> {
  return api(url).server.getServerInfo({}, { timeoutMs: 8000 });
}

export async function join(
  url: string,
  fields: { displayName: string; avatarUrl: string; bio: string },
  invite: string,
  info: GetServerInfoResponse,
  answers: string[] = [],
) {
  const base = info.baseUrl ? info.baseUrl.replace(/\/+$/, "") : url;
  await api(base).server.join({ ...fields, inviteCode: invite, answers: answers.map((a) => a.trim()) });
  set((s) => ({
    order: s.order.includes(base) ? s.order : [...s.order, base],
    cs: { ...s.cs, [base]: { ...(s.cs[base] ?? emptyCommunity(base)), info: toInfo(info), status: "connecting" } },
    modal: null,
  }));
  saveOrder();
  void connect(base);
  selectCommunity(base);
}

// Leave on the server, then drop it locally. A server that already removed you (or that you
// never joined) is just dropped. Other errors, like the owner trying to leave, are thrown.
export async function leaveCommunity(url: string) {
  if (state.cs[url]?.me) {
    try {
      await api(url).server.leaveCommunity({});
    } catch (e) {
      const code = ConnectError.from(e).code;
      if (code !== Code.PermissionDenied && code !== Code.NotFound) throw e;
    }
  }
  leave(url);
}

export const setRole = (url: string, memberId: string, role: MemberRole) => api(url).server.setMemberRole({ memberId, role });
export const removeMember = (url: string, memberId: string, ban: boolean) =>
  ban ? api(url).server.banMember({ memberId }) : api(url).server.kickMember({ memberId });

export const listBans = async (url: string) => (await api(url).server.listBans({})).bans;
export const unbanMember = (url: string, memberId: string) => api(url).server.unbanMember({ memberId });

export const reportMessage = (url: string, messageId: string, note: string) => api(url).server.reportMessage({ messageId, note });
export const listReports = async (url: string) => (await api(url).server.listReports({})).reports;
export const resolveReport = (url: string, reportId: string) => api(url).server.resolveReport({ reportId });

export const createInvite = (url: string, expiresInSeconds: number, maxUses: number) =>
  api(url).server.createInvite({ expiresInSeconds: BigInt(expiresInSeconds), maxUses });
export const listInvites = async (url: string) => (await api(url).server.listInvites({})).invites;
export const revokeInvite = (url: string, code: string) => api(url).server.revokeInvite({ code });
/** Delete messages after this many days; 0 keeps them forever (1072). */
export async function setRetention(url: string, retentionDays: number) {
  const r = await api(url).server.updateServerSettings({ retentionDays });
  patchC(url, (c) => ({ ...c, info: c.info && { ...c.info, retentionDays: r.retentionDays } }));
}

export async function setInviteOnly(url: string, inviteOnly: boolean) {
  const r = await api(url).server.updateServerSettings({ inviteOnly });
  patchC(url, (c) => ({ ...c, info: c.info && { ...c.info, inviteOnly: r.inviteOnly } }));
}

/** Banner, icon and Markdown description (1026, 1044). An id of "" removes that image. */
export async function setCommunityProfile(url: string, req: { description?: string; bannerId?: string; iconId?: string }) {
  const r = await api(url).server.updateServerSettings(req);
  patchC(url, (c) => ({ ...c, info: c.info && { ...c.info, description: r.description, bannerUrl: r.banner?.url, iconUrl: r.iconUrl } }));
}

// ---------------------------------------------------------------------------
// Channel modes and roles (ticket 1011). Admin calls apply their result locally at once;
// the server's own event for the same change is an idempotent upsert.
// ---------------------------------------------------------------------------

const dropList = (lists: Community["lists"], k: string) => Object.fromEntries(Object.entries(lists).filter(([x]) => x !== k));

export async function setChannelMode(url: string, channelMode: ChannelMode) {
  const r = await api(url).server.updateServerSettings({ channelMode });
  local(url, { case: "channelModeChanged", value: r.channelMode });
}
export const browseChannels = async (url: string) => (await api(url).chat.browseChannels({})).channels;

/** Opens a channel I have not joined, read-only. */
export function peekChannel(url: string, ch: Channel) {
  patchC(url, (c) => ({ ...c, peek: ch, lists: dropList(c.lists, ch.id) }));
  selectChannel(url, ch.id);
}
export async function joinChannel(url: string, channelId: string) {
  const r = await api(url).chat.joinChannel({ channelId });
  if (r.channel) local(url, { case: "channelCreated", value: r.channel });
  // A preview list missed live events; reload it as a member.
  patchC(url, (c) => ({ ...c, lists: dropList(c.lists, channelId) }));
}
export async function leaveChannel(url: string, channelId: string) {
  await api(url).chat.leaveChannel({ channelId });
  local(url, { case: "channelDeleted", value: channelId });
}
export async function setChannelAccess(url: string, channelId: string, roleIds: string[], isDefault: boolean) {
  const r = await api(url).chat.setChannelAccess({ channelId, roleIds, isDefault });
  if (r.channel && state.cs[url]?.channels[channelId]) local(url, { case: "channelUpdated", value: r.channel });
  return r.channel;
}
export async function createRole(url: string, name: string, color: string) {
  const r = await api(url).server.createRole({ name, color });
  if (r.role) local(url, { case: "roleUpdated", value: r.role });
}
export async function updateRole(url: string, roleId: string, patch: { name?: string; color?: string; position?: number }) {
  const r = await api(url).server.updateRole({ roleId, ...patch });
  if (r.role) local(url, { case: "roleUpdated", value: r.role });
}
export async function deleteRole(url: string, roleId: string) {
  await api(url).server.deleteRole({ roleId });
  local(url, { case: "roleDeleted", value: roleId });
}
export async function setMemberRoles(url: string, memberId: string, roleIds: string[]) {
  const r = await api(url).server.setMemberRoles({ memberId, roleIds });
  if (r.member) local(url, { case: "memberUpdated", value: r.member });
}

export function joinAgain(url: string) {
  patchC(url, (c) => ({ ...c, status: "join" }));
}

// Drops a community from the list, on every device once it syncs.
export function leave(url: string) {
  conns.get(url)?.ctl.abort();
  conns.delete(url);
  set((s) => {
    const { [url]: _, ...cs } = s.cs;
    const order = s.order.filter((u) => u !== url);
    return { cs, order, modal: null, url: s.url === url ? order[0] ?? "" : s.url, channelId: s.url === url ? "" : s.channelId };
  });
  saveOrder();
  if (state.url) selectCommunity(state.url);
}

export function reorder(order: string[]) {
  set({ order });
  saveOrder();
}

// The community list follows the account across devices like appearance does (1225).
let orderTimer: ReturnType<typeof setTimeout> | undefined;
function saveOrder() {
  save("order", state.order);
  save("orderAt", Date.now());
  clearTimeout(orderTimer);
  orderTimer = setTimeout(pushOrder, 1000);
}
function pushOrder() {
  if (!FAKE) saveCommunities(load<string[]>("order", []), load("orderAt", 0)).catch(() => {});
}
async function syncCommunities() {
  const remote = await fetchCommunities().catch(() => undefined);
  if (remote === undefined) return;
  const r = communitiesSync(load<string[] | null>("order", null), load("orderAt", 0), remote, Date.now());
  if (r.order) {
    save("order", r.order);
    save("orderAt", r.at);
    applyOrder(r.order);
  }
  if (r.push) pushOrder();
}
/** Shows exactly these communities: connects the new ones and drops the rest from this browser. */
function applyOrder(order: string[]) {
  const infos = load<Record<string, Info>>("info", {});
  const added = order.filter((u) => !state.cs[u]);
  for (const u of state.order.filter((u) => !order.includes(u))) {
    conns.get(u)?.ctl.abort();
    conns.delete(u);
  }
  const gone = !order.includes(state.url);
  set((s) => ({
    order,
    cs: Object.fromEntries(order.map((u) => [u, s.cs[u] ?? emptyCommunity(u, infos[u])])),
    ...(gone && { url: order[0] ?? "", channelId: "" }),
  }));
  added.forEach((u) => void connect(u));
  if (gone && state.url) selectCommunity(state.url);
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export function setLook(patch: Partial<Appearance>) {
  set({ look: parseAppearance({ ...state.look, ...patch }) });
  save("appearance", state.look);
  save("appearanceAt", Date.now());
  // A quick crossfade between the old and new look (1268), unless motion is reduced.
  const still = state.look.motion === "reduce" || (state.look.motion !== "full" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  if (still || !document.startViewTransition) applyLook();
  else document.startViewTransition(applyLook);
  clearTimeout(lookTimer);
  lookTimer = setTimeout(pushLook, 1000);
}
let lookTimer: ReturnType<typeof setTimeout> | undefined;
// Appearance follows the account across devices. Offline or failing, localStorage carries on alone.
function pushLook() {
  if (!FAKE) saveAppearance(state.look, load("appearanceAt", 0)).catch(() => {});
}
async function syncLook() {
  const remote = await fetchAppearance().catch(() => undefined);
  if (remote === undefined) return;
  const how = appearanceSync(load("appearanceAt", 0), remote && remote.updatedAt);
  if (how === "push") pushLook();
  if (how !== "pull" || !remote) return;
  set({ look: parseAppearance(remote.data) });
  save("appearance", state.look);
  save("appearanceAt", remote.updatedAt);
  applyLook();
}
/** Switches to the custom theme, starting from the colors on screen the first time. */
export function startCustomTheme() {
  const custom = state.look.custom || themeString(readTokens(["--frost", "--ink", "--paper", "--text", "--accent-fill", "--badge"]).map(toHex));
  setLook({ theme: "custom", custom });
}
/** Token values resolved for the current theme and light or dark scheme, as rgb() strings. */
function readTokens(vars: string[]) {
  const probe = document.body.appendChild(document.createElement("i"));
  const out = vars.map((v) => ((probe.style.color = `var(${v})`), getComputedStyle(probe).color));
  probe.remove();
  return out;
}
/** Puts the appearance on <html>: data attributes for CSS, a font size, and an accent fitted to the theme. */
function applyLook() {
  const { theme, density, sidebar, motion, fontSize, accent, custom, font } = state.look;
  const root = document.documentElement;
  const attrs = { theme, density, sidebar, motion, font };
  for (const [k, v] of Object.entries(attrs)) {
    if (v === "system" || v === "cozy" || v === "default") delete root.dataset[k];
    else root.dataset[k] = v;
  }
  root.style.fontSize = fontSize === APPEARANCE.fontSize ? "" : `${(fontSize / 15) * 100}%`;
  for (const v of [...root.style].filter((v) => v.startsWith("--") || v === "color-scheme")) root.style.removeProperty(v);
  if (theme === "custom") {
    const { tokens, dark } = customTheme(custom.split(","));
    for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v);
    root.style.colorScheme = dark ? "dark" : "light";
  }
  const [paper, frost, onAccent, hover, mention] = readTokens(["--paper", "--frost", "--on-accent", "--msg-hover", "--mention-bg"]);
  if ([paper, hover, mention].join() !== state.surfaces.join()) set({ surfaces: [paper, hover, mention] });
  if (!accent || theme === "custom") return;
  const min = theme === "contrast" ? 7 : 4.5;
  root.style.setProperty("--raspberry", fitContrast(accent, [paper, frost], min));
  root.style.setProperty("--accent-fill", fitContrast(accent, [onAccent], min));
  root.style.setProperty("--selected", "color-mix(in srgb, var(--raspberry) 22%, var(--paper))");
}

export async function setNotify(on: boolean) {
  if (on && typeof Notification !== "undefined" && Notification.permission !== "granted") {
    on = (await Notification.requestPermission()) === "granted";
  }
  set({ notify: on });
  save("notify", on);
}

export function toggleCollapsed(key: string) {
  set((s) => ({ collapsed: { ...s.collapsed, [key]: !s.collapsed[key] } }));
  save("collapsed", state.collapsed);
}

let draftTimer = 0;
export function setDraft(key: string, text: string) {
  set((s) => ({ drafts: { ...s.drafts, [key]: text } }));
  clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => save("drafts", Object.fromEntries(Object.entries(state.drafts).filter(([, v]) => v))), 400);
}

export const signIn = (signup = false) => (FAKE ? start() : startLogin(signup));

export function signOut() {
  for (const { ctl } of conns.values()) ctl.abort();
  conns.clear();
  if (!FAKE) authSignOut();
  // The next person on this device must not see this one's drafts or cached private previews.
  clearTimeout(draftTimer);
  save("drafts", {});
  // The community list is the account's now; the next account starts from its own.
  clearTimeout(orderTimer);
  save("order", null);
  save("orderAt", 0);
  unfurled.clear();
  unfurling.clear();
  sentRead.clear();
  set({ auth: "out", cs: {}, modal: null, profile: undefined, drafts: {} });
}

/** Label for a channel: "#name" or the other people in a DM. */
export function channelTitle(c: Community, ch: Channel) {
  return isDM(ch) ? channelLabel(ch, c.members, c.me?.id) : ch.name;
}
export const isText = (ch: Channel) => ch.kind !== ChannelKind.DM;

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function start() {
  const infos = load<Record<string, Info>>("info", {});
  const order = load<string[] | null>("order", null) ?? (FAKE ? FAKE_URLS : DEFAULT_COMMUNITIES);
  set({
    auth: "in",
    order,
    cs: Object.fromEntries(order.map((u) => [u, emptyCommunity(u, infos[u])])),
    profile: FAKE
      ? { username: "ian", displayName: "Ian Langworth", avatarUrl: "", bio: "Making Sblurp. Ask me about the rail." }
      : state.profile,
  });
  if (!FAKE) fetchProfile().then((profile) => set({ profile })).catch((e) => e instanceof SignedOutError && set({ auth: "out" }));
  if (!FAKE) void syncLook();
  if (!FAKE) void syncCommunities();
  order.forEach((u) => void connect(u));
  const fromHash = parseHash(location.hash);
  const url = order.find((u) => hostOf(u) === fromHash?.host) ?? order[0] ?? "";
  set({ url, channelId: fromHash?.channelId ?? "", pane: fromHash?.channelId ? parsePane(location.hash) : null });
  if (fromHash?.messageId) jumpTo(url, { id: fromHash.messageId, channelId: fromHash.channelId, threadRootId: fromHash.rootId });
  let join = null;
  try {
    join = sessionStorage.getItem(JOIN_KEY);
    sessionStorage.removeItem(JOIN_KEY);
  } catch {
    // storage blocked: the invite link is lost, Add a community still works by hand
  }
  if (join) set({ modal: { t: "add", input: join } });
}

// An invite link opened in a browser lands on #/join (see joinHashInput). It waits in
// sessionStorage, so it survives the sign-in round trip in this tab.
const JOIN_KEY = "sblurp.join";

export async function boot() {
  applyLook();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyLook);
  addEventListener("popstate", applyHash);
  addEventListener("blur", flushReads);
  addEventListener("pagehide", flushReads);
  document.addEventListener("visibilitychange", () => document.hidden && flushReads());
  const join = joinHashInput(location.hash);
  if (join) {
    try {
      sessionStorage.setItem(JOIN_KEY, join);
    } catch {
      // see start()
    }
    history.replaceState(null, "", location.pathname + location.search);
  }
  if (FAKE) {
    if (params.has("signedout")) set({ auth: "out" });
    else start();
    if (!params.has("quiet")) startSimulation();
    return;
  }
  if (location.pathname === "/auth/callback") {
    const q = new URLSearchParams(location.search);
    history.replaceState(null, "", "/");
    try {
      if (!(await finishLogin(q))) set({ authError: q.get("error_description") ?? "Sign-in didn't finish. Try again." });
    } catch (e) {
      set({ authError: e instanceof SignedOutError ? "Sign-in was refused. Try again." : `Can't reach sblurp.chat. ${String(e)}` });
    }
  }
  if (hasSession()) start();
  else set({ auth: "out" });
}

export { AUTH_URL };
