// Custom emoji, pure parts: shortcodes in text, names from file paths, and planning a bulk upload.
// The server is the authority; these mirror its rules so the client can skip pointless uploads.

import { fuzzyFilter } from "./logic";

type Piece = string | { name: string };

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

const MAX_EMOJI_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = 60 * 1024 * 1024; // the server takes 64 MB per request
const MAX_REQUEST_FILES = 20; // small requests so progress moves and one failure costs little

type UploadStatus = "added" | "exists" | "rejected";
export interface UploadResult {
  file: string;
  name: string;
  status: UploadStatus;
  error?: string;
}

const kindOf = (path: string): "image" | "zip" | null => {
  const ext = path.toLowerCase().split(".").pop();
  return ext === "zip" ? "zip" : ext === "png" || ext === "gif" || ext === "webp" ? "image" : null;
};

/**
 * Decide what to send from files picked or found by walking dropped folders. Hidden files are
 * dropped silently; names already on the server (or earlier in this batch) are skipped without
 * uploading, so dropping the same pack twice costs nothing. Batches stay under one request's limit.
 */
export function planUpload<F extends { path: string; size: number }>(files: F[], existing: Set<string>, maxBytes = MAX_REQUEST_BYTES, maxFiles = MAX_REQUEST_FILES) {
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
    if (size + f.size > maxBytes || batches.at(-1)!.length >= maxFiles) {
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

/** Search: fuzzy by name or Unicode name (alt), best first ("canof" finds can-of-worms); a leading or trailing colon is ignored. */
export function searchEmoji<T extends { name: string; alt?: string }>(list: T[], q: string): T[] {
  q = q.trim().replace(/^:|:$/g, "");
  return q ? fuzzyFilter(list, q, (e) => (e.alt ? [e.name, e.alt] : e.name)) : list;
}

/** One cell in the picker: a standard emoji has `ch`, a community one has `src`. */
export interface PickItem {
  name: string;
  ch?: string;
  src?: string;
  alt?: string; // the Unicode name when name is a Slack one
}
interface PickSection {
  id: string;
  label: string;
  items: PickItem[];
}

/**
 * The picker's sections, standard and custom in one grid. A query gives one ranked list across
 * both (a custom emoji named like a standard one shows the standard one, as messages do).
 * Without a query: frequently used first, then the standard groups, then the community's own.
 */
export function pickerSections(groups: PickSection[], custom: PickItem[], recent: string[], q: string): PickSection[] {
  const by = new Map<string, PickItem>();
  for (const e of groups.flatMap((g) => g.items).concat(custom)) if (!by.has(e.name)) by.set(e.name, e);
  if (q.trim()) return [{ id: "results", label: "Results", items: searchEmoji([...by.values()], q) }];
  const freq = recent.flatMap((n) => by.get(n) ?? []);
  const own = custom.filter((e) => by.get(e.name) === e);
  return [...(freq.length ? [{ id: "recent", label: "Frequently used", items: freq }] : []), ...groups, ...(own.length ? [{ id: "custom", label: "Custom", items: own }] : [])];
}

/** Move a just-picked name to the front of the frequently used list. */
export const bumpRecent = (recent: string[], name: string, max = 27) => [name, ...recent.filter((n) => n !== name)].slice(0, max);
