import { Code, ConnectError } from "@connectrpc/connect";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent } from "react";
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
  channelSlug,
  blockedRows,
} from "./logic";
import {
  absUrl,
  ACCOUNT_URL,
  SELF_HOST_DOCS_URL,
  errorText,
  FAKE,
  get,
  join,
  joinAgain,
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
import { AUTH_URL } from "./auth";
import { AvatarField } from "./AvatarField";
import { pond } from "./pond";
import { Avatar, AvatarEditOverlay, CommunityIcon, CopyButton, Dialog, Editable, EmojiPicker, emojiChar, focusMain, Icon, Markdown, menuKeys, Pop, presenceLabel, Resizer, Skeleton, useClamped } from "./ui";

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
        else if (s.pane) set({ pane: null });
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
  // On a phone the open drawer covers the channel: focus goes in, and back to the menu button when it closes.
  const was = useRef(false);
  useEffect(() => {
    if (!narrow) return;
    if (drawer) document.querySelector<HTMLElement>(".drawer [aria-current=page], .drawer button")?.focus();
    else if (was.current) document.querySelector<HTMLElement>(".menu-btn")?.focus();
    was.current = drawer;
  }, [drawer, narrow]);
  return (
    <div className="app" data-drawer={drawer || !channelId} data-pane={!!pane}>
      <button className="btn skip-link" onClick={focusMain}>
        Skip to messages
      </button>
      <div className="drawer">
        <Rail />
        {c && <Sidebar c={c} />}
      </div>
      <main className="main" tabIndex={-1} inert={covered}>
        {!url || !c ? (
          <Empty
            title="You're not in any communities yet."
            body="Add one with its address or an invite link."
            action={<button className="btn primary" onClick={() => set({ modal: { t: "add" } })}>Add a community</button>}
          />
        ) : c.status === "join" ? (
          <JoinCard url={url} />
        ) : c.status === "removed" ? (
          <Empty
            title={`You were removed from ${c.info?.name ?? hostOf(url)}`}
            body="You can't read or send messages there anymore. If you were only kicked, you can join again."
            action={
              <div className="row-end">
                <button className="btn" onClick={() => leave(url)}>
                  Remove
                </button>
                <button className="btn ghost" onClick={() => joinAgain(url)}>
                  Join again
                </button>
              </div>
            }
          />
        ) : !c.me ? (
          c.error ? (
            <Unreachable c={c} />
          ) : (
            <div className="loading-main" aria-busy="true">
              <div className="chan-head">
                <h1 className="visually-hidden">Loading {c.info?.name ?? hostOf(url)}</h1>
              </div>
              <Skeleton rows={8} avatar={36} chat className="skel-chat" />
              <div className="composer" aria-hidden="true">
                <div className="composer-box skel-composer" />
              </div>
            </div>
          )
        ) : (
          <ChannelView key={`${url} ${channelId}`} />
        )}
      </main>
      {pane && c?.me && <RightPane />}
      <Modals />
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

function Unreachable({ c }: { c: Community }) {
  const name = c.info?.name ?? hostOf(c.url);
  const secs = useCountdown(c.retryAt);
  return (
    <Empty
      title={`Can't reach ${name}`}
      body={`${c.error ?? ""} ${secs > 0 ? `Trying again in ${secs}s.` : "Trying again now."}`}
      action={
        <button className="btn" onClick={() => retryNow(c.url)}>
          Try now
        </button>
      }
    />
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
                      <li key={ch.id}>
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
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })
        ) : c.status === "join" || c.status === "removed" || c.error ? null : (
          <Skeleton rows={7} avatar={16} lines={0} className="side-skel" />
        )}
      </nav>
      <MeBar c={c} />
    </aside>
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
          <small className="truncate">{me?.statusText || me?.statusEmoji ? `${me.statusEmoji} ${me.statusText}`.trim() : (me ? "Online" : c.status === "join" || c.status === "removed" ? "Not a member" : "Connecting…")}</small>
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
            Sign in with sblurp.chat
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
            autoFocus
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
      return <Settings />;
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
          {modal.video ? <video src={modal.src} controls autoPlay playsInline aria-label={modal.name} /> : <img src={modal.src} alt={modal.name} />}
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
  system: "Match system",
  light: "Light",
  dark: "Dark",
  midnight: "Midnight",
  contrast: "High contrast",
  cvd: "Colorblind safe",
  cola: "Cherry cola",
  mint: "Mint",
  cocoa: "Cocoa",
  fjord: "Fjord",
  sand: "Sand",
  grape: "Grape",
  black: "Black",
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
          <Icon name="info" size={16} /> {fixed.join(" and ")} {fixed.length > 1 ? "were" : "was"} too close to the background, so Sblurp adjusted {fixed.length > 1 ? "them" : "it"} to pass WCAG AA contrast.
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
          That is not a theme. Paste six colors separated by commas, like the one above.
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
        Appearance <small className="scope">Synced to your account</small>
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
        <small className="fine">Sblurp darkens or lightens the color if text on it would be hard to read.</small>
      </fieldset>
      )}
      <Choice
        k="density"
        label="Messages"
        options={[
          ["cozy", "Cozy"],
          ["compact", "Compact"],
          ["irc", "IRC"],
        ]}
      />
      <Choice
        k="sidebar"
        label="Sidebar"
        options={[
          ["cozy", "Cozy"],
          ["compact", "Compact"],
        ]}
      />
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
        label="Reduce motion"
        options={[
          ["system", "Match system"],
          ["reduce", "On"],
          ["full", "Off"],
        ]}
      />
    </section>
  );
}

function Settings() {
  const notify = useApp((s) => s.notify);
  const profile = useApp((s) => s.profile);
  const denied = typeof Notification !== "undefined" && Notification.permission === "denied";
  return (
    <Dialog label="Settings" className="settings">
      <header className="dialog-head">
        <div>
          <h2>Settings</h2>
          <p className="dialog-sub">The same in every community you join.</p>
        </div>
        <button className="icon-btn" aria-label="Close" onClick={() => set({ modal: null })}>
          <Icon name="x" />
        </button>
      </header>
      <Appearance />
      <section>
        <h3>
          Notifications <small className="scope">On this device</small>
        </h3>
        <label className="toggle-row">
          <span>
            <b>Mentions and direct messages</b>
            <small>Show a notification when Sblurp is in the background.</small>
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
        {denied && <p className="error small">Notifications are blocked for this site. Allow them in your browser's site settings, then turn this on.</p>}
      </section>
      <BlockedList />
      <section>
        <h3>Keyboard</h3>
        <button className="btn small" aria-keyshortcuts={`${MOD === "⌘" ? "Meta" : "Control"}+/`} onClick={() => set({ modal: { t: "keys" } })}>
          Keyboard shortcuts <kbd>{MOD}</kbd> <kbd>/</kbd>
        </button>
      </section>
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
    </Dialog>
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
        Blocked members <small className="scope">Per community</small>
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
        <p className="muted small">You haven't blocked anyone. Block someone from their profile.</p>
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
        <button className="btn ghost" autoFocus onClick={() => set({ modal: null })}>
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
      <input className="input" type="search" aria-label="Search channels" placeholder="Search by name or topic" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
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
  const c = useApp((s) => s.cs[s.url]);
  if (!c?.me) return null;
  const close = () => set({ modal: null });
  return (
    <PeoplePicker
      c={c}
      title="New message"
      exclude={[]}
      max={8}
      action={(n) => (n > 1 ? "Start group message" : "Message")}
      busyText="Opening…"
      empty="Nobody else is here yet."
      onSubmit={(ids) => openDM(c.url, ids)}
      onClose={close}
    />
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
        <AvatarField url={c.url} me={me} name={name} value={pic} onChange={setPic} onBusy={setUploading} autoFocus={focusPic} />
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
      <Pop anchor={pick} onClose={() => setPick(null)} label="Pick a status emoji">
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
        <button className="btn ghost" autoFocus onClick={() => set({ modal: null })}>
          Cancel
        </button>
        <button className="btn danger" onClick={go}>
          Delete
        </button>
      </div>
    </Dialog>
  );
}

function BlockMember({ url, memberId }: { url: string; memberId: string }) {
  const m = useApp((s) => s.cs[url]?.members[memberId]);
  const [err, setErr] = useState("");
  if (!m) return null;
  const name = m.displayName || m.username;
  const go = () =>
    setBlocked(url, memberId, true).then(
      () => set({ modal: null }),
      (e) => setErr(errorText(e)),
    );
  return (
    <Dialog label={`Block ${name}`} className="confirm">
      <h2>Block {name}?</h2>
      <p className="muted">
        Neither of you can send the other direct messages, and their messages in channels show collapsed for you. They are not told. Unblock them any time
        from their profile or in Settings.
      </p>
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      <div className="row-end">
        <button className="btn ghost" autoFocus onClick={() => set({ modal: null })}>
          Cancel
        </button>
        <button className="btn danger" onClick={go}>
          Block
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
        <button className="btn ghost" autoFocus onClick={() => set({ modal: null })}>
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
    <Pop anchor={p && m ? p.rect : null} side="right" className="profile" label={m ? `${m.displayName || m.username}'s profile` : "Profile"} onClose={() => (setErr(""), set({ popover: null }))}>
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
                <button className="btn primary wide" onClick={() => openDM(p.url, m.id).catch((e) => setErr(errorText(e)))}>
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
              <button className="btn primary wide" onClick={() => openDM(p.url, m.id).catch((e) => setErr(errorText(e)))}>
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
                  <button className="btn ghost small" title={muted ? undefined : "Collapse their messages and skip their pings, unread and typing. They are not told."} onClick={() => (setErr(""), setMuted(p.url, m.id, !muted).catch((e) => setErr(errorText(e))))}>
                    <Icon name={muted ? "bell" : "bellOff"} size={16} /> {muted ? "Unmute" : "Mute"}
                  </button>
                )}
                {m.id !== me?.id && !blocked && (
                  <button className="btn danger-ghost small" onClick={() => set({ popover: null, modal: { t: "block", url: p.url, memberId: m.id } })}>
                    Block
                  </button>
                )}
                {mod.remove && [false, true].map((ban) => (
                  <button
                    key={String(ban)}
                    className="btn danger-ghost small"
                    onClick={() => set({ popover: null, modal: { t: "remove", url: p.url, memberId: m.id, ban } })}
                  >
                    {ban ? "Ban" : "Kick"}
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
