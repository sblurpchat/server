// Pure decision logic. No DOM, no network. Everything here is covered by logic.test.ts.
import { create } from "@bufbuild/protobuf";
import {
  ChannelKind,
  ChannelMode,
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
  type Role,
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
  bannerUrl?: string;
  /** Delete messages after this many days; 0 or unset keeps them forever (1072). */
  retentionDays?: number;
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
  /** My sidebar: in OPT_IN mode only the channels I joined. */
  channels: Record<string, Channel>;
  /** A visible channel I have not joined, open read-only from Browse channels. */
  peek?: Channel;
  roles: Role[];
  mode: ChannelMode;
  reads: Record<string, ReadState>;
  seq: bigint;
  /** Message lists keyed by channel id, or `t:<rootId>` for a thread. */
  lists: Record<string, MsgList>;
  /** Typing expiry (ms) keyed by list key, then member id. */
  typing: Record<string, Record<string, number>>;
  /** client_ids of optimistic messages that failed to send. */
  failed: Record<string, true>;
  /** Bumped by a plugins_changed event, so the admin plugin list reloads (1090). */
  pluginsRev?: number;
  /** Members I blocked (1118): their messages show collapsed. */
  blocked: string[];
}

export const emptyCommunity = (url: string, info?: Info): Community => ({
  url,
  info,
  status: "connecting",
  members: {},
  channels: {},
  roles: [],
  mode: ChannelMode.ROLES,
  reads: {},
  seq: 0n,
  lists: {},
  typing: {},
  failed: {},
  blocked: [],
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
    roles: s.roles,
    mode: s.channelMode || ChannelMode.ROLES,
    reads: Object.fromEntries(s.readStates.map((r) => [r.channelId, r])),
    seq: s.seq,
    blocked: s.blockedMemberIds,
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

const DAY_MS = 86_400_000;

/** True if the community's retention has deleted (or is about to delete) m. Unsent messages never expire. */
export const isExpired = (m: Message, days = 0, now = Date.now()) => days > 0 && m.seq > 0n && Number(m.createdAtMs) < now - days * DAY_MS;

/** The messages to show: the server prunes expired ones without an event per message, so the client drops them itself. */
export const retained = (items: Message[], days = 0, now = Date.now()) => (days > 0 ? items.filter((m) => !isExpired(m, days, now)) : items);

/** A list being left keeps only its newest messages, so coming back mounts fast. A window from a search jump is dropped
 *  (undefined) because it is not the newest; a list mid-load is kept whole so the page in flight still lines up. */
export function trimList(l: MsgList, keep = 100): MsgList | undefined {
  if (l.loading || l.items.length <= keep) return l;
  return l.hasMoreAfter ? undefined : { ...l, items: l.items.slice(-keep), hasMore: true, focusId: undefined };
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
      if (c.peek?.id === k.value.id) next.peek = undefined;
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
    case "roleUpdated":
      next.roles = [...c.roles.filter((r) => r.id !== k.value.id), k.value].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
      return next;
    case "roleDeleted": {
      const gone = k.value;
      const strip = <T extends { roleIds: string[] }>(x: T): T => (x.roleIds.includes(gone) ? { ...x, roleIds: x.roleIds.filter((r) => r !== gone) } : x);
      next.roles = c.roles.filter((r) => r.id !== gone);
      next.members = Object.fromEntries(Object.entries(c.members).map(([id, m]) => [id, strip(m)]));
      next.channels = Object.fromEntries(Object.entries(c.channels).map(([id, ch]) => [id, strip(ch)]));
      if (c.me) next.me = strip(c.me);
      return next;
    }
    case "channelModeChanged":
      next.mode = k.value || c.mode;
      return next;
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
    case "presence":
    case "presenceBatch": {
      const changes = k.case === "presence" ? [k.value] : k.value.changes;
      next.members = { ...c.members };
      for (const { memberId: id, presence } of changes) {
        if (next.members[id]) next.members[id] = { ...next.members[id], presence };
        // c.me is its own copy of your member, so it needs the update too.
        if (next.me?.id === id) next.me = { ...next.me, presence };
      }
      return next;
    }
    case "memberBlocked":
      if (!c.blocked.includes(k.value)) next.blocked = [...c.blocked, k.value];
      return next;
    case "memberUnblocked":
      next.blocked = c.blocked.filter((id) => id !== k.value);
      return next;
    case "pluginsChanged":
      next.pluginsRev = (c.pluginsRev ?? 0) + 1;
      return next;
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

export const timeLabel = (ms: number, h24 = false) =>
  new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hourCycle: h24 ? "h23" : "h12" });

/** A member's roles, in role order. */
export const memberRoles = (m: Member | undefined, roles: Role[]) => (m ? roles.filter((r) => m.roleIds.includes(r.id)) : []);

const fitted = new Map<string, string>();
/** Name color from a member's first colored role, made readable on every surface a message sits on. "" when none. */
export function nameColor(m: Member | undefined, roles: Role[], surfaces: string[]) {
  const color = memberRoles(m, roles).find((r) => r.color)?.color;
  if (!color || !surfaces.length) return "";
  const k = `${color} ${surfaces.join()}`;
  if (!fitted.has(k)) fitted.set(k, fitContrast(color, surfaces, 4.5));
  return fitted.get(k)!;
}

/** A server message as a sentence: capitalized, ending in a full stop unless it has its own. */
export function sentence(s: string): string {
  const t = s.trim();
  return t ? `${t[0].toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? "" : "."}` : t;
}

/** Browse channels: matching channels by name or topic, joined state attached; ones you can join first, then by name. */
export function browseList(all: Channel[], joined: Record<string, Channel>, q: string) {
  const s = q.trim().toLowerCase().replace(/^#/, "");
  return all
    .filter((ch) => !s || ch.name.includes(s) || ch.topic.toLowerCase().includes(s))
    .map((ch) => ({ ch, joined: !!joined[ch.id] }))
    .sort((a, b) => Number(a.joined) - Number(b.joined) || a.ch.name.localeCompare(b.ch.name));
}

/** The line under a Browse channels row: member count, then topic. Old servers send no count (0). */
export function browseDetail(ch: Channel): string {
  const n = ch.memberCount;
  return [n ? `${n} ${n === 1 ? "member" : "members"}` : "", ch.topic].filter(Boolean).join(" · ");
}

// ---------------------------------------------------------------------------
// Appearance: synced to the account as an opaque blob, parsed defensively because localStorage and the blob are user-editable.
// ---------------------------------------------------------------------------

export const THEMES = ["system", "light", "dark", "midnight", "contrast", "cvd", "cola", "mint", "cocoa", "fjord", "sand", "grape", "black", "custom"] as const;
export type Theme = (typeof THEMES)[number];
const DENSITIES = ["cozy", "compact", "irc"] as const;
/** "default" is the theme's own font (Schibsted Grotesk, or Iosevka in Cocoa). */
export const FONTS = ["default", "schibsted", "system", "inter", "serif", "pt-mono", "iosevka"] as const;
export interface Appearance {
  theme: Theme;
  /** "" keeps the theme's own accent. */
  accent: string;
  density: (typeof DENSITIES)[number];
  sidebar: "cozy" | "compact";
  /** Message text size in px; everything else scales with it. */
  fontSize: number;
  clock: "12" | "24";
  motion: "system" | "reduce" | "full";
  /** The custom theme as a share string (see themeString), or "". */
  custom: string;
  font: (typeof FONTS)[number];
}
export const APPEARANCE: Appearance = { theme: "system", accent: "", density: "cozy", sidebar: "cozy", fontSize: 15, clock: "12", motion: "system", custom: "", font: "default" };

export function parseAppearance(v: unknown): Appearance {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const one = <T>(x: unknown, ok: readonly T[], d: T) => (ok.includes(x as T) ? (x as T) : d);
  const custom = typeof o.custom === "string" ? parseThemeString(o.custom) : null;
  const size = typeof o.fontSize === "number" && Number.isFinite(o.fontSize) ? Math.round(Math.min(20, Math.max(12, o.fontSize))) : APPEARANCE.fontSize;
  return {
    theme: o.theme === "custom" && !custom ? APPEARANCE.theme : one(o.theme, THEMES, APPEARANCE.theme),
    accent: typeof o.accent === "string" && /^#[0-9a-f]{6}$/i.test(o.accent) ? o.accent.toLowerCase() : "",
    density: one(o.density, DENSITIES, APPEARANCE.density),
    sidebar: one(o.sidebar, ["cozy", "compact"] as const, APPEARANCE.sidebar),
    fontSize: size,
    clock: one(o.clock, ["12", "24"] as const, APPEARANCE.clock),
    motion: one(o.motion, ["system", "reduce", "full"] as const, APPEARANCE.motion),
    custom: custom ? themeString(custom) : "",
    font: one(o.font, FONTS, APPEARANCE.font),
  };
}

/** Which copy of the appearance wins at startup, by edit time in ms (0 = never edited here). */
export function appearanceSync(localAt: number, serverAt: number | null): "pull" | "push" | "keep" {
  if (serverAt === null) return localAt ? "push" : "keep";
  return serverAt > localAt ? "pull" : serverAt < localAt ? "push" : "keep";
}

/**
 * Merges this browser's community list with the account's (1225). `local` is null when this
 * browser never chose any (it shows the defaults); `localAt` is 0 when it chose some but never
 * synced, so a first sign-in keeps both: server order, then local extras. After that the newer
 * list wins whole, so removing a community on one device removes it everywhere.
 */
export function communitiesSync(
  local: string[] | null,
  localAt: number,
  server: { urls: string[]; updatedAt: number } | null,
  now: number,
): { order: string[] | null; at: number; push: boolean } {
  if (!server) return local ? { order: local, at: localAt || now, push: true } : { order: null, at: 0, push: false };
  const pull = { order: server.urls, at: server.updatedAt, push: false };
  if (!local) return pull;
  if (!localAt) return { order: [...server.urls, ...local.filter((u) => !server.urls.includes(u))], at: now, push: true };
  if (server.updatedAt > localAt) return pull;
  return { order: local, at: localAt, push: server.updatedAt < localAt };
}

/** "#rrggbb" or "rgb(r, g, b)" (what getComputedStyle returns) to [r, g, b]. */
export function parseColor(c: string): [number, number, number] {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c.trim());
  if (hex) return [1, 2, 3].map((i) => parseInt(hex[i], 16)) as [number, number, number];
  const n = c.match(/[\d.]+/g);
  if (!n || n.length < 3) throw new Error(`not a color: ${c}`);
  return [+n[0], +n[1], +n[2]];
}
const luminance = (c: string) => {
  const [r, g, b] = parseColor(c).map((v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** WCAG 2 contrast ratio, 1 to 21. */
export function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
const hex = (rgb: number[]) => "#" + rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
/** Darkens or lightens fg, away from the first background (or the other way if that fails), until it reaches min against every background. */
export function fitContrast(fg: string, bgs: string[], min: number) {
  const away = luminance(bgs[0]) > 0.18 ? 0 : 255;
  const rgb = parseColor(fg);
  for (const to of [away, 255 - away]) {
    for (let t = 0; t <= 1.001; t += 0.04) {
      const c = hex(rgb.map((v) => v + (to - v) * t));
      if (bgs.every((b) => contrast(c, b) >= min)) return c;
    }
  }
  return away ? "#ffffff" : "#000000";
}
export const toHex = (c: string) => hex(parseColor(c));
/** color-mix(in srgb, a w, b): w of a, the rest b. */
const mix = (a: string, b: string, w: number) => {
  const y = parseColor(b);
  return hex(parseColor(a).map((v, i) => v * w + y[i] * (1 - w)));
};

/** The base colors of a custom theme, in share-string order. Like Slack's, a pasted string is just these. */
export const CUSTOM_COLORS = ["Sidebar", "Sidebar text", "Messages", "Message text", "Accent", "Mentions and badges"];
export const themeString = (colors: string[]) => colors.join(",");
/** "#171925,#e7e9f2,..." (commas or spaces, # optional) to six lowercase hex colors, or null. */
export function parseThemeString(s: string): string[] | null {
  const c = s.split(/[\s,]+/).filter(Boolean).map((x) => "#" + x.replace(/^#/, "").toLowerCase());
  return c.length === CUSTOM_COLORS.length && c.every((x) => /^#[0-9a-f]{6}$/.test(x)) ? c : null;
}
/**
 * Every token of a custom theme from its six base colors. Text colors are moved until they pass
 * WCAG AA on every surface they sit on; `fixed` names the base colors the person chose that moved.
 * Tokens not set here (presence, tooltips) come from the light or dark side of :root.
 */
export function customTheme(colors: string[]) {
  const [frost, ink0, paper, text0, accent, badge0] = colors;
  const dark = luminance(paper) <= 0.18;
  const selected = mix(accent, frost, dark ? 0.3 : 0.2);
  const hover = mix(ink0, frost, 0.07);
  const msgHover = mix(text0, paper, 0.04);
  const mentionBg = mix(badge0, paper, dark ? 0.18 : 0.1);
  const codeBg = mix(frost, paper, 0.5);
  const text = fitContrast(text0, [paper, msgHover, mentionBg, codeBg], 4.5);
  const ink = fitContrast(ink0, [frost, selected, hover], 4.5);
  const cherry = fitContrast(badge0, [paper, frost, codeBg], 4.5);
  const tokens: Record<string, string> = {
    "--frost": frost,
    "--ink": ink,
    "--paper": paper,
    "--text": text,
    "--rail": dark ? mix(frost, "#000000", 0.6) : ink,
    "--raspberry": fitContrast(accent, [paper, frost, codeBg], 4.5),
    "--accent-fill": fitContrast(accent, ["#ffffff"], 4.5),
    "--on-accent": "#ffffff",
    "--badge": fitContrast(badge0, ["#ffffff"], 4.5),
    "--cherry": cherry,
    "--cherry-text": cherry,
    "--graphite": fitContrast(mix(text, paper, 0.6), [paper, frost, selected, codeBg], 4.5),
    "--line": mix(text, paper, 0.12),
    "--hover": hover,
    "--selected": selected,
    "--msg-hover": msgHover,
    "--mention-bg": mentionBg,
    "--raised": mix("#ffffff", paper, dark ? 0.04 : 0.5),
    "--code-bg": codeBg,
  };
  const fixed = [ink !== ink0 && CUSTOM_COLORS[1], text !== text0 && CUSTOM_COLORS[3]].filter((x): x is string => !!x);
  return { tokens, dark, fixed };
}

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

/** List step for a picker's key: ArrowDown/Ctrl+N is 1, ArrowUp/Ctrl+P is -1, anything else 0. */
export function listStep(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): number {
  if (e.key === "ArrowDown") return 1;
  if (e.key === "ArrowUp") return -1;
  if (!e.ctrlKey || e.metaKey || e.altKey) return 0;
  return e.key === "n" ? 1 : e.key === "p" ? -1 : 0;
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

/**
 * Full-jitter backoff: a random wait in [0, 2s doubling to 30s). After a server restart every
 * client loses its stream at once, so the first retry is spread over 2s, not bunched together.
 * `rand` is in [0, 1).
 */
export const backoffMs = (attempt: number, rand: number) => Math.round(rand * Math.min(30_000, 2000 * 2 ** attempt));

/** A stream must stay up this long before backoff starts over, so a server that accepts and then drops does not get retried at full speed. */
export const STABLE_MS = 30_000;

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

/** Add a community's text for "#/join?url=…&invite=…", where a server's /invite/CODE sends a browser. */
export function joinHashInput(hash: string): string | null {
  if (!hash.startsWith("#/join?")) return null;
  const q = new URLSearchParams(hash.slice("#/join?".length));
  const n = normalizeCommunityUrl(q.get("url") ?? "");
  if (!n) return null;
  const invite = q.get("invite") || n.invite;
  return invite ? inviteLink(n.url, invite) : n.url;
}

/** Image types a server takes for a banner or channel header (it refuses the rest). */
export const BANNER_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"];
const MAX_BANNER = 8 << 20;

/** Why a picked file cannot be a banner or header image, or "" if it can. */
export function bannerFileError(f: { type: string; size: number }): string {
  if (!BANNER_TYPES.includes(f.type)) return "Pick a PNG, JPEG, GIF, WebP or AVIF image.";
  if (f.size > MAX_BANNER) return "That image is over 8 MB. Pick a smaller one.";
  return "";
}

/** The centered square of a w x h image, and its size once shrunk to at most max px (1044). */
export function squareCrop(w: number, h: number, max: number) {
  const side = Math.min(w, h);
  return { sx: Math.floor((w - side) / 2), sy: Math.floor((h - side) / 2), side, out: Math.min(side, max) };
}

/** A CSS url() for an inline style; quotes and backslashes in the URL cannot end the string. */
export const cssUrl = (u: string) => (u ? `url("${u.replace(/["\\\n]/g, (ch) => `\\${ch === "\n" ? "a " : ch}`)}")` : "");

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

/** "Banned yesterday by Ana Ruiz". The banner may have left since; then only the day. */
export function banDetail(atMs: number, by: Member | undefined, now: number): string {
  const d = dayLabel(atMs, now);
  const when = d === "Today" || d === "Yesterday" ? d.toLowerCase() : `on ${d}`;
  return `Banned ${when}${by ? ` by ${by.displayName || by.username}` : ""}`;
}

/** Where a reported message lives (1119), and whether this moderator can open it. */
export function reportPlace(r: { dm: boolean; message?: { channelId: string } }, channels: Record<string, Channel>): { label: string; open: boolean } {
  if (r.dm) return { label: "Direct message", open: false };
  const ch = channels[r.message?.channelId ?? ""];
  return ch ? { label: `#${ch.name}`, open: true } : { label: "A channel you cannot see", open: false };
}

export function reportDetail(atMs: number, by: Member | undefined, now: number): string {
  const d = dayLabel(atMs, now);
  const when = d === "Today" || d === "Yesterday" ? d.toLowerCase() : `on ${d}`;
  return `Reported ${when} by ${by ? by.displayName || by.username : "a former member"}`;
}

export const hostOf = (url: string) => new URL(url).host;

/** #/c/<host>[/<channel>[/<message>[/<thread root>]]][?<pane>] */
export function parseHash(hash: string): { host: string; channelId: string; messageId: string; rootId: string } | null {
  const m = /^#\/c\/([^/?]+)(?:\/([^/?]+))?(?:\/([^/?]+))?(?:\/([^/?]+))?/.exec(hash);
  const d = (i: number) => decodeURIComponent(m![i] ?? "");
  try {
    return m ? { host: d(1), channelId: d(2), messageId: m[2] ? d(3) : "", rootId: m[3] ? d(4) : "" } : null;
  } catch {
    return null; // a bad %-escape, maybe from a link in someone's message
  }
}

/** A link to one message; a thread reply also names its root so the thread opens. */
export const messageHash = (url: string, m: { id: string; channelId: string; threadRootId: string }) =>
  `${formatHash(url, m.channelId)}/${encodeURIComponent(m.id)}${m.threadRootId ? `/${encodeURIComponent(m.threadRootId)}` : ""}`;

export type Permalink = { host: string; channelId: string; messageId: string; rootId: string };

/** A message link in this app at `app` (origin and path), as Copy link makes it (1109).
 *  A channel link with ?thread=<root> and no message id points at the root. */
export function parsePermalink(href: string, app: string): Permalink | null {
  let u: URL, a: URL;
  try {
    u = new URL(href);
    a = new URL(app);
  } catch {
    return null;
  }
  if (u.origin !== a.origin || u.pathname !== a.pathname) return null;
  const r = parseHash(u.hash);
  if (!r?.channelId) return null;
  if (r.messageId) return r;
  const p = parsePane(u.hash);
  return p?.t === "thread" ? { ...r, messageId: p.rootId } : null;
}

/** The message links in a message's text to preview: each message once, at most three. */
export function permalinks(text: string, app: string): Permalink[] {
  const out: Permalink[] = [];
  for (const [href] of text.matchAll(/https?:\/\/[^\s<]*[^\s<.,:;"')\]!?]/g)) {
    const l = parsePermalink(href, app);
    if (l && !out.some((x) => x.host === l.host && x.messageId === l.messageId)) out.push(l);
    if (out.length === 3) break;
  }
  return out;
}

export const formatHash = (url: string, channelId: string) =>
  `#/c/${encodeURIComponent(hostOf(url))}${channelId ? `/${encodeURIComponent(channelId)}` : ""}`;

/** The right-hand pane, kept after the route so a reload reopens it: ?thread=<root>, ?members, ?search=<q>. */
export type Pane = null | { t: "thread"; rootId: string } | { t: "members" } | { t: "search"; q: string };

export function paneQuery(p: Pane): string {
  if (!p) return "";
  if (p.t === "members") return "?members";
  return `?${new URLSearchParams(p.t === "thread" ? { thread: p.rootId } : { search: p.q })}`;
}

export function parsePane(hash: string): Pane {
  const i = hash.indexOf("?");
  if (i < 0) return null;
  const q = new URLSearchParams(hash.slice(i + 1));
  const thread = q.get("thread");
  const search = q.get("search");
  if (thread) return { t: "thread", rootId: thread };
  if (search) return { t: "search", q: search };
  return q.has("members") ? { t: "members" } : null;
}

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
let swatchFills: string[] | null = null;
export function swatch(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  swatchFills ??= SWATCHES.map(onWhite);
  return swatchFills[h % SWATCHES.length];
}
/** A fill dark enough for white initials or labels on it (4.5:1). */
export const onWhite = (c: string) => fitContrast(c, ["#ffffff"], 4.5);

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

// ---------------------------------------------------------------------------
// Resizable panels: the sidebar grows to the right, the side pane to the left
// ---------------------------------------------------------------------------

export interface Panel {
  def: number;
  min: number;
  max: number;
  dir: 1 | -1; // +1 when moving the handle right makes the panel wider
}
export const PANELS = {
  side: { def: 260, min: 200, max: 420, dir: 1 },
  pane: { def: 340, min: 280, max: 640, dir: -1 },
} satisfies Record<string, Panel>;

/** A press on a modal <dialog> itself is on its backdrop only outside its box: its padding is the dialog too. */
export const onBackdrop = (r: { left: number; top: number; right: number; bottom: number }, x: number, y: number) =>
  x < r.left || x > r.right || y < r.top || y > r.bottom;

export const clampWidth = (p: Panel, w: number) => Math.round(Math.min(p.max, Math.max(p.min, w)));

// New width for a key on the separator, or null when the key is not ours.
export function keyWidth(p: Panel, w: number, key: string, big = false): number | null {
  const step = big ? 64 : 16;
  if (key === "ArrowRight") return clampWidth(p, w + step * p.dir);
  if (key === "ArrowLeft") return clampWidth(p, w - step * p.dir);
  if (key === "Home") return p.min;
  if (key === "End") return p.max;
  if (key === "Enter") return p.def;
  return null;
}

// MarkRead is a server write, so the client sends it at most once per READ_EVERY_MS per channel
// (1040). Returns how long to wait before sending: 0 sends now.
export const READ_EVERY_MS = 3000;
export const readDelay = (lastSentMs: number | undefined, nowMs: number, everyMs = READ_EVERY_MS) =>
  lastSentMs === undefined ? 0 : Math.max(0, lastSentMs + everyMs - nowMs);

// A paste outside any text field (1077): which composer takes the files. The thread pane wins only
// when it was the last place touched and a thread is open there; otherwise the main channel.
export const pasteTarget = (editable: boolean, hasFiles: boolean, last: "pane" | "channel" | null, threadOpen: boolean) =>
  editable || !hasFiles ? null : last === "pane" && threadOpen ? "pane" : "channel";

// ---------------------------------------------------------------------------
// Plugins (1090)
// ---------------------------------------------------------------------------

export const MAX_PLUGIN_BYTES = 256 * 1024;

/** A plugin name from a file name: "Dice Roller.js" becomes "dice-roller". The server re-checks it. */
export function pluginNameFromFile(file: string): string {
  return file
    .replace(/\.js$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

/** Why the install form cannot be sent yet, or "" when it can. */
export function pluginFormError(name: string, source: string): string {
  if (!/^[a-z0-9_.-]{2,32}$/.test(name)) return "Names use 2 to 32 of a-z, 0-9, _, . and -.";
  if (!source.trim()) return "Choose a .js file or paste the source.";
  if (new TextEncoder().encode(source).length > MAX_PLUGIN_BYTES) return "The source is over 256 KB.";
  return "";
}

/** The status line for a plugin row. */
export function pluginStatus(p: { enabled: boolean; running: boolean; error: string }): { label: string; tone: "ok" | "off" | "bad" } {
  if (!p.enabled) return { label: "Off", tone: "off" };
  if (!p.running) return { label: "Did not load", tone: "bad" };
  return p.error ? { label: "Running, with an error", tone: "bad" } : { label: "Running", tone: "ok" };
}

/** Bots created with a token, not by a plugin (a plugin's bot has the plugin's name). */
export function tokenBots<B extends { username: string }>(bots: B[], plugins: { name: string }[]): B[] {
  const names = new Set(plugins.map((p) => p.name));
  return bots.filter((b) => !names.has(b.username));
}

/** Whether a message may have link previews worth asking its server for (1110). */
export const mayPreview = (text: string) => /https?:\/\//i.test(text);

/** The link previews to show: none for links into this app at `app` (1109 previews those), at most five. */
export function shownPreviews<T extends { url: string }>(ps: T[], app: string): T[] {
  const a = new URL(app);
  return ps
    .filter((p) => {
      try {
        const u = new URL(p.url);
        return u.origin !== a.origin || u.pathname !== a.pathname;
      } catch {
        return false;
      }
    })
    .slice(0, 5);
}

/** Leaving Community settings (1183): null lets it go, else the id of the unsaved form to show. `to` is the next tab, null to close. */
export function unsavedBlock(dirty: readonly string[], from: string, to: string | null): string | null {
  return from === to ? null : (dirty[0] ?? null);
}

// The hover toolbar sits 16px above its message; the scroller's top 20px fade out under a mask.
// A message closer to the top than that gets its toolbar inside instead of clipped (1193).
export const toolsInside = (msgTop: number, scrollerTop: number) => msgTop - scrollerTop < 16 + 20;

// ---------------------------------------------------------------------------
// Keyboard and screen readers (1188)
// ---------------------------------------------------------------------------

/** Menu keys: Down and Up wrap, Home and End jump. The new index, or -1 when the key is not a move. */
export function listMove(i: number, n: number, key: string): number {
  if (!n) return -1;
  if (key === "ArrowDown") return (i + 1) % n;
  if (key === "ArrowUp") return i < 0 ? n - 1 : (i - 1 + n) % n;
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  return -1;
}

/** Arrow keys in a grid laid out by the browser (rows can be short, as at the end of an emoji section).
 * Left and right step through the order; up and down go to the nearest row that way, then the closest column.
 * The new index, or -1 when the key is not a move. */
export function gridMove(cells: { x: number; y: number }[], i: number, key: string): number {
  const n = cells.length;
  if (key === "ArrowLeft") return Math.max(0, i - 1);
  if (key === "ArrowRight") return Math.min(n - 1, i + 1);
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  if (key !== "ArrowDown" && key !== "ArrowUp") return -1;
  const at = cells[i];
  const sign = key === "ArrowDown" ? 1 : -1;
  let best = i;
  let dyBest = Infinity;
  let dxBest = Infinity;
  cells.forEach((c, j) => {
    const dy = (c.y - at.y) * sign;
    const dx = Math.abs(c.x - at.x);
    if (dy > 0 && (dy < dyBest || (dy === dyBest && dx < dxBest))) [best, dyBest, dxBest] = [j, dy, dx];
  });
  return best;
}

/** What a screen reader says when a message arrives in an open list: the newest one if someone
 * else sent it after `since`. History pages and your own messages stay quiet. */
export function arrivalText(items: Message[], since: number, meId: string | undefined, members: Record<string, Member>): string {
  const m = items.at(-1);
  if (!m || m.deleted || m.authorId === meId || Number(m.createdAtMs) <= since) return "";
  const who = members[m.authorId];
  return `${who?.displayName || who?.username || "Someone"}: ${plainText(m.text, members) || count(m.attachments.length, "attachment", "attachments")}`;
}

/** How long a load may take before its skeleton shows, so a fast load never flashes one. */
export const SKELETON_DELAY_MS = 200;

/** What the top of a message list shows: a skeleton before the first page, an error,
 * placeholder rows while older pages remain, or the start of the channel. */
export function listPhase(l: MsgList | undefined): "skeleton" | "error" | "more" | "start" {
  if (l?.error) return "error";
  if (!l || (l.loading && !l.items.length)) return "skeleton";
  return l.hasMore ? "more" : "start";
}

/** Shapes for n placeholder rows, widths in percent. Fixed, so a skeleton never jitters between renders.
 * In chat, every third row continues the one above: no avatar or name, like a grouped message. */
export function skeletonRows(n: number): { head: boolean; name: number; lines: number[] }[] {
  return Array.from({ length: n }, (_, i) => {
    const r = (i * 37 + 11) % 41; // 0-40, scattered
    return { head: i % 3 !== 2, name: 14 + (r % 4) * 5, lines: r % 2 ? [48 + r] : [70 + (r % 25), 24 + r] };
  });
}

/** Everyone I blocked, in every community I am in, for the Settings list (1118). Left members show as "Former member". */
export function blockedRows(order: string[], cs: Record<string, Community>): { url: string; id: string; name: string; community: string }[] {
  return order.flatMap((url) => {
    const c = cs[url];
    return (c?.blocked ?? []).map((id) => {
      const m = c!.members[id];
      return { url, id, name: m ? m.displayName || m.username : "Former member", community: c!.info?.name ?? hostOf(url) };
    });
  });
}
