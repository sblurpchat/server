import { describe, expect, it } from "vitest";
import { mayPreview, shownPreviews } from "./logic";

describe("link previews", () => {
  it("asks only for messages with a web link", () => {
    expect(mayPreview("see https://macotron.statico.io/")).toBe(true);
    expect(mayPreview("HTTP://EXAMPLE.COM")).toBe(true);
    expect(mayPreview("mail me at a@b.c or ftp://x")).toBe(false);
  });
  it("leaves out links into this app and keeps five", () => {
    const app = "http://app.sblurp.localhost:1355/";
    const ps = [
      { url: "http://app.sblurp.localhost:1355/#/c/x/y/z" },
      { url: "not a url" },
      ...["a", "b", "c", "d", "e", "f"].map((h) => ({ url: `https://${h}.com/` })),
    ];
    expect(shownPreviews(ps, app).map((p) => p.url)).toEqual(["https://a.com/", "https://b.com/", "https://c.com/", "https://d.com/", "https://e.com/"]);
    expect(shownPreviews([{ url: "http://app.sblurp.localhost:1355/docs" }], app)).toHaveLength(1);
  });
});
