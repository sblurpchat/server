import { describe, expect, it } from "vitest";
import { detectLang, highlight, langLabel, snippetLangs, snippetName } from "./highlight";

describe("code highlighting", () => {
  it("marks keywords and strings, follows aliases, escapes HTML and skips unknown languages", () => {
    expect(highlight('const a = "<b>";', "ts")).toBe('<span class="hljs-keyword">const</span> a = <span class="hljs-string">&quot;&lt;b&gt;&quot;</span>;');
    expect(highlight("# hi", "SH")).toBe('<span class="hljs-comment"># hi</span>');
    expect(highlight("<img src=x onerror=alert(1)>", "nope")).toBeNull();
  });
});

// Real snippets people paste into chat. Each must come out as its language, and prose must stay plain.
const CASES: [string, string][] = [
  ["python", "#!/usr/bin/env python3\nprint('hi')"],
  ["bash", "#!/bin/bash\nset -euo pipefail\nfor f in *.log; do\n  gzip \"$f\"\ndone"],
  ["javascript", "#!/usr/bin/env node\nconsole.log(process.argv)"],
  ["php", "<?php\necho 'Hello ' . $name;\n$items = array_map(fn($x) => $x * 2, $list);"],
  ["diff", "diff --git a/main.go b/main.go\nindex 3b18e51..a9c1d22 100644\n--- a/main.go\n+++ b/main.go\n@@ -1,3 +1,4 @@\n package main\n+import \"fmt\"\n"],
  ["diff", "--- a/README.md\n+++ b/README.md\n@@ -10,2 +10,2 @@\n-old line\n+new line"],
  ["json", '{\n  "name": "sblurp-web",\n  "private": true,\n  "scripts": { "dev": "vite" }\n}'],
  ["json", '[{"id": 1, "ok": true}, {"id": 2, "ok": false}]'],
  ["xml", "<!doctype html>\n<html lang=\"en\">\n<head><title>Hi</title></head>\n<body><p>Hello</p></body>\n</html>"],
  ["xml", '<div class="card">\n  <img src="a.png" alt="">\n  <span>Caption</span>\n</div>'],
  ["go", 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hello")\n}'],
  ["go", 'func (s *Server) Close() error {\n\tif err := s.db.Close(); err != nil {\n\t\treturn err\n\t}\n\treturn nil\n}'],
  ["python", "import os\n\ndef walk(root):\n    for dirpath, _, files in os.walk(root):\n        yield from files\n"],
  ["python", "from dataclasses import dataclass\n\n@dataclass\nclass Point:\n    x: int\n    y: int\n"],
  ["python", "class Cache:\n    def __init__(self):\n        self.items = {}\n\n    def get(self, key):\n        return self.items.get(key)\n"],
  ["rust", 'fn main() {\n    let mut v = Vec::new();\n    v.push(1);\n    println!("{:?}", v);\n}'],
  ["rust", "pub fn parse(s: &str) -> Result<u32, ParseIntError> {\n    s.trim().parse::<u32>()\n}"],
  ["sql", "SELECT id, name\nFROM members\nWHERE kind = 'bot'\nORDER BY name;"],
  ["sql", "create table attachments (\n  id text primary key,\n  size integer not null\n);"],
  ["sql", "UPDATE members SET role = 2 WHERE id = ?"],
  ["typescript", "interface Member {\n  id: string;\n  name: string;\n}\n\nexport const byId = (ms: Member[]) => new Map(ms.map((m) => [m.id, m]));"],
  ["typescript", "type Pane = { t: \"thread\"; rootId: string } | null;\nfunction open(p: Pane): void {}"],
  ["javascript", "const express = require('express');\nconst app = express();\napp.get('/', (req, res) => res.send('ok'));\napp.listen(3000);"],
  ["javascript", "export default function App() {\n  const [n, setN] = useState(0);\n  return n;\n}"],
  ["java", "public class Hello {\n    public static void main(String[] args) {\n        System.out.println(\"Hello\");\n    }\n}"],
  ["c", "#include <stdio.h>\n\nint main(void) {\n    printf(\"hi\\n\");\n    return 0;\n}"],
  ["swift", "import SwiftUI\n\nstruct ContentView: View {\n    var body: some View {\n        Text(\"Hello\")\n    }\n}"],
  ["swift", "func greet(_ name: String) -> String {\n    guard !name.isEmpty else { return \"Hi\" }\n    let s = \"Hi \\(name)\"\n    return s\n}"],
  ["ruby", "require 'json'\n\ndef greet(name)\n  puts \"Hello #{name}\"\nend\n"],
  ["ruby", "class User < ApplicationRecord\n  has_many :posts\n  validates :email, presence: true\nend"],
  ["yaml", "name: CI\non:\n  push:\n    branches: [main]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n"],
  ["yaml", "# fly.toml is TOML, this is compose\nservices:\n  web:\n    image: nginx\n    ports:\n      - \"80:80\"\n"],
  ["ini", '[server]\nport = 8082\nname = "Sblurp Community"\n\n[files]\nmax_mb = 25'],
  ["dockerfile", "FROM golang:1.25 AS build\nWORKDIR /src\nCOPY . .\nRUN go build -o /out/server ./cmd/server\n\nFROM gcr.io/distroless/static\nCOPY --from=build /out/server /\nENTRYPOINT [\"/server\"]"],
  ["css", ".composer {\n  border: 1px solid var(--line);\n  border-radius: 10px;\n}\n\n.composer:focus-within {\n  border-color: var(--raspberry);\n}"],
  ["markdown", "# Release notes\n\n- Snippets with **syntax highlighting**\n- See [the ticket](https://example.com)\n\n```ts\nconst a = 1;\n```"],
  ["markdown", "## Setup\n\n1. Install Go\n2. Run `make dev`\n\nThen open the app."],
  ["bash", "cd web\npnpm install\npnpm exec vite build\ncurl -s http://localhost:8082/healthz"],
  ["bash", "export PORT=8082\nif [ -z \"$TOKEN\" ]; then\n  echo \"missing token\" >&2\n  exit 1\nfi"],
  ["plaintext", "Hey all, the kiln is booked Thursday from 6 to 9. Bring your own glaze if you want something special, otherwise we have the usual blues and greens."],
  ["plaintext", "Shopping list\nmilk\neggs\nbread\nselect a nice cheese from the deli"],
  ["plaintext", ""],
];

describe("language detection", () => {
  it.each(CASES)("detects %s", (want, code) => {
    expect(detectLang(code)).toBe(want);
  });

  it("labels and names snippets by language", () => {
    expect(langLabel("ts")).toBe("TypeScript");
    expect(langLabel("xml")).toBe("HTML");
    expect(langLabel("plaintext")).toBe("Plain text");
    expect(snippetName("typescript")).toBe("snippet.ts");
    expect(snippetName("dockerfile")).toBe("Dockerfile");
    expect(snippetName("plaintext")).toBe("snippet.txt");
    expect(snippetName("markdown")).toBe("snippet.md");
    expect(snippetName("bash", " deploy ")).toBe("deploy.sh");
    expect(snippetName("bash", "deploy.SH")).toBe("deploy.SH");
    expect(snippetName("markdown", "notes.txt")).toBe("notes.txt.md");
    expect(snippetName("go", "a/b\\c")).toBe("a-b-c.go");
    expect(snippetLangs()[0]).toBe("plaintext");
    expect(snippetLangs()).toContain("dockerfile");
  });
});
