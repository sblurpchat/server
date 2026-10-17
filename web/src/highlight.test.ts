import { describe, expect, it } from "vitest";
import { highlight } from "./highlight";

describe("code highlighting", () => {
  it("marks keywords and strings, follows aliases, escapes HTML and skips unknown languages", () => {
    expect(highlight('const a = "<b>";', "ts")).toBe('<span class="hljs-keyword">const</span> a = <span class="hljs-string">&quot;&lt;b&gt;&quot;</span>;');
    expect(highlight("# hi", "SH")).toBe('<span class="hljs-comment"># hi</span>');
    expect(highlight("<img src=x onerror=alert(1)>", "nope")).toBeNull();
  });
});
