import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ChannelView, RightPane } from "./Chat";
import { MemberKind, MemberRole, type GetServerInfoResponse } from "./gen/sblurp/v1/sblurp_pb";
import {
  channelLabel,
  communityBadge,
  formatHash,
  hostOf,
  isDM,
  matchScore,
  moveItem,
  normalizeCommunityUrl,
  sidebarSections,
  tabTitle,
  type Community,
  count,
} from "./logic";
import {
  absUrl,
  ACCOUNT_URL,
  errorText,
  FAKE,
  get,
  join,
  leave,
  openDM,
  probe,
  remove,
  reorder,
  retryNow,
  selectChannel,
  selectCommunity,
  set,
  setNotify,
  setTheme,
  signIn,
  signOut,
  toggleCollapsed,
  useApp,
  type Theme,
} from "./store";
import { Avatar, CommunityIcon, Dialog, Icon, Pop } from "./ui";

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
      } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && !s.modal) {
        e.preventDefault();
        moveChannel(e.key === "ArrowUp" ? -1 : 1, e.shiftKey);
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

function Shell() {
  const url = useApp((s) => s.url);
  const c = useApp((s) => s.cs[s.url]);
  const pane = useApp((s) => s.pane);
  const drawer = useApp((s) => s.drawer);
  const channelId = useApp((s) => s.channelId);
  return (
    <div className="app" data-drawer={drawer || !channelId} data-pane={!!pane}>
      <div className="drawer">
        <Rail />
        {c && <Sidebar c={c} />}
      </div>
      <main className="main">
        {!url || !c ? (
          <Empty
            title="You're not in any communities yet."
            body="Add one with its address or an invite link."
            action={<button className="btn primary" onClick={() => set({ modal: { t: "add" } })}>Add a community</button>}
          />
        ) : c.status === "join" ? (
          <JoinCard url={url} />
        ) : !c.me ? (
          c.error ? (
            <Unreachable c={c} />
          ) : (
            <div className="loading-main" aria-busy="true" aria-label="Loading">
              <div className="skel-head" />
              {[0, 1, 2, 3].map((i) => (
                <div className="skel-row" key={i}>
                  <i />
                  <span>
                    <b style={{ width: `${18 + i * 7}%` }} />
                    <b style={{ width: `${70 - i * 9}%` }} />
                  </span>
                </div>
              ))}
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
                onClick={() => selectCommunity(u)}
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
              {b.mentions > 0 && <span className="badge rail-badge">{b.mentions > 99 ? "99+" : b.mentions}</span>}
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

function Sidebar({ c }: { c: Community }) {
  const channelId = useApp((s) => s.channelId);
  const collapsed = useApp((s) => s.collapsed);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const name = c.info?.name ?? hostOf(c.url);
  const sections = useMemo(() => sidebarSections(c), [c.channels]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <aside className="sidebar" aria-label={name}>
      <button className="side-head" aria-haspopup="menu" onClick={(e) => setMenu(e.currentTarget.getBoundingClientRect())}>
        <span className="truncate">{name}</span>
        <Icon name="chevron" size={18} />
      </button>
      <Pop anchor={menu} onClose={() => setMenu(null)} className="menu" label={`${name} menu`}>
        <div role="menu" onClick={() => setMenu(null)}>
          <button role="menuitem" onClick={() => set({ modal: { t: "info" } })}>
            <Icon name="info" size={18} /> Community info
          </button>
          <button role="menuitem" onClick={() => set({ modal: { t: "invite" } })}>
            <Icon name="invite" size={18} /> Invite people
          </button>
          <hr />
          <button role="menuitem" className="danger" onClick={() => set({ modal: { t: "leave" } })}>
            <Icon name="leave" size={18} /> Leave community
          </button>
        </div>
      </Pop>
      <nav className="side-scroll" aria-label="Channels">
        {c.me ? (
          sections.map((sec) => {
            const key = `${c.url}|${sec.title}`;
            const shut = !!collapsed[key];
            const shown = shut
              ? sec.channels.filter((ch) => ch.id === channelId || (c.reads[ch.id]?.unreadCount ?? 0) > 0)
              : sec.channels;
            if (sec.dm && !sec.channels.length) return null;
            return (
              <section key={sec.title} className="side-sec">
                <h2>
                  <button aria-expanded={!shut} onClick={() => toggleCollapsed(key)}>
                    <span className="caret" data-shut={shut}>
                      <Icon name="chevron" size={14} />
                    </span>
                    {sec.title}
                  </button>
                </h2>
                <ul>
                  {shown.map((ch) => {
                    const rs = c.reads[ch.id];
                    const unread = (rs?.unreadCount ?? 0) > 0 && ch.id !== channelId;
                    const other = sec.dm ? c.members[ch.memberIds.find((id) => id !== c.me?.id) ?? ""] : undefined;
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
                            <Avatar m={other} size={20} presence={ch.memberIds.length === 2} />
                          ) : (
                            <span className="chan-icon">
                              <Icon name={ch.kind === 2 ? "lock" : "hash"} size={16} />
                            </span>
                          )}
                          <span className="truncate">{label}</span>
                          {(rs?.mentionCount ?? 0) > 0 && ch.id !== channelId && (
                            <span className="badge" aria-label={`${rs!.mentionCount} mentions`}>
                              {rs!.mentionCount}
                            </span>
                          )}
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })
        ) : (
          <div className="side-skel" aria-hidden="true">
            {[60, 45, 70, 50, 38].map((w, i) => (
              <b key={i} style={{ width: `${w}%` }} />
            ))}
          </div>
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
          <small className="truncate">{me?.statusText || (me ? "Online" : "Connecting…")}</small>
        </span>
      </button>
      <button className="icon-btn" aria-label="Settings" title="Settings" onClick={() => set({ modal: { t: "settings" } })}>
        <Icon name="sliders" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

function SignIn() {
  const err = useApp((s) => s.authError);
  return (
    <div className="signin">
      <div className="signin-rail" aria-hidden="true">
        {["#3550F0", "#7B5CE6", "#D9822B", "#0F9D8A"].map((c, i) => (
          <span key={c} className="cicon" data-on={i === 0} style={{ background: c }} />
        ))}
      </div>
      <div className="signin-body">
        <h1 className="wordmark">Sblurp</h1>
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
      await join(url, { displayName: pick("displayName"), avatarUrl: pick("avatarUrl"), bio: pick("bio") }, invite, info);
    } catch (x) {
      setErr(errorText(x, info.name));
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

function AddCommunity() {
  const order = useApp((s) => s.order);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [found, setFound] = useState<{ url: string; invite: string; info: GetServerInfoResponse } | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = normalizeCommunityUrl(input);
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
      return <AddCommunity />;
    case "switcher":
      return <Switcher />;
    case "info":
    case "invite":
    case "leave":
      return <CommunityDialog kind={modal.t} />;
    case "delete":
      return <DeleteConfirm id={modal.id} />;
    case "lightbox":
      return (
        <Dialog label={modal.name} className="lightbox">
          <img src={modal.src} alt={modal.name} />
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

function Settings() {
  const theme = useApp((s) => s.theme);
  const notify = useApp((s) => s.notify);
  const profile = useApp((s) => s.profile);
  const denied = typeof Notification !== "undefined" && Notification.permission === "denied";
  const themes: [Theme, string][] = [
    ["system", "Match system"],
    ["light", "Light"],
    ["dark", "Dark"],
  ];
  return (
    <Dialog label="Settings" className="settings">
      <header className="dialog-head">
        <h2>Settings</h2>
        <button className="icon-btn" aria-label="Close" onClick={() => set({ modal: null })}>
          <Icon name="x" />
        </button>
      </header>
      <section>
        <h3>Theme</h3>
        <div className="theme-pick" role="radiogroup" aria-label="Theme">
          {themes.map(([t, label]) => (
            <label key={t} className="theme-opt">
              <input type="radio" name="theme" checked={theme === t} onChange={() => setTheme(t)} />
              <span className={`theme-swatch ${t}`} aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              {label}
            </label>
          ))}
        </div>
      </section>
      <section>
        <h3>Notifications</h3>
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
            if (e.key === "ArrowDown") setSel((s) => Math.min(items.length - 1, s + 1));
            else if (e.key === "ArrowUp") setSel((s) => Math.max(0, s - 1));
            else if (e.key === "Enter") pick(sel);
            else return;
            e.preventDefault();
          }}
        />
      </div>
      <ul id="switcher-list" role="listbox" ref={listRef} aria-label="Channels">
        {items.map((x, i) => {
          const other = isDM(x.ch) ? x.c.members[x.ch.memberIds.find((id) => id !== x.c.me?.id) ?? ""] : undefined;
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
              {x.mentions > 0 && <span className="badge">{x.mentions}</span>}
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

function CommunityDialog({ kind }: { kind: "info" | "invite" | "leave" }) {
  const c = useApp((s) => s.cs[s.url]);
  const [copied, setCopied] = useState(false);
  if (!c) return null;
  const name = c.info?.name ?? hostOf(c.url);
  const copy = () => navigator.clipboard.writeText(c.url).then(() => setCopied(true));
  const close = () => set({ modal: null });
  if (kind === "leave") {
    return (
      <Dialog label={`Leave ${name}`} className="confirm">
        <h2>Leave {name}?</h2>
        <p className="muted">
          {name} leaves your rail and stops sending you messages. Your messages stay on its server, and you can add it again with its address.
        </p>
        <div className="row-end">
          <button className="btn ghost" autoFocus onClick={close}>
            Cancel
          </button>
          <button className="btn danger" onClick={() => leave(c.url)}>
            Leave
          </button>
        </div>
      </Dialog>
    );
  }
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
      ) : (
        <p className="muted">Share this address. Anyone with a sblurp.chat account can add it and join.</p>
      )}
      <div className="copy-row">
        <input className="input" readOnly value={c.url} aria-label="Community address" onFocus={(e) => e.target.select()} />
        <button className="btn" onClick={copy}>
          <Icon name={copied ? "check" : "copy"} size={16} /> {copied ? "Copied" : "Copy"}
        </button>
      </div>
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
      {err && <p className="error">{err}</p>}
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

const ROLE: Record<number, string> = {
  [MemberRole.OWNER]: "Owner",
  [MemberRole.ADMIN]: "Admin",
  [MemberRole.MODERATOR]: "Moderator",
};

function ProfilePopover() {
  const p = useApp((s) => s.popover);
  const m = useApp((s) => (s.popover ? s.cs[s.popover.url]?.members[s.popover.memberId] : undefined));
  const meId = useApp((s) => (s.popover ? s.cs[s.popover.url]?.me?.id : undefined));
  const [err, setErr] = useState("");
  return (
    <Pop anchor={p && m ? p.rect : null} side="right" className="profile" label="Profile" onClose={() => (setErr(""), set({ popover: null }))}>
      {m && p && (
        <>
          <div className="profile-band" style={{ background: `color-mix(in srgb, ${"var(--raspberry)"} 18%, var(--paper))` }} />
          <div className="profile-body">
            <Avatar m={m} size={72} presence />
            <h3>
              {m.displayName || m.username}
              {m.kind === MemberKind.BOT && <span className="tag">Bot</span>}
              {ROLE[m.role] && <span className="tag role">{ROLE[m.role]}</span>}
            </h3>
            <p className="muted">@{m.username}</p>
            {(m.statusText || m.statusEmoji) && (
              <p className="profile-status">
                {m.statusEmoji} {m.statusText}
              </p>
            )}
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
            {err && <p className="error small">{err}</p>}
            {m.id === meId ? (
              <p className="fine">This is you.</p>
            ) : (
              <button className="btn primary wide" onClick={() => openDM(p.url, m.id).catch((e) => setErr(errorText(e)))}>
                Message
              </button>
            )}
          </div>
        </>
      )}
    </Pop>
  );
}
