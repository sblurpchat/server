import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from "react";
import { useCountdown } from "./App";
import { MemberKind, type Attachment, type Member, type Message } from "./gen/sblurp/v1/sblurp_pb";
import {
  acQuery,
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
  timeLabel,
  typingLabel,
  type Community,
  count,
  communityBadge,
} from "./logic";
import {
  absUrl,
  discardSend,
  edit,
  errorText,
  get,
  loadList,
  markRead,
  jumpTo,
  react,
  refreshMessage,
  retryNow,
  retrySend,
  search,
  send,
  set,
  setDraft,
  typing,
  upload,
  useApp,
} from "./store";
import { Avatar, EMOJI, EmojiPicker, emojiChar, Icon, Markdown, Pop } from "./ui";

const useC = () => useApp((s) => s.cs[s.url]!);
const openProfile = (url: string, memberId: string, el: HTMLElement) =>
  set({ popover: { url, memberId, rect: el.getBoundingClientRect() } });

// ---------------------------------------------------------------------------
// Channel view
// ---------------------------------------------------------------------------

export function ChannelView() {
  const c = useC();
  const channelId = useApp((s) => s.channelId);
  const pane = useApp((s) => s.pane);
  const ch = c.channels[channelId];
  const [q, setQ] = useState(pane?.t === "search" ? pane.q : "");
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
  return (
    <section className="channel" aria-label={dm ? title : `#${title}`}>
      <header className="chan-head">
        <button
          className="icon-btn only-mobile menu-btn"
          aria-label={elsewhere ? "Open communities and channels, unread messages" : "Open communities and channels"}
          data-unread={elsewhere}
          onClick={() => set({ drawer: true })}
        >
          <Icon name="menu" />
        </button>
        <h1 className="chan-title">
          {dm ? <Avatar m={other} size={24} presence={ch.memberIds.length === 2} /> : <Icon name={ch.kind === 2 ? "lock" : "hash"} size={20} />}
          <span className="truncate">{title}</span>
        </h1>
        {ch.topic && <p className="chan-topic truncate">{ch.topic}</p>}
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
      <Composer url={c.url} channelId={channelId} rootId="" placeholder={dm ? `Message ${title}` : `Message #${title}`} />
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
  const rows = useMemo(() => buildRows(list?.items ?? [], marker, c.me?.id), [list?.items, marker, c.me?.id]);

  useEffect(() => {
    if (!list) void loadList(url, channelId, rootId);
  }, [url, channelId, rootId, list]);

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

  const empty = list && !list.loading && !list.hasMore && !list.items.length;
  return (
    <div className="msg-wrap">
      {newAbove && (
        <button className="jump jump-new" onClick={() => scroller.current?.querySelector(".new-divider")?.scrollIntoView({ block: "center" })}>
          New messages above <Icon name="chevron" size={14} />
        </button>
      )}
      <div className="scroller" ref={scroller} onScroll={check} tabIndex={-1}>
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
            <div className="chan-start">
              <h2>{isDM(ch) ? channelLabel(ch, c.members, c.me?.id) : `#${ch.name}`}</h2>
              <p className="muted">
                {empty
                  ? isDM(ch)
                    ? `This is the start of your conversation with ${channelLabel(ch, c.members, c.me?.id)}. Say hello.`
                    : `This is the start of #${ch.name}. Say hello.`
                  : isDM(ch)
                    ? `This is the start of your conversation with ${channelLabel(ch, c.members, c.me?.id)}.`
                    : `This is the start of #${ch.name}.${ch.topic ? ` ${ch.topic}` : ""}`}
              </p>
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

function MessageRow({ url, m, head, inThread, fresh, focus }: { url: string; m: Message; head: boolean; inThread: boolean; fresh: boolean; focus?: boolean }) {
  const c = useC();
  const editing = useApp((s) => s.editing === m.id);
  const [pick, setPick] = useState<DOMRect | null>(null);
  const [more, setMore] = useState<DOMRect | null>(null);
  const author = c.members[m.authorId];
  const mine = m.authorId === c.me?.id;
  const pending = m.seq === 0n && !!m.clientId;
  const failed = pending && c.failed[m.clientId];
  const name = author?.displayName || author?.username || "Unknown member";
  const time = new Date(Number(m.createdAtMs));
  const timeEl = (
    <time dateTime={time.toISOString()} title={time.toLocaleString()}>
      {timeLabel(Number(m.createdAtMs))}
    </time>
  );
  if (m.deleted) {
    return (
      <article className="msg deleted" data-head={head}>
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
      aria-label={`${name}, ${timeLabel(Number(m.createdAtMs))}`}
    >
      <div className="msg-gutter">
        {head ? (
          <button className="avatar-btn" aria-label={`${name}'s profile`} onClick={(e) => openProfile(url, m.authorId, e.currentTarget)}>
            <Avatar m={author} />
          </button>
        ) : (
          <span className="hover-time">{timeEl}</span>
        )}
      </div>
      <div className="msg-body">
        {head && (
          <header className="msg-head">
            <button className="name" onClick={(e) => openProfile(url, m.authorId, e.currentTarget)}>
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
              const who = r.memberIds.map((id) => c.members[id]?.displayName ?? "someone").join(", ");
              return (
                <button key={r.emoji} className="reaction" aria-pressed={me} title={`${who} reacted with ${r.emoji}`} onClick={() => react(url, m, r.emoji)}>
                  <span className="emoji">{emojiChar(r.emoji)}</span> {r.memberIds.length}
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
      <Pop anchor={more} side="left" onClose={() => setMore(null)} className="menu" label="Message actions">
        <div role="menu" onClick={() => setMore(null)}>
          <button role="menuitem" onClick={() => navigator.clipboard.writeText(decodeMentions(m.text, c.members))}>
            <Icon name="copy" size={18} /> Copy text
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
}

function ThreadLink({ m }: { m: Message }) {
  const open = useApp((s) => s.pane?.t === "thread" && s.pane.rootId === m.id);
  return (
    <button className="thread-link" aria-pressed={open} onClick={() => set({ pane: { t: "thread", rootId: m.id } })}>
      <Icon name="thread" size={16} />
      <b>{count(m.replyCount, "reply", "replies")}</b>
      {m.lastReplyAtMs > 0n && <span className="muted">Last reply {timeLabel(Number(m.lastReplyAtMs))}</span>}
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
  const [dragging, setDragging] = useState(false);
  const ref = useAutosize(text);
  const ac = acQuery(text, caret);
  const options = useMemo(() => {
    if (!ac) return [];
    if (ac.kind === ":") return EMOJI.filter(([n]) => n.includes(ac.q)).slice(0, 8).map(([n, ch]) => ({ id: n, label: `:${n}:`, insert: `${ch} `, m: undefined }));
    return Object.values(c.members)
      .map((m) => ({ m, s: Math.max(matchScore(ac.q, m.username), matchScore(ac.q, m.displayName)) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s || a.m.username.localeCompare(b.m.username))
      .slice(0, 8)
      .map(({ m }) => ({ id: m.id, label: m.displayName || m.username, insert: `@${m.username} `, m: m as Member | undefined }));
  }, [ac?.kind, ac?.q, c.members]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  };

  return (
    <form
      className="composer"
      data-drag={dragging}
      onSubmit={submit}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
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
              {o.m ? <Avatar m={o.m} size={22} /> : <span className="emoji">{o.insert.trim()}</span>}
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
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setSel((s) => (s + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
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
      <header className="pane-head">
        <div>
          <h2>{title}</h2>
          {pane.t === "thread" && ch && <p className="muted small truncate">{isDM(ch) ? channelLabel(ch, c.members, c.me?.id) : `#${ch.name}`}</p>}
          {pane.t === "search" && <p className="muted small truncate">“{pane.q}” in {c.info?.name}</p>}
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

function Members({ c }: { c: Community }) {
  const groups = useMemo(() => memberGroups(Object.values(c.members)), [c.members]);
  return (
    <div className="pane-scroll members">
      {groups.map((g) => (
        <section key={g.title}>
          <h3>
            {g.title} <span className="muted">{g.members.length}</span>
          </h3>
          <ul>
            {g.members.map((m) => (
              <li key={m.id}>
                <button className="member" data-off={g.title === "Offline"} onClick={(e) => openProfile(c.url, m.id, e.currentTarget)}>
                  <Avatar m={m} size={32} presence />
                  <span className="member-text">
                    <span className="member-name">
                      <b className="truncate">{m.displayName || m.username}</b>
                      {m.kind === MemberKind.BOT && <span className="tag">Bot</span>}
                    </span>
                    {(m.statusText || m.statusEmoji) && (
                      <small className="truncate">
                        {m.statusEmoji} {m.statusText}
                      </small>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function SearchResults({ c, q }: { c: Community; q: string }) {
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
                  {a?.displayName ?? "Unknown"}, {dayLabel(Number(m.createdAtMs), Date.now())} {timeLabel(Number(m.createdAtMs))}
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
