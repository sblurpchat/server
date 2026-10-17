// Shared UI primitives: icons, avatars, dialogs, popovers, the emoji picker and the markdown renderer.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Presence, type Member } from "./gen/sblurp/v1/sblurp_pb";
import { PANELS, clampWidth, initials, keyWidth, onWhite, parseMarkdown, swatch, type Inline } from "./logic";
import { set } from "./store";

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
  external: "M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
  retry: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5",
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
