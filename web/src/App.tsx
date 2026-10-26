import { Code, ConnectError } from "@connectrpc/connect";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent } from "react";
import { ChannelDialog, CommunitySettings, Invites, PERMISSION, RoleChips, ReportDialog, ReportsDialog } from "./Admin";
import { ChannelView, openProfile, PeoplePicker, RightPane } from "./Chat";
import { SetupWizard, useSetupPrompt } from "./Setup";
import { create } from "@bufbuild/protobuf";
import { ChannelKind, ChannelMode, MemberKind, MemberRole, MemberSchema, type Channel, type GetServerInfoResponse, type Member } from "./gen/sblurp/v1/sblurp_pb";
import {
  channelLabel,
  communityBadge,
  formatHash,
  hostOf,
  showDown,
  isDM,
  dmPeer,
  matchScore,
  modActions,
  moveItem,
  nameColor,
  normalizeCommunityUrl,
  sidebarSections,
  tabTitle,
  type Community,
  count,
  browseDetail,
  browseList,
  THEMES,
  CUSTOM_COLORS,
  customTheme,
  parseThemeString,
  themeString,
  timeLabel,
  type Appearance as Look,
  type Theme,
  sentence,
  listStep,
  cssUrl,
  settingsGroups,
  type SettingsPage,
  channelSlug,
  blockedRows,
  swipeAxis,
  swipeEnds,
  swipeTab,
  allDMs,
  dmPreview,
  rowWhen,
  tabBadges,
} from "./logic";
import {
  absUrl,
  ACCOUNT_URL,
  SELF_HOST_DOCS_URL,
  errorText,
  FAKE,
  closePane,
  get,
  join,
  leave,
  leaveCommunity,
  markAllRead,
  updateProfile,
  removeMember,
  openDM,
  probe,
  remove,
  reorder,
  retryNow,
  selectChannel,
  selectCommunity,
  set,
  setRole,
  setNotify,
  setLook,
  startCustomTheme,
  signIn,
  signOut,
  toggleCollapsed,
  useApp,
  browseChannels,
  joinChannel,
  leaveChannel,
  peekChannel,
  removeFromChannel,
  setBlocked,
  setMuted,
} from "./store";
import { AUTH_URL, nativeApp } from "./auth";
import { appPlatform, DOWNLOADS, offered } from "./downloads";
import { LinksSetting, sheetApp } from "./links";
import { AvatarField } from "./AvatarField";
import { PushAsk, PushSetting } from "./PushAsk";
import { iosApp } from "./push";
import { pond } from "./pond";
import { Avatar, AvatarEditOverlay, CommunityIcon, CopyButton, Dialog, Editable, EmojiPicker, emojiChar, focusMain, AUTOFOCUS, autoFocusTo, Icon, type IconName, thenCompose, Markdown, menuKeys, Pop, presenceLabel, Resizer, Skeleton, useClamped, ZoomStage } from "./ui";

export function App() {
  const auth = useApp((s) => s.auth);
  useTitle();
  useShortcuts();
  if (auth === "loading") return <div className="boot" aria-busy="true" />;
  if (auth === "out") return <SignIn />;
  return <Shell />;
}

// ---------------------------------------------------------------------------
// Global behavior
// ---------------------------------------------------------------------------

function useTitle() {
  const cs = useApp((s) => s.cs);
  const url = useApp((s) => s.url);
  const channelId = useApp((s) => s.channelId);
  useEffect(() => {
    let mentions = 0;
    let unread = false;
    for (const c of Object.values(cs)) {
      const b = communityBadge(c);
      mentions += b.mentions;
      unread ||= b.unread;
    }
    const c = cs[url];
    const ch = c?.channels[channelId];
    const label = ch ? (isDM(ch) ? channelLabel(ch, c.members, c.me?.id) : `#${ch.name}`) : c?.info?.name ?? "";
    document.title = tabTitle(mentions, unread, label);
  }, [cs, url, channelId]);
}

/** Channels of the current community in sidebar order, for Alt+Up/Down. */
function moveChannel(dir: 1 | -1, unreadOnly: boolean) {
  const s = get();
  const c = s.cs[s.url];
  if (!c) return;
  const list = sidebarSections(c).flatMap((x) => x.channels);
  const i = list.findIndex((ch) => ch.id === s.channelId);
  for (let step = 1; step <= list.length; step++) {
    const ch = list[(i + dir * step + list.length * 2) % list.length];
    if (!unreadOnly || (c.reads[ch.id]?.unreadCount ?? 0) > 0) return selectChannel(s.url, ch.id);
  }
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = get();
      if (s.auth !== "in") return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        set({ modal: s.modal?.t === "switcher" ? null : { t: "switcher" } });
      } else if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        set({ modal: s.modal?.t === "keys" ? null : { t: "keys" } });
      } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && !s.modal) {
        e.preventDefault();
        moveChannel(e.key === "ArrowUp" ? -1 : 1, e.shiftKey);
      } else if (e.key === "Escape" && e.shiftKey && !s.modal) {
        e.preventDefault();
        markAllRead(s.url);
      } else if (e.key === "Escape" && !s.modal && !e.defaultPrevented && !document.querySelector(":popover-open")) {
        if (s.editing) set({ editing: null });
        else if (s.pane) closePane();
        else if (s.drawer) set({ drawer: false });
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

// The phone layout (< 768px), where the rail and sidebar are a drawer over the channel.
const NARROW = matchMedia("(max-width: 767px)");
const onNarrow = (f: () => void) => (NARROW.addEventListener("change", f), () => NARROW.removeEventListener("change", f));


/** Can this element scroll sideways? Then a sideways drag inside it is its own, not the drawer's. */
const scrollsX = (el: Element) => el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(el).overflowX);

/** Swipe a DM row left to reveal Close (1389). Not a native scroll-snap row (1411): WKWebView drops a
 *  tap while a scroll view decelerates, and a snap scroller decelerates long after it looks still,
 *  so Close took two taps. Here the row is only translated, so nothing scrolls under the tap. */
const ROW_W = 92; // the Close button plus its gap
function rowSwipe(e: React.PointerEvent<HTMLLIElement>) {
  if (e.pointerType !== "touch") return;
  const li = e.currentTarget;
  const x0 = e.clientX;
  const from = parseFloat(li.style.getPropertyValue("--dx")) || 0;
  let at = from, t = e.timeStamp, v = 0;
  const move = (m: PointerEvent) => {
    const next = Math.min(0, Math.max(-ROW_W, from + m.clientX - x0));
    v = (at - next) / Math.max(1, m.timeStamp - t);
    at = next;
    t = m.timeStamp;
    li.dataset.drag = "";
    li.style.setProperty("--dx", `${at}px`);
  };
  const up = (u: PointerEvent) => {
    li.removeEventListener("pointermove", move);
    li.removeEventListener("pointerup", up);
    li.removeEventListener("pointercancel", up);
    if (li.dataset.drag == null) return;
    delete li.dataset.drag;
    const open = u.type === "pointerup" ? swipeEnds(-at / ROW_W, v) : from < 0;
    for (const o of document.querySelectorAll<HTMLElement>(".side-sec li[style]")) o.style.removeProperty("--dx");
    if (open) li.style.setProperty("--dx", `${-ROW_W}px`);
  };
  li.addEventListener("pointermove", move);
  li.addEventListener("pointerup", up);
  li.addEventListener("pointercancel", up);
}

/** What a tab swipe moves: the drawer's list, not the tab bar under it. */
const tabPanels = (drawer: HTMLElement) => drawer.querySelectorAll<HTMLElement>(":scope > :not(.tabbar)");

/** Phone drawer swipe (1354): a sideways drag anywhere on the channel opens the drawer like Slack,
 *  the drawer follows the finger and settles on release; dragging it back closes it. In a thread
 *  or member pane the same drag pulls the pane away and goes back to the channel (1403, 1416).
 *  On the open drawer's tab lists a drag either way pages to the next tab (1423, 1477); past the
 *  last tab, or on the rail, a drag to the left closes the drawer. */
function useDrawerSwipe(app: React.RefObject<HTMLDivElement | null>, live: React.RefObject<{ drawer: boolean; channelId: string }>) {
  useEffect(() => {
    const root = app.current!;
    let g: { x: number; y: number; t: number; t0: number; open: boolean; axis: ReturnType<typeof swipeAxis> | "tab"; p: number; v: number; pane: HTMLElement | null; tabs: boolean; dir: number } | null = null;
    const els = () => [root.querySelector<HTMLElement>(".drawer")!, root.querySelector<HTMLElement>(".scrim")!] as const;
    const start = (e: TouchEvent) => {
      g = null;
      if (!NARROW.matches || e.touches.length !== 1) return;
      const t = e.target as Element;
      // An open menu (a message long press, 1400) owns the touch, and so does the menu itself.
      if (t.closest("dialog, input, textarea, [popover], .side-sec li:has(.chan-close)") ||document.querySelector(".pop:popover-open")) return;
      for (let el: Element | null = t; el && el !== root; el = el.parentElement) if (scrollsX(el)) return;
      const tabs = (live.current.drawer || !live.current.channelId) && !!t.closest(".drawer") && !t.closest(".rail");
      // With no channel picked the drawer is all there is: nothing to swipe back to.
      if (!live.current.channelId && !tabs) return;
      // After a jump from search, Activity or Threads (1433) the channel itself swipes back, like a pane.
      const pane = t.closest<HTMLElement>(".pane") ?? (!live.current.drawer && history.state?.back ? t.closest<HTMLElement>(".channel") : null);
      const open = !pane && live.current.drawer;
      g = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: e.timeStamp, t0: e.timeStamp, open, axis: null, p: open ? 1 : 0, v: 0, pane, tabs, dir: 0 };
    };
    const move = (e: TouchEvent) => {
      if (!g || g.axis === "none") return;
      const dx = e.touches[0].clientX - g.x;
      if (g.axis === null) {
        const dy = e.touches[0].clientY - g.y, ms = e.timeStamp - g.t0;
        let a: ReturnType<typeof swipeAxis> | "tab" = swipeAxis(g.open, dx, dy, ms);
        const side = swipeAxis(dx < 0, dx, dy, ms); // "open" or "close" for any sideways drag
        if (g.tabs && (side === "open" || side === "close") && swipeTab(get().tab, dx)) [a, g.dir] = ["tab", Math.sign(dx)];
        else if (a && !live.current.channelId) a = "none";
        g.axis = a;
        // Swiping back from a channel shows its list, never the You tab left open last time (1438).
        if (a === "open" && !g.pane) {
          const s = get();
          set({ tab: isDM(s.cs[s.url]?.channels[s.channelId]) ? "dms" : "home" });
        }
      }
      if (g.axis !== "open" && g.axis !== "close" && g.axis !== "tab") return;
      e.preventDefault();
      const [drawer, scrim] = els();
      if (g.axis === "tab") {
        const p = Math.max(0, (dx * g.dir) / drawer.offsetWidth);
        g.v = ((p - g.p) * drawer.offsetWidth) / Math.max(1, e.timeStamp - g.t);
        g.p = p;
        g.t = e.timeStamp;
        drawer.style.overflow = "clip";
        for (const el of tabPanels(drawer)) Object.assign(el.style, { transition: "none", translate: `${p * g.dir * drawer.offsetWidth}px 0` });
        return;
      }
      const w = (g.pane ?? drawer).offsetWidth;
      const p = Math.min(1, Math.max(0, (g.open ? 1 : 0) + dx / w));
      g.v = ((p - g.p) * w) / Math.max(1, e.timeStamp - g.t);
      g.p = p;
      g.t = e.timeStamp;
      if (g.pane) return void Object.assign(g.pane.style, { transition: "none", translate: `${p * 100}% 0` });
      Object.assign(drawer.style, { transition: "none", visibility: "visible", translate: `${(p - 1) * 100}% 0` });
      Object.assign(scrim.style, { transition: "none", opacity: String(p) });
    };
    const end = () => {
      if (g?.axis === "tab") {
        const go = swipeEnds(g.p, g.v);
        const dir = g.dir;
        g = null;
        els()[0].style.removeProperty("overflow");
        for (const el of tabPanels(els()[0])) {
          el.style.removeProperty("translate");
          el.style.removeProperty("transition");
        }
        if (go) set({ tab: swipeTab(get().tab, dir)! });
        return;
      }
      if (!g || (g.axis !== "open" && g.axis !== "close")) return (g = null);
      const open = swipeEnds(g.p, g.v);
      const pane = g.pane;
      g = null;
      if (pane) {
        Object.assign(pane.style, { transition: "translate 140ms ease-out", translate: open ? "100% 0" : "" });
        if (open && pane.matches(".channel")) {
          addEventListener("popstate", () => requestAnimationFrame(() => pane.style.removeProperty("translate")), { once: true });
          setTimeout(() => history.back(), 140);
        } else if (open) setTimeout(closePane, 140);
        return;
      }
      for (const el of els()) el.removeAttribute("style");
      set({ drawer: open });
    };
    root.addEventListener("touchstart", start, { passive: true });
    root.addEventListener("touchmove", move, { passive: false });
    root.addEventListener("touchend", end);
    root.addEventListener("touchcancel", end);
    return () => {
      root.removeEventListener("touchstart", start);
      root.removeEventListener("touchmove", move);
      root.removeEventListener("touchend", end);
      root.removeEventListener("touchcancel", end);
    };
  }, []);
}

/** Skip past the rail and sidebar: to the message box, else the message list, else the main area. */
function Shell() {
  useSetupPrompt();
  const url = useApp((s) => s.url);
  const c = useApp((s) => s.cs[s.url]);
  const pane = useApp((s) => s.pane);
  const drawer = useApp((s) => s.drawer);
  const channelId = useApp((s) => s.channelId);
  const narrow = useSyncExternalStore(onNarrow, () => NARROW.matches);
  const covered = narrow && (drawer || !channelId);
  const appRef = useRef<HTMLDivElement>(null);
  const tab = useApp((s) => s.tab);
  const live = useRef({ drawer, channelId });
  live.current = { drawer, channelId };
  useDrawerSwipe(appRef, live);
  // A tab switch remounts the drawer's list, so each tab's scroll is kept here and put back (1457).
  const scrolls = useRef<Record<string, number>>({});
  useLayoutEffect(() => {
    const el = appRef.current!.querySelector<HTMLElement>(".drawer > :is(.sidebar, .tab-panel)");
    if (!el) return;
    el.scrollTop = scrolls.current[tab] ?? 0;
    const save = () => (scrolls.current[tab] = el.scrollTop);
    el.addEventListener("scroll", save, { passive: true });
    return () => el.removeEventListener("scroll", save);
  }, [tab, !!c]);
  // With no community the phone drawer covers main, so the empty state goes in the drawer too (1451).
  const none = (
    <Empty
      title="You're not in any communities yet."
      body="Add one with its address or an invite link."
      action={<button className="btn primary" onClick={() => set({ modal: { t: "add" } })}>Add a community</button>}
    />
  );
  // On a phone the open drawer covers the channel: focus goes in, and back to the menu button when it closes.
  const was = useRef(false);
  useEffect(() => {
    if (!narrow) return;
    if (drawer) autoFocusTo(document.querySelector(".drawer [aria-current=page], .drawer button"));
    else if (was.current) document.querySelector<HTMLElement>(".menu-btn")?.focus();
    was.current = drawer;
  }, [drawer, narrow]);
  return (
    <div ref={appRef} className="app" data-drawer={drawer || !channelId} data-pane={!!pane}>
      <button className="btn skip-link" onClick={focusMain}>
        Skip to messages
      </button>
      <div className="drawer" tabIndex={-1}>
        {!narrow || tab === "home" ? (
          <>
            <Rail />
            {c ? <Sidebar c={c} /> : narrow && none}
          </>
        ) : tab === "dms" ? (
          <DMList />
        ) : (
          <You c={c} />
        )}
        {narrow && <TabBar />}
      </div>
      <main className="main" tabIndex={-1} inert={covered}>
        {!url || !c ? (
          none
        ) : c.status === "join" ? (
          <JoinCard url={url} />
        ) : !c.me ? (
          <Loading c={c} />
        ) : (
          <ChannelView key={`${url} ${channelId}`} />
        )}
      </main>
      {pane && c?.me && <RightPane />}
      <Modals />
      <PushAsk />
      <ProfilePopover />
      <div className="scrim" onClick={() => set({ drawer: false })} />
    </div>
  );
}

function Empty({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      <p>{body}</p>
      {action}
    </div>
  );
}

/** The skeleton, or after QUIET_MS of failing, why the community does not load (1376). */
function Loading({ c }: { c: Community }) {
  const name = c.info?.name ?? hostOf(c.url);
  const secs = useCountdown(c.retryAt);
  const down = c.error && showDown(c, Date.now());
  // The title already says it can't be reached, so only a different reason is repeated (1468).
  const reason = c.error?.startsWith("Can't reach") ? "" : `${c.error} `;
  return (
    <div className="loading-main" aria-busy={!down}>
      {/* The phone header stays, so the menu button is a way out while it loads or fails (1468). */}
      <header className="chan-head">
        <button className="icon-btn only-mobile menu-btn" aria-label="Open communities and channels" onClick={() => set({ drawer: true })}>
          <Icon name="back" />
        </button>
        <div className="chan-id">
          <h1 className="chan-title">
            <span className="truncate">{name}</span>
          </h1>
        </div>
      </header>
      {down ? (
        <Empty
          title={`Can't reach ${name}`}
          body={`${reason}${secs > 0 ? `Trying again in ${secs}s.` : "Trying again now."}`}
          action={
            <button className="btn" onClick={() => retryNow(c.url)}>
              Try now
            </button>
          }
        />
      ) : (
        <>
          <Skeleton rows={8} avatar={36} chat className="skel-chat" />
          <div className="composer" aria-hidden="true">
            <div className="composer-box skel-composer" />
          </div>
        </>
      )}
    </div>
  );
}

export function useCountdown(at?: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!at) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [at]);
  return at ? Math.max(0, Math.ceil((at - now) / 1000)) : 0;
}

// ---------------------------------------------------------------------------
// Phone tabs (1369): Home, DMs and You at the bottom of the drawer, like Slack and Discord
// ---------------------------------------------------------------------------

// A second tap on the open tab scrolls its list to the top, like iOS (1472).
const toTop = () => document.querySelector(".drawer > :is(.sidebar, .tab-panel)")?.scrollTo({ top: 0, behavior: "smooth" });

function TabBar() {
  const tab = useApp((s) => s.tab);
  const cs = useApp((s) => s.cs);
  const me = useApp((s) => s.cs[s.url]?.me);
  const b = useMemo(() => tabBadges(cs), [cs]);
  const item = (t: typeof tab, label: string, icon: React.ReactNode, badge = 0, dot = false) => (
    <button className="tab" aria-current={tab === t ? "page" : undefined} onClick={() => (tab === t ? toTop() : set({ tab: t }))}>
      {icon}
      <span>{label}</span>
      {badge > 0 ? (
        <span className="badge tab-badge">
          {badge > 99 ? "99+" : badge}
          <span className="visually-hidden"> unread</span>
        </span>
      ) : (
        dot && (
          <span className="tab-dot">
            <span className="visually-hidden"> unread</span>
          </span>
        )
      )}
    </button>
  );
  return (
    <nav className="tabbar" aria-label="Sections">
      {item("home", "Home", <Icon name="house" size={24} />, b.home.mentions, b.home.unread)}
      {item("dms", "DMs", <Icon name="messages" size={24} />, b.dms)}
      {item("you", "You", <Avatar m={me} size={24} />)}
    </nav>
  );
}

function DMList() {
  const cs = useApp((s) => s.cs);
  const order = useApp((s) => s.order);
  const current = useApp((s) => s.channelId);
  const dms = useMemo(() => allDMs(cs, order), [cs, order]);
  const many = order.length > 1;
  const h24 = useApp((s) => s.look.clock === "24");
  return (
    <section className="tab-panel" aria-labelledby="dms-title">
      <header className="tab-head">
        <h2 id="dms-title">Direct messages</h2>
        <button className="icon-btn" aria-label="New message" title="New message" onClick={() => set({ modal: { t: "newdm" } })}>
          <Icon name="plus" />
        </button>
      </header>
      {dms.length ? (
        // side-sec: the same swipe-to-Close rows as Home's DMs (1476).
        <ul className="tab-scroll side-sec">
          {dms.map(({ url, ch, unread, mentions }) => {
            const c = cs[url];
            const other = c.members[dmPeer(ch, c.me?.id)];
            const label = channelLabel(ch, c.members, c.me?.id);
            return (
              <li key={`${url} ${ch.id}`} onPointerDown={rowSwipe}>
                <a
                  href={formatHash(url, ch.id)}
                  className="dm-row"
                  data-unread={unread}
                  aria-current={ch.id === current ? "page" : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    selectChannel(url, ch.id);
                  }}
                >
                  <Avatar m={other} size={36} presence={ch.memberIds.length <= 2} />
                  <span className="dm-text">
                    <span className="dm-top">
                      <b className="truncate">{label}</b>
                      {ch.lastMessage && <time>{rowWhen(Number(ch.lastMessage.createdAtMs), Date.now(), h24)}</time>}
                    </span>
                    <small className="truncate">
                      {[many && (c.info?.name ?? hostOf(url)), dmPreview(ch.lastMessage, c.members, c.me?.id)].filter(Boolean).join(" · ")}
                    </small>
                  </span>
                  {unread && !mentions && <span className="visually-hidden">, unread</span>}
                  {mentions > 0 && (
                    <span className="badge">
                      {mentions}
                      <span className="visually-hidden"> {mentions === 1 ? "mention" : "mentions"}</span>
                    </span>
                  )}
                </a>
                <button
                  className="chan-close"
                  aria-label={`Close conversation with ${label}`}
                  title="Close conversation"
                  onClick={() => removeFromChannel(url, ch.id, c.me!.id).catch(() => {})}
                >
                  <Icon name="x" size={14} />
                  <span className="chan-close-text" aria-hidden="true">
                    Close
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="tab-empty">No direct messages yet. Start one with the + button.</p>
      )}
    </section>
  );
}

function You({ c }: { c?: Community }) {
  const profile = useApp((s) => s.profile);
  const me = c?.me;
  const status = me?.statusText || me?.statusEmoji ? `${me.statusEmoji} ${me.statusText}`.trim() : me ? "Online" : "";
  return (
    <section className="tab-panel" aria-labelledby="you-title">
      <div className="you-card">
        <Avatar m={me} size={56} presence={!!me} />
        <span className="me-text">
          <b id="you-title" className="truncate">{me?.displayName ?? profile?.displayName ?? "You"}</b>
          {status && <small className="truncate">{status}</small>}
        </span>
      </div>
      <div className="you-rows">
        {me && (
          <button onClick={() => set({ modal: { t: "profile" } })}>
            <Icon name="edit" size={20} /> Edit profile and status
          </button>
        )}
        <button onClick={() => set({ modal: { t: "add" } })}>
          <Icon name="plus" size={20} /> Add a community
        </button>
      </div>
      {/* Settings rows live here on the phone, one tap closer (1418). */}
      {settingsGroups(sheetApp).map((g) => (
        <div className="you-rows" key={g[0]}>
          {g.map((p) => (
            <button key={p} onClick={() => set({ modal: { t: "settings", page: p } })}>
              <Icon name={PAGES[p][1]} size={20} /> {PAGES[p][0]}
            </button>
          ))}
        </div>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Rail
// ---------------------------------------------------------------------------

function Rail() {
  const order = useApp((s) => s.order);
  const cs = useApp((s) => s.cs);
  const current = useApp((s) => s.url);
  const drag = useRef(-1);
  const [over, setOver] = useState(-1);
  const move = (from: number, to: number) => to >= 0 && to < order.length && reorder(moveItem(order, from, to));
  return (
    <nav className="rail" aria-label="Communities">
      <ul>
        {order.map((u, i) => {
          const c = cs[u];
          const b = c ? communityBadge(c) : { unread: false, mentions: 0 };
          const name = c?.info?.name ?? hostOf(u);
          return (
            <li
              key={u}
              className="rail-item"
              data-selected={u === current}
              data-unread={b.unread}
              data-over={over === i}
              draggable
              onDragStart={(e) => {
                drag.current = i;
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(i);
              }}
              onDragLeave={() => setOver(-1)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(-1);
                move(drag.current, i);
              }}
            >
              <button
                className="rail-btn"
                aria-label={`${name}${b.mentions ? `, ${b.mentions} mentions` : b.unread ? ", unread messages" : ""}`}
                aria-current={u === current ? "page" : undefined}
                aria-keyshortcuts="Alt+Shift+ArrowUp Alt+Shift+ArrowDown"
                // On a phone the drawer stays open on the new community's channels (1297).
                onClick={() => (selectCommunity(u), NARROW.matches && set({ drawer: true }))}
                onKeyDown={(e) => {
                  if (e.altKey && e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
                    e.preventDefault();
                    e.stopPropagation();
                    move(i, i + (e.key === "ArrowUp" ? -1 : 1));
                  }
                }}
              >
                <CommunityIcon name={name} icon={c?.info?.iconUrl ? absUrl(u, c.info.iconUrl) : ""} accent={c?.info?.accentColor} />
              </button>
              {b.mentions > 0 && <span className="badge rail-badge" aria-hidden="true">{b.mentions > 99 ? "99+" : b.mentions}</span>}
              <span className="tip" aria-hidden="true">
                {name}
              </span>
            </li>
          );
        })}
        <li className="rail-item rail-add">
          <button className="rail-btn" aria-label="Add a community" onClick={() => set({ modal: { t: "add" } })}>
            <span className="cicon add">
              <Icon name="plus" size={22} />
            </span>
          </button>
          <span className="tip" aria-hidden="true">
            Add a community
          </span>
        </li>
      </ul>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

/** The community description under its name: three lines, then "Show more". */
function SideAbout({ c, text, admin }: { c: Community; text: string; admin: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const cut = useClamped(ref, text);
  return (
    <div className="side-about">
      <Editable label="Edit community description" onEdit={admin ? () => set({ modal: { t: "community", tab: "about", focusDesc: true } }) : undefined}>
        <div ref={ref} id="side-about-text" className="side-about-text msg-text" data-open={open}>
          <Markdown text={text} members={c.members} meId={c.me?.id} onMention={(id, el) => openProfile(c.url, id, el)} />
        </div>
      </Editable>
      {(cut || open) && (
        <button className="link-btn" aria-expanded={open} aria-controls="side-about-text" onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/** Activity and Threads (1405) open in the side pane, on a phone over the channel. */
// On a phone, closing it goes back to the drawer it came from (1469).
function openSideView(t: "activity" | "threads") {
  set({ pane: { t }, drawer: false });
  if (NARROW.matches) history.replaceState({ ...history.state, drawer: true }, "");
}

function SideViews() {
  const pane = useApp((s) => s.pane?.t);
  const row = (t: "activity" | "threads", label: string, icon: "bell" | "thread") => (
    <button className="chan browse-btn" aria-current={pane === t ? "page" : undefined} onClick={() => openSideView(t)}>
      <span className="chan-icon">
        <Icon name={icon} size={16} />
      </span>
      {label}
    </button>
  );
  return (
    <>
      {row("activity", "Activity", "bell")}
      {row("threads", "Threads", "thread")}
    </>
  );
}

function Sidebar({ c }: { c: Community }) {
  const channelId = useApp((s) => s.channelId);
  const collapsed = useApp((s) => s.collapsed);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const name = c.info?.name ?? hostOf(c.url);
  const sections = useMemo(() => sidebarSections(c), [c.channels]);
  const admin = (c.me?.role ?? 0) >= MemberRole.ADMIN;
  const banner = absUrl(c.url, c.info?.bannerUrl ?? "");
  return (
    <aside className="sidebar" aria-label={name}>
      <Resizer panel="side" label="Resize sidebar" />
      <button
        className="side-head"
        aria-haspopup="menu"
        aria-expanded={!!menu}
        data-banner={banner ? true : undefined}
        style={banner ? ({ "--banner": cssUrl(banner) } as CSSProperties) : undefined}
        onClick={(e) => setMenu(e.currentTarget.getBoundingClientRect())}
      >
        <span className="truncate">{name}</span>
        {!!c.openReports && (
          <span className="badge" style={{ animation: "fade-in 150ms ease-out" }}>
            {c.openReports}
            <span className="visually-hidden"> open {c.openReports === 1 ? "report" : "reports"}</span>
          </span>
        )}
        <Icon name="chevron" size={18} />
      </button>
      {c.info?.description && <SideAbout c={c} text={c.info.description} admin={admin} />}
      <Pop anchor={menu} onClose={() => setMenu(null)} className="menu" label={`${name} menu`}>
        <div role="menu" onClick={() => setMenu(null)} onKeyDown={menuKeys}>
          <button role="menuitem" onClick={() => set({ modal: { t: "info" } })}>
            <Icon name="info" size={18} /> Community info
          </button>
          <button role="menuitem" onClick={() => set({ modal: { t: "invite" } })}>
            <Icon name="invite" size={18} /> Invite people
          </button>
          {admin && (
            <>
              {c.info?.needsSetup && (
                <button role="menuitem" onClick={() => set({ modal: { t: "setup" } })}>
                  <Icon name="sliders" size={18} /> Set up community
                </button>
              )}
              <button role="menuitem" onClick={() => set({ modal: { t: "channel" } })}>
                <Icon name="plus" size={18} /> Create channel
              </button>
              <button role="menuitem" onClick={() => set({ modal: { t: "community" } })}>
                <Icon name="gear" size={18} /> Community settings
              </button>
            </>
          )}
          {(c.me?.role ?? 0) >= MemberRole.MODERATOR && (
            <button role="menuitem" onClick={() => set({ modal: { t: "reports" } })}>
              <Icon name="flag" size={18} /> Reports
              {!!c.openReports && (
                <span className="badge">
                  {c.openReports}
                  <span className="visually-hidden"> open</span>
                </span>
              )}
            </button>
          )}
          <button role="menuitem" onClick={() => markAllRead(c.url)}>
            <Icon name="check" size={18} /> Mark all as read
          </button>
          <hr />
          <button role="menuitem" className="danger" onClick={() => set({ modal: { t: "leave" } })}>
            <Icon name="leave" size={18} /> Leave community
          </button>
        </div>
      </Pop>
      <nav className="side-scroll" aria-label="Channels" aria-busy={!c.me && !c.error}>
        {c.me && <SideViews />}
        {c.me && c.mode === ChannelMode.OPT_IN && (
          <button className="chan browse-btn" onClick={() => set({ modal: { t: "browse" } })}>
            <span className="chan-icon">
              <Icon name="search" size={16} />
            </span>
            Browse channels
          </button>
        )}
        {c.me ? (
          sections.map((sec) => {
            const key = `${c.url}|${sec.title}`;
            const shut = !!collapsed[key];
            const shown = shut
              ? sec.channels.filter((ch) => ch.id === channelId || (c.reads[ch.id]?.unreadCount ?? 0) > 0)
              : sec.channels;
            return (
              <section key={sec.title} className="side-sec">
                <h2>
                  <button aria-expanded={!shut} onClick={() => toggleCollapsed(key)}>
                    <span className="caret" data-shut={shut}>
                      <Icon name="chevron" size={14} />
                    </span>
                    {sec.title}
                  </button>
                  {sec.dm && (
                    <button className="sec-add" aria-label="New message" title="New message" onClick={() => set({ modal: { t: "newdm" } })}>
                      <Icon name="plus" size={16} />
                    </button>
                  )}
                  {admin && !sec.dm && (
                    <button
                      className="sec-add"
                      aria-label={`Create a channel in ${sec.title}`}
                      title="Create channel"
                      onClick={() => set({ modal: { t: "channel", category: sec.title === "Channels" ? "" : sec.title } })}
                    >
                      <Icon name="plus" size={16} />
                    </button>
                  )}
                </h2>
                <ul>
                  {shown.map((ch) => {
                    const rs = c.reads[ch.id];
                    const unread = (rs?.unreadCount ?? 0) > 0 && ch.id !== channelId;
                    const other = sec.dm ? c.members[dmPeer(ch, c.me?.id)] : undefined;
                    const label = channelLabel(ch, c.members, c.me?.id);
                    return (
                      <li key={ch.id} onPointerDown={sec.dm ? rowSwipe : undefined}>
                        <a
                          href={formatHash(c.url, ch.id)}
                          className="chan"
                          data-unread={unread}
                          aria-current={ch.id === channelId ? "page" : undefined}
                          onClick={(e) => {
                            e.preventDefault();
                            selectChannel(c.url, ch.id);
                          }}
                        >
                          {sec.dm ? (
                            <Avatar m={other} size={24} presence={ch.memberIds.length <= 2} />
                          ) : (
                            <span className="chan-icon">
                              <Icon name={ch.kind === 2 ? "lock" : "hash"} size={16} />
                            </span>
                          )}
                          <span className="truncate">{label}</span>
                          {other && ch.memberIds.length <= 2 && <span className="visually-hidden">, {presenceLabel(other.presence)}</span>}
                          {unread && <span className="visually-hidden">, unread</span>}
                          {(rs?.mentionCount ?? 0) > 0 && ch.id !== channelId && (
                            <span className="badge">
                              {rs!.mentionCount}
                              <span className="visually-hidden"> {rs!.mentionCount === 1 ? "mention" : "mentions"}</span>
                            </span>
                          )}
                        </a>
                        {sec.dm && (
                          <button
                            className="chan-close"
                            aria-label={`Close conversation with ${label}`}
                            title="Close conversation"
                            onClick={() => removeFromChannel(c.url, ch.id, c.me!.id).catch(() => {})}
                          >
                            <Icon name="x" size={14} />
                            <span className="chan-close-text" aria-hidden="true">
                              Close
                            </span>
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })
        ) : c.status === "join" || c.error ? null : (
          <Skeleton rows={7} avatar={16} lines={0} className="side-skel" />
        )}
      </nav>
      <NotifyNudge />
      <MeBar c={c} />
    </aside>
  );
}

// 1330: browser users get one offer to turn on notifications; X hides it for good. The Tauri app asks on its own.
const NUDGE_KEY = "sblurp.notifyNudgeDismissed";
const nudgeDismissed = () => {
  try {
    return !!localStorage.getItem(NUDGE_KEY);
  } catch {
    return false;
  }
};

function NotifyNudge() {
  const [hidden, setHidden] = useState(
    () => "__TAURI_INTERNALS__" in globalThis || typeof Notification === "undefined" || Notification.permission !== "default" || nudgeDismissed(),
  );
  if (hidden) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(NUDGE_KEY, "1");
    } catch {
      // blocked storage: hidden for this session only
    }
    setHidden(true);
  };
  return (
    <div className="notify-nudge" role="status">
      <Icon name="bell" size={16} />
      <p>Get notified about mentions and direct messages.</p>
      <button className="icon-btn" aria-label="Dismiss" onClick={dismiss}>
        <Icon name="x" size={16} />
      </button>
      <button className="btn small primary" onClick={() => setNotify(true).finally(() => setHidden(true))}>
        Turn on notifications
      </button>
    </div>
  );
}

function MeBar({ c }: { c: Community }) {
  const profile = useApp((s) => s.profile);
  const me = c.me;
  return (
    <div className="mebar">
      <button
        className="me-btn"
        disabled={!me}
        onClick={(e) => me && set({ popover: { url: c.url, memberId: me.id, rect: e.currentTarget.getBoundingClientRect() } })}
      >
        <Avatar m={me} size={32} presence />
        <span className="me-text">
          <b className="truncate">{me?.displayName ?? profile?.displayName ?? "You"}</b>
          <small className="truncate">{me?.statusText || me?.statusEmoji ? `${me.statusEmoji} ${me.statusText}`.trim() : (me ? "Online" : c.status === "join" ? "Not a member" : "Connecting…")}</small>
        </span>
      </button>
      <button className="icon-btn" aria-label="Settings" title="Settings" onClick={() => set({ modal: { t: "settings" } })}>
        <Icon name="gear" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

function SignIn() {
  const err = useApp((s) => s.authError);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current!;
    return pond(el, el.querySelector(".holo")!, [...el.querySelectorAll<HTMLElement>(".signin-lede, .signin-actions, .fine")]);
  }, []);
  return (
    <div className="signin" ref={root}>
      <div className="signin-body">
        <h1 className="wordmark">
          <span className="holo">
            <span className="holo-card">
              <img src="/logo.png" alt="" draggable={false} />
            </span>
          </span>
          Sblurp
        </h1>
        <p className="signin-lede">Every community you belong to, in one window. Each runs its own server; your sign-in works in all of them.</p>
        <div className="signin-actions">
          <button className="btn primary big" onClick={() => signIn(false)}>
            Sign in
          </button>
          <button className="btn big" onClick={() => signIn(true)}>
            Create an account
          </button>
        </div>
        {err && (
          <p className="error" role="alert">
            {err}
          </p>
        )}
        <p className="fine">Communities only see the profile details you choose to share with them.</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------

function JoinCard({ url }: { url: string }) {
  const [info, setInfo] = useState<GetServerInfoResponse | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    probe(url).then(setInfo, (e) => setErr(errorText(e, hostOf(url))));
  }, [url]);
  return (
    <div className="empty">
      <div className="card join-card">
        {info ? (
          <JoinConsent url={url} info={info} invite="" />
        ) : err ? (
          <>
            <h2>Can't reach {hostOf(url)}</h2>
            <p className="muted">{err}</p>
            <div className="row-end">
              <button className="btn" onClick={() => leave(url)}>
                Remove
              </button>
            </div>
          </>
        ) : (
          <p className="muted">Looking up {hostOf(url)}…</p>
        )}
      </div>
    </div>
  );
}

function JoinConsent({ url, info, invite, onBack }: { url: string; info: GetServerInfoResponse; invite: string; onBack?: () => void }) {
  const profile = useApp((s) => s.profile);
  const [share, setShare] = useState({ displayName: true, avatarUrl: true, bio: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [code, setCode] = useState(invite);
  const [answers, setAnswers] = useState(() => info.joinQuestions.map(() => ""));
  const fields = [
    { k: "displayName" as const, label: "Display name", value: profile?.displayName ?? "" },
    { k: "avatarUrl" as const, label: "Avatar", value: profile?.avatarUrl ?? "" },
    { k: "bio" as const, label: "Bio", value: profile?.bio ?? "" },
  ];
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const pick = (k: (typeof fields)[number]["k"]) => (share[k] ? fields.find((f) => f.k === k)!.value : "");
      await join(url, { displayName: pick("displayName"), avatarUrl: pick("avatarUrl"), bio: pick("bio") }, code.trim(), info, answers);
    } catch (x) {
      // A refusal is permission_denied: a bad invite code, or a reason from the community's join check.
      const ce = ConnectError.from(x);
      if (ce.code !== Code.PermissionDenied) setErr(errorText(x, info.name));
      else if (info.inviteOnly && /invite/i.test(ce.rawMessage)) setErr("That invite code doesn't work. It may have expired or been used up.");
      else setErr(sentence(ce.rawMessage));
      setBusy(false);
    }
  };
  return (
    <form className="consent" onSubmit={submit}>
      <div className="consent-head">
        <CommunityIcon name={info.name} icon={info.iconUrl ? absUrl(url, info.iconUrl) : ""} accent={info.accentColor} size={64} />
        <div>
          <h2>{info.name}</h2>
          <p className="muted small">
            {hostOf(url)}
            {info.memberCount > 0 && <> &nbsp;&nbsp;{count(info.memberCount, "member", "members")}</>}
          </p>
        </div>
      </div>
      {info.description && <p className="consent-desc">{info.description}</p>}
      {info.inviteOnly && (
        <label className="field">
          <b>Invite code</b>
          <input
            className="input"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            spellCheck={false}
            autoCapitalize="characters"
            placeholder="From your invite link"
          />
          <small className="muted">{info.name} is invite only.</small>
        </label>
      )}
      {info.joinQuestions.length > 0 && (
        <fieldset className="join-questions">
          <legend>{info.name} asks before you join</legend>
          {info.joinQuestions.map((q, i) => (
            <label className="field" key={i}>
              <b>{q}</b>
              <textarea
                className="input textarea"
                rows={2}
                required
                maxLength={1000}
                value={answers[i]}
                onChange={(e) => setAnswers(answers.map((a, j) => (j === i ? e.target.value : a)))}
              />
            </label>
          ))}
        </fieldset>
      )}
      <h3>Share your profile with {info.name}?</h3>
      <ul className="consent-fields">
        {fields.map((f) => (
          <li key={f.k}>
            <label>
              <span className="consent-field">
                <b>{f.label}</b>
                {f.k === "avatarUrl" && f.value ? (
                  <img src={f.value} alt="" className="consent-avatar" />
                ) : (
                  <small className="truncate">{f.value || `No ${f.label.toLowerCase()} set`}</small>
                )}
              </span>
              <input
                type="checkbox"
                role="switch"
                className="switch"
                disabled={!f.value}
                checked={share[f.k] && !!f.value}
                onChange={(e) => setShare({ ...share, [f.k]: e.target.checked })}
              />
            </label>
          </li>
        ))}
      </ul>
      <p className="fine">
        {info.name} gets only what is switched on. Your email and the rest of your sblurp.chat account stay private.
      </p>
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      <div className="row-end">
        {onBack && (
          <button type="button" className="btn ghost" onClick={onBack}>
            Back
          </button>
        )}
        <button className="btn primary" disabled={busy}>
          {busy ? "Joining…" : `Join ${info.name}`}
        </button>
      </div>
    </form>
  );
}

function AddCommunity({ input: given }: { input?: string }) {
  const order = useApp((s) => s.order);
  const [input, setInput] = useState(given ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [found, setFound] = useState<{ url: string; invite: string; info: GetServerInfoResponse } | null>(null);
  // Opened from an invite link: look it up right away and land on the consent step.
  useEffect(() => void (given && lookUp(given)), []);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    lookUp(input);
  };
  const lookUp = async (input: string) => {
    const n = normalizeCommunityUrl(input, AUTH_URL);
    if (!n) return setErr("Enter a community address, like nightowls.chat, or paste an invite link.");
    setBusy(true);
    setErr("");
    try {
      const info = await probe(n.url);
      const base = (info.baseUrl || n.url).replace(/\/+$/, "");
      if (order.includes(base)) {
        set({ modal: null });
        selectCommunity(base);
        return;
      }
      setFound({ url: n.url, invite: n.invite, info });
    } catch (x) {
      setErr(errorText(x, hostOf(n.url)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog label="Add a community" className="add">
      {found ? (
        <JoinConsent {...found} onBack={() => setFound(null)} />
      ) : (
        <form onSubmit={submit}>
          <h2>Add a community</h2>
          <p className="muted">Enter its address or paste an invite link.</p>
          <input
            className="input big"
            autoFocus={AUTOFOCUS}
            aria-label="Community address or invite link"
            placeholder="nightowls.chat"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            aria-invalid={!!err}
            spellCheck={false}
            autoCapitalize="off"
          />
          {err && (
            <p className="error" role="alert">
              {err}
            </p>
          )}
          {FAKE && !err && <p className="fine">Demo mode: try letterpress.club</p>}
          <p className="fine">
            Each community runs on its own server, so you join one by its address. Want to start your own?{" "}
            <a href={SELF_HOST_DOCS_URL} target="_blank" rel="noopener noreferrer">
              Read how to run a server
            </a>
            .
          </p>
          <div className="row-end">
            <button type="button" className="btn ghost" onClick={() => set({ modal: null })}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy || !input.trim()}>
              {busy ? "Looking it up…" : "Continue"}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function Modals() {
  const modal = useApp((s) => s.modal);
  switch (modal?.t) {
    case "settings":
      return <Settings start={modal.page} />;
    case "add":
      return <AddCommunity input={modal.input} />;
    case "switcher":
      return <Switcher />;
    case "info":
    case "invite":
    case "leave":
      return <CommunityDialog kind={modal.t} />;
    case "delete":
      return <DeleteConfirm id={modal.id} />;
    case "channel":
      return <ChannelDialog key={modal.id ?? "new"} id={modal.id} category={modal.category} name={modal.name} focusTopic={modal.focusTopic} />;
    case "community":
      return <CommunitySettings tab={modal.tab} focusDesc={modal.focusDesc} />;
    case "newdm":
      return <NewMessage />;
    case "browse":
      return <BrowseChannels />;
    case "keys":
      return <KeyboardShortcuts />;
    case "profile":
      return <EditProfile focusPic={modal.focusPic} />;
    case "remove":
      return <RemoveMember {...modal} />;
    case "block":
      return <BlockMember {...modal} />;
    case "report":
      return <ReportDialog {...modal} />;
    case "reports":
      return <ReportsDialog />;
    case "setup":
      return <SetupWizard />;
    case "lightbox":
      return (
        <Dialog label={modal.name} className="lightbox">
          {/* Full screen (1312): a tap on the dark around the picture closes it, like the backdrop did. */}
          {modal.video ? (
            <div className="lightbox-stage" onClick={(e) => e.target === e.currentTarget && set({ modal: null })}>
              <video src={modal.src} controls autoPlay playsInline aria-label={modal.name} />
            </div>
          ) : (
            <ZoomStage src={modal.src} alt={modal.name} onClose={() => set({ modal: null })} />
          )}
          <div className="lightbox-bar">
            <span className="truncate">{modal.name}</span>
            <a className="btn ghost small" href={modal.src} target="_blank" rel="noopener noreferrer">
              Open original
            </a>
            <button className="icon-btn" aria-label="Close" onClick={() => set({ modal: null })}>
              <Icon name="x" />
            </button>
          </div>
        </Dialog>
      );
    default:
      return null;
  }
}

const THEME_NAMES: Record<Theme, string> = {
  system: "Same as device",
  light: "Light",
  dark: "Dark",
  midnight: "Midnight",
  contrast: "High contrast",
  cvd: "Colorblind safe",
  cola: "Cherry cola",
  mint: "Mint",
  clementine: "Clementine",
  fjord: "Fjord",
  sand: "Sand",
  grape: "Grape",
  black: "Black",
  ash: "Ash",
  neon: "Neon",
  phosphor: "Phosphor",
  klein: "Klein",
  chrome: "Chrome",
  custom: "Custom",
};
const FONT_NAMES: Record<Look["font"], string> = {
  default: "Default",
  schibsted: "Schibsted Grotesk",
  system: "System",
  inter: "Inter",
  serif: "Source Serif",
  "pt-mono": "PT Mono",
  iosevka: "Iosevka",
};
const ACCENTS: [string, string][] = [
  ["", "Theme default"],
  ["#d0306a", "Raspberry"],
  ["#e2681a", "Tangerine"],
  ["#4f9a1f", "Lime"],
  ["#0f8b8d", "Teal"],
  ["#8247d6", "Grape"],
];

/** A row of radio buttons styled as a segmented control. */
function Choice<K extends keyof Look>({ k, label, options }: { k: K; label: string; options: [Look[K], string][] }) {
  const v = useApp((s) => s.look[k]);
  return (
    <fieldset className="choice">
      <legend>{label}</legend>
      <div className="seg">
        {options.map(([o, name]) => (
          <label key={String(o)}>
            <input type="radio" name={k} checked={v === o} onChange={() => setLook({ [k]: o })} />
            {name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const SAMPLE = [
  { who: create(MemberSchema, { id: "mei", username: "mei", displayName: "Mei Chen" }), at: 9 * 60 + 41, text: "Kiln's loaded. Firing starts at six.", head: true },
  { who: null, at: 9 * 60 + 42, text: "Bring a jumper, the shed gets cold.", head: false },
  { who: create(MemberSchema, { id: "ana", username: "ana", displayName: "Ana Ruiz" }), at: 13 * 60 + 5, text: "Saving you both a seat by the window.", head: true },
];

/** Slack-style custom theme: six base colors, the rest derived, shared as a pasted string. */
function CustomTheme() {
  const custom = useApp((s) => s.look.custom);
  const colors = custom.split(",");
  const { fixed } = customTheme(colors);
  const [paste, setPaste] = useState("");
  const [bad, setBad] = useState(false);
  const apply = (e: FormEvent) => {
    e.preventDefault();
    const c = parseThemeString(paste);
    setBad(!c);
    if (!c) return;
    setLook({ custom: themeString(c) });
    setPaste("");
  };
  return (
    <fieldset className="choice custom-theme">
      <legend>Custom theme</legend>
      <div className="custom-colors">
        {CUSTOM_COLORS.map((name, i) => (
          <label key={name}>
            <input type="color" value={colors[i]} onChange={(e) => setLook({ custom: themeString(colors.map((c, j) => (j === i ? e.target.value : c))) })} />
            {name}
          </label>
        ))}
      </div>
      {fixed.length > 0 && (
        <p className="fine custom-warn">
          <Icon name="info" size={16} /> {fixed.join(" and ")} {fixed.length > 1 ? "were" : "was"} hard to read on the background, so Sblurp changed {fixed.length > 1 ? "them" : "it"}.
        </p>
      )}
      <div className="copy-row">
        <input className="input" readOnly value={custom} aria-label="Theme to share" onFocus={(e) => e.target.select()} />
        <CopyButton text={custom} />
      </div>
      <form className="copy-row" onSubmit={apply}>
        <input
          className="input"
          aria-label="Paste a theme"
          placeholder="Paste a theme: #171925,#e7e9f2,…"
          value={paste}
          aria-invalid={bad}
          onChange={(e) => (setPaste(e.target.value), setBad(false))}
        />
        <button className="btn" disabled={!paste.trim()}>
          Apply
        </button>
      </form>
      {bad && (
        <p className="error custom-warn" role="alert">
          That is not a theme. Paste six colors with commas between them, like the one above.
        </p>
      )}
    </fieldset>
  );
}

function Appearance() {
  const look = useApp((s) => s.look);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const custom = !!look.accent && !ACCENTS.some(([a]) => a === look.accent);
  // Same avatar and name color as the person in the open community, when they are in it.
  const c = useApp((s) => s.cs[s.url]);
  const surfaces = useApp((s) => s.surfaces);
  const who = (m: Member) => Object.values(c?.members ?? {}).find((x) => x.username === m.username) ?? m;
  return (
    <section className="appearance">
      <h3>
        Appearance <small className="scope">Saved to your account</small>
      </h3>
      <div className="preview" inert aria-hidden="true">
        {SAMPLE.map((m, i) => (
          <article key={i} className="msg" data-head={m.head}>
            <div className="msg-gutter">
              {m.who && (
                <span className="avatar-btn">
                  <Avatar m={who(m.who)} />
                </span>
              )}
              <span className="hover-time">
                <time>{timeLabel(today.getTime() + m.at * 60_000, look.clock === "24")}</time>
              </span>
            </div>
            <div className="msg-body">
              {m.who && (
                <header className="msg-head">
                  <span className="name" style={{ color: nameColor(who(m.who), c?.roles ?? [], surfaces) || undefined }}>
                    {m.who.displayName}
                  </span>
                  <time>{timeLabel(today.getTime() + m.at * 60_000, look.clock === "24")}</time>
                </header>
              )}
              <div className="msg-text">
                <p>{m.text}</p>
              </div>
            </div>
          </article>
        ))}
      </div>
      <fieldset className="choice">
        <legend>Theme</legend>
        <div className="theme-pick">
          {THEMES.map((t) => (
            <label key={t} className="theme-opt">
              <input type="radio" name="theme" checked={look.theme === t} onChange={() => (t === "custom" ? startCustomTheme() : setLook({ theme: t }))} />
              {t === "custom" ? (
                <span className="theme-swatch" data-empty={!look.custom} aria-hidden="true" style={look.custom ? customTheme(look.custom.split(",")).tokens : undefined}>
                  {look.custom ? (
                    <>
                      <i />
                      <i />
                      <i>
                        <b />
                        <b />
                      </i>
                    </>
                  ) : (
                    <Icon name="sliders" />
                  )}
                </span>
              ) : t === "system" ? (
                <span className="theme-swatch split" aria-hidden="true">
                  {(["light", "dark"] as const).map((half) => (
                    <span key={half} className="theme-swatch" data-theme={half}>
                      <i />
                      <i />
                      <i>
                        <b />
                        <b />
                      </i>
                    </span>
                  ))}
                </span>
              ) : (
                <span className="theme-swatch" data-theme={t} aria-hidden="true">
                  <i />
                  <i />
                  <i>
                    <b />
                    <b />
                  </i>
                </span>
              )}
              <span className="theme-name">{THEME_NAMES[t]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {look.theme === "custom" ? (
        <CustomTheme />
      ) : (
      <fieldset className="choice">
        <legend>Accent color</legend>
        <div className="accents">
          {ACCENTS.map(([a, name]) => (
            <label key={name} className="accent-opt" title={name}>
              <input type="radio" name="accent" aria-label={name} checked={look.accent === a} onChange={() => setLook({ accent: a })} />
              <span style={{ background: a || "var(--raspberry)" }} data-default={!a} />
            </label>
          ))}
          <label className="accent-opt custom" title="Custom color">
            <input
              type="color"
              aria-label="Custom accent color"
              value={look.accent || "#3550f0"}
              data-checked={custom}
              onChange={(e) => setLook({ accent: e.target.value })}
            />
          </label>
        </div>
        <small className="fine">If text on the color is hard to read, Sblurp changes the color a little.</small>
      </fieldset>
      )}
      {/* Phones show IRC as compact (1424). */}
      <Choice
        k="density"
        label="Messages"
        options={[
          ["cozy", "Cozy"],
          ["compact", "Compact"],
          ["irc", "IRC"],
        ]}
      />
      {/* Phones always use the compact sidebar (1364). */}
      <div className="desk-only">
      <Choice
        k="sidebar"
        label="Sidebar"
        options={[
          ["cozy", "Cozy"],
          ["compact", "Compact"],
        ]}
      />
      </div>
      <label className="choice size">
        <span className="legend">Font</span>
        <select className="input" value={look.font} onChange={(e) => setLook({ font: e.target.value as Look["font"] })}>
          {Object.entries(FONT_NAMES).map(([f, name]) => (
            <option key={f} value={f}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label className="choice size">
        <span className="legend">
          Text size <span>{look.fontSize}px</span>
        </span>
        <input type="range" min={12} max={20} step={1} aria-valuetext={`${look.fontSize} pixels`} value={look.fontSize} onChange={(e) => setLook({ fontSize: +e.target.value })} />
      </label>
      <Choice
        k="clock"
        label="Clock"
        options={[
          ["12", "12-hour"],
          ["24", "24-hour"],
        ]}
      />
      <Choice
        k="motion"
        label="Less motion"
        options={[
          ["system", "Device"],
          ["reduce", "On"],
          ["full", "Off"],
        ]}
      />
    </section>
  );
}

const PAGES: Record<SettingsPage, [string, IconName]> = {
  appearance: ["Appearance", "sliders"],
  notifications: ["Notifications", "bell"],
  links: ["Links", "link"],
  blocked: ["Blocked people", "ban"],
  account: ["Account", "user"],
};

/** Settings. On a phone (1368, 1370) it is a short list of grouped rows, and each row opens its
 *  own page with a back button in the top bar, like iOS Settings. Opened at `start` from the You
 *  tab (1418), back goes back to the tab. */
function Settings({ start }: { start?: SettingsPage }) {
  const narrow = useSyncExternalStore(onNarrow, () => NARROW.matches);
  const [page, setPage] = useState<SettingsPage | null>(start ?? null);
  const last = useRef<SettingsPage | null>(null);
  const listRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (page) last.current = page;
    autoFocusTo(page ? document.querySelector(".settings-back") : listRef.current?.querySelector(`[data-page="${last.current}"]`));
  }, [page]);
  const sub = narrow ? page : null;
  const body = {
    appearance: <Appearance />,
    notifications: <Notifications />,
    links: <LinksSetting />,
    blocked: <BlockedList />,
    account: <Account />,
  };
  return (
    <Dialog label="Settings" className="settings">
      <header className="dialog-head">
        {sub && (
          <button className="icon-btn settings-back" aria-label={start ? "Back to You" : "Back to Settings"} onClick={() => (start ? set({ modal: null }) : setPage(null))}>
            <Icon name="back" />
          </button>
        )}
        <div>
          <h2>{sub ? PAGES[sub][0] : "Settings"}</h2>
          <p className="dialog-sub">These apply in all your communities.</p>
        </div>
        {!sub && (
          <button className="icon-btn" aria-label="Close" onClick={() => set({ modal: null })}>
            <Icon name="x" />
          </button>
        )}
      </header>
      {sub ? (
        <div className="settings-page" key={sub}>
          {body[sub]}
        </div>
      ) : narrow ? (
        <nav className="settings-list" aria-label="Settings" ref={listRef}>
          {settingsGroups(sheetApp).map((g) => (
            <ul key={g[0]}>
              {g.map((p) => (
                <li key={p}>
                  <button data-page={p} onClick={() => setPage(p)}>
                    <Icon name={PAGES[p][1]} />
                    <span>{PAGES[p][0]}</span>
                    <Icon name="chevron" />
                  </button>
                </li>
              ))}
            </ul>
          ))}
        </nav>
      ) : (
        <>
          <Appearance />
          <Notifications />
          <BlockedList />
          <LinksSetting />
          <section>
            <h3>Keyboard</h3>
            <button className="btn small" aria-keyshortcuts={`${MOD === "⌘" ? "Meta" : "Control"}+/`} onClick={() => set({ modal: { t: "keys" } })}>
              Keyboard shortcuts <kbd>{MOD}</kbd> <kbd>/</kbd>
            </button>
          </section>
          <section>
            <h3>Get the apps</h3>
            <ul className="download-list">
              {offered(DOWNLOADS, appPlatform(nativeApp(), navigator.userAgent, navigator.maxTouchPoints > 1)).map((d) => (
                <li key={d.id}>
                  <svg className="platform-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d={d.icon} />
                  </svg>
                  <span>
                    <b>{d.name}</b>
                    {d.hint && <small>{d.hint}</small>}
                  </span>
                  {d.url ? (
                    <a className="btn small" href={d.url} target="_blank" rel="noopener noreferrer">
                      {d.action}
                      {d.action === "Download" && <span className="visually-hidden"> for {d.name}</span>} <Icon name="external" size={14} />
                    </a>
                  ) : (
                    <span className="soon">{d.action}</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
          <Account />
        </>
      )}
    </Dialog>
  );
}

function Notifications() {
  if (iosApp()) return <PushSetting />;
  return <WebNotifications />;
}

function WebNotifications() {
  const notify = useApp((s) => s.notify);
  const denied = typeof Notification !== "undefined" && Notification.permission === "denied";
  return (
    <section>
      <h3>
        Notifications <small className="scope">On this device</small>
      </h3>
      <label className="toggle-row">
        <span>
          <b>Mentions and direct messages</b>
          <small>Get an alert when Sblurp is not open.</small>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          checked={notify && !denied}
          disabled={denied}
          onChange={(e) => setNotify(e.target.checked)}
        />
      </label>
      {denied && <p className="error small">Your browser blocks alerts from Sblurp. Allow them in the browser settings, then turn this on.</p>}
    </section>
  );
}

function Account() {
  const profile = useApp((s) => s.profile);
  return (
    <section>
      <h3>Account</h3>
      <div className="account-row">
        <span>
          <b>{profile?.displayName}</b>
          <small>@{profile?.username} on sblurp.chat</small>
        </span>
        <a className="btn small" href={ACCOUNT_URL} target="_blank" rel="noopener noreferrer">
          Manage account <Icon name="external" size={14} />
        </a>
      </div>
      <button className="btn danger-ghost" onClick={signOut}>
        Sign out
      </button>
    </section>
  );
}

function BlockedList() {
  const order = useApp((s) => s.order);
  const cs = useApp((s) => s.cs);
  const rows = useMemo(() => blockedRows(order, cs), [order, cs]);
  const [err, setErr] = useState("");
  return (
    <section>
      <h3>
        Blocked people <small className="scope">In each community</small>
      </h3>
      {rows.length ? (
        <ul className="blocked-list">
          {rows.map((r) => (
            <li key={`${r.url} ${r.id}`}>
              <Avatar m={cs[r.url]?.members[r.id]} size={28} />
              <span className="truncate">
                <b>{r.name}</b>
                <small>{r.community}</small>
              </span>
              <button className="btn small" onClick={() => (setErr(""), setBlocked(r.url, r.id, false).catch((e) => setErr(errorText(e))))}>
                Unblock
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">You have not blocked anyone. To block a person, open their profile.</p>
      )}
      {err && (
        <p className="error small" role="alert">
          {err}
        </p>
      )}
    </section>
  );
}

function Switcher() {
  const cs = useApp((s) => s.cs);
  const order = useApp((s) => s.order);
  const current = useApp((s) => s.url);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const items = useMemo(() => {
    const all = order.flatMap((u) => {
      const c = cs[u];
      if (!c?.me) return [];
      return Object.values(c.channels).map((ch) => {
        const rs = c.reads[ch.id];
        const label = channelLabel(ch, c.members, c.me?.id);
        return { u, c, ch, label, unread: (rs?.unreadCount ?? 0) > 0, mentions: rs?.mentionCount ?? 0 };
      });
    });
    return all
      .map((x) => ({ ...x, score: matchScore(q, x.label) + (x.unread ? 5 : 0) + (x.u === current ? 2 : 0) }))
      .filter((x) => x.score >= 0 && (q || x.unread || x.u === current))
      .sort((a, b) => b.score - a.score)
      .slice(0, 40);
  }, [cs, order, q, current]);
  const pick = (i: number) => {
    const x = items[i];
    if (!x) return;
    set({ modal: null });
    selectChannel(x.u, x.ch.id);
  };
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [sel]);
  return (
    <Dialog label="Jump to a channel" className="switcher">
      <div className="switcher-input">
        <Icon name="search" />
        <input
          autoFocus
          role="combobox"
          aria-label="Jump to a channel or person"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls="switcher-list"
          aria-activedescendant={items[sel] ? `sw-${sel}` : undefined}
          placeholder="Jump to a channel or person"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            const d = listStep(e);
            if (d) setSel((s) => Math.max(0, Math.min(items.length - 1, s + d)));
            else if (e.key === "Enter") pick(sel);
            else return;
            e.preventDefault();
          }}
        />
      </div>
      <ul id="switcher-list" role="listbox" ref={listRef} aria-label="Channels">
        {items.map((x, i) => {
          const other = isDM(x.ch) ? x.c.members[dmPeer(x.ch, x.c.me?.id)] : undefined;
          return (
            <li
              key={`${x.u} ${x.ch.id}`}
              id={`sw-${i}`}
              role="option"
              aria-selected={i === sel}
              data-unread={x.unread}
              onMouseMove={() => setSel(i)}
              onClick={() => pick(i)}
            >
              {isDM(x.ch) ? (
                <Avatar m={other} size={22} />
              ) : (
                <span className="chan-icon">
                  <Icon name="hash" size={16} />
                </span>
              )}
              <span className="truncate">{x.label}</span>
              {x.unread && <span className="visually-hidden">, unread</span>}
              {x.mentions > 0 && (
                <span className="badge">
                  {x.mentions}
                  <span className="visually-hidden"> {x.mentions === 1 ? "mention" : "mentions"}</span>
                </span>
              )}
              <span className="sw-community">
                <CommunityIcon name={x.c.info?.name ?? ""} icon={x.c.info?.iconUrl ? absUrl(x.u, x.c.info.iconUrl) : ""} accent={x.c.info?.accentColor} size={18} />
                <span className="truncate">{x.c.info?.name ?? hostOf(x.u)}</span>
              </span>
            </li>
          );
        })}
        {!items.length && <li className="sw-empty">{q ? `Nothing matches “${q}”.` : "Type a channel or person's name."}</li>}
      </ul>
      <p className="switcher-hint">
        <kbd>↑</kbd> <kbd>↓</kbd> to move, <kbd>Enter</kbd> to open, <kbd>Esc</kbd> to close
      </p>
    </Dialog>
  );
}

function LeaveDialog({ c, name }: { c: Community; name: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  return (
    <Dialog label={`Leave ${name}`} className="confirm">
      <h2>Leave {name}?</h2>
      <p className="muted">
        You stop being a member of {name} and it leaves your rail. Your messages stay on its server, and you can join again with its address.
      </p>
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      <div className="row-end">
        <button className="btn ghost" autoFocus={AUTOFOCUS} onClick={() => set({ modal: null })}>
          Cancel
        </button>
        <button
          className="btn danger"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setErr("");
            leaveCommunity(c.url).catch((e) => {
              setErr(errorText(e, name));
              setBusy(false);
            });
          }}
        >
          {busy ? "Leaving…" : "Leave"}
        </button>
      </div>
    </Dialog>
  );
}

function CommunityDialog({ kind }: { kind: "info" | "invite" | "leave" }) {
  const c = useApp((s) => s.cs[s.url]);
  if (!c) return null;
  const name = c.info?.name ?? hostOf(c.url);
  const close = () => set({ modal: null });
  if (kind === "leave") return <LeaveDialog c={c} name={name} />;
  return (
    <Dialog label={kind === "info" ? name : `Invite people to ${name}`} className="community-dialog">
      <header className="dialog-head">
        <CommunityIcon name={name} icon={c.info?.iconUrl ? absUrl(c.url, c.info.iconUrl) : ""} accent={c.info?.accentColor} size={56} />
        <div>
          <h2>{kind === "info" ? name : `Invite people to ${name}`}</h2>
          <p className="muted small">{count(c.info?.memberCount ?? Object.keys(c.members).length, "member", "members")}</p>
        </div>
        <button className="icon-btn" aria-label="Close" onClick={close}>
          <Icon name="x" />
        </button>
      </header>
      {kind === "info" ? (
        <p>{c.info?.description || "This community has no description."}</p>
      ) : (c.me?.role ?? 0) >= MemberRole.ADMIN ? (
        <Invites url={c.url} inviteOnly={!!c.info?.inviteOnly} />
      ) : c.info?.inviteOnly ? (
        <p className="muted">{name} is invite only. Ask an admin for an invite link.</p>
      ) : (
        <p className="muted">Share this address. Anyone with a sblurp.chat account can add it and join.</p>
      )}
      {(kind === "info" || !c.info?.inviteOnly) && (
        <div className="copy-row">
          <input className="input" readOnly value={c.url} aria-label="Community address" onFocus={(e) => e.target.select()} />
          <CopyButton text={c.url} />
        </div>
      )}
    </Dialog>
  );
}

export const MOD = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";
const KEYS: [keys: string[][], what: string][] = [
  [[[MOD, "K"]], "Jump to a channel or person"],
  [[[MOD, "/"]], "Show keyboard shortcuts"],
  [[["Alt", "↑"], ["Alt", "↓"]], "Previous or next channel"],
  [[["Alt", "Shift", "↑"], ["Alt", "Shift", "↓"]], "Previous or next unread channel"],
  [[["Shift", "Esc"]], "Mark everything in this community as read"],
  [[["Esc"]], "Cancel an edit, close the side panel or menu"],
  [[["Enter"]], "Send a message"],
  [[["Shift", "Enter"]], "New line in a message"],
  [[[MOD, "Shift", "Enter"]], "Post the message box as a snippet, for long code or text"],
  [[["Shift", "Drop"]], "Send dropped files right away, without the message box"],
  [[["↑"]], "Edit your last message, from an empty message box"],
  [[["Tab"]], "Move to the message list; Tab again reaches a message's actions"],
  [[["↑"], ["↓"]], "Move between messages in the list"],
  [[["Home"], ["End"]], "First or last loaded message"],
  [[["Alt", "Shift", "↑"], ["Alt", "Shift", "↓"]], "Move the focused community up or down the rail"],
];

function KeyboardShortcuts() {
  return (
    <Dialog label="Keyboard shortcuts" className="keys">
      <header className="dialog-head">
        <h2>Keyboard shortcuts</h2>
        <button className="icon-btn" aria-label="Close" onClick={() => set({ modal: null })}>
          <Icon name="x" />
        </button>
      </header>
      <dl className="keys-list">
        {KEYS.map(([combos, what]) => (
          <div key={what}>
            <dt>
              {combos.map((c, i) => (
                <span key={i}>
                  {i > 0 && <span className="muted"> or </span>}
                  {c.map((k) => (
                    <kbd key={k}>{k}</kbd>
                  ))}
                </span>
              ))}
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}

function BrowseChannels() {
  const c = useApp((s) => s.cs[s.url]);
  const url = c?.url ?? "";
  const [all, setAll] = useState<Channel[] | null>(null);
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const load = () => browseChannels(url).then(setAll, (x) => setErr(errorText(x)));
  const admin = (c?.me?.role ?? 0) >= MemberRole.ADMIN;
  const create = (name = "") => set({ modal: { t: "channel", name } });
  useEffect(() => {
    if (url) load();
  }, [url]);
  if (!c) return null;
  const rows = browseList(all ?? [], c.channels, q);
  const act = (id: string, f: () => Promise<unknown>) => {
    setBusy(id);
    setErr("");
    f().then(
      () => (setBusy(""), load()),
      (x) => (setBusy(""), setErr(errorText(x))),
    );
  };
  return (
    <Dialog label="Browse channels" className="browse">
      <header className="dialog-head">
        <h2>Browse channels</h2>
        {admin && (
          <button className="btn small" onClick={() => create()}>
            <Icon name="plus" size={16} /> Create channel
          </button>
        )}
        <button className="icon-btn" aria-label="Close" onClick={() => set({ modal: null })}>
          <Icon name="x" />
        </button>
      </header>
      <input className="input" type="search" aria-label="Search channels" placeholder="Search by name or topic" value={q} onChange={(e) => setQ(e.target.value)} autoFocus={AUTOFOCUS} />
      {err && (
        <p className="error small" role="alert">
          {err}
        </p>
      )}
      {!all && !err && <Skeleton rows={5} className="skel-browse" />}
      {all && !rows.length && (
        <p className="fine">
          {q ? `No channel matches "${q}".` : "There are no channels you can join yet."}{" "}
          {admin && channelSlug(q) && (
            <button className="link-btn" onClick={() => create(q)}>
              Create #{channelSlug(q)}
            </button>
          )}
        </p>
      )}
      <ul className="browse-list" aria-busy={!all && !err}>
        {rows.map(({ ch, joined }) => (
          <li key={ch.id}>
            <button
              className="browse-open"
              onClick={() => {
                if (joined) selectChannel(url, ch.id);
                else peekChannel(url, ch);
                set({ modal: null });
              }}
            >
              <b>
                <Icon name={ch.kind === ChannelKind.PRIVATE ? "lock" : "hash"} size={16} />
                {ch.name}
                {joined && <span className="tag">Joined</span>}
              </b>
              {browseDetail(ch) && <small className="truncate">{browseDetail(ch)}</small>}
            </button>
            {joined ? (
              !ch.isDefault && <button className="btn small" disabled={busy === ch.id} aria-label={`Leave #${ch.name}`} onClick={() => act(ch.id, () => leaveChannel(url, ch.id))}>
                Leave
              </button>
            ) : (
              <button className="btn small primary" disabled={busy === ch.id} aria-label={`Join #${ch.name}`} onClick={() => act(ch.id, () => joinChannel(url, ch.id))}>
                Join
              </button>
            )}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

function NewMessage() {
  const cs = useApp((s) => s.cs);
  const order = useApp((s) => s.order);
  const current = useApp((s) => s.url);
  // The DMs tab spans every community, so say which one the DM is in and let it change (1454).
  const [url, setUrl] = useState(current);
  const c = cs[url];
  const joined = order.filter((u) => cs[u]?.me);
  if (!c?.me) return null;
  const close = () => set({ modal: null });
  return (
    <PeoplePicker
      key={url}
      c={c}
      title="New message"
      exclude={[]}
      max={8}
      action={(n) => (n > 1 ? "Start group message" : "Message")}
      busyText="Opening…"
      empty="Nobody else is here yet."
      onSubmit={(ids) => openDM(c.url, ids)}
      onClose={close}
    >
      {joined.length > 1 && (
        <label className="field">
          <b>Community</b>
          <select className="input" value={url} onChange={(e) => setUrl(e.target.value)}>
            {joined.map((u) => (
              <option key={u} value={u}>
                {cs[u].info?.name ?? hostOf(u)}
              </option>
            ))}
          </select>
        </label>
      )}
    </PeoplePicker>
  );
}

function EditProfile({ focusPic }: { focusPic?: boolean }) {
  const c = useApp((s) => s.cs[s.url]);
  const me = c?.me;
  const [f, setF] = useState({ displayName: me?.displayName ?? "", statusEmoji: me?.statusEmoji ?? "", statusText: me?.statusText ?? "", bio: me?.bio ?? "" });
  const [pic, setPic] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pick, setPick] = useState<DOMRect | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (!c || !me) return null;
  const name = c.info?.name ?? hostOf(c.url);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      await updateProfile(c.url, { displayName: f.displayName.trim(), statusEmoji: f.statusEmoji, statusText: f.statusText.trim(), bio: f.bio.trim(), ...(pic !== null && { avatarUrl: pic }) });
      set({ modal: null });
    } catch (x) {
      setErr(errorText(x, name));
      setBusy(false);
    }
  };
  return (
    <Dialog label="Edit profile" className="channel-dialog">
      <form className="stack" onSubmit={submit}>
        <header className="dialog-head">
          <h2>Your profile in {name}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={() => set({ modal: null })}>
            <Icon name="x" />
          </button>
        </header>
        <AvatarField url={c.url} me={me} name={name} value={pic} onChange={setPic} onBusy={setUploading} autoFocus={AUTOFOCUS && focusPic} />
        <label className="field">
          <b>Display name</b>
          <input className="input" value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} placeholder={me.username} maxLength={64} />
        </label>
        <div className="field">
          <b id="status-label">Status</b>
          <span className="row">
            <button
              type="button"
              className="btn emoji-btn"
              aria-label={f.statusEmoji ? `Status emoji ${f.statusEmoji}, change` : "Pick a status emoji"}
              onClick={(e) => setPick(e.currentTarget.getBoundingClientRect())}
            >
              {f.statusEmoji || <Icon name="smile" size={18} />}
            </button>
            <input
              className="input"
              aria-labelledby="status-label"
              value={f.statusText}
              onChange={(e) => setF({ ...f, statusText: e.target.value })}
              placeholder="What are you up to?"
              maxLength={100}
            />
            {(f.statusText || f.statusEmoji) && (
              <button type="button" className="btn ghost small" onClick={() => setF({ ...f, statusText: "", statusEmoji: "" })}>
                Clear
              </button>
            )}
          </span>
        </div>
        <label className="field">
          <b>About</b>
          <textarea className="input textarea" rows={3} value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} maxLength={500} />
        </label>
        <p className="fine">Only {name} sees this. Your sblurp.chat account doesn't change.</p>
        {err && (
          <p className="error" role="alert">
            {err}
          </p>
        )}
        <div className="row-end">
          <button type="button" className="btn ghost" onClick={() => set({ modal: null })}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || uploading}>
            Save changes
          </button>
        </div>
      </form>
      <Pop anchor={pick} onClose={() => setPick(null)} className="emoji-sheet" label="Pick a status emoji" sheet>
        <EmojiPicker
          onPick={(e) => {
            setPick(null);
            setF((x) => ({ ...x, statusEmoji: emojiChar(e) }));
          }}
        />
      </Pop>
    </Dialog>
  );
}

function DeleteConfirm({ id }: { id: string }) {
  const c = useApp((s) => s.cs[s.url]);
  const [err, setErr] = useState("");
  const m = c && Object.values(c.lists).flatMap((l) => l.items).find((x) => x.id === id);
  if (!c || !m) return null;
  const go = async () => {
    try {
      await remove(c.url, m);
      set({ modal: null });
    } catch (e) {
      setErr(errorText(e, c.info?.name));
    }
  };
  return (
    <Dialog label="Delete message" className="confirm">
      <h2>Delete message?</h2>
      <blockquote className="delete-preview">{m.text || "(attachment)"}</blockquote>
      <p className="muted">This can't be undone.</p>
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      <div className="row-end">
        <button className="btn ghost" autoFocus={AUTOFOCUS} onClick={() => set({ modal: null })}>
          Cancel
        </button>
        <button className="btn danger" onClick={go}>
          Delete
        </button>
      </div>
    </Dialog>
  );
}

/** Block, or with `mute` mute (1410), after a confirm. */
function BlockMember({ url, memberId, mute }: { url: string; memberId: string; mute?: boolean }) {
  const m = useApp((s) => s.cs[url]?.members[memberId]);
  const [err, setErr] = useState("");
  if (!m) return null;
  const name = m.displayName || m.username;
  const verb = mute ? "Mute" : "Block";
  const go = () =>
    (mute ? setMuted(url, memberId, true) : setBlocked(url, memberId, true)).then(
      () => set({ modal: null }),
      (e) => setErr(errorText(e)),
    );
  return (
    <Dialog label={`${verb} ${name}`} className="confirm">
      <h2>
        {verb} {name}?
      </h2>
      <p className="muted">
        {mute
          ? "Their messages show collapsed for you, and you skip their pings, unread counts and typing. They are not told. Unmute them any time from their profile."
          : "Neither of you can send the other direct messages, and their messages in channels show collapsed for you. They are not told. Unblock them any time from their profile or in Settings."}
      </p>
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      <div className="row-end">
        <button className="btn ghost" autoFocus={AUTOFOCUS} onClick={() => set({ modal: null })}>
          Cancel
        </button>
        <button className={mute ? "btn primary" : "btn danger"} onClick={go}>
          {verb}
        </button>
      </div>
    </Dialog>
  );
}

function RemoveMember({ url, memberId, ban }: { url: string; memberId: string; ban: boolean }) {
  const c = useApp((s) => s.cs[url]);
  const m = c?.members[memberId];
  const [err, setErr] = useState("");
  if (!c || !m) return null;
  const name = m.displayName || m.username;
  const where = c.info?.name ?? hostOf(url);
  const verb = ban ? "Ban" : "Kick";
  const go = () =>
    removeMember(url, memberId, ban).then(
      () => set({ modal: null }),
      (e) => setErr(errorText(e, where)),
    );
  return (
    <Dialog label={`${verb} ${name}`} className="confirm">
      <h2>
        {verb} {name}?
      </h2>
      <p className="muted">
        {ban
          ? `${name} is removed from ${where} and can't join again with this account.`
          : `${name} is removed from ${where}. They can join again with its address.`}
      </p>
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      <div className="row-end">
        <button className="btn ghost" autoFocus={AUTOFOCUS} onClick={() => set({ modal: null })}>
          Cancel
        </button>
        <button className="btn danger" onClick={go}>
          {verb}
        </button>
      </div>
    </Dialog>
  );
}

function ProfilePopover() {
  const p = useApp((s) => s.popover);
  const m = useApp((s) => (s.popover ? s.cs[s.popover.url]?.members[s.popover.memberId] : undefined));
  const me = useApp((s) => (s.popover ? s.cs[s.popover.url]?.me : undefined));
  const roleCount = useApp((s) => (s.popover ? s.cs[s.popover.url]?.roles.length ?? 0 : 0));
  const blocked = useApp((s) => !!s.popover && !!s.cs[s.popover.url]?.blocked.includes(s.popover.memberId));
  const muted = useApp((s) => !!s.popover && !!s.cs[s.popover.url]?.muted.includes(s.popover.memberId));
  const admin = (me?.role ?? 0) >= MemberRole.ADMIN;
  const [err, setErr] = useState("");
  const mod = m ? modActions(me, m) : { remove: false, roles: [] };
  return (
    <Pop anchor={p && m ? p.rect : null} side="right" className="profile" sheet label={m ? `${m.displayName || m.username}'s profile` : "Profile"} onClose={() => (setErr(""), set({ popover: null }))}>
      {m && p && (
        <>
          <div className="profile-band" style={{ background: "color-mix(in srgb, var(--raspberry) 18%, var(--paper))" }} />
          <div className="profile-body">
            {m.id === me?.id ? (
              <button className="avatar-edit" aria-label="Edit profile" title="Edit profile" onClick={() => set({ popover: null, modal: { t: "profile", focusPic: true } })}>
                <Avatar m={m} size={72} presence />
                <AvatarEditOverlay icon="edit" />
              </button>
            ) : (
              <Avatar m={m} size={72} presence />
            )}
            <h3>
              {m.displayName || m.username}
              {m.kind === MemberKind.BOT && <span className="tag">Bot</span>}
              {m.role > MemberRole.MEMBER && <span className="tag role">{PERMISSION[m.role]}</span>}
            </h3>
            <p className="muted">
              @{m.username}
              <span className="visually-hidden">, {presenceLabel(m.presence)}</span>
            </p>
            {(m.statusText || m.statusEmoji) && (
              <p className="profile-status">
                {m.statusEmoji} {m.statusText}
              </p>
            )}
            {(roleCount > 0 && admin) || m.roleIds.length > 0 ? (
              <>
                <h4>Roles</h4>
                <RoleChips url={p.url} m={m} edit={admin} />
              </>
            ) : null}
            {m.bio && (
              <>
                <h4>About</h4>
                <p>{m.bio}</p>
              </>
            )}
            {m.joinedAtMs > 0n && (
              <>
                <h4>Member since</h4>
                <p>{new Date(Number(m.joinedAtMs)).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</p>
              </>
            )}
            {err && (
              <p className="error small" role="alert">
                {err}
              </p>
            )}
            {m.id === me?.id ? (
              <>
                <button className="btn primary wide" onClick={() => thenCompose(openDM(p.url, m.id)).catch((e) => setErr(errorText(e)))}>
                  Message
                </button>
                <button className="btn wide" onClick={() => set({ popover: null, modal: { t: "profile" } })}>
                  Edit profile and status
                </button>
              </>
            ) : blocked ? (
              <>
                <p className="muted small">You blocked this member. Their messages show collapsed and never ping you, and neither of you can send direct messages.</p>
                <button className="btn wide" onClick={() => (setErr(""), setBlocked(p.url, m.id, false).catch((e) => setErr(errorText(e))))}>
                  Unblock
                </button>
              </>
            ) : (
              <button className="btn primary wide" onClick={() => thenCompose(openDM(p.url, m.id)).catch((e) => setErr(errorText(e)))}>
                Message
              </button>
            )}
            {mod.roles.length > 0 && (
              <label className="profile-role">
                Permission
                <select
                  className="input"
                  value={m.role}
                  onChange={(e) => (setErr(""), setRole(p.url, m.id, Number(e.target.value)).catch((x) => setErr(errorText(x))))}
                >
                  {mod.roles.map((r) => (
                    <option key={r} value={r}>
                      {PERMISSION[r]}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {(mod.remove || (m.id !== me?.id && !blocked)) && (
              <div className="row-end profile-mod">
                {m.id !== me?.id && !blocked && (
                  <button className="btn ghost small" title={muted ? undefined : "Collapse their messages and skip their pings, unread and typing. They are not told."} onClick={() => (muted ? (setErr(""), setMuted(p.url, m.id, false).catch((e) => setErr(errorText(e)))) : set({ popover: null, modal: { t: "block", url: p.url, memberId: m.id, mute: true } }))}>
                    <Icon name={muted ? "bell" : "bellOff"} size={16} /> {muted ? "Unmute" : "Mute"}
                  </button>
                )}
                {m.id !== me?.id && !blocked && (
                  <button className="btn ghost small" onClick={() => set({ popover: null, modal: { t: "block", url: p.url, memberId: m.id } })}>
                    <Icon name="ban" size={16} /> Block
                  </button>
                )}
                {mod.remove && [false, true].map((ban) => (
                  <button
                    key={String(ban)}
                    className="btn danger-ghost small"
                    onClick={() => set({ popover: null, modal: { t: "remove", url: p.url, memberId: m.id, ban } })}
                  >
                    <Icon name={ban ? "ban" : "leave"} size={16} /> {ban ? "Ban" : "Kick"}
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </Pop>
  );
}
