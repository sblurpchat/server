// Loaded with import() only when a message has a fenced block with a language, so the main bundle stays the same.
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
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

for (const [name, lang] of Object.entries({ bash, c, css, diff, dockerfile, go, ini, java, javascript, json, python, ruby, rust, sql, swift, typescript, xml, yaml })) hljs.registerLanguage(name, lang);

/** Highlighted HTML (highlight.js escapes the code), or null for a language we do not ship. */
export function highlight(code: string, lang: string): string | null {
  const l = lang.toLowerCase();
  return hljs.getLanguage(l) ? hljs.highlight(code, { language: l, ignoreIllegals: true }).value : null;
}
