// Pure decision logic. No DOM, no network. Everything here is covered by logic.test.ts.
import { create } from "@bufbuild/protobuf";
import {
  ChannelKind,
  MemberKind,
  MemberRole,
  Presence,
  ReadStateSchema,
  type Channel,
  type Event,
  type GetStateResponse,
  type Member,
  type Message,
  type ReadState,
} from "./gen/sblurp/v1/sblurp_pb";

// ---------------------------------------------------------------------------
// Community state and the event reducer
// ---------------------------------------------------------------------------

export type Status = "connecting" | "live" | "reconnecting" | "join" | "removed" | "error";

export interface Info {
  name: string;
  description: string;
  iconUrl: string;
  accentColor: string;
  memberCount: number;
  inviteOnly?: boolean;
}

export interface MsgList {
  items: Message[];
  hasMore: boolean;
  // Set after a search jump: the list is a window around focusId and newer messages exist.
  hasMoreAfter?: boolean;
  focusId?: string;
  loading?: boolean;
  error?: string;
}

export interface Community {
  url: string;
  info?: Info;
  status: Status;
  error?: string;
  retryAt?: number;
  me?: Member;
  members: Record<string, Member>;
  channels: Record<string, Channel>;
  reads: Record<string, ReadState>;
  seq: bigint;
  /** Message lists keyed by channel id, or `t:<rootId>` for a thread. */
  lists: Record<string, MsgList>;
  /** Typing expiry (ms) keyed by list key, then member id. */
  typing: Record<string, Record<string, number>>;
  /** client_ids of optimistic messages that failed to send. */
  failed: Record<string, true>;
}

export const emptyCommunity = (url: string, info?: Info): Community => ({
  url,
  info,
  status: "connecting",
  members: {},
  channels: {},
  reads: {},
  seq: 0n,
  lists: {},
  typing: {},
  failed: {},
});

export const listKey = (channelId: string, rootId = "") => (rootId ? `t:${rootId}` : channelId);

export const isDM = (ch?: Channel) => ch?.kind === ChannelKind.DM;

export const mentionsMe = (text: string, meId: string | undefined) => !!meId && text.includes(`<@${meId}>`);

export function applySnapshot(c: Community, s: GetStateResponse): Community {
  return {
    ...c,
    me: s.me,
    members: Object.fromEntries(s.members.map((m) => [m.id, m])),
    channels: Object.fromEntries(s.channels.map((ch) => [ch.id, ch])),
    reads: Object.fromEntries(s.readStates.map((r) => [r.channelId, r])),
    seq: s.seq,
    // Lists may have missed events; the open view reloads them.
    lists: {},
    typing: {},
  };
}

/** Insert or replace a message, matching by id or by the optimistic client_id. Keeps time order. */
export function upsertMessage(items: Message[], m: Message): Message[] {
  const i = items.findIndex((x) => x.id === m.id || (!!m.clientId && x.clientId === m.clientId));
  if (i >= 0) {
    const next = items.slice();
    next[i] = m;
    return next;
  }
  let at = items.length;
  while (at > 0 && items[at - 1].createdAtMs > m.createdAtMs) at--;
  return [...items.slice(0, at), m, ...items.slice(at)];
}

function mapLists(c: Community, fn: (items: Message[]) => Message[]): Record<string, MsgList> {
  const out: Record<string, MsgList> = {};
  for (const [k, l] of Object.entries(c.lists)) out[k] = { ...l, items: fn(l.items) };
  return out;
}

/** Unread math for one new message in a channel. */
export function bumpUnread(
  rs: ReadState | undefined,
  channelId: string,
  m: Message,
  seq: bigint,
  meId: string | undefined,
  dm: boolean,
  viewing: boolean,
): ReadState {
  const base = rs ?? create(ReadStateSchema, { channelId });
  if (m.authorId === meId || viewing) {
    return { ...base, lastReadSeq: seq > base.lastReadSeq ? seq : base.lastReadSeq, unreadCount: 0, mentionCount: 0 };
  }
  const mention = dm || mentionsMe(m.text, meId);
  return { ...base, unreadCount: base.unreadCount + 1, mentionCount: base.mentionCount + (mention ? 1 : 0) };
}

export const TYPING_TTL = 6000;

/**
 * Apply one Subscribe event. `viewing` is the channel the person is looking at with the list
 * scrolled to the bottom; new messages there do not count as unread.
 */
export function applyEvent(c: Community, ev: Event, now: number, viewing: string | null): Community {
  if (ev.seq > 0n && ev.seq <= c.seq) return c; // already applied (replay overlap)
  const next: Community = ev.seq > 0n ? { ...c, seq: ev.seq } : { ...c };
  const k = ev.kind;
  switch (k.case) {
    case "messageCreated": {
      const m = k.value;
      const key = listKey(m.channelId, m.threadRootId);
      const l = c.lists[key];
      // A window from a search jump is not at the newest end, so new messages would leave a gap.
      if (l && !l.hasMoreAfter) next.lists = { ...c.lists, [key]: { ...l, items: upsertMessage(l.items, m) } };
      if (m.clientId && c.failed[m.clientId]) {
        const { [m.clientId]: _, ...rest } = c.failed;
        next.failed = rest;
      }
      const t = c.typing[key];
      if (t?.[m.authorId]) {
        const { [m.authorId]: _, ...rest } = t;
        next.typing = { ...c.typing, [key]: rest };
      }
      const ch = c.channels[m.channelId];
      if (ch && !m.threadRootId) {
        next.channels = { ...c.channels, [ch.id]: { ...ch, lastMessageSeq: ev.seq } };
        next.reads = {
          ...c.reads,
          [ch.id]: bumpUnread(c.reads[ch.id], ch.id, m, ev.seq, c.me?.id, isDM(ch), viewing === ch.id),
        };
      } else if (ch && m.authorId !== c.me?.id && (isDM(ch) || mentionsMe(m.text, c.me?.id))) {
        // Thread replies are not channel unread, but a mention in one (or any DM reply) still counts.
        const rs = c.reads[ch.id] ?? create(ReadStateSchema, { channelId: ch.id });
        next.reads = { ...c.reads, [ch.id]: { ...rs, mentionCount: rs.mentionCount + 1 } };
      }
      return next;
    }
    case "messageUpdated": {
      const m = k.value;
      next.lists = mapLists(c, (items) => items.map((x) => (x.id === m.id ? m : x)));
      return next;
    }
    case "messageDeleted": {
      const m = k.value;
      // A deleted thread root stays as a placeholder so its replies remain reachable.
      next.lists = mapLists(c, (items) =>
        m.replyCount > 0 ? items.map((x) => (x.id === m.id ? { ...m, deleted: true } : x)) : items.filter((x) => x.id !== m.id),
      );
      return next;
    }
    case "channelCreated":
    case "channelUpdated":
      next.channels = { ...c.channels, [k.value.id]: k.value };
      return next;
    case "channelDeleted": {
      const { [k.value]: _, ...rest } = c.channels;
      next.channels = rest;
      return next;
    }
    case "memberJoined":
    case "memberUpdated":
      next.members = { ...c.members, [k.value.id]: k.value };
      if (c.me?.id === k.value.id) next.me = k.value;
      return next;
    case "memberLeft": {
      const { [k.value]: _, ...rest } = c.members;
      next.members = rest;
      return next;
    }
    case "readState":
      next.reads = { ...c.reads, [k.value.channelId]: k.value };
      return next;
    case "typing": {
      const t = k.value;
      if (t.memberId === c.me?.id) return c;
      const key = listKey(t.channelId, t.threadRootId);
      next.typing = { ...c.typing, [key]: { ...c.typing[key], [t.memberId]: now + TYPING_TTL } };
      return next;
    }
    case "presence": {
      const { memberId: id, presence } = k.value;
      // c.me is its own copy of your member, so it needs the update too.
      if (c.members[id]) next.members = { ...c.members, [id]: { ...c.members[id], presence } };
      if (c.me?.id === id) next.me = { ...c.me, presence };
      return next;
    }
    default:
      return next; // heartbeat; resync is handled by the connection loop
  }
}

/** Rail badge for a community: any unread channel, and the total mention count. */
export function communityBadge(c: Community): { unread: boolean; mentions: number } {
  let unread = false;
  let mentions = 0;
  for (const ch of Object.values(c.channels)) {
    const r = c.reads[ch.id];
    if (!r) continue;
    if (r.unreadCount > 0) unread = true;
    mentions += r.mentionCount;
  }
  return { unread, mentions };
}

/** Browser tab title: mention count first, a dot for plain unread. */
export function tabTitle(mentions: number, unread: boolean, label: string): string {
  const prefix = mentions > 0 ? `(${mentions > 99 ? "99+" : mentions}) ` : unread ? "• " : "";
  return `${prefix}${label ? `${label} | ` : ""}Sblurp`;
}

// ---------------------------------------------------------------------------
// Message rows: grouping, day dividers and the "New" divider
// ---------------------------------------------------------------------------

export type Row =
  | { t: "day"; key: string; ms: number }
  | { t: "new"; key: string }
  | { t: "msg"; key: string; m: Message; head: boolean };

export const GROUP_GAP_MS = 5 * 60 * 1000;

const dayOf = (ms: number) => new Date(ms).toDateString();

/**
 * newAfterSeq: the read position when the channel was opened. The "New" divider goes before the
 * first message from someone else with a higher seq. Null for no divider.
 */
export function buildRows(items: Message[], newAfterSeq: bigint | null, meId?: string): Row[] {
  const rows: Row[] = [];
  let prev: Message | undefined;
  let placedNew = newAfterSeq === null;
  for (const m of items) {
    const ms = Number(m.createdAtMs);
    let head = !prev || prev.authorId !== m.authorId || ms - Number(prev.createdAtMs) > GROUP_GAP_MS || prev.deleted;
    if (!prev || dayOf(ms) !== dayOf(Number(prev.createdAtMs))) {
      rows.push({ t: "day", key: `day-${dayOf(ms)}`, ms });
      head = true;
    }
    // createdSeq, not seq: edits and reactions bump seq, and an old message is not new.
    if (!placedNew && m.createdSeq > (newAfterSeq ?? 0n) && m.authorId !== meId && m.createdSeq > 0n) {
      rows.push({ t: "new", key: "new" });
      placedNew = true;
      head = true;
    }
    rows.push({ t: "msg", key: m.clientId || m.id, m, head });
    prev = m;
  }
  return rows;
}

export function dayLabel(ms: number, now: number): string {
  const d = new Date(ms);
  const today = new Date(now);
  const yesterday = new Date(now);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(d.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
}

export const timeLabel = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

// ---------------------------------------------------------------------------
// Markdown subset → tokens. Rendering builds React nodes from these; no HTML strings.
// ---------------------------------------------------------------------------

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "mention"; id: string }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "b" | "i" | "s"; c: Inline[] };

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "quote"; c: Inline[] }
  | { t: "pre"; lang: string; v: string }
  | { t: "ul"; items: Inline[][] }
  | { t: "ol"; start: number; items: Inline[][] };

const INLINE =
  /`([^`\n]+)`|<@([\w-]+)>|\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)|(https?:\/\/[^\s<]*[^\s<.,:;"')\]!?])|\*\*([^\n]+?)\*\*|~~([^\n]+?)~~|\*([^*\s](?:[^*\n]*[^*\s])?)\*|(?<!\w)_([^_\s](?:[^_\n]*[^_\s])?)_(?!\w)/g;

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of s.matchAll(INLINE)) {
    const i = m.index!;
    if (i > last) out.push({ t: "text", v: s.slice(last, i) });
    last = i + m[0].length;
    if (m[1] !== undefined) out.push({ t: "code", v: m[1] });
    else if (m[2] !== undefined) out.push({ t: "mention", id: m[2] });
    else if (m[3] !== undefined) out.push({ t: "link", href: m[4], c: parseInline(m[3]) });
    else if (m[5] !== undefined) out.push({ t: "link", href: m[5], c: [{ t: "text", v: m[5] }] });
    else if (m[6] !== undefined) out.push({ t: "b", c: parseInline(m[6]) });
    else if (m[7] !== undefined) out.push({ t: "s", c: parseInline(m[7]) });
    else out.push({ t: "i", c: parseInline(m[8] ?? m[9]) });
  }
  if (last < s.length) out.push({ t: "text", v: s.slice(last) });
  return out;
}

export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  let para: string[] = [];
  let quote: string[] = [];
  // ponytail: flat lists only; indented items join the list at the same level.
  let list = null as { t: "ul" | "ol"; start: number; items: string[] } | null;
  const flush = () => {
    if (para.length) blocks.push({ t: "p", c: parseInline(para.join("\n")) });
    if (quote.length) blocks.push({ t: "quote", c: parseInline(quote.join("\n")) });
    if (list) blocks.push(list.t === "ul" ? { t: "ul", items: list.items.map(parseInline) } : { ...list, items: list.items.map(parseInline) } as Block);
    para = [];
    quote = [];
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^```([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const end = lines.findIndex((l, j) => j > i && /^```\s*$/.test(l));
      if (end > i) {
        flush();
        blocks.push({ t: "pre", lang: fence[1], v: lines.slice(i + 1, end).join("\n") });
        i = end;
        continue;
      }
    }
    const li = /^\s*(?:([-*•])|(\d{1,9})[.)])\s+(.*)$/.exec(line);
    if (li) {
      const t = li[1] ? "ul" : "ol";
      if (list?.t !== t) flush();
      list ??= { t, start: Number(li[2] ?? 1), items: [] };
      list.items.push(li[3]);
      continue;
    }
    if (list && /^\s+\S/.test(line)) {
      list.items[list.items.length - 1] += `\n${line.trim()}`;
      continue;
    }
    if (list) flush();
    const q = /^> ?(.*)$/.exec(line);
    if (q) {
      if (para.length) flush();
      quote.push(q[1]);
    } else {
      if (quote.length) flush();
      para.push(line);
    }
  }
  flush();
  return blocks;
}

/** Plain text for notifications and previews. */
export function plainText(text: string, members: Record<string, Member>): string {
  return text
    .replace(/<@([\w-]+)>/g, (_, id) => `@${members[id]?.displayName ?? "someone"}`)
    .replace(/```[\w+-]*\n?|`|\*\*|~~|\*/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

// ---------------------------------------------------------------------------
// Composer: mentions and autocomplete
// ---------------------------------------------------------------------------

/** "@ana hi" → "<@id> hi" for known usernames. */
export function encodeMentions(text: string, members: Member[]): string {
  const byName = new Map(members.map((m) => [m.username.toLowerCase(), m.id]));
  return text.replace(/(^|[^\w@])@([\w.-]*\w)/g, (all, pre, name) => {
    const id = byName.get(name.toLowerCase());
    return id ? `${pre}<@${id}>` : all;
  });
}

/** "<@id>" → "@username", for editing a sent message. */
export function decodeMentions(text: string, members: Record<string, Member>): string {
  return text.replace(/<@([\w-]+)>/g, (all, id) => (members[id] ? `@${members[id].username}` : all));
}

/** The token being typed at the caret, for `@` and `:` autocomplete. */
export function acQuery(text: string, caret: number): { kind: "@" | ":"; start: number; q: string } | null {
  const before = text.slice(0, caret);
  const m = /(?:^|\s)([@:])([\w.+-]*)$/.exec(before);
  if (!m) return null;
  if (m[1] === ":" && m[2].length < 2) return null;
  return { kind: m[1] as "@" | ":", start: caret - m[2].length - 1, q: m[2].toLowerCase() };
}

/** Who reacted, you first: "You, Ana Ruiz and 3 others reacted with 👍". */
export function reactorsLabel(ids: string[], members: Record<string, Member>, meId: string | undefined, emoji: string): string {
  const names = [...ids].sort((a, b) => Number(b === meId) - Number(a === meId)).map((id) => (id === meId ? "You" : members[id]?.displayName || members[id]?.username || "Someone"));
  const shown = names.length > 4 ? [...names.slice(0, 3), count(names.length - 3, "other", "others")] : names;
  const list = shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : shown[0] ?? "Nobody";
  return `${list} reacted with ${emoji}`;
}

export function typingLabel(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return "Several people are typing…";
}

// ---------------------------------------------------------------------------
// Connection timing
// ---------------------------------------------------------------------------

/** Exponential backoff, 1s doubling to 30s, with jitter in [50%, 100%]. `rand` is in [0, 1). */
export const backoffMs = (attempt: number, rand: number) =>
  Math.round(Math.min(30_000, 1000 * 2 ** attempt) * (0.5 + rand / 2));

/** Servers send a heartbeat every 25s. Two missed beats plus slack means the stream is dead. */
export const HEARTBEAT_TIMEOUT_MS = 60_000;

/** Access tokens are refreshed when less than this is left. */
export const TOKEN_SKEW_MS = 60_000;
export const tokenFresh = (expMs: number, now: number) => expMs - now > TOKEN_SKEW_MS;

// ---------------------------------------------------------------------------
// URLs and routing
// ---------------------------------------------------------------------------

/** Accepts "nightowls.chat", "https://x.y/", "localhost:8082" or an invite link. */
export function normalizeCommunityUrl(input: string): { url: string; invite: string } | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    s = (/^(localhost|127\.|\[::1\])/.test(s) ? "http://" : "https://") + s;
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (!u.hostname.includes(".") && u.hostname !== "localhost") return null;
  let invite = u.searchParams.get("invite") ?? "";
  let path = u.pathname.replace(/\/+$/, "");
  const inv = /^(.*)\/(?:invite|i)\/([\w-]+)$/.exec(path);
  if (inv) {
    path = inv[1];
    invite = inv[2];
  }
  return { url: u.origin + path, invite };
}

/** A link "Add a community" understands (normalizeCommunityUrl reads the code back out). */
export const inviteLink = (url: string, code: string) => `${url}/invite/${code}`;

/** "2 of 10 uses, expires in 6 days", or why the invite no longer works. */
export function inviteState(inv: { expiresAtMs: bigint; maxUses: number; uses: number }, now: number): { live: boolean; text: string } {
  const uses = inv.maxUses ? `${inv.uses} of ${inv.maxUses} uses` : count(inv.uses, "use", "uses");
  const left = Number(inv.expiresAtMs) - now;
  if (inv.expiresAtMs > 0n && left <= 0) return { live: false, text: `Expired, ${uses}` };
  if (inv.maxUses && inv.uses >= inv.maxUses) return { live: false, text: `Used up, ${uses}` };
  const H = 3_600_000;
  const exp = !inv.expiresAtMs
    ? "never expires"
    : left < 24 * H
      ? `expires in ${count(Math.ceil(left / H), "hour", "hours")}`
      : `expires in ${count(Math.ceil(left / (24 * H)), "day", "days")}`;
  return { live: true, text: `${uses}, ${exp}` };
}

export const hostOf = (url: string) => new URL(url).host;

/** #/c/<host>[/<channel>[/<message>[/<thread root>]]] */
export function parseHash(hash: string): { host: string; channelId: string; messageId: string; rootId: string } | null {
  const m = /^#\/c\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/]+))?/.exec(hash);
  const d = (i: number) => decodeURIComponent(m![i] ?? "");
  return m ? { host: d(1), channelId: d(2), messageId: m[2] ? d(3) : "", rootId: m[3] ? d(4) : "" } : null;
}

/** A link to one message; a thread reply also names its root so the thread opens. */
export const messageHash = (url: string, m: { id: string; channelId: string; threadRootId: string }) =>
  `${formatHash(url, m.channelId)}/${encodeURIComponent(m.id)}${m.threadRootId ? `/${encodeURIComponent(m.threadRootId)}` : ""}`;

export const formatHash = (url: string, channelId: string) =>
  `#/c/${encodeURIComponent(hostOf(url))}${channelId ? `/${encodeURIComponent(channelId)}` : ""}`;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Quick switcher ranking: prefix beats substring beats subsequence. -1 = no match. */
export function matchScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 1;
  if (t.startsWith(q)) return 300 - t.length;
  const i = t.indexOf(q);
  if (i >= 0) return 200 - i;
  let j = 0;
  for (const ch of t) if (ch === q[j]) j++;
  return j === q.length ? 100 - t.length : -1;
}

export function moveItem<T>(arr: T[], from: number, to: number): T[] {
  const out = arr.slice();
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
}

/** The name the server will store ("Book Club" becomes "book-club"), or "" when it would be refused. */
export function channelSlug(name: string): string {
  const n = name.trim().replace(/^#/, "").toLowerCase().split(/\s+/).filter(Boolean).join("-");
  return /^[a-z0-9_-]{1,80}$/.test(n) ? n : "";
}

/**
 * Move a channel one step up or down inside its category. Returns the position updates to send.
 * The category keeps the positions it already had, so it stays where it is among the other categories.
 */
export function reorderChannel(chans: { id: string; position: number }[], id: string, dir: -1 | 1): { id: string; position: number }[] {
  const from = chans.findIndex((c) => c.id === id);
  const to = from + dir;
  if (from < 0 || to < 0 || to >= chans.length) return [];
  const slots = chans.map((c) => c.position).sort((a, b) => a - b);
  // Equal positions can't express an order, so spread them out from the lowest.
  const pos = new Set(slots).size === slots.length ? slots : slots.map((_, i) => slots[0] + i);
  return moveItem(chans, from, to)
    .map((c, i) => ({ id: c.id, position: pos[i] }))
    .filter((u) => chans.find((c) => c.id === u.id)!.position !== u.position);
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => [...w][0]!.toUpperCase())
    .join("") || "?";

/** Stable soda-fountain color for a name, used for avatars without images. */
const SWATCHES = ["#3550F0", "#E8344E", "#7B5CE6", "#D9822B", "#0F9D8A", "#2C8BD6", "#C2457A", "#4F7A28"];
export function swatch(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return SWATCHES[h % SWATCHES.length];
}

/** DM label: the other people's names. */
export function channelLabel(ch: Channel, members: Record<string, Member>, meId?: string): string {
  if (!isDM(ch)) return ch.name;
  const others = ch.memberIds.filter((id) => id !== meId).map((id) => members[id]?.displayName ?? "Unknown");
  return others.join(", ") || "Just you";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Sidebar order: channel categories in position order ("Channels" for none), then DMs, newest first. */
export function sidebarSections(c: Community): { title: string; channels: Channel[]; dm: boolean }[] {
  const chans = Object.values(c.channels)
    .filter((ch) => !isDM(ch))
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  const sections: { title: string; channels: Channel[]; dm: boolean }[] = [];
  for (const ch of chans) {
    const title = ch.category || "Channels";
    let s = sections.find((x) => x.title === title);
    if (!s) sections.push((s = { title, channels: [], dm: false }));
    s.channels.push(ch);
  }
  const dms = Object.values(c.channels)
    .filter(isDM)
    .sort((a, b) => Number(b.lastMessageSeq - a.lastMessageSeq));
  sections.push({ title: "Direct messages", channels: dms, dm: true });
  return sections;
}

/** Where to land in a community with no remembered channel: #general, else the first unread, else the first. */
export function landingChannel(c: Community): string {
  const list = sidebarSections(c).flatMap((s) => s.channels);
  const pick =
    list.find((ch) => !isDM(ch) && ch.name === "general") ??
    list.find((ch) => (c.reads[ch.id]?.unreadCount ?? 0) > 0) ??
    list[0];
  return pick?.id ?? "";
}

// What `me` may do to `target` from the profile card. Mirrors the server: moderators and up act
// only on lower ranks, kick and ban only humans, and admins set roles below their own.
export function modActions(me: Member | undefined, target: Member) {
  const above = !!me && me.id !== target.id && me.role >= MemberRole.MODERATOR && me.role > target.role;
  const roles = [MemberRole.MEMBER, MemberRole.MODERATOR, MemberRole.ADMIN];
  return {
    remove: above && target.kind === MemberKind.HUMAN,
    roles: above && me!.role >= MemberRole.ADMIN ? roles.filter((r) => r < me!.role) : [],
  };
}

/** Private channel: you can always leave; removing someone else takes moderator and a higher rank (bots too). */
export const canRemoveFromChannel = (me: Member | undefined, target: Member) =>
  !!me && (me.id === target.id || (me.role >= MemberRole.MODERATOR && me.role > target.role));

const ROLE_GROUP: [MemberRole, string][] = [
  [MemberRole.OWNER, "Owners"],
  [MemberRole.ADMIN, "Admins"],
  [MemberRole.MODERATOR, "Moderators"],
];

/** Online members by role, then everyone online, then offline. */
export function memberGroups(members: Member[]): { title: string; members: Member[] }[] {
  const sorted = [...members].sort((a, b) => (a.displayName || a.username).localeCompare(b.displayName || b.username));
  const off = (m: Member) => m.presence === Presence.OFFLINE || m.presence === Presence.UNSPECIFIED;
  const groups = ROLE_GROUP.map(([r, title]) => ({ title, members: sorted.filter((m) => !off(m) && m.role === r) }));
  groups.push({ title: "Online", members: sorted.filter((m) => !off(m) && m.role < MemberRole.MODERATOR) });
  groups.push({ title: "Offline", members: sorted.filter(off) });
  return groups.filter((g) => g.members.length);
}


/** "1 reply", "3 replies", "1,204 members". */
export const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
