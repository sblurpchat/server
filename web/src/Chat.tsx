import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type CSSProperties, type FormEvent, type KeyboardEvent } from "react";
import { useCountdown } from "./App";
import { Glyph, useCustomMatches } from "./CustomEmoji";
import { ChannelKind, ChannelMode, MemberKind, MemberRole, type Attachment, type Member, type Message } from "./gen/sblurp/v1/sblurp_pb";
import {
  acQuery,
  canRemoveFromChannel,
  buildRows,
  channelLabel,
  dayLabel,
  decodeMentions,
  encodeMentions,
  formatBytes,
  hostOf,
  isDM,
  listKey,
  matchScore,
  memberGroups,
  mentionsMe,
  retained,
  timeLabel,
  typingLabel,
  reactorsLabel,
  type Community,
  cssUrl,
  count,
  communityBadge,
  messageHash,
  nameColor,
  listStep,
} from "./logic";
import {
  absUrl,
  addToChannel,
  discardSend,
  edit,
  errorText,
  get,
  leaveList,
  loadList,
  markRead,
  flushReads,
  jumpTo,
  react,
  refreshMessage,
  removeFromChannel,
  retryNow,
  retrySend,
  search,
  send,
  set,
  setDraft,
  typing,
  upload,
  useApp,
  joinChannel,
  leaveChannel,
} from "./store";
import { Avatar, Dialog, EMOJI, EmojiPicker, emojiChar, Icon, Markdown, Pop, Resizer, useClamped } from "./ui";

const useC = () => useApp((s) => s.cs[s.url]!);
export const openProfile = (url: string, memberId: string, el: HTMLElement) =>
  set({ popover: { url, memberId, rect: el.getBoundingClientRect() } });

/** A channel topic in Markdown, clamped to two lines; the button shows all of it. */
function Topic({ c, topic, title }: { c: Community; topic: string; title: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const cut = useClamped(ref, topic);
  const [full, setFull] = useState<DOMRect | null>(null);
  const md = <Markdown text={topic} members={c.members} meId={c.me?.id} onMention={(id, el) => openProfile(c.url, id, el)} />;
  return (
    <>
      <div ref={ref} className="chan-topic msg-text">
        {md}
      </div>
      {cut && (
        <button className="icon-btn topic-more" aria-label="Show full topic" title="Show full topic" onClick={(e) => setFull(e.currentTarget.getBoundingClientRect())}>
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

export function ChannelView() {
  const c = useC();
  const channelId = useApp((s) => s.channelId);
  const pane = useApp((s) => s.pane);
  const joined = !!c.channels[channelId];
  const ch = c.channels[channelId] ?? (c.peek?.id === channelId ? c.peek : undefined);
  const [q, setQ] = useState(pane?.t === "search" ? pane.q : "");
  const [joinErr, setJoinErr] = useState("");
  const [menu, setMenu] = useState<DOMRect | null>(null);
  // Mobile hides the rail and sidebar, so the menu button carries a dot for unread anywhere.
  const elsewhere = useApp((s) =>
    Object.values(s.cs).some((x) => {
      const b = communityBadge(x);
      return b.unread || b.mentions > 0;
    }),
  );
  if (!ch) {
    return (
      <section className="channel">
        <div className="empty">
          <h2>This channel isn't here anymore.</h2>
          <p>It may have been deleted or made private. Pick another from the sidebar.</p>
        </div>
      </section>
    );
  }
  const dm = isDM(ch);
  const title = channelLabel(ch, c.members, c.me?.id);
  const other = dm ? c.members[ch.memberIds.find((id) => id !== c.me?.id) ?? ""] : undefined;
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
          aria-label={elsewhere ? "Open communities and channels, unread messages" : "Open communities and channels"}
          data-unread={elsewhere}
          onClick={() => set({ drawer: true })}
        >
          <Icon name="menu" />
        </button>
        <div className="chan-id">
          <h1 className="chan-title">
            {dm ? <Avatar m={other} size={24} presence={ch.memberIds.length === 2} /> : <Icon name={ch.kind === 2 ? "lock" : "hash"} size={20} />}
            <span className="truncate">{title}</span>
          </h1>
          {ch.topic && <Topic c={c} topic={ch.topic} title={title} />}
        </div>
        <form
          role="search"
          className="chan-search"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) set({ pane: { t: "search", q: q.trim() } });
          }}
        >
          <Icon name="search" size={16} />
          <input type="search" aria-label={`Search ${c.info?.name ?? ""}`} placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        </form>
        {(canEdit || canLeave) && (
          <button className="icon-btn" aria-label={`#${title} options`} title="Channel options" aria-haspopup="menu" onClick={(e) => setMenu(e.currentTarget.getBoundingClientRect())}>
            <Icon name="more" />
          </button>
        )}
        <Pop anchor={menu} onClose={() => setMenu(null)} className="menu" label={`#${title} options`}>
          <div role="menu" onClick={() => setMenu(null)}>
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
      {joined ? (
        <Composer url={c.url} channelId={channelId} rootId="" placeholder={dm ? `Message ${title}` : `Message #${title}`} />
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
  const secs = useCountdown(c.retryAt);
  if (c.status !== "reconnecting" && c.status !== "error") return null;
  return (
    <div className="banner" role="status">
      <span>
        Can't reach {c.info?.name ?? hostOf(c.url)}. {c.status === "reconnecting" && (secs > 0 ? `Trying again in ${secs}s.` : "Reconnecting…")}
      </span>
      <button className="btn small" onClick={() => retryNow(c.url)}>
        Try now
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message list. The scroller is flex column-reverse, so the browser keeps it pinned to the
// bottom and keeps the reading position when older messages are added on top.
// ---------------------------------------------------------------------------

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
    addEventListener("focus", check);
    addEventListener("blur", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      removeEventListener("focus", check);
      removeEventListener("blur", check);
      document.removeEventListener("visibilitychange", check);
      if (!rootId) set({ viewing: null });
    };
  });
  useEffect(() => {
    if (viewing && list) markRead(url, channelId);
  }, [viewing, ch?.lastMessageSeq, list, url, channelId]);
  useEffect(() => flushReads, [url, channelId]);

  const empty = list && !list.loading && !list.hasMore && !items.length;
  return (
    <div className="msg-wrap">
      {newAbove && (
        <button className="jump jump-new" onClick={() => scroller.current?.querySelector(".new-divider")?.scrollIntoView({ block: "center" })}>
          New messages above <Icon name="chevron" size={14} />
        </button>
      )}
      <div className="scroller" ref={scroller} onScroll={check} onKeyDown={moveFocus} tabIndex={0} aria-label="Message list. Arrow keys move between messages.">
        <div className="msgs" role="log" aria-live="polite" aria-relevant="additions" aria-label="Messages">
          {list?.error ? (
            <div className="list-note">
              <p className="error">{list.error}</p>
              <button className="btn small" onClick={() => loadList(url, channelId, rootId, list.items.length ? "older" : "")}>
                Try again
              </button>
            </div>
          ) : list?.hasMore !== false && !rootId ? (
            <div className="list-note muted" aria-busy="true">
              Loading earlier messages…
            </div>
          ) : !rootId && ch ? (
            <div className="chan-start" data-empty={!!empty}>
              {empty && (
                <span className="chan-start-icon" aria-hidden="true">
                  <Icon name={isDM(ch) ? "thread" : ch.kind === ChannelKind.PRIVATE ? "lock" : "hash"} size={32} />
                </span>
              )}
              <h2>{isDM(ch) ? channelLabel(ch, c.members, c.me?.id) : `#${ch.name}`}</h2>
              <p className="muted">
                {empty
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
const MessageRow = memo(function MessageRow({ url, m, head, inThread, fresh, focus }: { url: string; m: Message; head: boolean; inThread: boolean; fresh: boolean; focus?: boolean }) {
  const c = {
    members: useApp((s) => s.cs[s.url]!.members),
    me: useApp((s) => s.cs[s.url]!.me),
    roles: useApp((s) => s.cs[s.url]!.roles),
    failed: useApp((s) => s.cs[s.url]!.failed),
  };
  const editing = useApp((s) => s.editing === m.id);
  const [pick, setPick] = useState<DOMRect | null>(null);
  const [more, setMore] = useState<DOMRect | null>(null);
  const [who, setWho] = useState<{ emoji: string; rect: DOMRect } | null>(null);
  const press = useRef<{ timer: number; held: HTMLElement | null; long: boolean }>({ timer: 0, held: null, long: false });
  const release = (e: { pointerType: string }) => {
    clearTimeout(press.current.timer);
    const el = press.current.held;
    if (!el) return;
    // A touch release also fires click; that click must not toggle the reaction.
    press.current = { timer: 0, held: null, long: e.pointerType !== "mouse" };
    setWho({ emoji: el.dataset.emoji!, rect: el.getBoundingClientRect() });
  };
  const whoR = who && m.reactions.find((r) => r.emoji === who.emoji);
  const author = c.members[m.authorId];
  const mine = m.authorId === c.me?.id;
  const pending = m.seq === 0n && !!m.clientId;
  const failed = pending && c.failed[m.clientId];
  const name = author?.displayName || author?.username || "Unknown member";
  const h24 = useApp((s) => s.look.clock === "24");
  const surfaces = useApp((s) => s.surfaces);
  const color = nameColor(author, c.roles, surfaces);
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
  return (
    <article
      className="msg"
      data-head={head}
      data-mine={mine}
      data-pending={pending && !failed}
      data-failed={!!failed}
      data-mention={mentionsMe(m.text, c.me?.id)}
      data-fresh={fresh}
      data-focus={focus}
      data-editing={editing}
      tabIndex={-1}
      aria-label={`${name}, ${timeLabel(Number(m.createdAtMs), h24)}`}
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
        {editing ? (
          <EditBox url={url} m={m} />
        ) : (
          <div className="msg-text">
            <Markdown text={m.text} members={c.members} meId={c.me?.id} onMention={(id, el) => openProfile(url, id, el)} />
            {m.editedAtMs > 0n && <span className="edited">(edited)</span>}
          </div>
        )}
        {m.attachments.length > 0 && (
          <div className="atts">
            {m.attachments.map((a) => (
              <AttachmentView key={a.id} url={url} a={a} m={m} />
            ))}
          </div>
        )}
        {failed && (
          <p className="send-failed" role="alert">
            Couldn't send this message.
            <button className="link-btn" onClick={() => retrySend(url, m)}>
              Try again
            </button>
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
                    else void react(url, m, r.emoji);
                  }}
                >
                  <Glyph e={r.emoji} /> {r.memberIds.length}
                </button>
              );
            })}
            <button className="reaction add" aria-label="Add reaction" onClick={(e) => setPick(e.currentTarget.getBoundingClientRect())}>
              <Icon name="smile" size={16} />
            </button>
          </div>
        )}
        {!inThread && m.replyCount > 0 && <ThreadLink m={m} />}
      </div>
      {!pending && !editing && (
        <div className="toolbar" role="toolbar" aria-label="Message actions">
          <button aria-label="Add reaction" title="Add reaction" onClick={(e) => setPick(e.currentTarget.getBoundingClientRect())}>
            <Icon name="smile" size={18} />
          </button>
          {!inThread && (
            <button aria-label="Reply in thread" title="Reply in thread" onClick={() => set({ pane: { t: "thread", rootId: m.id } })}>
              <Icon name="thread" size={18} />
            </button>
          )}
          {mine && (
            <button aria-label="Edit message" title="Edit" onClick={() => set({ editing: m.id })}>
              <Icon name="edit" size={18} />
            </button>
          )}
          <button aria-label="More actions" title="More" aria-haspopup="menu" onClick={(e) => setMore(e.currentTarget.getBoundingClientRect())}>
            <Icon name="more" size={18} />
          </button>
        </div>
      )}
      <Pop anchor={pick} side="left" onClose={() => setPick(null)} label="Pick a reaction">
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
      <Pop anchor={more} side="left" onClose={() => setMore(null)} className="menu" label="Message actions">
        <div role="menu" onClick={() => setMore(null)}>
          <button role="menuitem" onClick={() => navigator.clipboard.writeText(decodeMentions(m.text, c.members))}>
            <Icon name="copy" size={18} /> Copy text
          </button>
          <button role="menuitem" onClick={() => navigator.clipboard.writeText(location.origin + location.pathname + location.search + messageHash(url, m))}>
            <Icon name="link" size={18} /> Copy link
          </button>
          {mine && (
            <button role="menuitem" className="danger" onClick={() => set({ modal: { t: "delete", id: m.id } })}>
              <Icon name="trash" size={18} /> Delete message
            </button>
          )}
        </div>
      </Pop>
    </article>
  );
});

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
        value={text}
        autoFocus
        onFocus={(e) => e.target.setSelectionRange(text.length, text.length)}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            set({ editing: null });
          }
        }}
      />
      {err && <p className="error small">{err}</p>}
      <p className="fine">
        Enter to save, Esc to cancel.{" "}
        <button className="link-btn" onClick={() => set({ editing: null })}>
          Cancel
        </button>{" "}
        <button className="link-btn" onClick={save}>
          Save
        </button>
      </p>
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

interface Pending {
  id: string;
  name: string;
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
  const options = useMemo(() => {
    if (!ac) return [];
    if (ac.kind === ":")
      return [
        ...EMOJI.filter(([n]) => n.includes(ac.q))
          .slice(0, custom.length ? 4 : 8)
          .map(([n, ch]) => ({ id: n, label: `:${n}:`, insert: `${ch} `, m: undefined })),
        ...custom.map((e) => ({ id: `c:${e.name}`, label: `:${e.name}:`, insert: `:${e.name}: `, m: undefined })),
      ].slice(0, 8);
    return Object.values(c.members)
      .map((m) => ({ m, s: Math.max(matchScore(ac.q, m.username), matchScore(ac.q, m.displayName)) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s || a.m.username.localeCompare(b.m.username))
      .slice(0, 8)
      .map(({ m }) => ({ id: m.id, label: m.displayName || m.username, insert: `@${m.username} `, m: m as Member | undefined }));
  }, [ac?.kind, ac?.q, c.members, custom]); // eslint-disable-line react-hooks/exhaustive-deps

  const uploading = files.some((f) => !f.att && !f.error);
  const ready = files.filter((f) => f.att).map((f) => f.att!);

  const addFiles = (list: FileList | File[]) => {
    for (const file of Array.from(list)) {
      const id = crypto.randomUUID();
      setFiles((fs) => [...fs, { id, name: file.name }]);
      upload(url, file).then(
        (att) => setFiles((fs) => fs.map((f) => (f.id === id ? { ...f, att } : f))),
        (e) => setFiles((fs) => fs.map((f) => (f.id === id ? { ...f, error: errorText(e, c.info?.name) } : f))),
      );
    }
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (uploading || (!text.trim() && !ready.length)) return;
    void send(url, channelId, rootId, encodeMentions(text.trim(), Object.values(c.members)), ready);
    setDraft(key, "");
    setFiles([]);
  };

  const choose = (i: number) => {
    const o = options[i];
    if (!o || !ac) return;
    const next = text.slice(0, ac.start) + o.insert + text.slice(caret);
    setDraft(key, next);
    const pos = ac.start + o.insert.length;
    requestAnimationFrame(() => {
      ref.current?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  // Files dropped anywhere over the channel (or the thread pane) land in this composer.
  const add = useRef(addFiles);
  add.current = addFiles;
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

  return (
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
              {o.m ? <Avatar m={o.m} size={22} /> : <Glyph e={o.label} />}
              <b>{o.label}</b>
              {o.m && <span className="muted">@{o.m.username}</span>}
              {o.m?.kind === MemberKind.BOT && <span className="tag">Bot</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="composer-box">
        {files.length > 0 && (
          <ul className="chips" aria-label="Attachments">
            {files.map((f) => (
              <li key={f.id} className="chip" data-error={!!f.error} aria-busy={!f.att && !f.error}>
                <Icon name="file" size={16} />
                <span className="truncate">{f.error ? `${f.name}: ${f.error}` : f.att ? f.name : `Uploading ${f.name}…`}</span>
                <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((fs) => fs.filter((x) => x.id !== f.id))}>
                  <Icon name="x" size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="composer-row">
          <label className="icon-btn attach" title="Attach files">
            <input type="file" multiple className="visually-hidden" aria-label="Attach files" onChange={(e) => (e.target.files && addFiles(e.target.files), (e.target.value = ""))} />
            <Icon name="clip" />
          </label>
          <textarea
            ref={ref}
            rows={1}
            className="composer-input"
            aria-label={placeholder}
            placeholder={placeholder}
            value={text}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={options.length > 0}
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
              if (e.key === "Enter" && !e.shiftKey) {
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
          <button className="send" aria-label="Send" disabled={uploading || (!text.trim() && !ready.length)}>
            <Icon name="send" size={18} />
          </button>
        </div>
      </div>
      {rootId && <TypingLine c={c} k={listKey(channelId, rootId)} />}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Right pane: thread, members, search
// ---------------------------------------------------------------------------

export function RightPane() {
  const pane = useApp((s) => s.pane);
  const c = useC();
  const channelId = useApp((s) => s.channelId);
  if (!pane) return null;
  const ch = c.channels[channelId];
  const close = () => set({ pane: null });
  const title = pane.t === "thread" ? "Thread" : pane.t === "members" ? "Members" : "Search";
  return (
    <aside className="pane" aria-label={title}>
      <Resizer panel="pane" label="Resize side pane" />
      <header className="pane-head">
        <div>
          <h2>{title}</h2>
          {pane.t === "thread" && ch && <p className="muted small truncate">{isDM(ch) ? channelLabel(ch, c.members, c.me?.id) : `#${ch.name}`}</p>}
          {pane.t === "search" && <p className="muted small truncate">“{pane.q}” in {c.info?.name}</p>}
          {pane.t === "members" && ch?.kind === ChannelKind.PRIVATE && <p className="muted small truncate">#{ch.name}</p>}
        </div>
        <button className="icon-btn" aria-label={`Close ${title.toLowerCase()}`} onClick={close}>
          <Icon name="x" />
        </button>
      </header>
      {pane.t === "thread" ? (
        <>
          <MessageList key={pane.rootId} url={c.url} channelId={channelId} rootId={pane.rootId} />
          <Composer key={`c${pane.rootId}`} url={c.url} channelId={channelId} rootId={pane.rootId} placeholder="Reply in thread" />
        </>
      ) : pane.t === "members" ? (
        <Members c={c} />
      ) : (
        <SearchResults key={pane.q} c={c} q={pane.q} />
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
        <Dialog label={`Leave #${priv.name}`} className="confirm" onClose={() => setLeaving(false)}>
          <h2>Leave #{priv.name}?</h2>
          <p className="muted">It's private, so you can't see it again until someone in it adds you back.</p>
          <div className="row-end">
            <button className="btn ghost" autoFocus onClick={() => setLeaving(false)}>
              Cancel
            </button>
            <button className="btn danger" onClick={() => (setLeaving(false), drop(c.me!.id))}>
              Leave
            </button>
          </div>
        </Dialog>
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
}) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const options = Object.values(c.members)
    .filter((m) => !exclude.includes(m.id))
    .map((m) => ({ m, s: Math.max(matchScore(q, m.username), matchScore(q, m.displayName)) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || (a.m.displayName || a.m.username).localeCompare(b.m.displayName || b.m.username))
    .map((x) => x.m);
  const full = max > 0 && picked.length >= max;
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
        <input className="input" autoFocus placeholder="Search by name" aria-label="Search people" value={q} onChange={(e) => setQ(e.target.value)} />
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
                    <b className="truncate">{m.displayName || m.username}</b>
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
            {busy ? busyText : action(picked.length)}
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
  }, [c.url, q]); // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <p className="error pane-note">{err}</p>;
  if (!res) return <p className="muted pane-note">Searching…</p>;
  if (!res.length) return <p className="muted pane-note">No messages match “{q}”. Try fewer words.</p>;
  return (
    <ul className="pane-scroll results">
      {res.map((m) => {
        const ch = c.channels[m.channelId];
        const a = c.members[m.authorId];
        return (
          <li key={m.id}>
            <button
              className="result"
              onClick={() => {
                jumpTo(c.url, m);
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
