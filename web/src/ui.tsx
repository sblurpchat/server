// Shared UI primitives: icons, avatars, dialogs, popovers, the emoji picker and the markdown renderer.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MemberRole, Presence, type Member } from "./gen/sblurp/v1/sblurp_pb";
import { PANELS, clampWidth, initials, keyWidth, onBackdrop, onWhite, parseMarkdown, swatch, type Inline } from "./logic";
import { Img, Shortcodes, useEmojiSet, useMore } from "./CustomEmoji";
import { bumpRecent, pickerSections, type PickItem } from "./emoji";
import { absUrl, set, useApp } from "./store";

// ---------------------------------------------------------------------------
// Icons: Lucide on a 24px grid, drawn at a 1.75 stroke
// ---------------------------------------------------------------------------

// Lucide (ISC), each icon flattened to one path so <Icon> stays a single element.
const ICONS = {
  hash: "M4 9L20 9M4 15L20 15M10 3L8 21M16 3L14 21",
  lock: "M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-7a2 2 0 0 1 2 -2zM7 11V7a5 5 0 0 1 10 0v4",
  plus: "M5 12h14M12 5v14",
  search: "M3 11a8 8 0 1 0 16 0a8 8 0 1 0 -16 0M21 21l-4.3-4.3",
  people: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M5 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  thread: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  smile: "M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0M8 14s1.5 2 4 2 4-2 4-2M9 9L9.01 9M15 9L15.01 9",
  edit: "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497zM15 5l4 4",
  more: "M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0M18 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0M4 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
  x: "M18 6 6 18M6 6l12 12",
  clip: "M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48",
  send: "M3.714 3.048a.498.498 0 0 0-.683.627l2.843 7.627a2 2 0 0 1 0 1.396l-2.842 7.627a.498.498 0 0 0 .682.627l18-8.5a.5.5 0 0 0 0-.904zM6 12h16",
  gear: "M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0", // Lucide settings
  sliders: "M21 4L14 4M10 4L3 4M21 12L12 12M8 12L3 12M21 20L16 20M12 20L3 20M14 2L14 6M8 10L8 14M16 18L16 22",
  chevron: "M6 9l6 6 6-6",
  menu: "M4 12L20 12M4 6L20 6M4 18L20 18",
  trash: "M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2M10 11L10 17M14 11L14 17",
  file: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7ZM14 2v4a2 2 0 0 0 2 2h4",
  back: "M12 19l-7-7 7-7M19 12H5",
  copy: "M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2zM4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2",
  link: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
  info: "M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0M12 16v-4M12 8h.01",
  leave: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17L21 12L16 7M21 12L9 12",
  invite: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M5 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0M19 8L19 14M22 11L16 11",
  down: "M12 5v14M19 12l-7 7-7-7",
  check: "M20 6 9 17l-5-5",
  maximize: "M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3", // Lucide maximize
  external: "M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
  image: "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2H5a2 2 0 0 1 -2 -2V5a2 2 0 0 1 2 -2zM7 9a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M21 15l-3.086-3.086a2 2 0 0 0-2.828 0L6 21",
  upload: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  folder: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
  puzzle:
    "M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z",
  retry: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5",
  clock: "M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0M12 6v6l4 2",
  leaf: "M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10ZM2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12",
  coffee: "M10 2v2M14 2v2M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1M6 2v2",
  lightbulb: "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5M9 18h6M10 22h4",
  heart: "M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5",
  smilePlus: "M22 11v1a10 10 0 1 1-9-10M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01M16 5h6M19 2v6", // Lucide smile-plus
};
export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Avatars
// ---------------------------------------------------------------------------

export function Avatar({ m, size = 36, presence = false }: { m?: Member; size?: number; presence?: boolean }) {
  const name = m?.displayName || m?.username || "?";
  const p = m?.presence;
  return (
    <span className="avatar" aria-hidden="true" style={{ width: size, height: size, ["--r" as string]: `${Math.round(size * 0.22)}px` }}>
      {m?.avatarUrl ? (
        <img src={m.avatarUrl} alt="" width={size} height={size} />
      ) : (
        <span className="avatar-initials" data-i={initials(name)} style={{ background: swatch(m?.id ?? name), fontSize: Math.round(size * 0.4) }} />
      )}
      {presence && (
        <span
          className={`presence ${p === Presence.ONLINE ? "on" : p === Presence.AWAY ? "away" : "off"}`}
          title={p === Presence.ONLINE ? "Online" : p === Presence.AWAY ? "Away" : "Offline"}
        />
      )}
    </span>
  );
}

export function CommunityIcon({ name, icon, accent, size = 48 }: { name: string; icon?: string; accent?: string; size?: number }) {
  return (
    <span className="cicon" aria-hidden="true" data-i={icon ? undefined : initials(name)} style={{ width: size, height: size, background: accent ? onWhite(accent) : "var(--accent-fill)", fontSize: Math.round(size * 0.34) }}>
      {icon && <img src={icon} alt="" />}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Dialogs (native <dialog>: focus trap, Escape and backdrop come for free)
// ---------------------------------------------------------------------------

export function Dialog({
  label,
  children,
  className = "",
  onClose = () => set({ modal: null }),
  guard,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  onClose?: () => void;
  /** Returns true to keep the dialog open on Escape or a backdrop click. */
  guard?: () => boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Children mount only once the dialog is open: a closed dialog cannot take focus, so
  // autoFocus would fail and showModal would focus the first button instead. No paint between.
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const d = ref.current!;
    d.showModal();
    setOpen(true);
    return () => d.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={label}
      className={`dialog ${className}`}
      onClose={onClose}
      // Escape's keydown too: Chrome ignores a cancelled cancel event when Escape is pressed twice.
      onKeyDown={(e) => e.key === "Escape" && guard?.() && e.preventDefault()}
      onCancel={(e) => guard?.() && e.preventDefault()}
      onMouseDown={(e) => e.target === ref.current && onBackdrop(ref.current.getBoundingClientRect(), e.clientX, e.clientY) && !guard?.() && ref.current.close()}
    >
      {open && children}
    </dialog>
  );
}

// ---------------------------------------------------------------------------
// Popovers (native popover="auto": light dismiss and Escape for free)
// ---------------------------------------------------------------------------

/** Position a top-layer element next to an anchor, kept inside the viewport. */
export function place(el: HTMLElement, a: DOMRect, side: "below" | "above" | "right" | "left" = "below", gap = 6) {
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let x = side === "right" ? a.right + gap : side === "left" ? a.left - w - gap : a.right - w;
  let y = side === "below" ? a.bottom + gap : side === "above" ? a.top - h - gap : a.top;
  if (side === "below" && y + h > innerHeight - 8) y = a.top - h - gap;
  if (side === "above" && y < 8) y = a.bottom + gap;
  x = Math.max(8, Math.min(x, innerWidth - w - 8));
  y = Math.max(8, Math.min(y, innerHeight - h - 8));
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}

/** A popover that opens next to `anchor` while it is set, and reports when it closes. */
export function Pop({
  anchor,
  side,
  onClose,
  className = "",
  label,
  children,
}: {
  anchor: DOMRect | null;
  side?: "below" | "above" | "right" | "left";
  onClose: () => void;
  className?: string;
  label?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    if (anchor) {
      if (!el.matches(":popover-open")) el.showPopover();
      place(el, anchor, side);
      el.querySelector<HTMLElement>("input, button, [tabindex]")?.focus();
    } else if (el.matches(":popover-open")) el.hidePopover();
  }, [anchor, side]);
  return (
    <div
      ref={ref}
      popover="auto"
      role="dialog"
      aria-label={label}
      className={`pop ${className}`}
      onToggle={(e) => (e as unknown as ToggleEvent).newState === "closed" && onClose()}
    >
      {anchor && children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Emoji
// ---------------------------------------------------------------------------

type Group = { id: string; label: string; icon: IconName; items: [string, string][] };
const GROUPS: Group[] = [
  { id: "people", label: "Smileys & people", icon: "smile", items: [
    ["thumbsup", "👍"], ["joy", "😂"], ["smile", "😄"], ["grin", "😁"], ["sweat_smile", "😅"], ["wink", "😉"], ["blush", "😊"],
    ["heart_eyes", "😍"], ["star_struck", "🤩"], ["party", "🥳"], ["cool", "😎"], ["nerd", "🤓"], ["hug", "🤗"], ["thinking", "🤔"],
    ["salute", "🫡"], ["upside_down", "🙃"], ["melting", "🫠"], ["open_mouth", "😮"], ["mind_blown", "🤯"], ["cry", "😢"], ["sob", "😭"],
    ["rage", "😡"], ["sleeping", "😴"], ["skull", "💀"], ["ghost", "👻"], ["robot", "🤖"], ["see_no_evil", "🙈"], ["eyes", "👀"],
    ["shrug", "🤷"], ["facepalm", "🤦"], ["wave", "👋"], ["clap", "👏"], ["raised_hands", "🙌"], ["pray", "🙏"], ["ok_hand", "👌"],
    ["muscle", "💪"], ["thumbsdown", "👎"], ["point_up", "☝️"], ["handshake", "🤝"],
  ] },
  { id: "nature", label: "Nature", icon: "leaf", items: [
    ["cat", "🐱"], ["dog", "🐶"], ["owl", "🦉"], ["bug", "🐛"], ["plant", "🌱"], ["wood", "🪵"], ["sun", "☀️"], ["moon", "🌙"],
    ["waxing_gibbous", "🌔"], ["star", "⭐"], ["shooting_star", "🌠"], ["rainbow", "🌈"], ["zap", "⚡"], ["snowflake", "❄️"], ["fire", "🔥"],
  ] },
  { id: "food", label: "Food & drink", icon: "coffee", items: [
    ["coffee", "☕"], ["tea", "🍵"], ["cup_with_straw", "🥤"], ["pizza", "🍕"], ["croissant", "🥐"], ["cake", "🍰"],
  ] },
  { id: "objects", label: "Objects", icon: "lightbulb", items: [
    ["tada", "🎉"], ["rocket", "🚀"], ["bulb", "💡"], ["art", "🎨"], ["books", "📚"], ["memo", "📝"], ["pushpin", "📌"], ["link", "🔗"],
    ["lock", "🔒"], ["wrench", "🔧"], ["gear", "⚙️"], ["computer", "💻"], ["phone", "📱"], ["camera", "📷"], ["musical_note", "🎵"],
    ["headphones", "🎧"], ["amphora", "🏺"],
  ] },
  { id: "symbols", label: "Symbols", icon: "heart", items: [
    ["heart", "❤️"], ["100", "💯"], ["sparkles", "✨"], ["check", "✅"], ["x", "❌"], ["warning", "⚠️"], ["question", "❓"], ["exclamation", "❗"],
  ] },
];
export const EMOJI: [string, string][] = GROUPS.flatMap((g) => g.items);
const BY_NAME = new Map(EMOJI);
/** Reactions may use ":shortcode:"; show the character when we know it. */
export const emojiChar = (e: string) => (/^:[\w+-]+:$/.test(e) ? BY_NAME.get(e.slice(1, -1)) ?? e : e);

const SECTIONS = GROUPS.map((g) => ({ ...g, items: g.items.map(([name, ch]) => ({ name, ch })) }));
const ICON_OF: Record<string, IconName> = { recent: "clock", ...Object.fromEntries(GROUPS.map((g) => [g.id, g.icon])) };

// Frequently used lives in this browser only (a per-viewer convenience); new people start with these.
const RECENT_KEY = "sblurp.emoji.recent";
const STARTER = ["thumbsup", "heart", "joy", "tada", "eyes", "pray", "fire", "100", "sparkles"];
function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "null");
    return Array.isArray(v) ? v : STARTER;
  } catch {
    return STARTER;
  }
}

const Face = ({ e }: { e: PickItem }) => (e.src ? <Img e={{ name: e.name, src: e.src }} /> : <span className="emoji">{e.ch}</span>);

/** Standard and community emoji in one grid, like Slack: one search, category tabs, Add emoji. */
export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const c = useApp((s) => s.cs[s.url]);
  const { list } = useEmojiSet(useApp((s) => s.url));
  const canAdd = (c?.me?.role ?? MemberRole.MEMBER) >= MemberRole.MODERATOR;
  const [q, setQ] = useState("");
  const [recent] = useState(readRecent);
  const [hover, setHover] = useState<PickItem | null>(null);
  const [at, setAt] = useState("");
  const [limit, more] = useMore(180);
  const grid = useRef<HTMLDivElement>(null);
  const jump = useRef("");
  const base = useMemo(() => pickerSections(SECTIONS, list, recent, ""), [list, recent]);
  const shown = useMemo(() => (q.trim() ? pickerSections(SECTIONS, list, recent, q) : base), [base, list, recent, q]);
  const first = shown[0]?.items[0];

  const go = (id: string) => {
    const g = grid.current!;
    g.scrollTop = g.querySelector<HTMLElement>(`[data-sec="${id}"]`)?.offsetTop ?? 0;
    setAt(id);
  };
  useLayoutEffect(() => {
    if (jump.current) go(jump.current);
    else grid.current!.scrollTop = 0;
    jump.current = "";
  }, [q]);
  const spy = () => {
    const g = grid.current!;
    let id = "";
    for (const h of g.querySelectorAll<HTMLElement>("[data-sec]")) if (h.offsetTop <= g.scrollTop + 4) id = h.dataset.sec!;
    setAt(id);
  };
  const pick = (e: PickItem) => {
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(bumpRecent(recent, e.name)));
    } catch {
      // private mode: frequently used just won't update
    }
    onPick(e.ch ?? `:${e.name}:`);
  };

  let n = 0;
  const peek = hover ?? first;
  return (
    <div className="emoji-picker">
      <input
        className="input"
        type="search"
        placeholder="Search all emoji"
        aria-label="Search emoji"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && first && pick(first)}
      />
      <nav className="emoji-tabs" aria-label="Emoji categories">
        {base.map((s) => (
          <button
            key={s.id}
            type="button"
            title={s.label}
            aria-label={s.label}
            aria-current={!q.trim() && (at || base[0].id) === s.id}
            onClick={() => (q ? ((jump.current = s.id), setQ("")) : go(s.id))}
          >
            {s.id === "custom" ? <CommunityIcon name={c?.info?.name || "?"} icon={c?.info?.iconUrl ? absUrl(c.url, c.info.iconUrl) : ""} accent={c?.info?.accentColor} size={18} /> : <Icon name={ICON_OF[s.id]} size={18} />}
          </button>
        ))}
      </nav>
      <div className="emoji-grid" role="listbox" aria-label="Emoji" ref={grid} onScroll={spy} onMouseLeave={() => setHover(null)}>
        {shown.map((s) => {
          const room = Math.max(0, limit - n);
          n += s.items.length;
          return (
            <Fragment key={s.id}>
              <p className="emoji-section" data-sec={s.id}>
                {s.label}
              </p>
              {s.items.slice(0, room).map((e) => (
                <button key={e.name} role="option" aria-selected="false" title={`:${e.name}:`} aria-label={e.name.replace(/[_-]/g, " ")} onMouseEnter={() => setHover(e)} onFocus={() => setHover(e)} onClick={() => pick(e)}>
                  <Face e={e} />
                </button>
              ))}
            </Fragment>
          );
        })}
        {limit < n && <div ref={more} className="emoji-more" />}
        {!first && <p className="muted small">No emoji match “{q.trim()}”.</p>}
      </div>
      <div className="emoji-foot">
        {peek && (
          <>
            <span className="emoji-peek" aria-hidden="true">
              <Face e={peek} />
            </span>
            <span className="truncate">:{peek.name}:</span>
          </>
        )}
        {canAdd && (
          <button
            type="button"
            className="btn ghost small"
            onClick={(e) => {
              e.currentTarget.closest<HTMLElement>("[popover]")?.hidePopover();
              set({ modal: { t: "community", tab: "emoji" } });
            }}
          >
            <Icon name="smilePlus" size={16} /> Add emoji
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Markdown → React nodes. Text is always rendered as text; links are http(s)/mailto only.
// ---------------------------------------------------------------------------

function renderInline(nodes: Inline[], members: Record<string, Member>, meId: string | undefined, onMention: (id: string, el: HTMLElement) => void): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text":
        return n.v.includes(":") ? <Shortcodes key={i} text={n.v} /> : n.v;
      case "code":
        return <code key={i}>{n.v}</code>;
      case "b":
        return <strong key={i}>{renderInline(n.c, members, meId, onMention)}</strong>;
      case "i":
        return <em key={i}>{renderInline(n.c, members, meId, onMention)}</em>;
      case "s":
        return <s key={i}>{renderInline(n.c, members, meId, onMention)}</s>;
      case "link":
        return (
          <a key={i} href={n.href} target="_blank" rel="noopener noreferrer">
            {renderInline(n.c, members, meId, onMention)}
          </a>
        );
      case "mention": {
        const m = members[n.id];
        return (
          <button key={i} className={`mention${n.id === meId ? " me" : ""}`} onClick={(e) => onMention(n.id, e.currentTarget)}>
            @{m?.displayName ?? "unknown"}
          </button>
        );
      }
    }
  });
}

/** A fenced block. With a language, the highlighter loads on first use and colors it in place. */
function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const key = `${lang}\n${code}`;
  const [hl, setHl] = useState({ key: "", html: null as string | null });
  useEffect(() => {
    if (!lang) return;
    let live = true;
    import("./highlight").then(
      (m) => live && setHl({ key, html: m.highlight(code, lang) }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const html = hl.key === key ? hl.html : null;
  return <pre data-lang={lang || undefined}>{html === null ? <code>{code}</code> : <code dangerouslySetInnerHTML={{ __html: html }} />}</pre>;
}

export function Markdown({
  text,
  members,
  meId,
  onMention,
}: {
  text: string;
  members: Record<string, Member>;
  meId?: string;
  onMention: (id: string, el: HTMLElement) => void;
}) {
  return (
    <>
      {parseMarkdown(text).map((b, i) =>
        b.t === "pre" ? (
          <CodeBlock key={i} lang={b.lang} code={b.v} />
        ) : b.t === "ul" || b.t === "ol" ? (
          (() => {
            const L = b.t;
            return (
              <L key={i} start={b.t === "ol" && b.start !== 1 ? b.start : undefined}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it, members, meId, onMention)}</li>
                ))}
              </L>
            );
          })()
        ) : b.t === "quote" ? (
          <blockquote key={i}>{renderInline(b.c, members, meId, onMention)}</blockquote>
        ) : (
          <p key={i}>{renderInline(b.c, members, meId, onMention)}</p>
        ),
      )}
    </>
  );
}

/** Text that someone allowed to change it can click to edit (1192, 1195): a hover tint and a pencil.
 * Links and mentions inside keep working; the pencil button is the keyboard way in. */
export function Editable({ label, onEdit, className = "", children }: { label: string; onEdit?: () => void; className?: string; children: ReactNode }) {
  if (!onEdit) return <div className={className}>{children}</div>;
  return (
    <div className={`${className} editable`} onClick={(e) => !(e.target as Element).closest("a, button") && onEdit()}>
      {children}
      <button className="edit-pencil" aria-label={label} title={label} onClick={onEdit}>
        <Icon name="edit" size={14} />
      </button>
    </div>
  );
}

/** Whether a line-clamped element cuts its content off; rechecks when it resizes or `dep` changes. */
export function useClamped(ref: { current: HTMLElement | null }, dep: unknown) {
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setCut(el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, dep]);
  return cut;
}

// ---------------------------------------------------------------------------
// Drag handle that sets --side-w or --pane-w on .app and remembers the width
// ---------------------------------------------------------------------------

const load = (k: string) => {
  try {
    return Number(localStorage.getItem(k)) || null;
  } catch {
    return null;
  }
};

export function Resizer({ panel, label }: { panel: keyof typeof PANELS; label: string }) {
  const p = PANELS[panel];
  const key = `sblurp.width.${panel}`;
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(() => clampWidth(p, load(key) ?? p.def));
  useLayoutEffect(() => {
    ref.current?.closest<HTMLElement>(".app")?.style.setProperty(`--${panel}-w`, `${w}px`);
    try {
      if (w === p.def) localStorage.removeItem(key);
      else localStorage.setItem(key, String(w));
    } catch {
      /* private mode: the width just isn't remembered */
    }
  }, [w, panel, key, p.def]);
  return (
    <div
      ref={ref}
      className={`resizer resizer-${panel}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={w}
      aria-valuemin={p.min}
      aria-valuemax={p.max}
      tabIndex={0}
      onDoubleClick={() => setW(p.def)}
      onKeyDown={(e) => {
        const n = keyWidth(p, w, e.key, e.shiftKey);
        if (n === null) return;
        e.preventDefault();
        setW(n);
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault(); // no text selection while dragging
        const el = e.currentTarget;
        const x0 = e.clientX;
        const w0 = w;
        el.setPointerCapture(e.pointerId);
        el.onpointermove = (m) => setW(clampWidth(p, w0 + (m.clientX - x0) * p.dir));
        el.onpointerup = el.onlostpointercapture = () => {
          el.onpointermove = el.onpointerup = el.onlostpointercapture = null;
        };
      }}
    />
  );
}
