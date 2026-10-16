// Shared UI primitives: icons, avatars, dialogs, popovers, the emoji picker and the markdown renderer.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Presence, type Member } from "./gen/sblurp/v1/sblurp_pb";
import { initials, parseMarkdown, swatch, type Inline } from "./logic";
import { set } from "./store";

// ---------------------------------------------------------------------------
// Icons (24px grid, 1.75 stroke)
// ---------------------------------------------------------------------------

const circ = (cx: number, cy: number, r: number) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
const ICONS = {
  hash: "M4 9h16M4 15h16M10 3 8 21M16 3l-2 18",
  lock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
  plus: "M12 5v14M5 12h14",
  search: `${circ(11, 11, 7)}M20 20l-4-4`,
  people: `${circ(9, 8, 4)}M2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1M16 4a4 4 0 0 1 0 8M19 14a5 5 0 0 1 3 5v2`,
  thread: "M21 14a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  smile: `${circ(12, 12, 9)}M8.5 14.5s1.3 1.8 3.5 1.8 3.5-1.8 3.5-1.8M9 9.5h.01M15 9.5h.01`,
  edit: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  more: `${circ(5, 12, 1)}${circ(12, 12, 1)}${circ(19, 12, 1)}`,
  x: "M18 6 6 18M6 6l12 12",
  clip: "m21 11-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6L15.1 6.5",
  send: "M4 12 3 4l18 8-18 8 1-8zm0 0h8",
  sliders: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
  chevron: "m6 9 6 6 6-6",
  menu: "M4 6h16M4 12h16M4 18h16",
  trash: "M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
  back: "M19 12H5M12 19l-7-7 7-7",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  info: `${circ(12, 12, 9)}M12 16v-4M12 8h.01`,
  leave: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
  invite: `${circ(9, 8, 4)}M2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1M19 8v6M22 11h-6`,
  down: "M12 5v14M19 12l-7 7-7-7",
  check: "M20 6 9 17l-5-5",
  external: "M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
  retry: "M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.2L3 16M3 21v-5h5",
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
    <span className="avatar" style={{ width: size, height: size, ["--r" as string]: `${Math.round(size * 0.22)}px` }}>
      {m?.avatarUrl ? (
        <img src={m.avatarUrl} alt="" width={size} height={size} />
      ) : (
        <span className="avatar-initials" style={{ background: swatch(m?.id ?? name), fontSize: Math.round(size * 0.4) }}>
          {initials(name)}
        </span>
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
    <span className="cicon" style={{ width: size, height: size, background: accent || "var(--raspberry)", fontSize: Math.round(size * 0.34) }}>
      {icon ? <img src={icon} alt="" /> : initials(name)}
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
}: {
  label: string;
  children: ReactNode;
  className?: string;
  onClose?: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    d.showModal();
    return () => d.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={label}
      className={`dialog ${className}`}
      onClose={onClose}
      onMouseDown={(e) => e.target === ref.current && ref.current.close()}
    >
      {children}
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

export const EMOJI: [string, string][] = [
  ["thumbsup", "👍"], ["heart", "❤️"], ["joy", "😂"], ["tada", "🎉"], ["eyes", "👀"], ["pray", "🙏"],
  ["fire", "🔥"], ["100", "💯"], ["sparkles", "✨"], ["cup_with_straw", "🥤"], ["smile", "😄"], ["grin", "😁"],
  ["sweat_smile", "😅"], ["wink", "😉"], ["blush", "😊"], ["heart_eyes", "😍"], ["star_struck", "🤩"],
  ["thinking", "🤔"], ["open_mouth", "😮"], ["cry", "😢"], ["sob", "😭"], ["rage", "😡"], ["sleeping", "😴"],
  ["upside_down", "🙃"], ["shrug", "🤷"], ["facepalm", "🤦"], ["wave", "👋"], ["clap", "👏"], ["raised_hands", "🙌"],
  ["ok_hand", "👌"], ["muscle", "💪"], ["thumbsdown", "👎"], ["point_up", "☝️"], ["handshake", "🤝"],
  ["rocket", "🚀"], ["bulb", "💡"], ["check", "✅"], ["x", "❌"], ["warning", "⚠️"], ["question", "❓"],
  ["exclamation", "❗"], ["star", "⭐"], ["sun", "☀️"], ["moon", "🌙"], ["waxing_gibbous", "🌔"],
  ["shooting_star", "🌠"], ["owl", "🦉"], ["coffee", "☕"], ["tea", "🍵"], ["pizza", "🍕"], ["cake", "🍰"],
  ["croissant", "🥐"], ["amphora", "🏺"], ["wood", "🪵"], ["art", "🎨"], ["books", "📚"], ["memo", "📝"],
  ["pushpin", "📌"], ["link", "🔗"], ["lock", "🔒"], ["bug", "🐛"], ["wrench", "🔧"], ["gear", "⚙️"],
  ["computer", "💻"], ["phone", "📱"], ["camera", "📷"], ["musical_note", "🎵"], ["headphones", "🎧"],
  ["party", "🥳"], ["cool", "😎"], ["nerd", "🤓"], ["skull", "💀"], ["ghost", "👻"], ["robot", "🤖"],
  ["cat", "🐱"], ["dog", "🐶"], ["plant", "🌱"], ["rainbow", "🌈"], ["zap", "⚡"], ["snowflake", "❄️"],
  ["salute", "🫡"], ["melting", "🫠"], ["hug", "🤗"], ["mind_blown", "🤯"], ["see_no_evil", "🙈"],
];
const BY_NAME = new Map(EMOJI);
/** Reactions may use ":shortcode:"; show the character when we know it. */
export const emojiChar = (e: string) => (/^:[\w+-]+:$/.test(e) ? BY_NAME.get(e.slice(1, -1)) ?? e : e);

export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [q, setQ] = useState("");
  const list = EMOJI.filter(([n]) => n.includes(q.toLowerCase().replace(/^:/, "")));
  return (
    <div className="emoji-picker">
      <input
        className="input"
        placeholder="Search emoji"
        aria-label="Search emoji"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && list[0] && onPick(list[0][1])}
      />
      <div className="emoji-grid" role="listbox" aria-label="Emoji">
        {list.map(([n, ch]) => (
          <button key={n} role="option" aria-selected="false" title={`:${n}:`} aria-label={n.replace(/_/g, " ")} onClick={() => onPick(ch)}>
            {ch}
          </button>
        ))}
        {!list.length && <p className="muted small">No emoji match “{q}”.</p>}
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
        return n.v;
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
          <pre key={i} data-lang={b.lang || undefined}>
            <code>{b.v}</code>
          </pre>
        ) : b.t === "quote" ? (
          <blockquote key={i}>{renderInline(b.c, members, meId, onMention)}</blockquote>
        ) : (
          <p key={i}>{renderInline(b.c, members, meId, onMention)}</p>
        ),
      )}
    </>
  );
}
