// App state (one store, read with useSyncExternalStore), actions, and one live connection per community.
import { create, fromJson } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Client, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { useSyncExternalStore } from "react";
import type { SettingsTab } from "./Admin";
import { AUTH_URL, fetchProfile, finishLogin, getToken, hasSession, SignedOutError, signOut as authSignOut, startLogin, type Profile } from "./auth";
import { fakeTransport, fakeUpload, FAKE_URLS, startSimulation } from "./fake";
import {
  AttachmentSchema,
  BotService,
  ChannelKind,
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
  plainText,
  upsertMessage,
  type Community,
  type Info,
  type MsgList,
} from "./logic";

const params = new URLSearchParams(location.search);
export const FAKE = params.has("fake") || import.meta.env.VITE_FAKE === "1";
const DEFAULT_COMMUNITIES: string[] = (import.meta.env.VITE_COMMUNITIES ?? "http://localhost:8082,http://localhost:8083").split(",");
export const ACCOUNT_URL = `${AUTH_URL}/account`;

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

export type Pane = null | { t: "thread"; rootId: string } | { t: "members" } | { t: "search"; q: string };
export type Modal =
  | null
  | { t: "settings" }
  | { t: "add" }
  | { t: "switcher" }
  | { t: "info" }
  | { t: "invite" }
  | { t: "leave" }
  | { t: "delete"; id: string }
  | { t: "channel"; id?: string; category?: string }
  | { t: "community"; tab?: SettingsTab }
  | { t: "newdm" }
  | { t: "profile" }
  | { t: "remove"; url: string; memberId: string; ban: boolean }
  | { t: "lightbox"; src: string; name: string };
export type Theme = "system" | "light" | "dark";

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
  theme: Theme;
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
  theme: load<Theme>("theme", "system"),
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
      return ce.rawMessage ? `${ce.rawMessage[0].toUpperCase()}${ce.rawMessage.slice(1)}.` : "Something went wrong. Try again.";
  }
}

const toInfo = (i: GetServerInfoResponse): Info => ({
  name: i.name,
  description: i.description,
  iconUrl: i.iconUrl,
  accentColor: i.accentColor,
  memberCount: i.memberCount,
  inviteOnly: i.inviteOnly,
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

async function connect(url: string) {
  conns.get(url)?.ctl.abort();
  const ctl = new AbortController();
  const conn = { ctl, wake: () => {} };
  conns.set(url, conn);
  const { server } = api(url);
  const infos = load<Record<string, Info>>("info", {});
  server
    .getServerInfo({}, { signal: ctl.signal })
    .then((i) => {
      patchC(url, (c) => ({ ...c, info: toInfo(i) }));
      save("info", { ...infos, [url]: toInfo(i) });
    })
    .catch(() => {});
  let attempt = 0;
  let snapshot = true;
  while (!ctl.signal.aborted) {
    try {
      if (snapshot) {
        const st = await server.getState({}, { signal: ctl.signal });
        patchC(url, (c) => applySnapshot(c, st));
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
          attempt = 0;
          // Live only once the server answers (it sends a heartbeat at once), so the banner does
          // not flicker off on every retry while the server is still down.
          if (state.cs[url]?.status !== "live") patchC(url, (c) => ({ ...c, status: "live", error: undefined, retryAt: undefined }));
          if (ev.kind.case === "resync") {
            snapshot = true;
            break;
          }
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
  if (location.hash !== hash) history[push ? "pushState" : "replaceState"](null, "", hash);
}

function applyHash() {
  const r = parseHash(location.hash);
  if (!r) return;
  const url = state.order.find((u) => hostOf(u) === r.host);
  if (!url) return;
  if (r.messageId) jumpTo(url, { id: r.messageId, channelId: r.channelId, threadRootId: r.rootId });
  else if (r.channelId) selectChannel(url, r.channelId, false);
  else selectCommunity(url);
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
export function jumpTo(url: string, m: Pick<Message, "id" | "channelId" | "threadRootId">) {
  void loadList(url, m.channelId, m.threadRootId, "around", m.id);
  selectChannel(url, m.channelId);
  if (m.threadRootId) set({ pane: { t: "thread", rootId: m.threadRootId } });
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
  api(url).chat.markRead({ channelId, seq }).catch(() => sentRead.delete(k));
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

export async function updateProfile(url: string, req: { displayName?: string; bio?: string; statusText?: string; statusEmoji?: string }) {
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
export async function updateChannel(url: string, req: { channelId: string; name?: string; topic?: string; category?: string; position?: number }) {
  const r = await api(url).chat.updateChannel(req);
  if (r.channel) local(url, { case: "channelUpdated", value: r.channel });
}
export const createBot = (url: string, req: { username: string; displayName: string; bio: string }) =>
  api(url).bot.createBot({ ...req, avatarUrl: "" });
export const listBots = async (url: string) => (await api(url).bot.listBots({})).bots;
export const rotateBotToken = async (url: string, botId: string) => (await api(url).bot.rotateBotToken({ botId })).token;
export const deleteBot = (url: string, botId: string) => api(url).bot.deleteBot({ botId });

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

export async function search(url: string, q: string) {
  return (await api(url).chat.search({ query: q, limit: 30 })).messages;
}

// ---------------------------------------------------------------------------
// Communities
// ---------------------------------------------------------------------------

export async function probe(url: string): Promise<GetServerInfoResponse> {
  return api(url).server.getServerInfo({}, { timeoutMs: 8000 });
}

export async function join(
  url: string,
  fields: { displayName: string; avatarUrl: string; bio: string },
  invite: string,
  info: GetServerInfoResponse,
) {
  const base = info.baseUrl ? info.baseUrl.replace(/\/+$/, "") : url;
  await api(base).server.join({ ...fields, inviteCode: invite });
  set((s) => ({
    order: s.order.includes(base) ? s.order : [...s.order, base],
    cs: { ...s.cs, [base]: { ...(s.cs[base] ?? emptyCommunity(base)), info: toInfo(info), status: "connecting" } },
    modal: null,
  }));
  save("order", state.order);
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

export const createInvite = (url: string, expiresInSeconds: number, maxUses: number) =>
  api(url).server.createInvite({ expiresInSeconds: BigInt(expiresInSeconds), maxUses });
export const listInvites = async (url: string) => (await api(url).server.listInvites({})).invites;
export const revokeInvite = (url: string, code: string) => api(url).server.revokeInvite({ code });
export async function setInviteOnly(url: string, inviteOnly: boolean) {
  const r = await api(url).server.updateServerSettings({ inviteOnly });
  patchC(url, (c) => ({ ...c, info: c.info && { ...c.info, inviteOnly: r.inviteOnly } }));
}

export function joinAgain(url: string) {
  patchC(url, (c) => ({ ...c, status: "join" }));
}

// Drops a community from this browser only.
export function leave(url: string) {
  conns.get(url)?.ctl.abort();
  conns.delete(url);
  set((s) => {
    const { [url]: _, ...cs } = s.cs;
    const order = s.order.filter((u) => u !== url);
    return { cs, order, modal: null, url: s.url === url ? order[0] ?? "" : s.url, channelId: s.url === url ? "" : s.channelId };
  });
  save("order", state.order);
  if (state.url) selectCommunity(state.url);
}

export function reorder(order: string[]) {
  set({ order });
  save("order", order);
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export function setTheme(theme: Theme) {
  set({ theme });
  save("theme", theme);
  applyTheme();
}
function applyTheme() {
  if (state.theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = state.theme;
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
  set({ auth: "out", cs: {}, modal: null, profile: undefined });
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
  const order = load<string[]>("order", FAKE ? FAKE_URLS : DEFAULT_COMMUNITIES);
  set({
    auth: "in",
    order,
    cs: Object.fromEntries(order.map((u) => [u, emptyCommunity(u, infos[u])])),
    profile: FAKE
      ? { username: "ian", displayName: "Ian Langworth", avatarUrl: "", bio: "Making Sblurp. Ask me about the rail." }
      : state.profile,
  });
  if (!FAKE) fetchProfile().then((profile) => set({ profile })).catch((e) => e instanceof SignedOutError && set({ auth: "out" }));
  order.forEach((u) => void connect(u));
  const fromHash = parseHash(location.hash);
  const url = order.find((u) => hostOf(u) === fromHash?.host) ?? order[0] ?? "";
  set({ url, channelId: fromHash?.channelId ?? "" });
  if (fromHash?.messageId) jumpTo(url, { id: fromHash.messageId, channelId: fromHash.channelId, threadRootId: fromHash.rootId });
}

export async function boot() {
  applyTheme();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
  addEventListener("popstate", applyHash);
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
