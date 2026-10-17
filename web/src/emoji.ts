// Custom emoji, pure parts: shortcodes in text, names from file paths, and planning a bulk upload.
// The server is the authority; these mirror its rules so the client can skip pointless uploads.

export type Piece = string | { name: string };

/** Split text into plain strings and known `:name:` shortcodes. Unknown names stay text. */
export function splitShortcodes(text: string, known: (name: string) => boolean): Piece[] {
  const out: Piece[] = [];
  const re = /:([a-z0-9_+-]{1,62}):/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!known(m[1])) {
      re.lastIndex = m.index + m[0].length - 1; // the closing colon may open the next one
      continue;
    }
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push({ name: m[1] });
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** The emoji name a file gets, like the server's emojiName: "pack/Party Parrot.GIF" → "party_parrot". */
export function emojiName(path: string): string {
  let base = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot > 0) base = base.slice(0, dot);
  let out = "";
  let gap = false;
  for (const ch of base.toLowerCase()) {
    if (/^[a-z0-9_-]$/.test(ch)) {
      if (gap && out) out += "_";
      out += ch;
      gap = false;
    } else gap = true;
  }
  return out.slice(0, 62).replace(/^[_-]+|[_-]+$/g, "");
}

export const MAX_EMOJI_BYTES = 256 * 1024;
export const MAX_REQUEST_BYTES = 60 * 1024 * 1024; // the server takes 64 MB per request

export type UploadStatus = "added" | "exists" | "rejected";
export interface UploadResult {
  file: string;
  name: string;
  status: UploadStatus;
  error?: string;
}

export const kindOf = (path: string): "image" | "zip" | null => {
  const ext = path.toLowerCase().split(".").pop();
  return ext === "zip" ? "zip" : ext === "png" || ext === "gif" || ext === "webp" ? "image" : null;
};

/**
 * Decide what to send from files picked or found by walking dropped folders. Hidden files are
 * dropped silently; names already on the server (or earlier in this batch) are skipped without
 * uploading, so dropping the same pack twice costs nothing. Batches stay under one request's limit.
 */
export function planUpload<F extends { path: string; size: number }>(files: F[], existing: Set<string>, maxBytes = MAX_REQUEST_BYTES) {
  const done: UploadResult[] = [];
  const send: F[] = [];
  const seen = new Set(existing);
  for (const f of files) {
    const base = f.path.split("/").pop() ?? "";
    if (base.startsWith(".") || f.path.includes("__MACOSX/")) continue;
    const kind = kindOf(f.path);
    const name = kind === "image" ? emojiName(f.path) : "";
    const reject = (error: string) => done.push({ file: f.path, name, status: "rejected", error });
    if (!kind) reject("not a PNG, GIF, WebP or .zip file");
    else if (kind === "zip" && f.size > maxBytes) reject(`larger than ${Math.floor(maxBytes / 2 ** 20)} MB; split the zip`);
    else if (kind === "zip") send.push(f);
    else if (!name) reject("no usable name; use a-z, 0-9, - and _");
    else if (f.size > MAX_EMOJI_BYTES) reject("larger than 256 KB");
    else if (seen.has(name)) done.push({ file: f.path, name, status: "exists", error: "an emoji with this name exists" });
    else {
      seen.add(name);
      send.push(f);
    }
  }
  const batches: F[][] = [];
  let size = Infinity;
  for (const f of send) {
    if (size + f.size > maxBytes) {
      batches.push([]);
      size = 0;
    }
    batches.at(-1)!.push(f);
    size += f.size;
  }
  return { done, batches };
}

/** Totals for the result summary. */
export function tally(results: UploadResult[]): Record<UploadStatus, number> {
  const t = { added: 0, exists: 0, rejected: 0 };
  for (const r of results) t[r.status]++;
  return t;
}

/** Search: names that start with the query first, then names that contain it. */
export function searchEmoji<T extends { name: string }>(list: T[], q: string): T[] {
  q = q.trim().toLowerCase().replace(/^:|:$/g, "");
  if (!q) return list;
  const starts: T[] = [];
  const has: T[] = [];
  for (const e of list) {
    if (e.name.startsWith(q)) starts.push(e);
    else if (e.name.includes(q)) has.push(e);
  }
  return starts.concat(has);
}
