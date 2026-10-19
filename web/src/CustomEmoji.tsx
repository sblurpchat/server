// Custom emoji in the client: the per-community list (one cached fetch, revalidated with the
// server's ETag and refetched on emoji_changed), inline rendering, and the
// Emoji tab of community settings with bulk upload (files, folders, zips) and export.
import { fromJson } from "@bufbuild/protobuf";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from "react";
import { getToken } from "./auth";
import { emojiName, planUpload, searchEmoji, splitShortcodes, tally, type UploadResult } from "./emoji";
import { fakeEmoji } from "./fakeEmoji";
import { EmojiUploadStatus, ListEmojiResponseSchema, MemberRole, UploadEmojiResponseSchema } from "./gen/sblurp/v1/sblurp_pb";
import { count, hostOf } from "./logic";
import { absUrl, api, errorText, FAKE, useApp } from "./store";
import { emojiChar, Icon } from "./ui";

export interface Emoji {
  name: string;
  src: string;
}
interface EmojiSet {
  list: Emoji[];
  by: Map<string, string>;
  raw?: string;
}

// ---------------------------------------------------------------------------
// The list, per community
// ---------------------------------------------------------------------------

const EMPTY: EmojiSet = { list: [], by: new Map() };
const sets = new Map<string, EmojiSet>();
const subs = new Set<() => void>();
function put(url: string, list: Emoji[], raw?: string) {
  sets.set(url, { list, by: new Map(list.map((e) => [e.name, e.src])), raw });
  subs.forEach((f) => f());
}
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
export const useEmojiSet = (url: string) => useSyncExternalStore(subscribe, () => sets.get(url) ?? EMPTY);

/** Fetch the list. The browser sends If-None-Match from its cache, so an unchanged list is a 304. */
export async function loadEmoji(url: string) {
  if (FAKE) {
    if (!sets.has(url)) put(url, fakeEmoji(url));
    return;
  }
  try {
    const res = await fetch(`${url}/emoji`, { headers: { Authorization: `Bearer ${await getToken(url)}` }, cache: "no-cache" });
    if (!res.ok) return; // an older server has no /emoji
    const raw = await res.text();
    if (raw === sets.get(url)?.raw) return;
    const j = fromJson(ListEmojiResponseSchema, JSON.parse(raw));
    put(url, j.emoji.map((e) => ({ name: e.name, src: absUrl(url, e.url) })), raw);
  } catch {
    // offline or signed out: keep the list we have
  }
}

const isBuiltin = (name: string) => emojiChar(`:${name}:`) !== `:${name}:`;

export function Img({ e }: { e: Emoji }) {
  return <img className="cemoji" src={e.src} alt={`:${e.name}:`} title={`:${e.name}:`} loading="lazy" decoding="async" draggable={false} />;
}

/** A reaction or status emoji: a character, a custom image, or the text when unknown. */
export function Glyph({ e }: { e: string }) {
  const { by } = useEmojiSet(useApp((s) => s.url));
  const name = /^:([a-z0-9_+-]{1,62}):$/.exec(e)?.[1];
  const src = name && !isBuiltin(name) ? by.get(name) : undefined;
  return src ? <Img e={{ name: name!, src }} /> : <span className="emoji">{emojiChar(e)}</span>;
}

/** Message text with known :shortcodes: drawn as emoji. */
export function Shortcodes({ text }: { text: string }) {
  const { by } = useEmojiSet(useApp((s) => s.url));
  return (
    <>
      {splitShortcodes(text, (n) => isBuiltin(n) || by.has(n)).map((p, i) =>
        typeof p === "string" ? p : isBuiltin(p.name) ? emojiChar(`:${p.name}:`) : <Img key={i} e={{ name: p.name, src: by.get(p.name)! }} />,
      )}
    </>
  );
}

/** Render `step` more items each time the sentinel scrolls into view, so 5,000 emoji cost a page. */
export function useMore(step = 160) {
  const [limit, setLimit] = useState(step);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setLimit((l) => l + step), { rootMargin: "240px" });
    io.observe(el);
    return () => io.disconnect();
  }, [limit, step]);
  return [limit, ref] as const;
}

/** Custom emoji matching an autocomplete query, for the composer's ":" list. */
export function useCustomMatches(q: string | null, max: number) {
  const { list } = useEmojiSet(useApp((s) => s.url));
  return useMemo(() => (q ? searchEmoji(list, q).slice(0, max) : []), [list, q, max]);
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

interface Picked {
  path: string;
  file: File;
}

/** Walk dropped files and folders. Entries must be taken during the drop event itself. */
async function walk(entry: FileSystemEntry, out: Picked[]) {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    out.push({ path: entry.fullPath.replace(/^\//, ""), file });
  } else if (entry.isDirectory) {
    const r = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => r.readEntries(res, rej)); // 100 at a time
      if (!batch.length) break;
      for (const e of batch) await walk(e, out);
    }
  }
}

const STATUS: Record<number, UploadResult["status"]> = {
  [EmojiUploadStatus.ADDED]: "added",
  [EmojiUploadStatus.EXISTS]: "exists",
  [EmojiUploadStatus.REJECTED]: "rejected",
};

async function postBatch(url: string, batch: Picked[]): Promise<UploadResult[]> {
  if (FAKE) {
    const cur = sets.get(url)?.list ?? [];
    const added = batch.filter((p) => !p.path.endsWith(".zip")).map((p) => ({ name: emojiName(p.path), src: URL.createObjectURL(p.file) }));
    put(url, [...cur, ...added].sort((a, b) => a.name.localeCompare(b.name)));
    return batch.map((p) =>
      p.path.endsWith(".zip") ? { file: p.path, name: "", status: "rejected", error: "zips need a real server" } : { file: p.path, name: emojiName(p.path), status: "added" },
    );
  }
  const body = new FormData();
  for (const p of batch) body.append("file", p.file, p.path);
  const res = await fetch(`${url}/emoji`, { method: "POST", body, headers: { Authorization: `Bearer ${await getToken(url)}` } });
  if (res.status === 404 || res.status === 405) throw new Error("This community's server doesn't support custom emoji yet.");
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error ? `Upload failed: ${j.error}` : `Upload failed (${res.status}). Try again.`);
  return fromJson(UploadEmojiResponseSchema, j).results.map((r) => ({ file: r.file, name: r.name, status: STATUS[r.status] ?? "rejected", error: r.error || undefined }));
}

async function exportZip(url: string) {
  const res = await fetch(`${url}/emoji.zip`, { headers: { Authorization: `Bearer ${await getToken(url)}` } });
  if (!res.ok) throw new Error(`Export failed (${res.status}). Try again.`);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(await res.blob());
  a.download = `${hostOf(url)}-emoji.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

const SHOW_RESULTS = 200;

export function EmojiTab({ url }: { url: string }) {
  const role = useApp((s) => s.cs[url]?.me?.role ?? MemberRole.MEMBER);
  const manage = role >= MemberRole.MODERATOR;
  const { list } = useEmojiSet(url);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<UploadResult[] | null>(null);
  const [busy, setBusy] = useState<{ done: number; total: number; failed: number } | null>(null);
  const [err, setErr] = useState("");
  const [drag, setDrag] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [gone, setGone] = useState("");
  const hits = useMemo(() => searchEmoji(list, q), [list, q]);
  useEffect(() => void loadEmoji(url), [url]);

  const run = async (picked: Picked[]) => {
    if (!picked.length || busy) return;
    setErr("");
    const { done, batches } = planUpload(
      picked.map((p) => ({ ...p, size: p.file.size })),
      new Set(list.map((e) => e.name)),
    );
    let all = done;
    setResults(all);
    const total = batches.reduce((n, b) => n + b.length, 0);
    let sent = 0;
    let failed = 0;
    setBusy({ done: 0, total, failed: 0 });
    const queue = [...batches];
    const worker = async () => {
      for (let b; (b = queue.shift()); ) {
        let res: UploadResult[];
        try {
          res = await postBatch(url, b);
        } catch (e) {
          const error = e instanceof Error ? e.message : errorText(e);
          setErr(error);
          failed += b.length;
          res = b.map((p) => ({ file: p.path, name: emojiName(p.path), status: "rejected", error }));
        }
        all = [...res, ...all];
        sent += b.length;
        setResults(all);
        setBusy({ done: sent, total, failed });
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    setBusy(null);
    void loadEmoji(url);
  };

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    if (!manage) return;
    const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter((x): x is FileSystemEntry => !!x);
    if (!entries.length) return run([...e.dataTransfer.files].map((file) => ({ path: file.name, file })));
    const out: Picked[] = [];
    for (const en of entries) await walk(en, out);
    void run(out);
  };

  const del = async (name: string) => {
    setConfirm("");
    setErr("");
    try {
      if (!FAKE) await api(url).server.deleteEmoji({ name });
      setGone(name);
      setTimeout(() => {
        setGone("");
        if (FAKE) put(url, (sets.get(url)?.list ?? []).filter((x) => x.name !== name));
        else void loadEmoji(url);
      }, 150);
    } catch (e) {
      setErr(errorText(e));
    }
  };

  const t = results && tally(results);
  const issues = results?.filter((r) => r.status !== "added") ?? [];
  const [limit, more] = useMore(200);
  return (
    <div
      className="stack emoji-tab"
      data-drag={drag || undefined}
      onDragOver={(e) => {
        if (!manage || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDrag(false)}
      onDrop={onDrop}
    >
      <p className="muted small">
        Use custom emoji in messages and reactions as <code>:name:</code>.{" "}
        {manage ? "PNG, GIF or WebP, up to 256 KB and 512 × 512. The file name becomes the emoji name." : "Moderators and admins can add and delete them."}{" "}
        Want to automate this?{" "}
        <a href="https://sblurp.chat/docs/api/files#custom-emoji" target="_blank" rel="noreferrer">
          See the emoji API <Icon name="external" size={14} />
        </a>
      </p>
      {manage && (
        <div className="emoji-drop dropzone" data-over={drag || undefined} aria-busy={!!busy}>
          <span className="drop-well">
            <Icon name="upload" size={22} />
          </span>
          <p>
            <b>Drop images, folders or .zip files here</b>
            <span className="muted small">Slackmoji packs work as they are. Names that exist are skipped.</span>
          </p>
          <div className="emoji-actions">
            <label className="btn small">
              <input type="file" multiple accept="image/png,image/gif,image/webp,.zip" className="visually-hidden" onChange={(e) => (void run([...(e.target.files ?? [])].map((file) => ({ path: file.name, file }))), (e.target.value = ""))} />
              <Icon name="image" size={16} /> Choose files
            </label>
            <label className="btn small">
              <input
                type="file"
                className="visually-hidden"
                {...{ webkitdirectory: "" }}
                onChange={(e) => (void run([...(e.target.files ?? [])].map((file) => ({ path: file.webkitRelativePath || file.name, file }))), (e.target.value = ""))}
              />
              <Icon name="folder" size={16} /> Choose a folder
            </label>
          </div>
        </div>
      )}
      {busy && (
        <p className="emoji-status" role="status">
          Uploading {busy.done.toLocaleString("en-US")} of {count(busy.total, "file", "files")}…
          {busy.failed > 0 && <span className="bad"> {busy.failed.toLocaleString("en-US")} failed</span>}
        </p>
      )}
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      {t && !busy && (
        <div className="emoji-results" role="status">
          <p>
            <b>{count(t.added, "emoji added", "emoji added")}</b>
            {t.exists > 0 && <span> · {count(t.exists, "skipped, name taken", "skipped, names taken")}</span>}
            {t.rejected > 0 && <span className="bad"> · {count(t.rejected, "rejected", "rejected")}</span>}
            <button className="btn ghost small" onClick={() => setResults(null)}>
              Dismiss
            </button>
          </p>
          {issues.length > 0 && (
            <ul aria-label="Files not added">
              {issues.slice(0, SHOW_RESULTS).map((r, i) => (
                <li key={i} data-status={r.status}>
                  <span className="truncate">{r.file}</span>
                  <span className="muted">{r.error}</span>
                </li>
              ))}
              {issues.length > SHOW_RESULTS && <li className="muted">and {count(issues.length - SHOW_RESULTS, "more", "more")}</li>}
            </ul>
          )}
        </div>
      )}
      <div className="emoji-bar">
        <input className="input" type="search" placeholder="Search emoji" aria-label="Search custom emoji" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="muted small">{count(list.length, "emoji", "emoji")}</span>
        <button className="btn small" disabled={!list.length} onClick={() => (FAKE ? setErr("Export needs a real server.") : exportZip(url).catch((e) => setErr(e.message)))}>
          <Icon name="download" size={16} /> Export .zip
        </button>
      </div>
      {!list.length && <p className="muted small">No custom emoji yet.</p>}
      {list.length > 0 && !hits.length && <p className="muted small">No emoji match “{q}”.</p>}
      <ul className="emoji-tiles" aria-label="Custom emoji" key={q}>
        {hits.slice(0, limit).map((e) => (
          <li key={e.name} data-gone={gone === e.name || undefined}>
            <Img e={e} />
            <span className="truncate" title={`:${e.name}:`}>
              :{e.name}:
            </span>
            {manage &&
              (confirm === e.name ? (
                <button className="btn danger small" onClick={() => del(e.name)} onBlur={() => setConfirm("")} autoFocus>
                  Delete
                </button>
              ) : (
                <button className="icon-btn" aria-label={`Delete :${e.name}:`} title="Delete" onClick={() => setConfirm(e.name)}>
                  <Icon name="trash" size={16} />
                </button>
              ))}
          </li>
        ))}
      </ul>
      {limit < hits.length && <div ref={more} className="emoji-more" />}
    </div>
  );
}
