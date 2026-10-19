import { describe, expect, it } from "vitest";
import { bumpRecent, emojiName, pickerSections, planUpload, searchEmoji, splitShortcodes, tally } from "./emoji";

describe("splitShortcodes", () => {
  const known = (n: string) => ["parrot", "blob-cat", "+1"].includes(n);
  it("turns known names into pieces and leaves the rest as text", () => {
    expect(splitShortcodes("hi :parrot: and :nope: :blob-cat:", known)).toEqual(["hi ", { name: "parrot" }, " and :nope: ", { name: "blob-cat" }]);
  });
  it("lets an unknown name's closing colon open a known one", () => {
    expect(splitShortcodes("at 10:30:parrot:", known)).toEqual(["at 10:30", { name: "parrot" }]);
    expect(splitShortcodes(":parrot::parrot:", known)).toEqual([{ name: "parrot" }, { name: "parrot" }]);
  });
  it("ignores uppercase, spaces and lone colons", () => {
    expect(splitShortcodes("Note: :Parrot: : parrot :", known)).toEqual(["Note: :Parrot: : parrot :"]);
    expect(splitShortcodes(":+1:", known)).toEqual([{ name: "+1" }]);
    expect(splitShortcodes("", known)).toEqual([]);
  });
});

describe("emojiName", () => {
  it.each([
    ["parrot.gif", "parrot"],
    ["pack/Party Parrot.GIF", "party_parrot"],
    ["C:\\emoji\\thumbs-up.png", "thumbs-up"],
    [":blob_cat:.webp", "blob_cat"],
    ["  héllo wörld .png", "h_llo_w_rld"],
    ["日本.png", ""],
    [".png", "png"],
    [`${"a".repeat(70)}.png`, "a".repeat(62)],
  ])("%s → %s", (path, want) => expect(emojiName(path)).toBe(want));
});

describe("planUpload", () => {
  const f = (path: string, size = 1000) => ({ path, size });
  it("skips hidden files, rejects others with reasons, and skips names that exist", () => {
    const { done, batches } = planUpload(
      [f("pack/.DS_Store"), f("__MACOSX/pack/._a.png"), f("pack/a.png"), f("pack/README.txt"), f("pack/Wave.gif"), f("pack/sub/wave.png"), f("pack/big.png", 300_000), f("pack/日本.png"), f("more.zip", 5000)],
      new Set(["a"]),
    );
    expect(done).toEqual([
      { file: "pack/a.png", name: "a", status: "exists", error: "an emoji with this name exists" },
      { file: "pack/README.txt", name: "", status: "rejected", error: "not a PNG, GIF, WebP or .zip file" },
      { file: "pack/sub/wave.png", name: "wave", status: "exists", error: "an emoji with this name exists" },
      { file: "pack/big.png", name: "big", status: "rejected", error: "larger than 256 KB" },
      { file: "pack/日本.png", name: "", status: "rejected", error: "no usable name; use a-z, 0-9, - and _" },
    ]);
    expect(batches.map((b) => b.map((x) => x.path))).toEqual([["pack/Wave.gif", "more.zip"]]);
    expect(tally(done)).toEqual({ added: 0, exists: 2, rejected: 3 });
  });
  it("splits sends into batches under the request limit", () => {
    const files = Array.from({ length: 5 }, (_, i) => f(`e${i}.png`, 40));
    const { batches } = planUpload(files, new Set(), 100);
    expect(batches.map((b) => b.length)).toEqual([2, 2, 1]);
    expect(planUpload(files, new Set(), 1000, 2).batches.map((b) => b.length)).toEqual([2, 2, 1]);
    expect(planUpload([f("huge.zip", 101)], new Set(), 100).done[0].status).toBe("rejected");
  });
});

describe("searchEmoji", () => {
  it("puts prefix matches first and accepts a leading colon", () => {
    const list = [{ name: "blobcat" }, { name: "catjam" }, { name: "dog" }, { name: "cat" }];
    expect(searchEmoji(list, ":cat").map((e) => e.name)).toEqual(["cat", "catjam", "blobcat"]);
    expect(searchEmoji(list, " ")).toBe(list);
  });
});

describe("pickerSections", () => {
  const groups = [
    { id: "people", label: "People", items: [{ name: "smile", ch: "😄" }, { name: "thumbsup", ch: "👍" }] },
    { id: "symbols", label: "Symbols", items: [{ name: "heart", ch: "❤️" }] },
  ];
  const custom = [{ name: "party_parrot", src: "p.gif" }, { name: "smile", src: "fake-smile.png" }, { name: "thumbsup_all", src: "t.png" }];
  const ids = (s: { items: { name: string; ch?: string; src?: string }[] }) => s.items.map((e) => e.ch ?? e.src);

  it("searches standard and custom together, prefix matches first", () => {
    const s = pickerSections(groups, custom, [], ":thumbs");
    expect(s.map((x) => x.id)).toEqual(["results"]);
    expect(ids(s[0])).toEqual(["👍", "t.png"]);
    expect(ids(pickerSections(groups, custom, [], "parrot")[0])).toEqual(["p.gif"]);
    expect(pickerSections(groups, custom, [], "zzz")[0].items).toEqual([]);
  });
  it("lets a standard emoji win a name clash, in search and in the custom section", () => {
    expect(ids(pickerSections(groups, custom, [], "smile")[0])).toEqual(["😄"]);
    const s = pickerSections(groups, custom, [], "");
    expect(ids(s.find((x) => x.id === "custom")!)).toEqual(["p.gif", "t.png"]);
  });
  it("puts frequently used first and custom last, skipping unknown recents", () => {
    const s = pickerSections(groups, custom, ["party_parrot", "gone", "heart"], " ");
    expect(s.map((x) => x.id)).toEqual(["recent", "people", "symbols", "custom"]);
    expect(ids(s[0])).toEqual(["p.gif", "❤️"]);
    expect(pickerSections(groups, [], [], "").map((x) => x.id)).toEqual(["people", "symbols"]);
  });
});

describe("bumpRecent", () => {
  it("moves the pick to the front without duplicates and caps the list", () => {
    expect(bumpRecent(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
    expect(bumpRecent(["a", "b"], "z", 2)).toEqual(["z", "a"]);
  });
});
