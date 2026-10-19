// Loaded with import() only when a code block or a snippet needs it, so the main bundle stays the same.
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANGS = { bash, c, css, diff, dockerfile, go, ini, java, javascript, json, markdown, php, python, ruby, rust, sql, swift, typescript, xml, yaml };
for (const [name, lang] of Object.entries(LANGS)) hljs.registerLanguage(name, lang);

/** Highlighted HTML (highlight.js escapes the code), or null for a language we do not ship. */
export function highlight(code: string, lang: string): string | null {
  const l = lang.toLowerCase();
  return hljs.getLanguage(l) ? hljs.highlight(code, { language: l, ignoreIllegals: true }).value : null;
}

const count = (s: string, re: RegExp) => s.match(re)?.length ?? 0;

/** Cheap, near-certain signs first, in an order that keeps look-alikes apart (Go/Swift `func`, Rust/JS `let`). */
function sniff(s: string): string | null {
  const bang = /^#!.*?\b(python\d?|node|deno|bun|ruby|php|bash|sh|zsh)\b/.exec(s)?.[1];
  if (bang) return { node: "javascript", deno: "typescript", bun: "typescript", ruby: "ruby", php: "php", bash: "bash", sh: "bash", zsh: "bash" }[bang] ?? "python";
  if (/^<\?php/.test(s)) return "php";
  if (/^diff --git |^--- \S.*\n\+\+\+ \S|^@@ -\d+(,\d+)? \+\d+/m.test(s)) return "diff";
  if (/^[[{]/.test(s)) {
    try {
      JSON.parse(s);
      return "json";
    } catch {
      /* not JSON */
    }
  }
  if (/^(<!doctype html|<\?xml|<(html|head|body|div|span|p|a|ul|ol|li|section|main|nav|template|svg|table|form|img|button)[\s>/])/i.test(s)) return "xml";
  // Before the code checks: a README's fenced blocks would otherwise win.
  const md = count(s, /^#{1,6} \S/gm) + count(s, /^```/gm) + count(s, /\[[^\]\n]+\]\([^)\s]+\)/g) + count(s, /^\s*([-*]|\d+\.) \S/gm) + count(s, /\*\*\S[^*\n]*\*\*|`[^`\n]+`/g);
  if (md >= 3 && (/^#{1,6} \S/m.test(s) || /^```/m.test(s))) return "markdown";
  if (/^package \w+\s*$/m.test(s) || (/\bfunc\b/.test(s) && /:=|\berr != nil\b/.test(s))) return "go";
  if (/^#include\s*[<"]/m.test(s)) return "c";
  if (/^FROM \S+/m.test(s) && /^(RUN|COPY|WORKDIR|CMD|ENTRYPOINT|ENV|EXPOSE) /m.test(s)) return "dockerfile";
  if (/\bfn \w+\s*[<(]/.test(s) && /\blet mut\b|->|::|\bimpl\b|\bpub\b|!\(|&str\b/.test(s)) return "rust";
  if (/^import (SwiftUI|UIKit|Foundation)\b/m.test(s) || (/\bfunc \w+\(/.test(s) && /\b(guard|let|var)\b/.test(s))) return "swift";
  if (/\bpublic (static |final )*(class|void|interface)\b|System\.out\.|^import java\./m.test(s)) return "java";
  if (/^\s*(def \w+\(.*\)( -> .+)?:|class \w+(\(.*\))?:|from [\w.]+ import |import [\w.]+( as \w+)?$|if __name__ ==|@\w+\n(def|class) )/m.test(s)) return "python";
  if (/^\s*end\s*$/m.test(s) && /^\s*(def |class |module |require |\w+\.each do|.* do \|)/m.test(s)) return "ruby";
  // Lowercase SQL needs a semicolon too, so "select the cheese from the deli" stays prose.
  const sqlish = /^\s*(select\b[\s\S]*?\bfrom\b|insert\s+into\b|update\s+\w+\s+set\b|delete\s+from\b|create\s+(table|index|unique\s+index|view)\b|alter\s+table\b)/im;
  if (sqlish.test(s) && (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER)\b/m.test(s) || s.includes(";"))) return "sql";
  if (/\b(interface \w+\s*\{|type \w+(<.+>)? = |: (string|number|boolean|void|unknown)\b|as const\b|\w+<\w+>\(|\): \w+(\[\])? (=>|\{))/.test(s)) return "typescript";
  if (/\b(const|let|var) \w+ = |\bfunction\b|=>|\brequire\(|module\.exports|console\.log|export default\b/.test(s)) return "javascript";
  const lines = s.split("\n").filter((l) => l.trim() && !/^\s*#/.test(l));
  if (/^\[[\w.-]+\]\s*$/m.test(s) && lines.every((l) => /^\[[\w.-]+\]\s*$|^\s*[\w.-]+\s*=/.test(l))) return "ini";
  if (lines.length && /^[\w.-]+:(\s|$)/m.test(s) && !/[;{}]\s*$/m.test(s) && lines.every((l) => /^\s*(- |[\w.\-"']+:(\s|$))/.test(l))) return "yaml";
  if (/\{\s*$/m.test(s) && /^\s*[\w-]+\s*:\s*[^;{}]+;\s*$/m.test(s) && /^[^\s{][^{]*\{\s*$/m.test(s)) return "css";
  if (/^\s*(\$ |sudo |cd |ls |echo |export \w+=|if \[|for \w+ in |curl |git |npm |pnpm |yarn |brew |apt(-get)? |docker |make |go (run|build|test) )/m.test(s)) return "bash";
  return null;
}

// highlightAuto over a short list of languages people actually paste; the rest of the list only adds false positives.
const AUTO = ["bash", "c", "css", "go", "java", "javascript", "json", "php", "python", "ruby", "rust", "sql", "swift", "typescript", "xml", "yaml"];
const MIN_RELEVANCE = 8;

/** The highlight.js language for some code, or "plaintext" when nothing is a confident match. */
export function detectLang(code: string): string {
  const s = code.trim();
  if (!s) return "plaintext";
  const hit = sniff(s);
  if (hit) return hit;
  // ponytail: one relevance cutoff for every language; tune per language if prose still gets colored.
  const auto = hljs.highlightAuto(s, AUTO);
  return auto.language && auto.relevance >= MIN_RELEVANCE ? auto.language : "plaintext";
}

const EXT: Record<string, string> = { bash: "sh", javascript: "js", typescript: "ts", python: "py", ruby: "rb", rust: "rs", markdown: "md", xml: "html", plaintext: "txt", yaml: "yaml" };

/** A file name that brings the language back when the snippet is read again: the title the person
 * gave (1278) with the language's extension, unless it already ends with it. */
export function snippetName(lang: string, title = ""): string {
  const ext = `.${EXT[lang] ?? lang}`;
  const t = title.trim().replace(/[/\\]/g, "-");
  if (!t) return lang === "dockerfile" ? "Dockerfile" : `snippet${ext}`;
  return t.toLowerCase().endsWith(ext) ? t : t + ext;
}

/** Every language the snippet dialog offers, Plain text first, then by label. */
export const snippetLangs = () => ["plaintext", ...Object.keys(LANGS).sort((a, b) => langLabel(a).localeCompare(langLabel(b)))];

/** "TypeScript" for "ts"; "Plain text" for anything we do not ship. */
export function langLabel(lang: string): string {
  const l = hljs.getLanguage(lang.toLowerCase());
  if (!l) return "Plain text";
  return l === hljs.getLanguage("xml") ? "HTML" : l.name!;
}
