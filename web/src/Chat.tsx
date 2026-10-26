import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type CSSProperties, type FormEvent, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import { PLATFORM } from "./downloads";
import { MOD, useCountdown } from "./App";
import { Glyph, useCustomMatches } from "./CustomEmoji";
import { AUTH_URL } from "./auth";
import { LinkPreviews } from "./LinkPreview";
import { ActivityKind, ChannelKind, ChannelMode, MemberKind, MemberRole, NotifyLevel, type ActivityItem, type Channel, type Attachment, type Member, type Message, type ThreadSummary } from "./gen/sblurp/v1/sblurp_pb";
import {
  acQuery,
  arrivalText,
  canRemoveFromChannel,
  buildRows,
  channelLabel,
  dayLabel,
  decodeMentions,
  editsInComposer,
  longDraft,
  emojiMatches,
  encodeMentions,
  formatBytes,
  hostOf,
  mergeNewest,
  isDM,
  levelOf,
  dmPeer,
  listKey,
  fuzzyFilter,
  memberGroups,
  mentionsMe,
  retained,
  timeLabel,
  typingLabel,
  reactorsLabel,
  type Community,
  cssUrl,
  count,
  HOLD,
  holdStep,
  tabBadges,
  shareMessageLink,
  nameColor,
  listStep,
  pasteTarget,
  permalinks,
  type Permalink,
  toolsInside,
  listPhase,
  mayPost,
  posterNames,
  showDown,
} from "./logic";
import {
  absUrl,
  api,
  addToChannel,
  discardSend,
  edit,
  errorText,
  get,
  useOnline,
  leaveList,
  loadList,
  markRead,
  flushReads,
  closePane,
  jumpTo,
  react,
  refreshMessage,
  removeFromChannel,
  retryNow,
  retrySend,
  search,
  markThreadRead,
  send,
  set,
  setDraft,
  setMuted,
  setNotifyLevel,
  typing,
  upload,
  useApp,
  joinChannel,
  leaveChannel,
  unfurl,
  unfurled,
  unfurlKey,
} from "./store";
import { Avatar, Confirm, CopyButton, Dialog, Editable, EMOJI_NAMES, EmojiPicker, emojiChar, focusMain, AUTOFOCUS, ghost, Icon, type IconName, Markdown, menuKeys, Pop, readRecent, Resizer, Skeleton, thenCompose, toned, useClamped, useLoad } from "./ui";

const useC = () => useApp((s) => s.cs[s.url]!);
/** A light haptic tap. iOS WebKit has no navigator.vibrate, so the iOS app navigates to
 *  sblurp-haptic:, which Rust cancels and plays natively (apps/src-tauri/src/lib.rs, 1384). */
const IOS_APP = PLATFORM === "ios";
export function haptic() {
  if (IOS_APP) location.href = "sblurp-haptic:tap";
  else navigator.vibrate?.(10);
}

/** Touch screens have no hover toolbar (1313): press and hold puts its actions in the menu. */
const NO_HOVER = matchMedia("(hover: none)");
export const openProfile = (url: string, memberId: string, el: HTMLElement) =>
  set({ popover: { url, memberId, rect: el.getBoundingClientRect() } });

/** A channel topic in Markdown, clamped to three lines (1203). Editors click it to edit; others click to read the rest. */
function Topic({ c, topic, title, onEdit }: { c: Community; topic: string; title: string; onEdit?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const cut = useClamped(ref, topic);
  const [full, setFull] = useState<DOMRect | null>(null);
  const md = <Markdown text={topic} members={c.members} meId={c.me?.id} onMention={(id, el) => openProfile(c.url, id, el)} />;
  const show = cut && !onEdit ? (e: React.MouseEvent<HTMLElement>) => !(e.target as Element).closest("a, button") && setFull(e.currentTarget.getBoundingClientRect()) : undefined;
  return (
    <>
      <Editable className="topic-wrap" label="Edit channel description" onEdit={onEdit}>
        <div ref={ref} className="chan-topic msg-text" data-more={show ? true : undefined} onClick={show}>
          {md}
        </div>
      </Editable>
      {cut && (
        <button className="icon-btn topic-more" aria-label="Show full topic" title="Show full topic" aria-expanded={!!full} onClick={(e) => setFull(e.currentTarget.getBoundingClientRect())}>
          <Icon name="chevron" size={16} />
        </button>
      )}
      <Pop anchor={full} onClose={() => setFull(null)} className="topic-pop" label={`#${title} topic`}>
        <div className="topic-full msg-text">{md}</div>
      </Pop>
    </>
  );
}

// ---------------------------------------------------------------------------
// Channel view
// ---------------------------------------------------------------------------

const LEVELS: [NotifyLevel, string, IconName][] = [
  [NotifyLevel.ALL, "All messages", "bell"],
  [NotifyLevel.MENTIONS, "Only mentions", "atSign"],
  [NotifyLevel.NOTHING, "Nothing", "bellOff"],
];

/** Notification level choices for a menu (1498): a channel's, or the community's without ch. */
export function NotifyItems({ c, ch }: { c: Community; ch?: Channel }) {
  const id = ch?.id ?? "";
  const cur = ch ? levelOf(c.levels, ch) : c.levels[""] || NotifyLevel.ALL;
  const pick = (l: NotifyLevel) => void setNotifyLevel(c.url, id, l).catch(() => {});
  return (
    <div role="group" aria-label="Notify me about">
      <p className="menu-label" aria-hidden="true">
        Notify me about
      </p>
      {LEVELS.map(([l, label, icon]) => (
        <button key={l} role="menuitemradio" aria-checked={cur === l} onClick={() => pick(l)}>
          <Icon name={icon} size={18} /> {label}
          {cur === l && (
            <span className="menu-check">
              <Icon name="check" size={18} />
            </span>
          )}
        </button>
      ))}
      {/* A channel's own level hides the community's; this goes back to following it (DMs follow only Nothing). */}
      {ch && !!c.levels[id] && (
        <button role="menuitem" onClick={() => pick(NotifyLevel.UNSPECIFIED)}>
          <Icon name="back" size={18} /> Use community setting
        </button>
      )}
    </div>
  );
}

export function ChannelView() {
  const c = useC();
  const channelId = useApp((s) => s.channelId);
  const pane = useApp((s) => s.pane);
  const joined = !!c.channels[channelId];
  const ch = c.channels[channelId] ?? (c.peek?.id === channelId ? c.peek : undefined);
  const [q, setQ] = useState(pane?.t === "search" ? pane.q : "");
  const [joinErr, setJoinErr] = useState("");
  const [menu, setMenu] = useState<DOMRect | null>(null);
  // Phone back button (1386): mentions away from this channel only, like Slack and Discord.
  const back = useApp((s) => tabBadges(s.cs, { url: s.url, channelId: s.channelId }).back);
  const many = useApp((s) => s.order.filter((u) => s.cs[u]?.me).length > 1);
  if (!ch) {
    return (
      <section className="channel">
        <div className="empty">
          {channelId ? (
            <>
              <h2>This channel isn't here anymore.</h2>
              <p>It may have been deleted or made private. Pick another from the sidebar.</p>
            </>
          ) : (
            <>
              <h2>No channels yet.</h2>
              <p>{(c.me?.role ?? 0) >= MemberRole.ADMIN ? "Click the community name at the top of the sidebar to create one." : "An admin can create one."}</p>
            </>
          )}
        </div>
      </section>
    );
  }
  const dm = isDM(ch);
  const title = channelLabel(ch, c.members, c.me?.id);
  const other = dm ? c.members[dmPeer(ch, c.me?.id)] : undefined;
  const canEdit = !dm && (c.me?.role ?? 0) >= MemberRole.ADMIN;
  const headImg = absUrl(c.url, ch.headerImage?.url ?? "");
  const canLeave = joined && !dm && !ch.isDefault && ch.kind === ChannelKind.TEXT && c.mode === ChannelMode.OPT_IN;
  return (
    <section className="channel" aria-label={dm ? title : `#${title}`}>
      <header
        className="chan-head"
        data-img={headImg ? true : undefined}
        style={headImg ? ({ "--head-img": cssUrl(headImg) } as CSSProperties) : undefined}
      >
        <button
          className="icon-btn only-mobile menu-btn"
          aria-label={history.state?.back ? "Back" : back ? `Open communities and channels, ${count(back, "mention", "mentions")}` : "Open communities and channels"}
          onClick={() => (history.state?.back ? history.back() : set({ drawer: true }))}
        >
          <Icon name="back" />
          {back > 0 && <span className="badge menu-badge">{back > 99 ? "99+" : back}</span>}
        </button>
        <div className="chan-id">
          <h1 className="chan-title">
            {dm ? <Avatar m={other} size={24} presence={ch.memberIds.length <= 2} /> : <Icon name={ch.kind === 2 ? "lock" : "hash"} size={20} />}
            <span className="chan-name">
              <span className="truncate">{title}</span>
              {/* On a phone nothing else says which community this is (1470). */}
              {many && (
                <small className="chan-comm truncate">
                  <span className="visually-hidden">in </span>
                  {c.info?.name ?? hostOf(c.url)}
                </small>
              )}
            </span>
          </h1>
          {ch.topic && <Topic c={c} topic={ch.topic} title={title} onEdit={canEdit ? () => set({ modal: { t: "channel", id: ch.id, focusTopic: true } }) : undefined} />}
        </div>
        <form
          role="search"
          className="chan-search"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) set({ pane: { t: "search", q: q.trim() } });
          }}
        >
          {/* On a phone the box is just this icon, so the icon must focus the input (1375). */}
          <label htmlFor={`search-${channelId}`} className="chan-search-icon">
            <Icon name="search" size={16} />
          </label>
          <input id={`search-${channelId}`} type="search" aria-label={`Search ${c.info?.name ?? ""}`} placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
          {/* Phone only, while the field covers the header (1456). Keeps focus on press so the tap lands. */}
          <button
            type="button"
            className="chan-search-cancel"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              setQ("");
              e.currentTarget.form?.querySelector("input")?.blur();
            }}
          >
            Cancel
          </button>
        </form>
        {joined && (
          <button className="icon-btn" aria-label={`#${title} options`} title="Channel options" aria-haspopup="menu" aria-expanded={!!menu} onClick={(e) => setMenu(e.currentTarget.getBoundingClientRect())}>
            <Icon name="more" />
          </button>
        )}
        <Pop anchor={menu} onClose={() => setMenu(null)} className="menu" label={`#${title} options`}>
          <div role="menu" onClick={() => setMenu(null)} onKeyDown={menuKeys}>
            <NotifyItems c={c} ch={ch} />
            {(canEdit || canLeave) && <hr />}
            {canEdit && (
              <button role="menuitem" onClick={() => set({ modal: { t: "channel", id: ch.id } })}>
                <Icon name="edit" size={18} /> Edit channel
              </button>
            )}
            {canEdit && canLeave && <hr />}
            {canLeave && (
              <button role="menuitem" className="danger" onClick={() => leaveChannel(c.url, ch.id).catch(() => {})}>
                <Icon name="leave" size={18} /> Leave channel
              </button>
            )}
          </div>
        </Pop>
        <button
          className="icon-btn"
          aria-label="Members"
          title="Members"
          aria-pressed={pane?.t === "members"}
          onClick={() => set({ pane: pane?.t === "members" ? null : { t: "members" } })}
        >
          <Icon name="people" />
        </button>
      </header>
      <Banner c={c} />
      <MessageList url={c.url} channelId={channelId} rootId="" />
      {joined && !mayPost(ch, c.me) ? (
        <p className="composer-note">
          Only {posterNames(ch.postRoleIds, c.roles)} post in #{title}. You can react and reply in threads.
        </p>
      ) : dm && other && c.blocked.includes(other.id) ? (
        // The server refuses every message here, so say why instead of offering a box that fails (1479).
        <p className="composer-note">You blocked {other.displayName}. Unblock them from their profile to send messages.</p>
      ) : joined ? (
        <Composer url={c.url} channelId={channelId} rootId="" placeholder={dm && c.me && dmPeer(ch, c.me.id) === c.me.id ? "Jot something down" : dm ? `Message ${title}` : `Message #${title}`} />
      ) : (
        <div className="join-bar">
          <p>
            You're previewing <b>#{title}</b>. {joinErr || "Join to post and get its messages in your sidebar."}
          </p>
          <button
            className="btn primary"
            onClick={() => joinChannel(c.url, ch.id).then(() => setJoinErr(""), (e) => setJoinErr(errorText(e)))}
          >
            Join channel
          </button>
        </div>
      )}
      <TypingLine c={c} k={channelId} />
    </section>
  );
}

function Banner({ c }: { c: Community }) {
  // retryAt is set whenever reconnecting, so this ticks every second and the quiet time ends on time.
  const secs = useCountdown(c.retryAt);
  const online = useOnline();
  const name = c.info?.name ?? hostOf(c.url);
  // No network is one fact for the whole app, not each community's fault (1494).
  const down = !online ? "You're offline. Messages will send when you reconnect." : showDown(c, Date.now()) ? `Can't reach ${name}.` : "";
  // A live region inserted with its text is not read out, so this one is always mounted and only
  // its text changes: the first sentence, never the countdown, and then the recovery (1486).
  const [said, setSaid] = useState("");
  useEffect(() => setSaid((was) => down || (was && "Connected again.")), [down]);
  return (
    <>
      <p className="visually-hidden" role="status">
        {said}
      </p>
      {down && (
        <div className="banner">
          {online ? (
            <>
              <span>
                {down} {c.status === "reconnecting" && (secs > 0 ? `Trying again in ${secs}s.` : "Reconnecting…")}
              </span>
              <button className="btn small" onClick={() => retryNow(c.url)}>
                Try now
              </button>
            </>
          ) : (
            <span>{down}</span>
          )}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Message list. The scroller is flex column-reverse, so the browser keeps it pinned to the
// bottom and keeps the reading position when older messages are added on top.
// ---------------------------------------------------------------------------

/** Keeps a message's hover toolbar inside the scroller when the message is at the top edge (1193). */
function placeTools(e: React.SyntheticEvent<HTMLElement>) {
  const msg = (e.target as Element).closest<HTMLElement>(".msg");
  msg?.toggleAttribute("data-tools-inside", toolsInside(msg.getBoundingClientRect().top, e.currentTarget.getBoundingClientRect().top));
}

function MessageList({ url, channelId, rootId }: { url: string; channelId: string; rootId: string }) {
  const c = useC();
  const key = listKey(channelId, rootId);
  const list = c.lists[key];
  const marker = useApp((s) => (rootId ? null : s.newMarker[channelId] ?? null));
  const viewing = useApp((s) => s.viewing === channelId);
  const scroller = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [newAbove, setNewAbove] = useState(false);
  const mountedAt = useRef(Date.now());
  const ch = c.channels[channelId];
  const root = rootId ? Object.values(c.lists).flatMap((l) => l.items).find((m) => m.id === rootId) : undefined;
  const days = c.info?.retentionDays;
  const items = useMemo(() => retained(list?.items ?? [], days), [list?.items, days]);
  const rows = useMemo(() => buildRows(items, marker, c.me?.id), [items, marker, c.me?.id]);

  useEffect(() => {
    if (!list) void loadList(url, channelId, rootId);
  }, [url, channelId, rootId, list]);
  useEffect(() => () => leaveList(url, key), [url, key]);
  // A load that failed while the connection was down tries again once it is back, and stays
  // quiet until then like the banner (1376).
  const live = c.status === "live";
  const listError = list?.error && (live || showDown(c, Date.now())) ? list.error : "";
  useEffect(() => {
    if (live && list?.error) void loadList(url, channelId, rootId, list.items.length ? "older" : "");
  }, [live]); // eslint-disable-line react-hooks/exhaustive-deps

  const check = () => {
    const el = scroller.current;
    if (!el) return;
    const bottom = el.scrollTop > -40;
    setAtBottom(bottom);
    const n = el.querySelector(".new-divider");
    setNewAbove(!!n && n.getBoundingClientRect().bottom < el.getBoundingClientRect().top);
    const l = get().cs[url]?.lists[key];
    if (l && l.hasMore && !l.loading && !l.error && el.scrollHeight - el.clientHeight + el.scrollTop < 400) void loadList(url, channelId, rootId, "older");
    if (l?.hasMoreAfter && !l.loading && !l.error && el.scrollTop > -400) void loadList(url, channelId, rootId, "newer");
    if (!rootId) {
      const v = bottom && document.visibilityState === "visible" && document.hasFocus() ? channelId : null;
      if (get().viewing !== v) set({ viewing: v });
    }
  };
  // Before check(), so it sees the jumped-to position and does not page newer from the bottom.
  useEffect(() => {
    if (list?.focusId) scroller.current?.querySelector(`[data-focus=true]`)?.scrollIntoView({ block: "center" });
  }, [list?.focusId]);
  useEffect(check);
  useEffect(() => {
    // Previews and images that load later push the New divider up without a scroll (1461).
    const ro = new ResizeObserver(() => check());
    const msgs = scroller.current?.querySelector(".msgs");
    if (msgs) ro.observe(msgs);
    addEventListener("focus", check);
    addEventListener("blur", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      removeEventListener("focus", check);
      removeEventListener("blur", check);
      document.removeEventListener("visibilitychange", check);
      ro.disconnect();
      if (!rootId) set({ viewing: null });
    };
  });
  useEffect(() => {
    if (viewing && list) markRead(url, channelId);
  }, [viewing, ch?.lastMessageSeq, list, url, channelId]);
  useEffect(() => flushReads, [url, channelId]);

  const empty = list && !list.loading && !list.hasMore && !items.length;
  const phase = listPhase(list);
  // Content that replaces a skeleton fades in; a list already in memory just shows.
  const [cold] = useState(phase === "skeleton");
  return (
    <div className="msg-wrap">
      {newAbove && (
        <button
          className="jump jump-new"
          onClick={() => {
            // Glide up to where the unread start, the divider at the top (1509); check() hides the pill once it shows.
            const m = get().look.motion;
            const still = m === "reduce" || (m !== "full" && matchMedia("(prefers-reduced-motion: reduce)").matches);
            const d = scroller.current?.querySelector(".new-divider");
            // Rows skipped by content-visibility take their real height once on screen and move it,
            // so an instant jump aims again for a few frames. A smooth one corrects itself on the way.
            const go = (n: number) => {
              d?.scrollIntoView({ block: "start", behavior: still ? "instant" : "smooth" });
              if (still && n) requestAnimationFrame(() => go(n - 1));
            };
            go(6);
          }}
        >
          New messages above <Icon name="chevron" size={14} />
        </button>
      )}
      <div
        className="scroller"
        ref={scroller}
        onScroll={check}
        onKeyDown={moveFocus}
        onPointerOver={placeTools}
        onFocus={placeTools}
        tabIndex={0}
        aria-label={AUTOFOCUS ? "Message list. Arrow keys move between messages." : "Message list"}
        aria-busy={phase === "skeleton" || !!list?.loading}
      >
        <div className="msgs" key={phase === "skeleton" ? "skel" : "list"} data-loaded={cold && phase !== "skeleton"}>
          {phase === "skeleton" && !rootId ? (
            <Skeleton rows={9} avatar={36} chat className="skel-chat" />
          ) : listError ? (
            <div className="list-note">
              <p className="error">{listError}</p>
              <button className="btn small" onClick={() => loadList(url, channelId, rootId, list.items.length ? "older" : "")}>
                Try again
              </button>
            </div>
          ) : phase === "more" && !rootId ? (
            <Skeleton rows={3} avatar={36} chat className="skel-chat skel-more" />
          ) : !rootId && ch ? (
            <div className="chan-start" data-empty={!!empty}>
              {empty && (
                <span className="chan-start-icon" aria-hidden="true">
                  <Icon name={isDM(ch) ? "thread" : ch.kind === ChannelKind.PRIVATE ? "lock" : "hash"} size={32} />
                </span>
              )}
              <h2>{isDM(ch) ? channelLabel(ch, c.members, c.me?.id) : `#${ch.name}`}</h2>
              <p className="muted">
                {isDM(ch) && ch.memberIds.length === 1 && ch.memberIds[0] === c.me?.id
                  ? "This is your space. Draft messages, list your to-dos, or keep links and files handy."
                  : empty
                  ? isDM(ch)
                    ? `This is the start of your conversation with ${channelLabel(ch, c.members, c.me?.id)}. Say hello.`
                    : `This is the start of #${ch.name}. Say hello.`
                  : isDM(ch)
                    ? `This is the start of your conversation with ${channelLabel(ch, c.members, c.me?.id)}.`
                    : `This is the start of #${ch.name}.`}
              </p>
              {!empty && !isDM(ch) && ch.topic && (
                <div className="muted msg-text chan-start-topic">
                  <Markdown text={ch.topic} members={c.members} meId={c.me?.id} onMention={(id, el) => openProfile(c.url, id, el)} />
                </div>
              )}
            </div>
          ) : null}
          {rootId && root && (
            <>
              <MessageRow url={url} m={root} head inThread fresh={false} />
              <div className="thread-count">
                <span>{count(root.replyCount, "reply", "replies")}</span>
              </div>
            </>
          )}
          {rootId && phase === "skeleton" && <Skeleton rows={Math.min(Number(root?.replyCount ?? 3), 6)} avatar={36} chat className="skel-chat" />}
          {rows.map((r) =>
            r.t === "day" ? (
              <div className="day" key={r.key} role="separator">
                <span>{dayLabel(r.ms, Date.now())}</span>
              </div>
            ) : r.t === "new" ? (
              <div className="new-divider" key="new" role="separator" aria-label="New messages">
                <span>New</span>
              </div>
            ) : (
              <MessageRow key={r.key} url={url} m={r.m} head={r.head} inThread={!!rootId} fresh={Number(r.m.createdAtMs) > mountedAt.current} focus={r.m.id === list?.focusId} />
            ),
          )}
        </div>
      </div>
      {/* New messages from others are read out one at a time; history and switching channels stay quiet. */}
      <p className="visually-hidden" aria-live="polite">
        {arrivalText(items, mountedAt.current, c.me?.id, c.members)}
      </p>
      {(!atBottom || list?.hasMoreAfter) && (
        <button
          className="jump jump-latest"
          onClick={() => {
            if (list?.hasMoreAfter) void loadList(url, channelId, rootId);
            scroller.current?.scrollTo({ top: 0 });
          }}
        >
          Jump to latest <Icon name="down" size={14} />
        </button>
      )}
    </div>
  );
}

function TypingLine({ c, k }: { c: Community; k: string }) {
  const t = c.typing[k] ?? {};
  const [, tick] = useState(0);
  const now = Date.now();
  const ids = Object.keys(t).filter((id) => t[id] > now);
  useEffect(() => {
    if (!ids.length) return;
    const i = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(i);
  }, [ids.length]);
  const names = ids.map((id) => c.members[id]?.displayName || c.members[id]?.username || "Someone");
  return (
    <div className="typing" aria-live="polite">
      {names.length > 0 && (
        <>
          <span className="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          {typingLabel(names)}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One message
// ---------------------------------------------------------------------------

/** Up, Down, Home and End move focus between messages, so Tab can then reach a message's actions. */
function moveFocus(e: KeyboardEvent<HTMLElement>) {
  const t = e.target as HTMLElement;
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key) || (t !== e.currentTarget && !t.matches(".msg"))) return;
  const all = [...e.currentTarget.querySelectorAll<HTMLElement>(".msg")];
  const i = all.indexOf(t);
  const next =
    e.key === "Home" ? all[0] : e.key === "End" || i < 0 ? all.at(-1) : all[i + (e.key === "ArrowUp" ? -1 : 1)];
  if (!next) return;
  e.preventDefault();
  next.focus();
}

// Memoized, and it reads only the community fields it shows, so loading a page of history renders only the new rows.
const MessageRow = memo(function MessageRow({ url, m, head: grouped, inThread, fresh, focus }: { url: string; m: Message; head: boolean; inThread: boolean; fresh: boolean; focus?: boolean }) {
  // IRC puts the time and nick on every line (1432).
  const irc = useApp((s) => s.look.density === "irc");
  const head = grouped || irc;
  const c = {
    members: useApp((s) => s.cs[s.url]!.members),
    me: useApp((s) => s.cs[s.url]!.me),
    roles: useApp((s) => s.cs[s.url]!.roles),
    failed: useApp((s) => s.cs[s.url]!.failed),
  };
  // A preview (OPT_IN, not joined) is read-only: the server refuses reactions there (1124).
  const joined = useApp((s) => !!s.cs[s.url]!.channels[m.channelId]);
  const editing = useApp((s) => s.editing === m.id);
  const blocked = useApp((s) => s.cs[s.url]!.blocked.includes(m.authorId));
  const muted = useApp((s) => s.cs[s.url]!.muted.includes(m.authorId));
  const [reveal, setReveal] = useState(false);
  const links = useMemo(() => permalinks(m.text, location.origin + location.pathname, AUTH_URL), [m.text]);
  const [pick, setPick] = useState<DOMRect | null>(null);
  const [more, setMore] = useState<DOMRect | null>(null);
  const [heldImg, setHeldImg] = useState<{ src: string; name: string } | null>(null); // a held image adds Save and Share
  const [who, setWho] = useState<{ emoji: string; rect: DOMRect } | null>(null);
  // The toolbar stays in the accessibility tree (1516), so its buttons are Tab stops only once focus is in the message.
  const [inside, setInside] = useState(false);
  const tab = inside ? 0 : -1;
  const press = useRef<{ timer: number; held: HTMLElement | null; long: boolean }>({ timer: 0, held: null, long: false });
  const release = (e: { pointerType: string }) => {
    clearTimeout(press.current.timer);
    const el = press.current.held;
    if (!el) return;
    // A touch release also fires click; that click must not toggle the reaction.
    press.current = { timer: 0, held: null, long: e.pointerType !== "mouse" };
    setWho({ emoji: el.dataset.emoji!, rect: el.getBoundingClientRect() });
  };
  // Press and hold a message on touch opens its actions menu (1297) as soon as the hold is
  // recognized, with a haptic tap (1384). The menu captures the pointer, so the release lands
  // on it and does not light-dismiss it; the release's click is swallowed below. Where capture
  // fails the release still light-dismisses it, so a close right at the release reopens it (1420).
  const hold = useRef({ timer: 0, touch: false, on: false, x: 0, y: 0, up: 0 });
  const moreRef = useRef<HTMLDivElement>(null);
  const whoR = who && m.reactions.find((r) => r.emoji === who.emoji);
  const author = c.members[m.authorId];
  const mine = m.authorId === c.me?.id;
  const pending = m.seq === 0n && !!m.clientId;
  const failed = pending && c.failed[m.clientId];
  const name = author?.displayName || author?.username || "Unknown member";
  const h24 = useApp((s) => s.look.clock === "24");
  const surfaces = useApp((s) => s.surfaces);
  const color = nameColor(author, c.roles, surfaces, irc ? m.authorId : "");
  const time = new Date(Number(m.createdAtMs));
  const timeEl = (
    <time dateTime={time.toISOString()} title={time.toLocaleString()}>
      {timeLabel(Number(m.createdAtMs), h24)}
    </time>
  );
  if (m.deleted) {
    return (
      <article className="msg deleted" data-head={head} tabIndex={-1}>
        <div className="msg-gutter">{head && <span className="avatar-ghost" />}</div>
        <div className="msg-body">
          <p className="muted">This message was deleted.</p>
          {!inThread && m.replyCount > 0 && <ThreadLink m={m} />}
        </div>
      </article>
    );
  }
  if ((blocked || muted) && !reveal) {
    return (
      <article className="msg blocked" data-head={head} tabIndex={-1}>
        <div className="msg-gutter">{head && <span className="avatar-ghost" />}</div>
        <div className="msg-body">
          <button className="blocked-btn" onClick={() => setReveal(true)}>
            {blocked ? "1 message from a blocked member" : "1 message from a muted member"} <span>Show</span>
          </button>
          {!inThread && m.replyCount > 0 && <ThreadLink m={m} />}
        </div>
      </article>
    );
  }
  return (
    <article
      className="msg"
      data-revealed={blocked || muted || undefined}
      data-head={head}
      data-mine={mine}
      data-pending={pending && !failed}
      data-failed={!!failed}
      data-mention={mentionsMe(m.text, c.me?.id)}
      data-fresh={fresh}
      data-focus={focus}
      data-editing={editing}
      data-held={(!!more && hold.current.on) || undefined}
      tabIndex={-1}
      aria-label={`${name}, ${timeLabel(Number(m.createdAtMs), h24)}${pending && !failed ? ", sending" : ""}`}
      onFocus={() => setInside(true)}
      onBlur={(e) => e.currentTarget.contains(e.relatedTarget) || setInside(false)}
      onPointerDown={(e) => {
        const h = hold.current;
        h.on = false; // a hold whose release fired no click must not swallow the next tap
        h.touch = e.pointerType !== "mouse";
        // Buttons hold too: an image, avatar, name or quote card is much of a phone row, and the
        // release's click is swallowed below (1458). Reactions have their own hold (who reacted).
        const t = e.target as Element;
        if (!h.touch || pending || editing || t.closest("input, textarea, select, video, .reaction, .pop")) return;
        const img = t.closest(".att-img")?.querySelector("img");
        const row = e.currentTarget;
        Object.assign(h, { x: e.clientX, y: e.clientY });
        const id = e.pointerId;
        h.timer = window.setTimeout(() => {
          h.on = true;
          haptic();
          row.focus({ preventScroll: true }); // the sheet hands focus back to the message, not <body> (1463)
          flushSync(() => {
            setHeldImg(img ? { src: img.src, name: img.alt } : null);
            setMore(new DOMRect(h.x, h.y, 0, 0));
          });
          moreRef.current?.focus({ preventScroll: true }); // no item looks picked before a tap (1407)
          try {
            moreRef.current?.closest(".pop")?.setPointerCapture(id);
          } catch {
            // the finger already lifted
          }
        }, HOLD.ms);
      }}
      onPointerMove={(e) => {
        const h = hold.current;
        if (!h.on && holdStep(0, e.clientX - h.x, e.clientY - h.y) === "cancel") clearTimeout(h.timer);
      }}
      onPointerUp={() => {
        clearTimeout(hold.current.timer);
        if (hold.current.on) hold.current.up = performance.now();
      }}
      onPointerCancel={() => {
        clearTimeout(hold.current.timer);
      }}
      onClickCapture={(e) => {
        if (!hold.current.on) return;
        hold.current.on = false; // the release's click must not follow a link
        e.preventDefault();
        e.stopPropagation();
      }}
      onContextMenu={(e) => hold.current.touch && e.preventDefault()}
    >
      <div className="msg-gutter">
        {head && (
          <button className="avatar-btn" aria-label={`${name}'s profile`} onClick={(e) => openProfile(url, m.authorId, e.currentTarget)}>
            <Avatar m={author} />
          </button>
        )}
        <span className="hover-time">{timeEl}</span>
      </div>
      <div className="msg-body">
        {head && (
          <header className="msg-head">
            <button className="name" style={color ? { color } : undefined} onClick={(e) => openProfile(url, m.authorId, e.currentTarget)}>
              {name}
            </button>
            {author?.kind === MemberKind.BOT && <span className="tag">Bot</span>}
            {timeEl}
          </header>
        )}
        {editing && !NO_HOVER.matches ? (
          <EditBox url={url} m={m} />
        ) : (
          <div className="msg-text">
            <Markdown text={m.text} members={c.members} meId={c.me?.id} onMention={(id, el) => openProfile(url, id, el)} />
            {m.editedAtMs > 0n && <span className="edited">(edited)</span>}
            {pending && !failed && (
              <span className="edited sending">
                <Icon name="clock" size={12} /> Sending…
              </span>
            )}
          </div>
        )}
        {links.map((l) => (
          <Unfurl key={`${l.host}/${l.messageId}`} link={l} />
        ))}
        <LinkPreviews url={url} m={m} />
        {m.attachments.length > 0 && (
          <div className="atts">
            {m.attachments.map((a) => (
              <AttachmentView key={a.id} url={url} a={a} m={m} />
            ))}
          </div>
        )}
        {failed && (
          <p className="send-failed" role="alert">
            Couldn't send this message. {failed.reason}
            {failed.retry && (
              <button className="link-btn" onClick={() => retrySend(url, m)}>
                Try again
              </button>
            )}
            <button className="link-btn" onClick={() => discardSend(url, m)}>
              Discard
            </button>
          </p>
        )}
        {m.reactions.length > 0 && (
          <div className="reactions">
            {m.reactions.map((r) => {
              const me = !!c.me && r.memberIds.includes(c.me.id);
              const label = reactorsLabel(r.memberIds, c.members, c.me?.id, emojiChar(r.emoji));
              const showWho = (el: HTMLElement) => setWho({ emoji: r.emoji, rect: el.getBoundingClientRect() });
              return (
                <button
                  key={r.emoji}
                  className="reaction"
                  aria-pressed={me}
                  aria-label={`${emojiChar(r.emoji)} ${r.memberIds.length}, ${label}`}
                  data-tip={label}
                  data-emoji={r.emoji}
                  // Who reacted: hover tooltip on desktop, right-click or press-and-hold for the full list.
                  // The list opens on release: a popover shown while the button is still down would be
                  // light-dismissed by the pointerup.
                  onPointerDown={(e) => {
                    if (e.pointerType === "mouse") return;
                    const el = e.currentTarget;
                    press.current.timer = window.setTimeout(() => (press.current.held = el), 450);
                  }}
                  onPointerUp={release}
                  onPointerCancel={release}
                  onPointerLeave={() => clearTimeout(press.current.timer)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (e.buttons) press.current.held = e.currentTarget;
                    else showWho(e.currentTarget);
                  }}
                  onClick={() => {
                    if (press.current.long) press.current.long = false;
                    else if (joined) void react(url, m, r.emoji);
                  }}
                >
                  <Glyph e={r.emoji} /> {r.memberIds.length}
                </button>
              );
            })}
            {joined && (
              <button className="reaction add" aria-label="Add reaction" aria-haspopup="dialog" onClick={(e) => setPick(e.currentTarget.getBoundingClientRect())}>
                <Icon name="smile" size={16} />
              </button>
            )}
          </div>
        )}
        {!inThread && m.replyCount > 0 && <ThreadLink m={m} />}
      </div>
      {!pending && !editing && (
        <div className="toolbar" role="group" aria-label="Message actions">
          {joined && (
            <button tabIndex={tab} aria-label="Add reaction" title="Add reaction" aria-haspopup="dialog" aria-expanded={!!pick} onClick={(e) => setPick(e.currentTarget.getBoundingClientRect())}>
              <Icon name="smile" size={18} />
            </button>
          )}
          {!inThread && (
            <button tabIndex={tab} aria-label="Reply in thread" title="Reply in thread" onClick={() => set({ pane: { t: "thread", rootId: m.id } })}>
              <Icon name="thread" size={18} />
            </button>
          )}
          {mine && (
            <button tabIndex={tab} aria-label="Edit message" title="Edit" onClick={() => set({ editing: m.id })}>
              <Icon name="edit" size={18} />
            </button>
          )}
          <button tabIndex={tab} aria-label="More actions" title="More" aria-haspopup="menu" aria-expanded={!!more} onClick={(e) => setMore(e.currentTarget.getBoundingClientRect())}>
            <Icon name="more" size={18} />
          </button>
        </div>
      )}
      <Pop anchor={pick} side="left" onClose={() => setPick(null)} className="emoji-sheet" label="Pick a reaction" sheet>
        <EmojiPicker
          onPick={(e) => {
            setPick(null);
            void react(url, m, e);
          }}
        />
      </Pop>
      <Pop anchor={whoR ? who.rect : null} side="above" onClose={() => setWho(null)} className="who" label={whoR ? reactorsLabel(whoR.memberIds, c.members, c.me?.id, emojiChar(whoR.emoji)) : "Reactions"}>
        {whoR && (
          <>
            <p className="who-head">
              <Glyph e={whoR.emoji} /> {count(whoR.memberIds.length, "reaction", "reactions")}
            </p>
            <ul>
              {whoR.memberIds.map((id) => (
                <li key={id}>
                  <Avatar m={c.members[id]} size={24} />
                  <span className="truncate">{id === c.me?.id ? "You" : c.members[id]?.displayName || c.members[id]?.username || "Someone"}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Pop>
      <Pop
        anchor={more}
        side="left"
        onClose={() => {
          if (performance.now() - hold.current.up > 300) return (setMore(null), setHeldImg(null));
          hold.current.up = 0;
          moreRef.current?.closest<HTMLElement>(".pop")?.showPopover();
          moreRef.current?.focus({ preventScroll: true });
        }}
        className="menu msg-menu" label="Message actions" sheet>
        {NO_HOVER.matches && (
          // The sheet can cover the held message, so it names what its actions apply to (1460).
          <p className="msg-peek truncate">
            <b>{name}</b> {decodeMentions(m.text, c.members) || count(m.attachments.length, "attachment", "attachments")}
          </p>
        )}
        <div role="menu" ref={moreRef} tabIndex={-1} onClick={() => setMore(null)} onKeyDown={menuKeys}>
          {NO_HOVER.matches && (
            <>
              {joined && (
                // An action sheet on phones, the emoji you picked most recently on top like iMessage and
                // Slack (1401, 1408), and the full picker last.
                <div className="quick" role="group" aria-label="Quick reactions">
                  {more &&
                    readRecent()
                      .slice(0, 5)
                      .map((n) => emojiChar(`:${n}:`))
                      .map((e) => (
                        <button key={e} role="menuitem" aria-label={`React with ${e}`} onClick={() => void react(url, m, e)}>
                          <Glyph e={e} />
                        </button>
                      ))}
                  <button role="menuitem" aria-label="Add reaction" onClick={() => setPick(more)}>
                    <Icon name="plus" size={24} />
                  </button>
                </div>
              )}
              {!inThread && (
                <button
                  role="menuitem"
                  onClick={() => {
                    // In the tap itself, or iOS does not raise the keyboard (1409).
                    void thenCompose(Promise.resolve(set({ pane: { t: "thread", rootId: m.id } })), ".pane .composer-input");
                  }}
                >
                  <Icon name="thread" size={18} /> Reply in thread
                </button>
              )}
              {mine && (
                <button role="menuitem" onClick={() => set({ editing: m.id })}>
                  <Icon name="edit" size={18} /> Edit message
                </button>
              )}
            </>
          )}
          {heldImg && (
            <>
              <a role="menuitem" href={heldImg.src} download={heldImg.name}>
                <Icon name="download" size={18} /> Save image
              </a>
              {"share" in navigator && (
                <button role="menuitem" onClick={() => void navigator.share({ title: heldImg.name, url: heldImg.src }).catch(() => {})}>
                  <Icon name="upload" size={18} /> Share image
                </button>
              )}
            </>
          )}
          <button role="menuitem" onClick={() => navigator.clipboard.writeText(decodeMentions(m.text, c.members))}>
            <Icon name="copy" size={18} /> Copy text
          </button>
          <button role="menuitem" onClick={() => navigator.clipboard.writeText(shareMessageLink(AUTH_URL, url, m))}>
            <Icon name="link" size={18} /> Copy link
          </button>
          {!mine && (
            <button role="menuitem" onClick={() => set({ modal: { t: "report", url, message: m } })}>
              <Icon name="flag" size={18} /> Report message
            </button>
          )}
          {!mine && !blocked && (
            <button role="menuitem" onClick={() => (muted ? void setMuted(url, m.authorId, false).catch(() => {}) : set({ modal: { t: "block", url, memberId: m.authorId, mute: true } }))}>
              <Icon name={muted ? "bell" : "bellOff"} size={18} /> {muted ? "Unmute" : "Mute"} {name}
            </button>
          )}
          {(mine || (c.me?.role ?? 0) >= MemberRole.MODERATOR) && (
            <button role="menuitem" className="danger" onClick={() => set({ modal: { t: "delete", id: m.id } })}>
              <Icon name="trash" size={18} /> Delete message
            </button>
          )}
          {NO_HOVER.matches && (
            <button role="menuitem">
              <Icon name="x" size={18} /> Cancel
            </button>
          )}
        </div>
      </Pop>
    </article>
  );
});

// A preview of a linked message (1109), only once the viewer's own server returns it.
function Unfurl({ link }: { link: Permalink }) {
  const u = useApp((s) => s.order.find((x) => hostOf(x) === link.host));
  const here = useApp((s) => s.url === u);
  const [m, setM] = useState(() => (u ? unfurled.get(unfurlKey(u, link)) : null));
  useEffect(() => {
    let live = true;
    if (u && m === undefined) void unfurl(u, link).then((x) => live && setM(x));
    return () => {
      live = false;
    };
  }, [u]);
  const c = useApp((s) => (u ? s.cs[u] : undefined));
  const h24 = useApp((s) => s.look.clock === "24");
  if (!u || !m || !c) return null;
  const author = c.members[m.authorId];
  const name = author?.displayName || author?.username || "Unknown member";
  const ch = c.channels[m.channelId];
  const where = (ch ? (isDM(ch) ? channelLabel(ch, c.members, c.me?.id) : `#${ch.name}`) : "a channel") + (here ? "" : ` in ${c.info?.name ?? link.host}`);
  const at = Number(m.createdAtMs);
  const text = decodeMentions(m.text, c.members) || count(m.attachments.length, "attachment", "attachments");
  return (
    <button className="unfurl" onClick={() => jumpTo(u, m, true)}>
      <span className="unfurl-head">
        <Avatar m={author} size={20} />
        <b>{name}</b>
        <span className="muted truncate">
          {where}, {dayLabel(at, Date.now())} {timeLabel(at, h24)}
        </span>
      </span>
      <span className="unfurl-text">{text}</span>
    </button>
  );
}

function ThreadLink({ m }: { m: Message }) {
  const open = useApp((s) => s.pane?.t === "thread" && s.pane.rootId === m.id);
  const h24 = useApp((s) => s.look.clock === "24");
  return (
    <button className="thread-link" aria-pressed={open} onClick={() => set({ pane: { t: "thread", rootId: m.id } })}>
      <Icon name="thread" size={16} />
      <b>{count(m.replyCount, "reply", "replies")}</b>
      {m.lastReplyAtMs > 0n && <span className="muted">Last reply {timeLabel(Number(m.lastReplyAtMs), h24)}</span>}
    </button>
  );
}

function AttachmentView({ url, a, m }: { url: string; a: Attachment; m: Message }) {
  const src = absUrl(url, a.url);
  if (a.contentType.startsWith("image/")) {
    const w = a.width || 360;
    const h = a.height || 240;
    const scale = Math.min(1, 360 / w, 280 / h);
    return (
      <button className="att-img" aria-label={`Open ${a.name}`} onClick={() => set({ modal: { t: "lightbox", src, name: a.name } })}>
        <img src={src} alt={a.name} width={Math.round(w * scale)} height={Math.round(h * scale)} loading="lazy" onError={() => refreshMessage(url, m)} />
      </button>
    );
  }
  if (a.contentType.startsWith("video/")) {
    // With the uploader's still (1324) no video bytes load until play. Without one (old uploads, bots),
    // preload="metadata" plus #t=0.1 makes the browser draw the first frame as the still (1198).
    const poster = a.posterUrl ? absUrl(url, a.posterUrl) : undefined;
    return (
      <div className="att-video" style={a.width && a.height ? ({ "--ar": `${a.width} / ${a.height}` } as CSSProperties) : undefined}>
        <video
          src={poster ? src : `${src}#t=0.1`}
          poster={poster}
          controls
          preload={poster ? "none" : "metadata"}
          playsInline
          aria-label={a.name}
          onError={() => refreshMessage(url, m)}
        />
        <button className="att-max icon-btn" aria-label={`Maximize ${a.name}`} onClick={() => set({ modal: { t: "lightbox", src, name: a.name, video: true } })}>
          <Icon name="maximize" size={18} />
        </button>
      </div>
    );
  }
  // ponytail: 1 MB cap on inline text; bigger files stay a download card.
  if (a.contentType.startsWith("text/") && Number(a.size) <= 1 << 20) return <Snippet url={url} a={a} m={m} src={src} />;
  return (
    <a className="att-file" href={src} download={a.name} target="_blank" rel="noopener noreferrer">
      <span className="att-icon">
        <Icon name="file" />
      </span>
      <span className="att-meta">
        <b className="truncate">{a.name}</b>
        <small>{formatBytes(Number(a.size))}</small>
      </span>
    </a>
  );
}

/** A text file shown inline, like Slack's snippets (1269): highlighted, collapsed to its first lines,
 * and rendered when it is Markdown. The file is fetched as text and never runs as HTML. */
function Snippet({ url, a, m, src }: { url: string; a: Attachment; m: Message; src: string }) {
  const c = useC();
  const [code, setCode] = useState<string | null>(null);
  const [hl, setHl] = useState<{ html: string | null; label: string }>({ html: null, label: "" });
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const ext = (a.name.includes(".") ? a.name.split(".").pop()! : a.name).toLowerCase();
  const md = ext === "md" || ext === "markdown";
  useEffect(() => {
    let live = true;
    fetch(src)
      .then((r) => (r.ok ? r.text() : Promise.reject(r.status === 403 && refreshMessage(url, m))))
      .then(async (t) => {
        const h = await import("./highlight");
        const lang = ext !== "txt" && h.langLabel(ext) !== "Plain text" ? ext : h.detectLang(t);
        if (live) (setCode(t), setHl({ html: h.highlight(t, lang), label: h.langLabel(lang) }));
      })
      .catch(() => live && setCode(""));
    return () => {
      live = false;
    };
  }, [src]);
  const cut = useClamped(body, `${code} ${raw}`);
  const lines = code ? code.split("\n").length : 0;
  return (
    <figure className="snippet" data-open={open} aria-busy={code === null}>
      <figcaption className="snippet-head">
        <Icon name="fileCode" size={16} />
        <b className="truncate">{a.name}</b>
        <span className="muted">{[hl.label, lines ? count(lines, "line", "lines") : formatBytes(Number(a.size))].filter(Boolean).join(" · ")}</span>
        <span className="snippet-tools">
          {md && code && (
            <span className="snippet-seg" role="group" aria-label="Show as">
              <button type="button" aria-pressed={!raw} onClick={() => setRaw(false)}>
                Rendered
              </button>
              <button type="button" aria-pressed={raw} onClick={() => setRaw(true)}>
                Raw
              </button>
            </span>
          )}
          {!!code && <CopyButton text={code} label={`Copy ${a.name}`} />}
          <a className="icon-btn" href={src} download={a.name} aria-label={`Download ${a.name}`} title="Download">
            <Icon name="download" size={16} />
          </a>
        </span>
      </figcaption>
      <div className="snippet-body" ref={body} id={`snip-${a.id}`}>
        {code === null ? (
          <Skeleton rows={3} />
        ) : code === "" ? (
          <p className="muted small">Couldn't load this file. Download it instead.</p>
        ) : md && !raw ? (
          <div className="snippet-md msg-text">
            <Markdown doc text={code} members={c.members} meId={c.me?.id} onMention={(id, el) => openProfile(url, id, el)} />
          </div>
        ) : (
          <pre>{hl.html === null ? <code>{code}</code> : <code dangerouslySetInnerHTML={{ __html: hl.html }} />}</pre>
        )}
      </div>
      {(cut || open) && (
        <button type="button" className="snippet-more" aria-expanded={open} aria-controls={`snip-${a.id}`} onClick={() => setOpen(!open)}>
          <Icon name="chevron" size={16} /> {open ? "Collapse" : lines > 1 ? `Show all ${lines} lines` : "Show all"}
        </button>
      )}
    </figure>
  );
}

function EditBox({ url, m }: { url: string; m: Message }) {
  const c = useC();
  const [text, setText] = useState(decodeMentions(m.text, c.members));
  const [err, setErr] = useState("");
  const ref = useAutosize(text);
  const save = async () => {
    if (!text.trim()) return set({ modal: { t: "delete", id: m.id } });
    try {
      await edit(url, m.id, encodeMentions(text, Object.values(c.members)));
      set({ editing: null });
    } catch (e) {
      setErr(errorText(e, c.info?.name));
    }
  };
  return (
    <div className="edit-box">
      <textarea
        ref={ref}
        className="composer-input"
        aria-label="Edit message"
        enterKeyHint={NO_HOVER.matches ? "enter" : undefined}
        value={text}
        autoFocus
        onFocus={(e) => e.target.setSelectionRange(text.length, text.length)}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // On a touch keyboard Return is a newline; Save is the button (1448).
          if (e.key === "Enter" && !e.shiftKey && !NO_HOVER.matches && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            set({ editing: null });
          }
        }}
      />
      {err && (
        <p className="error small" role="alert">
          {err}
        </p>
      )}
      {NO_HOVER.matches ? (
        // No Esc key on a phone, and fingertip buttons (1462).
        <div className="edit-actions">
          <button className="btn ghost" onClick={() => set({ editing: null })}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </div>
      ) : (
        <p className="fine">
          Enter to save, Esc to cancel.{" "}
          <button className="link-btn" onClick={() => set({ editing: null })}>
            Cancel
          </button>{" "}
          <button className="link-btn" onClick={save}>
            Save
          </button>
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function useAutosize(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return ref;
}

const revoke = (f: Pending) => f.src && URL.revokeObjectURL(f.src);

// Which side was touched last, the main channel or the side pane, so a stray paste knows where to go.
let lastZone: "pane" | "channel" | null = null;
const touch = (e: Event) => {
  const z = e.target instanceof Element ? e.target.closest(".channel, .pane") : null;
  if (z) lastZone = z.classList.contains("pane") ? "pane" : "channel";
};
document.addEventListener("pointerdown", touch, true);
document.addEventListener("focusin", touch, true);

interface Pending {
  id: string;
  name: string;
  src?: string; // object URL for an image preview (1078)
  att?: Attachment;
  error?: string;
}

function Composer({ url, channelId, rootId, placeholder }: { url: string; channelId: string; rootId: string; placeholder: string }) {
  const c = useC();
  const key = `${url} ${listKey(channelId, rootId)}`;
  const text = useApp((s) => s.drafts[key] ?? "");
  const [caret, setCaret] = useState(0);
  const [sel, setSel] = useState(0);
  const [files, setFiles] = useState<Pending[]>([]);
  const ref = useAutosize(text);
  const form = useRef<HTMLFormElement>(null);
  const ac = acQuery(text, caret);
  const custom = useCustomMatches(ac?.kind === ":" ? ac.q : null, 8);
  const tone = useApp((s) => s.look.skinTone);
  const options = useMemo(() => {
    if (!ac) return [];
    if (ac.kind === ":")
      return emojiMatches(
        ac.q,
        EMOJI_NAMES,
        custom.map((e) => e.name),
      ).map((e) => ({ id: e.ch ? e.name : `c:${e.name}`, label: `:${e.name}:`, insert: `${e.ch ? toned(e.ch, tone) : `:${e.name}:`} `, m: undefined }));
    const byName = Object.values(c.members).sort((a, b) => a.username.localeCompare(b.username));
    return fuzzyFilter(byName, ac.q, (m) => [m.username, m.displayName])
      .slice(0, 8)
      .map((m) => ({ id: m.id, label: m.displayName || m.username, insert: `@${m.username} `, m: m as Member | undefined }));
  }, [ac?.kind, ac?.q, c.members, custom, tone]);
  // The phone list scrolls after four rows, so the picked row stays in view (1480).
  useEffect(() => document.getElementById(`ac-${key}-${sel}`)?.scrollIntoView({ block: "nearest" }), [key, sel]);

  // On a phone, Edit message moves the text into this box, like iMessage and Slack (1513).
  // The draft is set aside and comes back on save, cancel or a channel switch.
  const editMsg = useApp((s) => {
    const m = s.editing ? s.cs[url]?.lists[listKey(channelId, rootId)]?.items.find((x) => x.id === s.editing) : undefined;
    return editsInComposer(NO_HOVER.matches, m, channelId, rootId) ? m : undefined;
  });
  const [editErr, setEditErr] = useState("");
  useEffect(() => {
    if (!editMsg) return;
    const saved = get().drafts[key] ?? "";
    const t = decodeMentions(editMsg.text, c.members);
    setDraft(key, t);
    setEditErr("");
    requestAnimationFrame(() => (ref.current?.focus(), ref.current?.setSelectionRange(t.length, t.length)));
    return () => setDraft(key, saved);
  }, [editMsg?.id, key]);
  const saveEdit = async () => {
    if (!editMsg) return;
    if (!text.trim()) return set({ modal: { t: "delete", id: editMsg.id } });
    try {
      await edit(url, editMsg.id, encodeMentions(text, Object.values(c.members)));
      set({ editing: null });
    } catch (e) {
      setEditErr(errorText(e, c.info?.name));
    }
  };

  const uploading = files.some((f) => !f.att && !f.error);
  const ready = files.filter((f) => f.att).map((f) => f.att!);

  const addFiles = (list: FileList | File[]) => {
    for (const file of Array.from(list)) {
      const id = crypto.randomUUID();
      const src = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      setFiles((fs) => [...fs, { id, name: file.name, src }]);
      upload(url, file).then(
        (att) => setFiles((fs) => fs.map((f) => (f.id === id ? { ...f, att } : f))),
        (e) => setFiles((fs) => fs.map((f) => (f.id === id ? { ...f, error: errorText(e, c.info?.name) } : f))),
      );
    }
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (editMsg) return void saveEdit();
    if (uploading || (!text.trim() && !ready.length)) return;
    void send(url, channelId, rootId, encodeMentions(text.trim(), Object.values(c.members)), ready);
    setDraft(key, "");
    files.forEach(revoke);
    setFiles([]);
  };

  // Cmd/Ctrl+Shift+Enter opens a small dialog for a title and a language, then posts the box as a
  // text file named for them, like Slack's snippets (1269, 1278).
  const [snip, setSnip] = useState<{ code: string; lang: string; title: string; h: typeof import("./highlight") } | null>(null);
  const openSnippet = async () => {
    const code = text.replace(/^\s*\n|\s+$/g, "");
    if (uploading || !code) return;
    const h = await import("./highlight");
    setSnip({ code, lang: h.detectLang(code), title: "", h });
  };
  const postSnippet = async (e: FormEvent) => {
    e.preventDefault();
    if (!snip) return;
    const file = new File([snip.code], snip.h.snippetName(snip.lang, snip.title), { type: "text/plain" });
    setSnip(null);
    setDraft(key, "");
    files.forEach(revoke);
    setFiles([]);
    try {
      await send(url, channelId, rootId, "", [...ready, await upload(url, file)]);
    } catch (e) {
      // Nothing is lost: the text and files come back with the error on a chip.
      setDraft(key, text);
      setFiles([...files, { id: crypto.randomUUID(), name: file.name, error: errorText(e, c.info?.name) }]);
    }
  };
  const longText = longDraft(text);

  // Fade the chip out, then drop it; with motion reduced there is no transition, so drop at once.
  const remove = (f: Pending, el: HTMLElement) => {
    const gone = () => (revoke(f), setFiles((fs) => fs.filter((x) => x.id !== f.id)));
    if (!parseFloat(getComputedStyle(el).transitionDuration)) return gone();
    el.dataset.leaving = "true";
    el.addEventListener("transitionend", gone, { once: true });
  };
  const live = useRef(files);
  live.current = files;
  useEffect(() => () => live.current.forEach(revoke), []);

  const choose = (i: number) => {
    const o = options[i];
    if (!o || !ac) return;
    const next = text.slice(0, ac.start) + o.insert + text.slice(caret);
    setDraft(key, next);
    const pos = ac.start + o.insert.length;
    // Skip if typing went on before the frame (1306): moving the caret back would split the new text.
    requestAnimationFrame(() => {
      if (ref.current?.value !== next) return;
      ref.current.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  // Files dropped anywhere over the channel (or the thread pane) land in this composer.
  const add = useRef(addFiles);
  add.current = addFiles;
  // Shift-drop sends the files at once as their own message, leaving the draft alone (1199).
  // If an upload fails, the files go to the composer instead, where the error shows on the chip.
  const sendNow = useRef<(list: File[]) => void>(() => {});
  sendNow.current = (list) =>
    void Promise.all(list.map((f) => upload(url, f))).then(
      (atts) => send(url, channelId, rootId, "", atts),
      () => addFiles(list),
    );
  useEffect(() => {
    const zone = form.current?.closest<HTMLElement>(".channel, .pane");
    if (!zone) return;
    const files = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    const over = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      zone.dataset.drag = "true";
    };
    const leave = (e: DragEvent) => {
      if (!zone.contains(e.relatedTarget as Node | null)) delete zone.dataset.drag;
    };
    const drop = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      delete zone.dataset.drag;
      if (e.shiftKey) return sendNow.current(Array.from(e.dataTransfer!.files));
      add.current(e.dataTransfer!.files);
      ref.current?.focus();
    };
    zone.addEventListener("dragover", over);
    zone.addEventListener("dragleave", leave);
    zone.addEventListener("drop", drop);
    return () => {
      zone.removeEventListener("dragover", over);
      zone.removeEventListener("dragleave", leave);
      zone.removeEventListener("drop", drop);
      delete zone.dataset.drag;
    };
  }, [ref]);

  // A paste with files outside any text field lands here when this is the pane last touched (1077).
  useEffect(() => {
    const mine = rootId ? "pane" : "channel";
    const onPaste = (e: globalThis.ClipboardEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      const editable = !!t?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), dialog, [role='dialog']");
      if (pasteTarget(editable, !!e.clipboardData?.files.length, lastZone, !!document.querySelector(".pane .composer")) !== mine) return;
      e.preventDefault();
      add.current(e.clipboardData!.files);
      ref.current?.focus();
    };
    // Typing a character outside any text field goes to the composer of the pane last clicked (1194).
    // Focusing on keydown lets the browser put the character in the composer.
    const onKey = (e: globalThis.KeyboardEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      const editable = !!t?.closest("input, textarea, select, button, a, [contenteditable]:not([contenteditable='false']), dialog, [role='dialog'], [role='menu']");
      const typing = e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey;
      if (get().modal || document.querySelector(":popover-open")) return;
      if (pasteTarget(editable, typing, lastZone, !!document.querySelector(".pane .composer")) === mine) ref.current?.focus();
    };
    // A click on empty space in this pane focuses its composer, like Slack and Discord (1194).
    // Not on controls, media or the composer itself, not when the click selects text,
    // and not on touch, where focusing would pop up the keyboard.
    const onClick = (e: globalThis.MouseEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      const zone = (el: Element | null | undefined) => el?.closest(".channel, .pane");
      if (!t || !ref.current || zone(t) !== zone(ref.current)) return;
      if (t.closest("a, button, input, textarea, select, label, summary, form, img, video, audio, canvas, iframe, [role='button'], [role='menu'], [role='menuitem'], dialog, [role='dialog'], [contenteditable]:not([contenteditable='false'])")) return;
      if (e.detail > 1 || !getSelection()?.isCollapsed) return;
      if ((e as PointerEvent).pointerType === "touch" || NO_HOVER.matches) return;
      if (get().modal || document.querySelector(":popover-open")) return;
      ref.current.focus({ preventScroll: true });
    };
    document.addEventListener("paste", onPaste);
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("paste", onPaste);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
    };
  }, [rootId, ref]);

  return (
    <>
    {snip && (
      <Dialog label="Post a snippet" className="confirm" onClose={() => setSnip(null)}>
        <form onSubmit={postSnippet} className="stack">
          <h2>Post a snippet</h2>
          <label className="field">
            <span>Title (optional)</span>
            <input className="input" autoFocus={AUTOFOCUS} maxLength={100} value={snip.title} placeholder="snippet" onChange={(e) => setSnip({ ...snip, title: e.target.value })} />
          </label>
          <label className="field">
            <span>Language</span>
            <select className="input" value={snip.lang} onChange={(e) => setSnip({ ...snip, lang: e.target.value })}>
              {snip.h.snippetLangs().map((l) => (
                <option key={l} value={l}>
                  {snip.h.langLabel(l)}
                </option>
              ))}
            </select>
          </label>
          <p className="muted">Posts as {snip.h.snippetName(snip.lang, snip.title)}.</p>
          <div className="row-end">
            <button type="button" className="btn ghost" onClick={() => setSnip(null)}>
              Cancel
            </button>
            <button className="btn primary">Post</button>
          </div>
        </form>
      </Dialog>
    )}
    <form className="composer" ref={form} onSubmit={submit}>
      {options.length > 0 && (
        <ul className="ac" role="listbox" id={`ac-${key}`} aria-label={ac?.kind === "@" ? "Members" : "Emoji"}>
          {options.map((o, i) => (
            <li
              key={o.id}
              id={`ac-${key}-${i}`}
              role="option"
              aria-selected={i === sel}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(i);
              }}
              onMouseMove={() => setSel(i)}
            >
              {o.m ? <Avatar m={o.m} size={22} /> : <Glyph e={o.insert.trim()} />}
              <b>{o.label}</b>
              {o.m && <span className="muted">@{o.m.username}</span>}
              {o.m?.kind === MemberKind.BOT && <span className="tag">Bot</span>}
            </li>
          ))}
        </ul>
      )}
      {editMsg && (
        <div className="edit-strip">
          <Icon name="edit" size={16} />
          <span>Editing message</span>
          {editErr && (
            <span className="error small" role="alert">
              {editErr}
            </span>
          )}
          <button type="button" className="icon-btn" aria-label="Cancel edit" onClick={() => set({ editing: null })}>
            <Icon name="x" />
          </button>
        </div>
      )}
      <div className="composer-box">
        {files.length > 0 && !editMsg && (
          <ul className="chips" aria-label="Attachments">
            {files.map((f) => (
              <li key={f.id} className="chip" data-error={!!f.error} aria-busy={!f.att && !f.error}>
                {f.src ? <img src={f.src} alt="" /> : <Icon name="file" size={16} />}
                <span className="truncate">{f.error ? `${f.name}: ${f.error}` : f.att ? f.name : `Uploading ${f.name}…`}</span>
                <button type="button" aria-label={`Remove ${f.name}`} onClick={(e) => remove(f, e.currentTarget.closest("li")!)}>
                  <Icon name="x" size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="composer-row">
          {!editMsg && (
            <label className="icon-btn attach" title="Attach files">
              <input type="file" multiple className="visually-hidden" aria-label="Attach files" onChange={(e) => (e.target.files && addFiles(e.target.files), (e.target.value = ""))} />
              <Icon name="clip" />
            </label>
          )}
          <textarea
            ref={ref}
            rows={1}
            className="composer-input"
            aria-label={placeholder}
            placeholder={placeholder}
            enterKeyHint={NO_HOVER.matches ? "enter" : undefined}
            value={text}
            aria-autocomplete="list"
            aria-controls={options.length ? `ac-${key}` : undefined}
            aria-activedescendant={options.length ? `ac-${key}-${sel}` : undefined}
            onChange={(e) => {
              setDraft(key, e.target.value);
              setCaret(e.target.selectionStart);
              setSel(0);
              if (e.target.value) typing(url, channelId, rootId);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onPaste={(e: ClipboardEvent) => {
              if (e.clipboardData.files.length) {
                e.preventDefault();
                addFiles(e.clipboardData.files);
              }
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter" && e.shiftKey && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void openSnippet();
                return;
              }
              if (options.length) {
                const d = listStep(e);
                if (d) {
                  e.preventDefault();
                  setSel((s) => (s + d + options.length) % options.length);
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  choose(sel);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setCaret(-1);
                  return;
                }
              }
              if (e.key === "Escape" && editMsg) {
                e.preventDefault();
                e.stopPropagation();
                set({ editing: null });
                return;
              }
              // On a touch keyboard Return is a newline and the send button sends, like iMessage (1448).
              if (e.key === "Enter" && !e.shiftKey && !NO_HOVER.matches) {
                e.preventDefault();
                submit();
              } else if (e.key === "ArrowUp" && !text) {
                const items = get().cs[url]?.lists[listKey(channelId, rootId)]?.items ?? [];
                const last = items.findLast((m) => m.authorId === c.me?.id && !m.deleted && m.seq > 0n);
                if (last) {
                  e.preventDefault();
                  set({ editing: last.id });
                }
              }
            }}
          />
          {editMsg ? (
            <button className="send" aria-label="Save edit">
              <Icon name="check" size={18} />
            </button>
          ) : (
            <button className="send" aria-label="Send" title={`Send (Enter). ${MOD} Shift Enter sends it as a snippet.`} disabled={uploading || (!text.trim() && !ready.length)}>
              <Icon name="send" size={18} />
            </button>
          )}
        </div>
        {/* A touch keyboard has no ⌘ Shift Enter (1482), so a button does it (1514). */}
        {longText && NO_HOVER.matches && !editMsg && (
          <p className="composer-hint">
            <button type="button" className="btn ghost" onClick={() => void openSnippet()}>
              Post as snippet
            </button>
          </p>
        )}
        {longText && !NO_HOVER.matches && (
          <p className="composer-hint">
            Long text? <kbd>{MOD}</kbd> <kbd>Shift</kbd> <kbd>Enter</kbd> posts it as a snippet.
          </p>
        )}
      </div>
      {rootId && <TypingLine c={c} k={listKey(channelId, rootId)} />}
    </form>
    </>
  );
}

// ---------------------------------------------------------------------------
// Right pane: thread, members, search
// ---------------------------------------------------------------------------

export function RightPane() {
  const pane = useApp((s) => s.pane);
  const c = useC();
  const channelId = useApp((s) => s.channelId);
  const many = useApp((s) => s.order.filter((u) => s.cs[u]?.me).length > 1);
  const open = !!pane;
  const ref = useRef<HTMLElement>(null);
  // Closing would drop focus on body (its close button is gone): send it back to the "replies"
  // button that opened the thread, else the conversation (1464). A frame later, once main is no
  // longer inert behind the phone pane.
  useLayoutEffect(() => {
    if (!open) return;
    const from = document.querySelector<HTMLElement>('.main .thread-link[aria-pressed="true"]');
    return () => {
      ghost(ref.current);
      if (document.activeElement === document.body || document.activeElement?.closest(".pane"))
        requestAnimationFrame(() => (from?.isConnected ? from.focus() : focusMain()));
    };
  }, [open]);
  // A thread counts as read when it opens and again when it closes, for the Threads view (1405).
  const rootId = pane?.t === "thread" ? pane.rootId : "";
  useEffect(() => {
    if (!rootId) return;
    markThreadRead(c.url, rootId);
    return () => markThreadRead(c.url, rootId);
  }, [c.url, rootId]);
  if (!pane) return null;
  const ch = c.channels[channelId];
  const close = closePane;
  const title = { thread: "Thread", members: "Members", search: "Search", activity: "Activity", threads: "Threads" }[pane.t];
  const where = ch ? (isDM(ch) ? channelLabel(ch, c.members, c.me?.id) : `#${ch.name}`) : c.info?.name;
  return (
    <aside ref={ref} className="pane" aria-label={title} data-pane={pane.t}>
      <Resizer panel="pane" label="Resize side pane" />
      <header className="pane-head">
        {/* A phone pushes the pane over the channel: one leading back, like the channel header (1452). */}
        <button className="icon-btn only-mobile" aria-label={`Back to ${history.state?.drawer ? c.info?.name : where}`} onClick={close}>
          <Icon name="back" />
        </button>
        <div>
          <h2>{title}</h2>
          {pane.t === "thread" && ch && <p className="muted small truncate">{isDM(ch) ? channelLabel(ch, c.members, c.me?.id) : `#${ch.name}`}</p>}
          {pane.t === "search" && <p className="muted small truncate">“{pane.q}” in {c.info?.name}</p>}
          {pane.t === "members" && ch?.kind === ChannelKind.PRIVATE && <p className="muted small truncate">#{ch.name}</p>}
          {(pane.t === "activity" || pane.t === "threads") && <p className="muted small truncate">{many ? "All communities" : c.info?.name}</p>}
        </div>
        <button className="icon-btn pane-close" aria-label={`Close ${title.toLowerCase()}`} onClick={close}>
          <Icon name="x" />
        </button>
      </header>
      {pane.t === "thread" ? (
        <>
          <MessageList key={pane.rootId} url={c.url} channelId={channelId} rootId={pane.rootId} />
          {ch ? (
            <Composer key={`c${pane.rootId}`} url={c.url} channelId={channelId} rootId={pane.rootId} placeholder="Reply in thread" />
          ) : (
            <p className="composer-note">Join the channel to reply.</p>
          )}
        </>
      ) : pane.t === "members" ? (
        <Members c={c} />
      ) : pane.t === "activity" ? (
        <Activity />
      ) : pane.t === "threads" ? (
        <Threads />
      ) : (
        <>
          {/* Phone (1456): the query stays editable at the top, with Cancel, like iOS search. */}
          <form
            role="search"
            className="pane-search only-mobile"
            onSubmit={(e) => {
              e.preventDefault();
              const q = String(new FormData(e.currentTarget).get("q")).trim();
              if (q) set({ pane: { t: "search", q } });
              e.currentTarget.querySelector("input")?.blur();
            }}
          >
            <span className="chan-search">
              <Icon name="search" size={16} />
              <input key={pane.q} name="q" type="search" enterKeyHint="search" aria-label={`Search ${c.info?.name ?? ""}`} defaultValue={pane.q} />
            </span>
            <button type="button" className="link-btn" onClick={close}>
              Cancel
            </button>
          </form>
          <SearchResults key={pane.q} c={c} q={pane.q} />
        </>
      )}
    </aside>
  );
}

// The community's members, or for a private channel the people in it, with Add people and Remove.
function Members({ c }: { c: Community }) {
  const channelId = useApp((s) => s.channelId);
  const ch = c.channels[channelId];
  const priv = ch?.kind === ChannelKind.PRIVATE ? ch : undefined;
  const ids = priv?.memberIds;
  const groups = useMemo(
    () => memberGroups(ids ? ids.flatMap((id) => c.members[id] ?? []) : Object.values(c.members)),
    [c.members, ids],
  );
  const [adding, setAdding] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [err, setErr] = useState("");
  const drop = (id: string) => {
    setErr("");
    removeFromChannel(c.url, priv!.id, id).catch((e) => setErr(errorText(e, c.info?.name)));
  };
  return (
    <div className="pane-scroll members">
      {priv && (
        <div className="members-head">
          <p className="muted small">Private. Only these {count(priv.memberIds.length, "person", "people")} can see #{priv.name}.</p>
          <button className="btn small" onClick={() => setAdding(true)}>
            <Icon name="invite" size={16} /> Add people
          </button>
          {err && <p className="error small" role="alert">{err}</p>}
        </div>
      )}
      {groups.map((g) => (
        <section key={g.title}>
          <h3>
            {g.title} <span className="muted">{g.members.length}</span>
          </h3>
          <ul>
            {g.members.map((m) => {
              const name = m.displayName || m.username;
              const self = m.id === c.me?.id;
              return (
                <li key={m.id} className="member-row">
                  <button className="member" data-off={g.title === "Offline"} onClick={(e) => openProfile(c.url, m.id, e.currentTarget)}>
                    <Avatar m={m} size={32} presence />
                    <span className="member-text">
                      <span className="member-name">
                        <b className="truncate">{name}</b>
                        {m.kind === MemberKind.BOT && <span className="tag">Bot</span>}
                      </span>
                      {(m.statusText || m.statusEmoji) && (
                        <small className="truncate">
                          {m.statusEmoji} {m.statusText}
                        </small>
                      )}
                    </span>
                  </button>
                  {priv && canRemoveFromChannel(c.me, m) && (
                    <button
                      className="icon-btn member-remove"
                      aria-label={self ? `Leave #${priv.name}` : `Remove ${name} from #${priv.name}`}
                      title={self ? "Leave channel" : "Remove from channel"}
                      onClick={() => (self ? setLeaving(true) : drop(m.id))}
                    >
                      <Icon name={self ? "leave" : "x"} size={16} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {priv && adding && (
        <PeoplePicker
          c={c}
          title={`Add people to #${priv.name}`}
          exclude={priv.memberIds}
          action={(n) => (n ? `Add ${count(n, "person", "people")}` : "Add")}
          busyText="Adding…"
          empty="Everyone is already here."
          onSubmit={(ids) => addToChannel(c.url, priv.id, ids)}
          onClose={() => setAdding(false)}
        />
      )}
      {priv && leaving && (
        <Confirm title={`Leave #${priv.name}`} verb="Leave" onConfirm={() => (setLeaving(false), drop(c.me!.id))} onClose={() => setLeaving(false)}>
          <p className="muted">It's private, so you can't see it again until someone in it adds you back.</p>
        </Confirm>
      )}
    </div>
  );
}

/** Pick people from the community: Add people to a private channel, or start a DM. */
export function PeoplePicker({
  c,
  title,
  exclude,
  max = 0,
  action,
  busyText,
  empty,
  onSubmit,
  onClose,
  children,
}: {
  c: Community;
  title: string;
  exclude: string[];
  max?: number;
  action: (n: number) => string;
  busyText: string;
  empty: string;
  onSubmit: (ids: string[]) => Promise<unknown>;
  onClose: () => void;
  /** Shown above the search field, e.g. a community picker (1454). */
  children?: React.ReactNode;
}) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const byName = Object.values(c.members)
    .filter((m) => !exclude.includes(m.id))
    .sort((a, b) => (a.displayName || a.username).localeCompare(b.displayName || b.username));
  const options = fuzzyFilter(byName, q, (m) => [m.username, m.displayName]);
  // You may pick yourself (a self DM, 1309); you never count toward the limit.
  const n = picked.filter((id) => id !== c.me?.id).length;
  const full = max > 0 && n >= max;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!picked.length) return;
    setBusy(true);
    setErr("");
    onSubmit(picked).then(onClose, (x) => {
      setErr(errorText(x, c.info?.name));
      setBusy(false);
    });
  };
  return (
    <Dialog label={title} className="add-people" onClose={onClose}>
      <form onSubmit={submit}>
        <header className="dialog-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>
        {children}
        <input className="input" autoFocus={AUTOFOCUS} placeholder="Search by name" aria-label="Search people" value={q} onChange={(e) => setQ(e.target.value)} />
        <ul className="pick-list" aria-label="People">
          {options.map((m) => (
            <li key={m.id}>
              <label className="member">
                <input
                  type="checkbox"
                  checked={picked.includes(m.id)}
                  disabled={full && !picked.includes(m.id)}
                  onChange={(e) => setPicked((p) => (e.target.checked ? [...p, m.id] : p.filter((x) => x !== m.id)))}
                />
                <Avatar m={m} size={28} />
                <span className="member-text">
                  <span className="member-name">
                    <b className="truncate">
                      {m.displayName || m.username}
                      {m.id === c.me?.id && <span className="muted"> (you)</span>}
                    </b>
                    {m.kind === MemberKind.BOT && <span className="tag">Bot</span>}
                  </span>
                  <small className="truncate">@{m.username}</small>
                </span>
              </label>
            </li>
          ))}
          {!options.length && <li className="muted pane-note">{q ? `Nobody else matches “${q}”.` : empty}</li>}
        </ul>
        {full && <p className="fine">A group message holds up to {max} other people.</p>}
        {err && (
          <p className="error small" role="alert">
            {err}
          </p>
        )}
        <div className="row-end">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !picked.length}>
            {busy ? busyText : action(n)}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function SearchResults({ c, q }: { c: Community; q: string }) {
  const h24 = useApp((s) => s.look.clock === "24");
  const [res, setRes] = useState<Message[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    search(c.url, q).then(setRes, (e) => setErr(errorText(e, c.info?.name)));
  }, [c.url, q]);
  if (err)
    return (
      <p className="error pane-note" role="alert">
        {err}
      </p>
    );
  if (!res)
    return (
      <div className="pane-scroll" aria-busy="true">
        <p className="visually-hidden" role="status">
          Searching…
        </p>
        <Skeleton rows={5} lines={2} className="skel-results" />
      </div>
    );
  if (!res.length) return <p className="muted pane-note" role="status">No messages match “{q}”. Try fewer words.</p>;
  return (
    <ul className="pane-scroll results loaded" ref={scrollBack}>
      {res.map((m) => {
        const ch = c.channels[m.channelId];
        const a = c.members[m.authorId];
        return (
          <li key={m.id}>
            <button
              className="result"
              onClick={() => {
                jumpTo(c.url, m, true);
              }}
            >
              <span className="result-meta">
                <b>{ch ? (isDM(ch) ? channelLabel(ch, c.members, c.me?.id) : `#${ch.name}`) : "Unknown channel"}</b>
                <span className="muted">
                  {a?.displayName ?? "Unknown"}, {dayLabel(Number(m.createdAtMs), Date.now())} {timeLabel(Number(m.createdAtMs), h24)}
                </span>
              </span>
              <span className="result-text">{decodeMentions(m.text, c.members)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// Back to a result list (1433) lands where it was: jumpTo saved the scroll on this entry. Used once,
// so a new search on the same entry starts at the top.
function scrollBack(el: HTMLElement | null) {
  const y = history.state?.scroll;
  if (!el || !y) return;
  el.scrollTop = y;
  history.replaceState({ ...history.state, scroll: 0 }, "");
}

// Activity and Threads (1405): loaded each time the pane opens, rows like search results.
// Every joined community at once (1453), like the DMs tab, so a mention anywhere shows up.
function useFeed<T>(load: (url: string) => Promise<T[]>, at: (x: T) => bigint) {
  const cs = useApp((s) => s.cs);
  const order = useApp((s) => s.order);
  const urls = order.filter((u) => cs[u]?.me);
  const key = urls.join(" ");
  const name = urls.length === 1 ? cs[urls[0]].info?.name : undefined;
  const { data: res, err } = useLoad(() => Promise.allSettled(urls.map(load)).then((got) => mergeNewest(urls, got, at)), [key], name);
  const note = err ? (
    <p className="error pane-note" role="alert">
      {err}
    </p>
  ) : !res ? (
    <div className="pane-scroll" aria-busy="true">
      <Skeleton rows={5} lines={2} className="skel-results" />
    </div>
  ) : null;
  // Rows name their community when there is more than one.
  const label = (c: Community, channelId: string) => (urls.length > 1 ? `${where(c, channelId)} in ${c.info?.name ?? hostOf(c.url)}` : where(c, channelId));
  return { res, note, cs, label };
}

function where(c: Community, channelId: string) {
  const ch = c.channels[channelId];
  return ch ? (isDM(ch) ? channelLabel(ch, c.members, c.me?.id) : `#${ch.name}`) : "a channel";
}

function Activity() {
  const h24 = useApp((s) => s.look.clock === "24");
  const { res, note, cs, label } = useFeed<ActivityItem>(async (url) => (await api(url).chat.listActivity({ limit: 100 })).items, (it) => it.atMs);
  if (note) return note;
  if (!res!.length) return <p className="muted pane-note">Mentions, replies to your threads and reactions to your messages show up here.</p>;
  return (
    <ul className="pane-scroll results loaded" ref={scrollBack}>
      {res!.map(({ url, x: it }, i) => {
        const c = cs[url];
        const m = it.message!;
        const who = c.members[it.actorId]?.displayName ?? "Someone";
        const at = Number(it.atMs);
        return (
          <li key={i}>
            <button className="result" onClick={() => jumpTo(c.url, m, true)}>
              <span className="result-meta">
                <span>
                  <b>{who}</b>{" "}
                  {it.kind === ActivityKind.REACTION ? (
                    <>
                      reacted <Glyph e={it.emoji} /> in
                    </>
                  ) : it.kind === ActivityKind.REPLY ? (
                    "replied to your thread in"
                  ) : (
                    "mentioned you in"
                  )}{" "}
                  <b>{label(c, m.channelId)}</b>
                </span>
                <span className="muted">
                  {dayLabel(at, Date.now())} {timeLabel(at, h24)}
                </span>
              </span>
              <span className="result-text">{decodeMentions(m.text, c.members)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Threads() {
  const h24 = useApp((s) => s.look.clock === "24");
  const { res, note, cs, label } = useFeed<ThreadSummary>(async (url) => (await api(url).chat.listThreads({ limit: 100 })).threads, (t) => t.root!.lastReplyAtMs);
  if (note) return note;
  if (!res!.length) return <p className="muted pane-note">Threads you start or reply in show up here.</p>;
  return (
    <ul className="pane-scroll results loaded" ref={scrollBack}>
      {res!.map(({ url, x: { root, unreadCount } }) => {
        const c = cs[url];
        const m = root!;
        const at = Number(m.lastReplyAtMs);
        return (
          <li key={`${url} ${m.id}`}>
            <button
              className="result"
              data-unread={unreadCount > 0 || undefined}
              onClick={() => {
                jumpTo(c.url, { id: m.id, channelId: m.channelId, threadRootId: "" }, true);
                set({ pane: { t: "thread", rootId: m.id } });
              }}
            >
              <span className="result-meta">
                <b>{label(c, m.channelId)}</b>
                {unreadCount > 0 && <span className="badge">{unreadCount} new</span>}
              </span>
              <span className="result-text">
                <b>{c.members[m.authorId]?.displayName ?? "Unknown"}</b> {decodeMentions(m.text, c.members)}
              </span>
              <span className="muted small">
                {count(m.replyCount, "reply", "replies")}, last {dayLabel(at, Date.now())} {timeLabel(at, h24)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
