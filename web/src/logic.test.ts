import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { Code } from "@connectrpc/connect";
import css from "./app.css?raw";
import { allDMs, channelLabel, dmPeer, swipeAxis, swipeEnds, tailnetUrl } from "./logic";
import {
  ChannelKind,
  ChannelMode,
  ChannelSchema,
  EventSchema,
  MemberKind,
  MemberRole,
  MemberSchema,
  Presence,
  MessageSchema,
  ReadStateSchema,
  RoleSchema,
  type Event,
} from "./gen/sblurp/v1/sblurp_pb";
import {
  denied,
  mayPost,
  posterNames,
  SKELETON_DELAY_MS,
  listPhase,
  skeletonRows,
  THEMES,
  banDetail,
  readDelay,
  pasteTarget,
  browseDetail,
  browseList,
  swatch,
  sentence,
  memberRoles,
  contrast,
  fitContrast,
  customTheme,
  parseThemeString,
  themeString,
  parseAppearance,
  appearanceSync,
  communitiesSync,
  timeLabel,
  acQuery,
  emojiMatches,
  listStep,
  applyEvent,
  pluginNameFromFile,
  pluginFormError,
  pluginStatus,
  tokenBots,
  MAX_PLUGIN_BYTES,
  backoffMs,
  buildRows,
  communityBadge,
  dayLabel,
  decodeMentions,
  emptyCommunity,
  encodeMentions,
  formatHash,
  matchScore,
  memberGroups,
  moveItem,
  inviteLink,
  inviteState,
  normalizeCommunityUrl,
  joinHashInput,
  deepLinkHash,
  shareMessageLink,
  shareInviteLink,
  shareToDeepLink,
  shownPreviews,
  channelSlug,
  reorderChannel,
  parseHash,
  messageHash,
  parsePermalink,
  permalinks,
  parseInline,
  parseMarkdown,
  pinchView,
  landingChannel,
  modActions,
  canRemoveFromChannel,
  sidebarSections,
  tabTitle,
  tokenFresh,
  typingLabel,
  reactorsLabel,
  upsertMessage,
  type Community,
  count,
  trimList,
  PANELS,
  clampWidth,
  keyWidth,
  onBackdrop,
  paneQuery,
  parsePane,
  bannerFileError,
  squareCrop,
  cssUrl,
  toolsInside,
  listMove,
  gridMove,
  arrivalText,
} from "./logic";

const T0 = new Date(2026, 9, 16, 10, 0).getTime();
const msg = (id: string, author: string, minutes: number, seq = 0n, extra = {}) =>
  create(MessageSchema, { id, authorId: author, channelId: "c1", text: "hi", createdAtMs: BigInt(T0 + minutes * 60_000), seq, createdSeq: seq, ...extra });
const ev = (seq: bigint, kind: Event["kind"]) => create(EventSchema, { seq, kind });

function community(): Community {
  const c = emptyCommunity("https://x.test");
  c.me = create(MemberSchema, { id: "me", username: "ian" });
  c.channels = {
    c1: create(ChannelSchema, { id: "c1", kind: ChannelKind.TEXT, name: "general" }),
    d1: create(ChannelSchema, { id: "d1", kind: ChannelKind.DM, memberIds: ["me", "ana"] }),
  };
  c.reads = { c1: create(ReadStateSchema, { channelId: "c1", lastReadSeq: 5n }) };
  c.seq = 10n;
  c.lists = { c1: { items: [msg("m1", "ana", 0, 9n)], hasMore: false } };
  return c;
}

describe("buildRows", () => {
  it("groups same author within 5 minutes and starts a new group after", () => {
    const rows = buildRows([msg("a", "ana", 0), msg("b", "ana", 4), msg("c", "ana", 10), msg("d", "ben", 11)], null);
    expect(rows.map((r) => (r.t === "msg" ? `${r.m.id}:${r.head}` : r.t))).toEqual([
      "day",
      "a:true",
      "b:false",
      "c:true",
      "d:true",
    ]);
  });

  it("adds a day divider when the date changes and breaks the group", () => {
    const rows = buildRows([msg("a", "ana", 0), msg("b", "ana", 24 * 60)], null);
    expect(rows.map((r) => r.t)).toEqual(["day", "msg", "day", "msg"]);
    expect(rows[3]).toMatchObject({ head: true });
  });

  it("puts the New divider before the first unread message from someone else", () => {
    const rows = buildRows(
      [msg("a", "ana", 0, 4n), msg("b", "me", 1, 6n), msg("c", "ana", 2, 7n), msg("d", "ana", 3, 8n)],
      5n,
      "me",
    );
    expect(rows.map((r) => (r.t === "msg" ? r.m.id : r.t))).toEqual(["day", "a", "b", "new", "c", "d"]);
    expect(rows[4]).toMatchObject({ head: true });
  });

  it("ignores seq bumps from edits: an old edited message is not new", () => {
    const rows = buildRows([msg("a", "ana", 0, 9n, { createdSeq: 4n }), msg("b", "ana", 1, 7n)], 5n, "me");
    expect(rows.map((r) => (r.t === "msg" ? r.m.id : r.t))).toEqual(["day", "a", "new", "b"]);
  });

  it("puts no New divider when everything is read", () => {
    const rows = buildRows([msg("a", "ana", 0, 4n)], 5n, "me");
    expect(rows.some((r) => r.t === "new")).toBe(false);
  });
});

describe("dayLabel", () => {
  it("says Today, Yesterday, then a weekday date", () => {
    expect(dayLabel(T0, T0)).toBe("Today");
    expect(dayLabel(T0 - 86_400_000, T0)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 9, 12).getTime(), T0)).toBe("Monday, October 12");
    expect(dayLabel(new Date(2025, 0, 2).getTime(), T0)).toBe("Thursday, January 2, 2025");
  });
});

describe("markdown", () => {
  it("parses inline marks, code and mentions", () => {
    expect(parseInline("**bold** and *it* ~~gone~~ `x*y` <@u1>")).toEqual([
      { t: "b", c: [{ t: "text", v: "bold" }] },
      { t: "text", v: " and " },
      { t: "i", c: [{ t: "text", v: "it" }] },
      { t: "text", v: " " },
      { t: "s", c: [{ t: "text", v: "gone" }] },
      { t: "text", v: " " },
      { t: "code", v: "x*y" },
      { t: "text", v: " " },
      { t: "mention", id: "u1" },
    ]);
  });

  it("links only http, https and mailto, and trims trailing punctuation", () => {
    expect(parseInline("see https://a.test/x.")).toEqual([
      { t: "text", v: "see " },
      { t: "link", href: "https://a.test/x", c: [{ t: "text", v: "https://a.test/x" }] },
      { t: "text", v: "." },
    ]);
    expect(parseInline("[click](javascript:alert(1))")).toEqual([{ t: "text", v: "[click](javascript:alert(1))" }]);
    expect(parseInline("[docs](https://d.test)")).toEqual([
      { t: "link", href: "https://d.test", c: [{ t: "text", v: "docs" }] },
    ]);
  });

  it("leaves snake_case and raw HTML as text", () => {
    expect(parseInline("my_var_name <b>x</b>")).toEqual([{ t: "text", v: "my_var_name <b>x</b>" }]);
  });

  it("parses code blocks and quotes", () => {
    expect(parseMarkdown("hi\n```js\nlet a = **1**\n```\n> quoted\n> more\nafter")).toEqual([
      { t: "p", c: [{ t: "text", v: "hi" }] },
      { t: "pre", lang: "js", v: "let a = **1**" },
      { t: "quote", c: [{ t: "text", v: "quoted\nmore" }] },
      { t: "p", c: [{ t: "text", v: "after" }] },
    ]);
  });

  it("parses bullet and numbered lists", () => {
    const t = (v: string) => [{ t: "text", v }];
    expect(parseMarkdown("todo:\n- milk\n* **eggs**\n  large ones\n3. three\n4) four\nafter")).toEqual([
      { t: "p", c: t("todo:") },
      { t: "ul", items: [{ c: t("milk") }, { c: [{ t: "b", c: t("eggs") }, { t: "text", v: "\nlarge ones" }] }] },
      { t: "ol", start: 3, items: [{ c: t("three") }, { c: t("four") }] },
      { t: "p", c: t("after") },
    ]);
    expect(parseMarkdown("-not a list")).toEqual([{ t: "p", c: t("-not a list") }]);
  });

  it("parses headings and rules only in Markdown files, never raw HTML", () => {
    const t = (v: string) => [{ t: "text", v }];
    expect(parseMarkdown("# Title ##\nbody\n---\n###### six\n####### seven\n<script>x</script>", true)).toEqual([
      { t: "h", level: 1, c: t("Title") },
      { t: "p", c: t("body") },
      { t: "hr" },
      { t: "h", level: 6, c: t("six") },
      { t: "p", c: t("####### seven\n<script>x</script>") },
    ]);
    expect(parseMarkdown("# not a heading in chat")).toEqual([{ t: "p", c: t("# not a heading in chat") }]);
    expect(parseMarkdown("[x](javascript:alert(1))", true)).toEqual([{ t: "p", c: t("[x](javascript:alert(1))") }]);
  });

  it("parses tables, task lists and nested lists only in Markdown files (1277)", () => {
    const t = (v: string) => [{ t: "text", v }];
    expect(parseMarkdown("| a | b \\| c | d |\n|:--|:-:|--:|\n| 1 | **2** |\nafter", true)).toEqual([
      { t: "table", align: ["left", "center", "right"], head: [t("a"), t("b | c"), t("d")], rows: [[t("1"), [{ t: "b", c: t("2") }], []]] },
      { t: "p", c: t("after") },
    ]);
    expect(parseMarkdown("- [x] done\n- [ ] todo\n  1. one\n     - deep\n  2. two\n- last", true)).toEqual([
      {
        t: "ul",
        items: [
          { c: t("done"), check: true },
          { c: t("todo"), check: false, sub: [{ t: "ol", start: 1, items: [{ c: t("one"), sub: [{ t: "ul", items: [{ c: t("deep") }] }] }, { c: t("two") }] }] },
          { c: t("last") },
        ],
      },
    ]);
    expect(parseMarkdown("| a |\n|---|\n- [x] x\n  - y")).toEqual([
      { t: "p", c: t("| a |\n|---|") },
      { t: "ul", items: [{ c: t("[x] x") }, { c: t("y") }] },
    ]);
  });

  it("treats an unclosed fence as text", () => {
    expect(parseMarkdown("```\nno end")).toEqual([{ t: "p", c: [{ t: "text", v: "```\nno end" }] }]);
  });
});

describe("mentions", () => {
  const ana = create(MemberSchema, { id: "u-ana", username: "ana" });
  it("encodes known @usernames and leaves unknown ones and emails", () => {
    expect(encodeMentions("@Ana hi @nobody, mail a@ana.test", [ana])).toBe("<@u-ana> hi @nobody, mail a@ana.test");
  });
  it("decodes ids back to usernames", () => {
    expect(decodeMentions("hey <@u-ana> <@gone>", { "u-ana": ana })).toBe("hey @ana <@gone>");
  });
  it("finds the autocomplete token at the caret", () => {
    const k = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) =>
      listStep({ key, ctrlKey: false, metaKey: false, altKey: false, ...mods });
    expect([k("ArrowDown"), k("ArrowUp"), k("n", { ctrlKey: true }), k("p", { ctrlKey: true })]).toEqual([1, -1, 1, -1]);
    expect([k("n"), k("p"), k("n", { ctrlKey: true, metaKey: true }), k("x", { ctrlKey: true }), k("Enter")]).toEqual([0, 0, 0, 0, 0]);
    expect(acQuery("hello @an", 9)).toEqual({ kind: "@", start: 6, q: "an" });
    expect(acQuery("nice :ta", 8)).toEqual({ kind: ":", start: 5, q: "ta" });
    expect(acQuery("time 10:3", 9)).toBeNull();
    expect(acQuery("a@b", 3)).toBeNull();
    expect(acQuery("see http://x.io/:path", 21)).toBeNull();
    expect(acQuery("nice :tad", -1)).toBeNull(); // Escape
  });
  it("ranks : autocomplete emoji like Slack", () => {
    const std: [string, string][] = [["heart_eyes", "😍"], ["smile", "😄"], ["thumbsup", "👍"], ["heart", "❤️"], ["+1", "👍"], ["red_heart", "❤️"]];
    const names = (q: string, custom: string[] = [], max = 8) => emojiMatches(q, std, custom, max).map((e) => e.name);
    expect(names("thu")).toEqual(["thumbsup"]);
    expect(names("+1")).toEqual(["+1"]);
    expect(names("hea")).toEqual(["heart", "heart_eyes"]); // prefix hits first, shortest first, red_heart is the same ❤️
    expect(names("art")).toEqual(["heart_eyes", "heart"]);
    expect(emojiMatches("+1", std, [])[0].ch).toBe("👍");
    expect(names("zzz")).toEqual([]);
    expect(names("hea", ["blobheart", "heart_party"])).toEqual(["heart", "heart_eyes", "heart_party", "blobheart"]);
    expect(names("hea", ["heart_a", "heart_b", "heart_c"], 4)).toEqual(["heart", "heart_eyes", "heart_a", "heart_b"]);
    expect(names("canof", ["can-of-worms", "cabinet_of_fun"])).toEqual(["can-of-worms", "cabinet_of_fun"]); // 1329
  });
});

describe("applyEvent", () => {
  it("appends a new message, bumps unread and mention counts, and advances seq", () => {
    const m = msg("m2", "ana", 1, 0n, { text: "hey <@me>" });
    const c = applyEvent(community(), ev(11n, { case: "messageCreated", value: m }), T0, null);
    expect(c.seq).toBe(11n);
    expect(c.lists.c1.items.map((x) => x.id)).toEqual(["m1", "m2"]);
    expect(c.reads.c1).toMatchObject({ unreadCount: 1, mentionCount: 1, lastReadSeq: 5n });
    expect(c.channels.c1.lastMessageSeq).toBe(11n);
  });

  it("does not append to a search-jump window that is missing newer messages, but still counts unread", () => {
    const c0 = community();
    c0.lists.c1.hasMoreAfter = true;
    const c = applyEvent(c0, ev(11n, { case: "messageCreated", value: msg("m2", "ana", 1) }), T0, null);
    expect(c.lists.c1.items.map((x) => x.id)).toEqual(["m1"]);
    expect(c.reads.c1).toMatchObject({ unreadCount: 1 });
  });

  it("does not count unread in the channel being viewed", () => {
    const c = applyEvent(community(), ev(11n, { case: "messageCreated", value: msg("m2", "ana", 1) }), T0, "c1");
    expect(c.reads.c1).toMatchObject({ unreadCount: 0, lastReadSeq: 11n });
  });

  it("counts every DM message as a mention", () => {
    const m = msg("m3", "ana", 1, 0n, { channelId: "d1" });
    const c = applyEvent(community(), ev(11n, { case: "messageCreated", value: m }), T0, null);
    expect(c.reads.d1).toMatchObject({ unreadCount: 1, mentionCount: 1 });
  });

  it("ignores replayed events at or below the applied seq", () => {
    const before = community();
    const after = applyEvent(before, ev(10n, { case: "messageCreated", value: msg("m9", "ana", 1) }), T0, null);
    expect(after).toBe(before);
  });

  it("replaces the optimistic message with the server copy by client_id and clears failure", () => {
    const c0 = community();
    c0.lists.c1.items.push(msg("local:abc", "me", 1, 0n, { clientId: "abc" }));
    c0.failed = { abc: true };
    const c = applyEvent(c0, ev(11n, { case: "messageCreated", value: msg("m2", "me", 1, 11n, { clientId: "abc" }) }), T0, null);
    expect(c.lists.c1.items.map((x) => x.id)).toEqual(["m1", "m2"]);
    expect(c.failed).toEqual({});
    expect(c.reads.c1).toMatchObject({ unreadCount: 0 });
  });

  it("does not count thread replies as channel unread", () => {
    const m = msg("r1", "ana", 1, 0n, { threadRootId: "m1" });
    const c = applyEvent(community(), ev(11n, { case: "messageCreated", value: m }), T0, null);
    expect(c.reads.c1.unreadCount).toBe(0);
    expect(c.lists.c1.items).toHaveLength(1);
  });

  it("counts a mention in a thread reply, but not a plain reply", () => {
    let c = community();
    c = applyEvent(c, ev(11n, { case: "messageCreated", value: msg("r1", "ana", 1, 11n, { threadRootId: "m1" }) }), T0, null);
    c = applyEvent(c, ev(12n, { case: "messageCreated", value: msg("r2", "ana", 2, 12n, { threadRootId: "m1", text: "<@me> look" }) }), T0, null);
    expect(c.reads.c1.unreadCount).toBe(0);
    expect(c.reads.c1.mentionCount).toBe(1);
  });

  it("removes deleted messages but keeps a deleted thread root", () => {
    const c0 = community();
    const gone = applyEvent(c0, ev(11n, { case: "messageDeleted", value: msg("m1", "ana", 0) }), T0, null);
    expect(gone.lists.c1.items).toHaveLength(0);
    const kept = applyEvent(c0, ev(11n, { case: "messageDeleted", value: msg("m1", "ana", 0, 0n, { replyCount: 2 }) }), T0, null);
    expect(kept.lists.c1.items[0].deleted).toBe(true);
  });

  it("records typing with an expiry and ignores my own typing", () => {
    const c = applyEvent(community(), ev(0n, { case: "typing", value: { channelId: "c1", memberId: "ana", threadRootId: "" } as never }), T0, null);
    expect(c.typing.c1).toEqual({ ana: T0 + 6000 });
    expect(c.seq).toBe(10n);
    const mine = applyEvent(community(), ev(0n, { case: "typing", value: { channelId: "c1", memberId: "me", threadRootId: "" } as never }), T0, null);
    expect(mine.typing).toEqual({});
  });

  it("applies a read state from another device", () => {
    const rs = create(ReadStateSchema, { channelId: "c1", lastReadSeq: 10n });
    expect(applyEvent(community(), ev(11n, { case: "readState", value: rs }), T0, null).reads.c1.lastReadSeq).toBe(10n);
  });
});

describe("unread math", () => {
  it("sums mentions and flags unread", () => {
    const c = community();
    c.reads.c1 = create(ReadStateSchema, { channelId: "c1", unreadCount: 3, mentionCount: 1 });
    c.reads.d1 = create(ReadStateSchema, { channelId: "d1", unreadCount: 2, mentionCount: 2 });
    expect(communityBadge(c)).toEqual({ unread: true, mentions: 3 });
    expect(communityBadge(community())).toEqual({ unread: false, mentions: 0 });
  });
  it("builds the tab title", () => {
    expect(tabTitle(3, true, "#general")).toBe("(3) #general | Sblurp");
    expect(tabTitle(0, true, "")).toBe("• Sblurp");
    expect(tabTitle(120, false, "")).toBe("(99+) Sblurp");
  });
});

describe("upsertMessage", () => {
  it("inserts in time order", () => {
    const out = upsertMessage([msg("a", "x", 0), msg("c", "x", 2)], msg("b", "x", 1));
    expect(out.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });
});

describe("timing", () => {
  it("backs off exponentially with full jitter and caps at 30s", () => {
    expect(backoffMs(0, 0)).toBe(0);
    expect(backoffMs(0, 0.5)).toBe(1000);
    expect(backoffMs(0, 0.999999)).toBe(2000);
    expect(backoffMs(3, 0.5)).toBe(8000);
    expect(backoffMs(10, 0.5)).toBe(15000);
    expect(backoffMs(10, 0.999999)).toBe(30000);
  });
  it("refreshes tokens with less than a minute left", () => {
    expect(tokenFresh(T0 + 61_000, T0)).toBe(true);
    expect(tokenFresh(T0 + 59_000, T0)).toBe(false);
  });
});

describe("community URLs", () => {
  it("normalizes hosts, schemes, trailing slashes and invite links", () => {
    expect(normalizeCommunityUrl("nightowls.chat")).toEqual({ url: "https://nightowls.chat", invite: "" });
    expect(normalizeCommunityUrl(" localhost:8082/ ")).toEqual({ url: "http://localhost:8082", invite: "" });
    expect(normalizeCommunityUrl("community.sblurp.localhost:1355")).toEqual({ url: "http://community.sblurp.localhost:1355", invite: "" });
    expect(normalizeCommunityUrl("localhost.example.com")).toEqual({ url: "https://localhost.example.com", invite: "" });
    expect(normalizeCommunityUrl("https://x.test/sub/invite/AbC-12")).toEqual({ url: "https://x.test/sub", invite: "AbC-12" });
    expect(normalizeCommunityUrl("https://x.test/?invite=Q1")).toEqual({ url: "https://x.test", invite: "Q1" });
  });
  it("reads back the invite links the client makes", () => {
    expect(normalizeCommunityUrl(inviteLink("http://localhost:8082", "ABCDE23456"))).toEqual({ url: "http://localhost:8082", invite: "ABCDE23456" });
  });
  it("reads the join route a server's invite link redirects to", () => {
    expect(joinHashInput("#/join?invite=ABCD234567&url=https%3A%2F%2Fowls.test")).toBe("https://owls.test/invite/ABCD234567");
    expect(joinHashInput("#/join?url=http%3A%2F%2Fcommunity.sblurp.localhost%3A1355%2F")).toBe("http://community.sblurp.localhost:1355");
    expect(joinHashInput("#/join?url=javascript%3Aalert(1)&invite=X")).toBeNull();
    expect(joinHashInput("#/c/owls.test/general")).toBeNull();
  });
  it("turns sblurp:// links from the apps into routes", () => {
    const d = (link: string) => deepLinkHash(`#/open?${link}`);
    expect(d("sblurp://owls.test")).toBe("#/c/owls.test");
    expect(d("sblurp://Owls.Test/")).toBe("#/c/owls.test");
    expect(d("sblurp://localhost:8082/ch-1")).toBe("#/c/localhost%3A8082/ch-1");
    expect(d("sblurp://owls.test/c1/m2/m1")).toBe("#/c/owls.test/c1/m2/m1");
    expect(d("sblurp://owls.test/invite/ABCD234567")).toBe("#/join?url=https%3A%2F%2Fowls.test&invite=ABCD234567");
    expect(d("sblurp://localhost:8082/i/AbC-12/")).toBe("#/join?url=http%3A%2F%2Flocalhost%3A8082&invite=AbC-12");
    expect(joinHashInput(d("sblurp://owls.test/invite/ABCD234567")!)).toBe("https://owls.test/invite/ABCD234567");
    expect(parseHash(d("sblurp://owls.test/c1/m2")!)).toEqual({ host: "owls.test", channelId: "c1", messageId: "m2", rootId: "" });
    expect(d("sblurp://auth/callback?code=c")).toBeNull();
    expect(d("https://owls.test/c1")).toBeNull();
    expect(d("javascript:alert(1)")).toBeNull();
    expect(d("not a url")).toBeNull();
    expect(deepLinkHash("#/c/owls.test")).toBeNull();
  });
  it("makes share links on sblurp.chat and routes them like sblurp:// links (1298)", () => {
    const S = "https://sblurp.chat";
    expect(shareMessageLink(S, "https://owls.test", { id: "m2", channelId: "c1", threadRootId: "" })).toBe("https://sblurp.chat/c/owls.test/c1/m2");
    expect(shareMessageLink(S, "http://localhost:8082", { id: "m 2", channelId: "c1", threadRootId: "r3" })).toBe("https://sblurp.chat/c/localhost:8082/c1/m%202/r3");
    expect(shareInviteLink(S, "https://owls.test", "ABCD234567")).toBe("https://sblurp.chat/i/owls.test/ABCD234567");
    const route = (href: string) => deepLinkHash(`#/open?${shareToDeepLink(href, S)}`);
    expect(route("https://sblurp.chat/c/owls.test/c1/m2/r3")).toBe("#/c/owls.test/c1/m2/r3");
    expect(route("https://sblurp.chat/c/Owls.Test/")).toBe("#/c/owls.test");
    expect(route("https://sblurp.chat/c/localhost:8082/c1")).toBe("#/c/localhost%3A8082/c1");
    expect(route("https://sblurp.chat/i/owls.test/ABCD234567")).toBe("#/join?url=https%3A%2F%2Fowls.test&invite=ABCD234567");
    expect(shareToDeepLink("https://evil.test/c/owls.test/c1", S)).toBeNull();
    expect(shareToDeepLink("http://sblurp.chat/c/owls.test", S)).toBeNull();
    expect(shareToDeepLink("https://sblurp.chat/c/owls.test/a/b/c/d", S)).toBeNull();
    expect(shareToDeepLink("https://sblurp.chat/i/owls.test", S)).toBeNull();
    expect(shareToDeepLink("https://sblurp.chat/docs", S)).toBeNull();
    expect(shareToDeepLink("not a url", S)).toBeNull();
    // Pasted into Add a community.
    expect(normalizeCommunityUrl("https://sblurp.chat/i/owls.test/ABCD234567", S)).toEqual({ url: "https://owls.test", invite: "ABCD234567" });
    expect(normalizeCommunityUrl("https://sblurp.chat/c/localhost:8082/c1/m2", S)).toEqual({ url: "http://localhost:8082", invite: "" });
    // Previewed like a permalink, not by the server.
    const app = "https://app.sblurp.chat/";
    expect(parsePermalink("https://sblurp.chat/c/owls.test/c1/m2/r3", app, S)).toEqual({ host: "owls.test", channelId: "c1", messageId: "m2", rootId: "r3" });
    expect(parsePermalink("https://sblurp.chat/c/owls.test/c1", app, S)).toBeNull();
    expect(permalinks("see https://sblurp.chat/c/owls.test/c1/m2.", app, S)).toEqual([{ host: "owls.test", channelId: "c1", messageId: "m2", rootId: "" }]);
    expect(shownPreviews([{ url: "https://sblurp.chat/i/owls.test/AB" }, { url: "https://sblurp.chat/docs" }], app, S)).toEqual([{ url: "https://sblurp.chat/docs" }]);
  });
  it("rejects junk and other schemes", () => {
    expect(normalizeCommunityUrl("")).toBeNull();
    expect(normalizeCommunityUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeCommunityUrl("ftp://x.test")).toBeNull();
    expect(normalizeCommunityUrl("hello")).toBeNull();
  });
  it("round-trips the hash route", () => {
    expect(formatHash("http://localhost:8082", "ch-1")).toBe("#/c/localhost%3A8082/ch-1");
    expect(parseHash("#/c/localhost%3A8082/ch-1")).toEqual({ host: "localhost:8082", channelId: "ch-1", messageId: "", rootId: "" });
    expect(parseHash("#/c/x.test")).toEqual({ host: "x.test", channelId: "", messageId: "", rootId: "" });
    expect(parseHash("#/nope")).toBeNull();
  });
  it("keeps the open pane after the route", () => {
    expect(paneQuery(null)).toBe("");
    expect(paneQuery({ t: "thread", rootId: "m1" })).toBe("?thread=m1");
    expect(paneQuery({ t: "members" })).toBe("?members");
    expect(paneQuery({ t: "search", q: "a b&c" })).toBe("?search=a+b%26c");
    expect(parsePane("#/c/x.test/c1?thread=m1")).toEqual({ t: "thread", rootId: "m1" });
    expect(parsePane("#/c/x.test/c1?members")).toEqual({ t: "members" });
    expect(parsePane("#/c/x.test/c1?search=a+b%26c")).toEqual({ t: "search", q: "a b&c" });
    expect(parsePane("#/c/x.test/c1")).toBeNull();
    expect(parsePane("#/c/x.test/c1?thread=")).toBeNull();
    expect(parseHash("#/c/x.test/c1?thread=m1")).toEqual({ host: "x.test", channelId: "c1", messageId: "", rootId: "" });
  });
  it("round-trips message links, with the thread root for replies", () => {
    const url = "https://x.test";
    expect(messageHash(url, { id: "m1", channelId: "c1", threadRootId: "" })).toBe("#/c/x.test/c1/m1");
    expect(parseHash(messageHash(url, { id: "m2", channelId: "c1", threadRootId: "m1" }))).toEqual({
      host: "x.test",
      channelId: "c1",
      messageId: "m2",
      rootId: "m1",
    });
  });
});

describe("message link previews", () => {
  const app = "http://app.sblurp.localhost:1355/";
  it("reads a message link from this app only", () => {
    const want = { host: "community.sblurp.localhost:1355", channelId: "c1", messageId: "m1", rootId: "" };
    expect(parsePermalink(`${app}#/c/community.sblurp.localhost%3A1355/c1/m1`, app)).toEqual(want);
    expect(parsePermalink(`${app}#/c/community.sblurp.localhost%3A1355/c1/m1?thread=m1`, app)).toEqual(want);
    expect(parsePermalink(`${app}?fake#/c/community.sblurp.localhost%3A1355/c1/m1`, app)).toEqual(want);
    expect(parsePermalink(`${app}#/c/community.sblurp.localhost%3A1355/c1?thread=m1`, app)).toEqual(want);
    expect(parsePermalink(`${app}#/c/x.test/c1/m2/m1`, app)).toEqual({ host: "x.test", channelId: "c1", messageId: "m2", rootId: "m1" });
    expect(parsePermalink(`${app}#/c/x.test/c1`, app)).toBeNull();
    expect(parsePermalink(`${app}#/c/x.test`, app)).toBeNull();
    expect(parsePermalink("https://evil.test/#/c/x.test/c1/m1", app)).toBeNull();
    expect(parsePermalink("http://app.sblurp.localhost:1355/other#/c/x.test/c1/m1", app)).toBeNull();
    expect(parsePermalink("not a url", app)).toBeNull();
  });
  it("finds each linked message once, at most three", () => {
    const l = (m: string) => `${app}#/c/x.test/c1/${m}`;
    expect(permalinks(`see ${l("m1")}, and (${l("m2")}). Again ${l("m1")} https://example.com`, app).map((x) => x.messageId)).toEqual(["m1", "m2"]);
    expect(permalinks(`[here](${l("m9")})`, app).map((x) => x.messageId)).toEqual(["m9"]);
    expect(permalinks([1, 2, 3, 4].map((i) => l(`m${i}`)).join(" "), app)).toHaveLength(3);
    expect(permalinks("no links", app)).toEqual([]);
    // A bad escape in someone's message must not throw while rendering it.
    expect(permalinks(`${app}#/c/x.test/c1/%E0%A4`, app)).toEqual([]);
    expect(parseHash("#/c/%zz")).toBeNull();
  });
});

describe("helpers", () => {
  it("ranks prefix over substring over subsequence", () => {
    expect(matchScore("gen", "general")).toBeGreaterThan(matchScore("gen", "regenerate"));
    expect(matchScore("gen", "regenerate")).toBeGreaterThan(matchScore("gnl", "general"));
    expect(matchScore("xyz", "general")).toBe(-1);
    // 1329: fuzzy, ignoring case and - _ space
    expect(matchScore("canof", "can-of-worms")).toBeGreaterThan(matchScore("canof", "cabinet_of_fun"));
    expect(matchScore("CanOf", "cabinet_of_fun")).toBeGreaterThanOrEqual(0);
    expect(matchScore("ianl", "Ian Langworth")).toBeGreaterThan(200);
  });
  it("moves list items", () => {
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  });
  it("labels typing", () => {
    expect(typingLabel(["Ana"])).toBe("Ana is typing…");
    expect(typingLabel(["Ana", "Ben"])).toBe("Ana and Ben are typing…");
    expect(typingLabel(["A", "B", "C"])).toBe("Several people are typing…");
  });
});

describe("reactorsLabel", () => {
  const members = Object.fromEntries(
    ["ana:Ana", "ben:Ben", "cy:Cy", "dee:Dee", "eve:Eve"].map((x) => {
      const [id, displayName] = x.split(":");
      return [id, create(MemberSchema, { id, displayName })];
    }),
  );
  it("puts you first and joins names with and", () => {
    expect(reactorsLabel(["ana"], members, "me", "👍")).toBe("Ana reacted with 👍");
    expect(reactorsLabel(["ana", "me"], members, "me", "👍")).toBe("You and Ana reacted with 👍");
    expect(reactorsLabel(["ana", "ben", "cy"], members, "me", "🎉")).toBe("Ana, Ben and Cy reacted with 🎉");
  });
  it("counts the rest after three names", () => {
    expect(reactorsLabel(["ana", "ben", "cy", "dee"], members, "me", "👀")).toBe("Ana, Ben, Cy and Dee reacted with 👀");
    expect(reactorsLabel(["ana", "ben", "cy", "dee", "eve"], members, "me", "👀")).toBe("Ana, Ben, Cy and 2 others reacted with 👀");
    expect(reactorsLabel(["gone"], members, "me", "👀")).toBe("Someone reacted with 👀");
  });
});

describe("presence", () => {
  it("updates your own member as well as the member list", () => {
    const c = community();
    c.members = { me: c.me!, ana: create(MemberSchema, { id: "ana" }) };
    const next = applyEvent(c, ev(0n, { case: "presence", value: { memberId: "me", presence: Presence.ONLINE } as never }), T0, null);
    expect(next.me?.presence).toBe(Presence.ONLINE);
    expect(next.members.me.presence).toBe(Presence.ONLINE);
    expect(next.members.ana.presence).toBe(Presence.UNSPECIFIED);
  });
  it("applies every change in a batch", () => {
    const c = community();
    c.members = { me: c.me!, ana: create(MemberSchema, { id: "ana" }), bob: create(MemberSchema, { id: "bob" }) };
    const changes = [
      { memberId: "me", presence: Presence.ONLINE },
      { memberId: "ana", presence: Presence.OFFLINE },
    ];
    const next = applyEvent(c, ev(0n, { case: "presenceBatch", value: { changes } as never }), T0, null);
    expect(next.me?.presence).toBe(Presence.ONLINE);
    expect(next.members.me.presence).toBe(Presence.ONLINE);
    expect(next.members.ana.presence).toBe(Presence.OFFLINE);
    expect(next.members.bob.presence).toBe(Presence.UNSPECIFIED);
  });
});

describe("landingChannel", () => {
  const ch = (id: string, name: string, position: number, kind = ChannelKind.TEXT) => create(ChannelSchema, { id, name, position, kind, category: "General" });
  it("prefers #general, then the first unread channel, then the first channel", () => {
    const c = emptyCommunity("https://x.test");
    c.channels = { a: ch("a", "announcements", 0), g: ch("g", "general", 1), r: ch("r", "random", 2), d: ch("d", "general", 3, ChannelKind.DM) };
    c.reads = { r: create(ReadStateSchema, { channelId: "r", unreadCount: 2 }) };
    expect(landingChannel(c)).toBe("g");
    delete c.channels.g;
    expect(landingChannel(c)).toBe("r");
    c.reads = {};
    expect(landingChannel(c)).toBe("a");
    expect(landingChannel(emptyCommunity("https://x.test"))).toBe("");
  });
});

describe("sidebarSections", () => {
  it("orders categories by position, then DMs newest first", () => {
    const c = emptyCommunity("https://x.test");
    const ch = (id: string, category: string, position: number, kind = ChannelKind.TEXT, lastMessageSeq = 0n) =>
      create(ChannelSchema, { id, name: id, category, position, kind, lastMessageSeq });
    c.channels = {
      b: ch("b", "Talk", 2),
      a: ch("a", "", 0),
      z: ch("z", "Talk", 1),
      d1: ch("d1", "", 0, ChannelKind.DM, 3n),
      d2: ch("d2", "", 0, ChannelKind.DM, 9n),
    };
    expect(sidebarSections(c).map((s) => `${s.title}:${s.channels.map((x) => x.id).join(",")}`)).toEqual([
      "Channels:a",
      "Talk:z,b",
      "Direct messages:d2,d1",
    ]);
  });
});

describe("memberGroups", () => {
  it("groups online members by role, then online, then offline", () => {
    const m = (id: string, role: MemberRole, presence: Presence) => create(MemberSchema, { id, displayName: id, role, presence });
    const groups = memberGroups([
      m("zed", MemberRole.MEMBER, Presence.ONLINE),
      m("owner", MemberRole.OWNER, Presence.ONLINE),
      m("mod", MemberRole.MODERATOR, Presence.AWAY),
      m("amy", MemberRole.MEMBER, Presence.ONLINE),
      m("gone", MemberRole.ADMIN, Presence.OFFLINE),
    ]);
    expect(groups.map((g) => `${g.title}:${g.members.map((x) => x.id).join(",")}`)).toEqual([
      "Owners:owner",
      "Moderators:mod",
      "Online:amy,zed",
      "Offline:gone",
    ]);
  });
});

it("count pluralizes and groups digits", () => {
  expect(count(1, "member", "members")).toBe("1 member");
  expect(count(0, "reply", "replies")).toBe("0 replies");
  expect(count(1204, "member", "members")).toBe("1,204 members");
});

describe("inviteState", () => {
  const now = 1_000_000_000_000;
  const inv = (expiresAtMs: number, maxUses: number, uses: number) => ({ expiresAtMs: BigInt(expiresAtMs), maxUses, uses });
  it("describes live invites", () => {
    expect(inviteState(inv(0, 0, 1), now)).toEqual({ live: true, text: "1 use, never expires" });
    expect(inviteState(inv(now + 6 * 86_400_000 - 1, 10, 2), now)).toEqual({ live: true, text: "2 of 10 uses, expires in 6 days" });
    expect(inviteState(inv(now + 90 * 60_000, 0, 0), now)).toEqual({ live: true, text: "0 uses, expires in 2 hours" });
  });
  it("says when an invite stopped working", () => {
    expect(inviteState(inv(now, 0, 3), now)).toEqual({ live: false, text: "Expired, 3 uses" });
    expect(inviteState(inv(0, 5, 5), now)).toEqual({ live: false, text: "Used up, 5 of 5 uses" });
  });
});

describe("canRemoveFromChannel", () => {
  const { MEMBER, MODERATOR, ADMIN } = MemberRole;
  const mem = (id: string, role: MemberRole, kind = MemberKind.HUMAN) => create(MemberSchema, { id, role, kind });
  it("lets anyone leave and moderators remove lower ranks, bots included", () => {
    expect(canRemoveFromChannel(mem("a", MEMBER), mem("a", MEMBER))).toBe(true);
    expect(canRemoveFromChannel(mem("a", MEMBER), mem("b", MEMBER))).toBe(false);
    expect(canRemoveFromChannel(mem("a", MODERATOR), mem("b", MEMBER, MemberKind.BOT))).toBe(true);
    expect(canRemoveFromChannel(mem("a", MODERATOR), mem("b", MODERATOR))).toBe(false);
    expect(canRemoveFromChannel(mem("a", MODERATOR), mem("b", ADMIN))).toBe(false);
    expect(canRemoveFromChannel(undefined, mem("b", MEMBER))).toBe(false);
  });
});

describe("modActions", () => {
  const { MEMBER, MODERATOR, ADMIN, OWNER } = MemberRole;
  const mem = (id: string, role: MemberRole, kind = MemberKind.HUMAN) => create(MemberSchema, { id, role, kind });
  it("lets moderators remove lower ranks but not set roles", () => {
    expect(modActions(mem("a", MODERATOR), mem("b", MEMBER))).toEqual({ remove: true, roles: [] });
    expect(modActions(mem("a", MODERATOR), mem("b", MODERATOR))).toEqual({ remove: false, roles: [] });
  });
  it("lets admins set roles below their own, and the owner up to admin", () => {
    expect(modActions(mem("a", ADMIN), mem("b", MEMBER)).roles).toEqual([MEMBER, MODERATOR]);
    expect(modActions(mem("a", OWNER), mem("b", ADMIN)).roles).toEqual([MEMBER, MODERATOR, ADMIN]);
    expect(modActions(mem("a", ADMIN), mem("b", OWNER))).toEqual({ remove: false, roles: [] });
  });
  it("never offers kick or ban for bots, yourself, or plain members", () => {
    expect(modActions(mem("a", OWNER), mem("b", MEMBER, MemberKind.BOT)).remove).toBe(false);
    expect(modActions(mem("a", OWNER), mem("a", OWNER)).remove).toBe(false);
    expect(modActions(mem("a", MEMBER), mem("b", MEMBER)).remove).toBe(false);
    expect(modActions(undefined, mem("b", MEMBER)).remove).toBe(false);
  });
});

describe("channelSlug", () => {
  it("matches the server's normalization", () => {
    expect(channelSlug("  Book   Club ")).toBe("book-club");
    expect(channelSlug("#Release_Notes")).toBe("release_notes");
    expect(channelSlug("café")).toBe("");
    expect(channelSlug("   ")).toBe("");
    expect(channelSlug("a".repeat(81))).toBe("");
  });
});

describe("reorderChannel", () => {
  const ch = (id: string, position: number) => ({ id, position });
  it("swaps neighbours and keeps the category's positions", () => {
    expect(reorderChannel([ch("a", 4), ch("b", 5), ch("c", 9)], "c", -1)).toEqual([ch("c", 5), ch("b", 9)]);
    expect(reorderChannel([ch("a", 4), ch("b", 5), ch("c", 9)], "a", 1)).toEqual([ch("b", 4), ch("a", 5)]);
  });
  it("spreads out equal positions", () => {
    expect(reorderChannel([ch("a", 0), ch("b", 0), ch("c", 0)], "c", -1)).toEqual([ch("c", 1), ch("b", 2)]);
  });
  it("does nothing past the ends", () => {
    expect(reorderChannel([ch("a", 0), ch("b", 1)], "a", -1)).toEqual([]);
    expect(reorderChannel([ch("a", 0), ch("b", 1)], "b", 1)).toEqual([]);
  });
});

describe("appearance", () => {
  it("parses stored settings and drops bad values field by field", () => {
    expect(parseAppearance(null)).toEqual({ theme: "system", accent: "", density: "cozy", sidebar: "cozy", fontSize: 15, clock: "12", motion: "system", custom: "", font: "default", skinTone: 0 });
    expect(parseAppearance({ skinTone: 3 }).skinTone).toBe(3);
    expect(parseAppearance({ skinTone: 6 }).skinTone).toBe(0);
    expect(parseAppearance({ skinTone: "3" }).skinTone).toBe(0);
    expect(parseAppearance("dark")).toMatchObject({ theme: "system" });
    const bad = parseAppearance({ theme: "vaporwave", accent: "red", density: "COMPACT", sidebar: 1, fontSize: "18", clock: 24, motion: true });
    expect(bad).toEqual({ theme: "system", accent: "", density: "cozy", sidebar: "cozy", fontSize: 15, clock: "12", motion: "system", custom: "", font: "default", skinTone: 0 });
    expect(parseAppearance({ theme: "clementine", font: "iosevka" })).toMatchObject({ theme: "clementine", font: "iosevka" });
    // A saved Cocoa appearance (removed in 1323) becomes Clementine, not the default.
    expect(parseAppearance({ theme: "cocoa", font: "iosevka" })).toMatchObject({ theme: "clementine", font: "iosevka" });
    expect(parseAppearance({ font: "comic-sans" }).font).toBe("default");
    expect(parseAppearance({ theme: "mint", accent: "#D0306A", density: "irc", fontSize: 99, clock: "24", motion: "reduce" })).toMatchObject({
      theme: "mint",
      accent: "#d0306a",
      density: "irc",
      fontSize: 20,
      clock: "24",
      motion: "reduce",
    });
    expect(parseAppearance({ fontSize: 3 }).fontSize).toBe(12);
    expect(parseAppearance({ fontSize: NaN }).fontSize).toBe(15);
    expect(parseAppearance({ accent: "#12345" }).accent).toBe("");
    // A custom theme needs its colors; without them it falls back to the default theme.
    expect(parseAppearance({ theme: "custom" }).theme).toBe("system");
    expect(parseAppearance({ theme: "custom", custom: "#fff" })).toMatchObject({ theme: "system", custom: "" });
    expect(parseAppearance({ theme: "custom", custom: "#AABBCC,#000000,#ffffff,#111111,#3550f0,#d42a44" })).toMatchObject({
      theme: "custom",
      custom: "#aabbcc,#000000,#ffffff,#111111,#3550f0,#d42a44",
    });
  });

  it("reads and writes a pasted theme string", () => {
    const six = ["#171925", "#e7e9f2", "#1d1f2d", "#e7e9f2", "#4a5ef2", "#d42a44"];
    expect(themeString(six)).toBe("#171925,#e7e9f2,#1d1f2d,#e7e9f2,#4a5ef2,#d42a44");
    expect(parseThemeString("#171925,#e7e9f2,#1d1f2d,#e7e9f2,#4a5ef2,#d42a44")).toEqual(six);
    // Slack-style pastes: spaces, upper case, no #.
    expect(parseThemeString(" 171925, E7E9F2 #1d1f2d,e7e9f2  4A5EF2,#d42a44\n")).toEqual(six);
    expect(parseThemeString("#171925,#e7e9f2,#1d1f2d,#e7e9f2,#4a5ef2")).toBeNull();
    expect(parseThemeString("#171925,#e7e9f2,#1d1f2d,#e7e9f2,#4a5ef2,#d42a44,#000000")).toBeNull();
    expect(parseThemeString("#171925,#e7e9f2,#1d1f2d,#e7e9f2,#4a5ef2,red")).toBeNull();
    expect(parseThemeString("")).toBeNull();
  });

  it("derives a custom theme and moves only the text that would be hard to read", () => {
    const good = customTheme(["#eef1f6", "#1a1c2b", "#ffffff", "#1a1c2b", "#3550f0", "#d42a44"]);
    expect(good.fixed).toEqual([]);
    expect(good.tokens["--text"]).toBe("#1a1c2b");
    expect(good.dark).toBe(false);
    // White text on white messages, dark sidebar text on a dark sidebar: both get fixed.
    const bad = customTheme(["#202020", "#303030", "#ffffff", "#ffffff", "#3550f0", "#d42a44"]);
    expect(bad.fixed).toEqual(["Sidebar text", "Message text"]);
    expect(contrast(bad.tokens["--text"], "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(bad.tokens["--ink"], "#202020")).toBeGreaterThanOrEqual(4.5);
    expect(customTheme(["#202020", "#eeeeee", "#101010", "#eeeeee", "#ffff00", "#ff0000"]).dark).toBe(true);
  });

  it("formats 12 and 24 hour clocks", () => {
    const t = new Date(2026, 0, 2, 21, 5).getTime();
    expect(timeLabel(t)).toBe("9:05 PM");
    expect(timeLabel(t, true)).toBe("21:05");
    expect(timeLabel(new Date(2026, 0, 2, 0, 7).getTime(), true)).toBe("00:07");
  });

  it("computes WCAG contrast ratios", () => {
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(contrast("rgb(255, 255, 255)", "#3550f0")).toBeCloseTo(contrast("#3550f0", "#ffffff"), 9);
  });

  it("fits an accent until it reads on every background", () => {
    // Yellow on white is about 1.07:1; the fitted color must reach 4.5 on both papers.
    const fitted = fitContrast("#ffff00", ["#ffffff", "#eef1f6"], 4.5);
    expect(contrast(fitted, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(fitted, "#eef1f6")).toBeGreaterThanOrEqual(4.5);
    expect(fitted).not.toBe("#000000");
    // On a dark paper it lightens instead.
    const light = fitContrast("#3550f0", ["#1d1f2d"], 4.5);
    expect(contrast(light, "#1d1f2d")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#3550f0", "#1d1f2d")).toBeLessThan(4.5);
    // A color that already passes comes back unchanged.
    expect(fitContrast("#0a6e54", ["#ffffff"], 4.5)).toBe("#0a6e54");
  });

  // Reads the real stylesheet so a token edit that breaks contrast fails here.
  it("every theme meets contrast (AA, AAA for high contrast)", () => {
    const block = (sel: string) => {
      const i = css.indexOf(sel);
      if (i < 0) throw new Error(`missing ${sel}`);
      const body = css.slice(css.indexOf("{", i) + 1, css.indexOf("}", i));
      return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()])) as Record<string, string>;
    };
    const base = block(':root,\n[data-theme="light"],\n[data-theme="dark"] {');
    const side = (v: string, i: number) => v.match(/^light-dark\((#\w+),\s*(#\w+)\)$/)?.[i + 1] ?? v;
    const themes: Record<string, Record<string, string>> = {
      light: Object.fromEntries(Object.entries(base).map(([k, v]) => [k, side(v, 0)])),
      dark: Object.fromEntries(Object.entries(base).map(([k, v]) => [k, side(v, 1)])),
    };
    for (const t of THEMES.filter((t) => !["system", "light", "dark", "custom"].includes(t))) themes[t] = { ...themes.light, ...block(`[data-theme="${t}"] {`) };
    expect(Object.keys(themes)).toHaveLength(THEMES.length - 2);
    // Custom themes, including careless and mid-gray picks, pass the same pairs once derived.
    const picks = [
      "#eef1f6,#1a1c2b,#ffffff,#1a1c2b,#3550f0,#d42a44",
      "#171925,#e7e9f2,#1d1f2d,#e7e9f2,#4a5ef2,#d42a44",
      "#ffffff,#ffffff,#ffffff,#ffffff,#ffff00,#ffccdd",
      "#000000,#000000,#000000,#000000,#000080,#400000",
      "#777777,#767676,#757575,#787878,#777777,#777777",
      "#3f0e40,#ffffff,#1a1d21,#d1d2d3,#1164a3,#cd2553",
    ];
    for (const p of picks) {
      const { tokens, dark } = customTheme(parseThemeString(p)!);
      const scheme = dark ? themes.dark : themes.light;
      themes[`custom ${p}`] = { ...scheme, ...Object.fromEntries(Object.entries(tokens).map(([k, v]) => [k.replace(/^--/, ""), v])) };
    }
    const pairs = [
      ["text", "paper"],
      ["ink", "frost"],
      ["ink", "selected"],
      ["graphite", "selected"],
      ["text", "msg-hover"],
      ["text", "mention-bg"],
      ["graphite", "paper"],
      ["graphite", "frost"],
      ["raspberry", "paper"],
      ["raspberry", "frost"],
      ["cherry-text", "paper"],
      ["on-accent", "accent-fill"],
      ["on-accent", "badge"],
      ["on-tip", "tip"],
      // Syntax colors in code blocks
      ["text", "code-bg"],
      ["raspberry", "code-bg"],
      ["cherry-text", "code-bg"],
      ["graphite", "code-bg"],
    ];
    const fails: string[] = [];
    for (const [name, tk] of Object.entries(themes)) {
      const min = name === "contrast" ? 7 : 4.5;
      for (const [fg, bg] of pairs) {
        const r = contrast(tk[fg], tk[bg]);
        if (r < min) fails.push(`${name}: --${fg} on --${bg} is ${r.toFixed(2)}`);
      }
    }
    expect(fails).toEqual([]);
  });
});

describe("channel modes and roles", () => {
  const role = (id: string, name: string, position: number) => create(RoleSchema, { id, name, position });

  it("upserts roles in position order and strips a deleted role from members, channels and me", () => {
    let c = community();
    c.me = create(MemberSchema, { id: "me", roleIds: ["r1", "r2"] });
    c.members = { me: c.me, ana: create(MemberSchema, { id: "ana", roleIds: ["r1"] }) };
    c.channels.c1 = create(ChannelSchema, { id: "c1", kind: ChannelKind.TEXT, name: "general", roleIds: ["r1", "r2"] });
    c = applyEvent(c, ev(11n, { case: "roleUpdated", value: role("r2", "Zed", 2) }), T0, null);
    c = applyEvent(c, ev(12n, { case: "roleUpdated", value: role("r1", "Alpha", 5) }), T0, null);
    expect(c.roles.map((r) => r.name)).toEqual(["Zed", "Alpha"]);
    c = applyEvent(c, ev(13n, { case: "roleUpdated", value: role("r2", "Zed", 9) }), T0, null);
    expect(c.roles.map((r) => r.id)).toEqual(["r1", "r2"]);
    c = applyEvent(c, ev(14n, { case: "roleDeleted", value: "r1" }), T0, null);
    expect(c.roles.map((r) => r.id)).toEqual(["r2"]);
    expect(c.members.ana.roleIds).toEqual([]);
    expect(c.me?.roleIds).toEqual(["r2"]);
    expect(c.channels.c1.roleIds).toEqual(["r2"]);
  });

  it("switches mode, and a joined channel stops being a preview", () => {
    let c = community();
    c.peek = create(ChannelSchema, { id: "c9", kind: ChannelKind.TEXT, name: "book-club" });
    c = applyEvent(c, ev(11n, { case: "channelModeChanged", value: ChannelMode.OPT_IN }), T0, null);
    expect(c.mode).toBe(ChannelMode.OPT_IN);
    c = applyEvent(c, ev(12n, { case: "channelCreated", value: c.peek! }), T0, null);
    expect(c.peek).toBeUndefined();
    expect(c.channels.c9.name).toBe("book-club");
    c = applyEvent(c, ev(13n, { case: "channelDeleted", value: "c9" }), T0, null);
    expect(c.channels.c9).toBeUndefined();
  });

  it("filters Browse channels by name or topic, marks what I joined and lists it last", () => {
    const all = [
      create(ChannelSchema, { id: "a", name: "general", topic: "Anything" }),
      create(ChannelSchema, { id: "b", name: "book-club", topic: "One novel a month" }),
      create(ChannelSchema, { id: "c", name: "art", topic: "" }),
      create(ChannelSchema, { id: "d", name: "about", topic: "" }),
    ];
    const joined = { a: all[0], d: all[3] };
    // Channels you can join come first, so they are not below the fold.
    expect(browseList(all, joined, "").map((x) => `${x.ch.name}:${x.joined}`)).toEqual(["art:false", "book-club:false", "about:true", "general:true"]);
    expect(browseList(all, joined, "#BOOK").map((x) => x.ch.id)).toEqual(["b"]);
    expect(browseList(all, joined, "novel").map((x) => x.ch.id)).toEqual(["b"]);
  });

  it("says when and by whom someone was banned", () => {
    const now = new Date(2026, 9, 16, 12).getTime();
    const ana = create(MemberSchema, { displayName: "Ana Ruiz", username: "ana" });
    expect(banDetail(now - 3_600_000, ana, now)).toBe("Banned today by Ana Ruiz");
    expect(banDetail(new Date(2026, 9, 15, 9).getTime(), create(MemberSchema, { username: "priya" }), now)).toBe("Banned yesterday by priya");
    expect(banDetail(new Date(2026, 8, 2, 9).getTime(), undefined, now)).toBe("Banned on Wednesday, September 2");
  });

  it("shows member count and topic under a Browse channels row", () => {
    expect(browseDetail(create(ChannelSchema, { memberCount: 12, topic: "Anything" }))).toBe("12 members · Anything");
    expect(browseDetail(create(ChannelSchema, { memberCount: 1 }))).toBe("1 member");
    expect(browseDetail(create(ChannelSchema, { topic: "Old server" }))).toBe("Old server");
  });

  it("lists a member's roles in role order", () => {
    const roles = [role("r1", "Core", 1), role("r2", "Design", 2), role("r3", "Film", 3)];
    expect(memberRoles(create(MemberSchema, { roleIds: ["r3", "r1"] }), roles).map((r) => r.name)).toEqual(["Core", "Film"]);
    expect(memberRoles(undefined, roles)).toEqual([]);
  });
});

describe("sentence", () => {
  it("capitalizes and ends a server reason once", () => {
    expect(sentence("tell us about your press")).toBe("Tell us about your press.");
    expect(sentence(" Answer the question first! ")).toBe("Answer the question first!");
    expect(sentence("")).toBe("");
  });
});

describe("swatch", () => {
  it("gives every avatar fill 4.5:1 against white initials", () => {
    for (let i = 0; i < 200; i++) expect(contrast(swatch(`m${i}`), "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("trimList", () => {
  const items = Array.from({ length: 150 }, (_, i) => create(MessageSchema, { id: `m${i}` }));
  it("keeps the newest 100 of a long latest list and marks older history as available", () => {
    const t = trimList({ items, hasMore: false, focusId: "m3" })!;
    expect(t.items.map((m) => m.id)).toEqual(Array.from({ length: 100 }, (_, i) => `m${i + 50}`));
    expect(t.hasMore).toBe(true);
    expect(t.focusId).toBeUndefined();
  });
  it("drops a search window, and leaves short or loading lists alone", () => {
    expect(trimList({ items, hasMore: true, hasMoreAfter: true })).toBeUndefined();
    const loading = { items, hasMore: true, loading: true };
    expect(trimList(loading)).toBe(loading);
    const short = { items: items.slice(0, 100), hasMore: false };
    expect(trimList(short)).toBe(short);
  });
});

describe("panel resize", () => {
  const { side, pane } = PANELS;
  it("closes a dialog only for a press on the backdrop, not its own padding", () => {
    const box = { left: 100, top: 50, right: 580, bottom: 450 };
    expect(onBackdrop(box, 110, 60)).toBe(false); // inside the 24px padding
    expect(onBackdrop(box, 340, 449)).toBe(false);
    expect(onBackdrop(box, 99, 60)).toBe(true);
    expect(onBackdrop(box, 340, 451)).toBe(true);
  });
  it("clamps drags to the panel's range", () => {
    expect(clampWidth(side, 50)).toBe(200);
    expect(clampWidth(side, 9999)).toBe(420);
    expect(clampWidth(side, 300.6)).toBe(301);
  });
  it("arrow keys move the edge the way the arrow points", () => {
    expect(keyWidth(side, 260, "ArrowRight")).toBe(276);
    expect(keyWidth(side, 260, "ArrowLeft")).toBe(244);
    expect(keyWidth(pane, 340, "ArrowLeft")).toBe(356); // pane edge is on its left
    expect(keyWidth(pane, 340, "ArrowRight", true)).toBe(280);
    expect(keyWidth(side, 410, "ArrowRight")).toBe(420);
    expect(keyWidth(side, 300, "Home")).toBe(200);
    expect(keyWidth(pane, 300, "End")).toBe(640);
    expect(keyWidth(side, 300, "Enter")).toBe(260);
    expect(keyWidth(side, 300, "a")).toBeNull();
  });
});

describe("banner images", () => {
  it("takes the image types the server takes, up to 8 MB", () => {
    expect(bannerFileError({ type: "image/png", size: 1000 })).toBe("");
    expect(bannerFileError({ type: "image/webp", size: 8 * 1024 * 1024 })).toBe("");
    expect(bannerFileError({ type: "image/svg+xml", size: 10 })).toMatch(/PNG, JPEG/);
    expect(bannerFileError({ type: "", size: 10 })).toMatch(/PNG, JPEG/);
    expect(bannerFileError({ type: "image/jpeg", size: 8 * 1024 * 1024 + 1 })).toMatch(/over 8 MB/);
  });
  it("quotes a URL for CSS", () => {
    expect(cssUrl("")).toBe("");
    expect(cssUrl("https://x.test/a.png?exp=1&sig=a_b")).toBe('url("https://x.test/a.png?exp=1&sig=a_b")');
    expect(cssUrl('blob:x/"); background: red; ("')).toBe('url("blob:x/\\"); background: red; (\\"")');
    expect(cssUrl("a\\b\nc")).toBe('url("a\\\\b\\a c")');
  });
});

describe("readDelay (1040)", () => {
  it("sends the first read now and holds the rest for the window", () => {
    expect(readDelay(undefined, 10_000)).toBe(0);
    expect(readDelay(10_000, 10_000)).toBe(3000);
    expect(readDelay(10_000, 11_000)).toBe(2000);
    expect(readDelay(10_000, 13_000)).toBe(0);
    expect(readDelay(10_000, 60_000)).toBe(0);
  });
  it("a busy channel sends one read per window, not one per message", () => {
    let sent: number | undefined;
    let sends = 0;
    let due = -1;
    // One message every 100 ms for 10 s; a timer fires when due.
    for (let t = 0; t <= 10_000; t += 100) {
      if (due >= 0 && t >= due) (sends++, (sent = t), (due = -1));
      if (due < 0) {
        const d = readDelay(sent, t);
        if (d === 0) (sends++, (sent = t));
        else due = t + d;
      }
    }
    expect(sends).toBe(4);
  });
});

describe("squareCrop", () => {
  it("takes the centered square and shrinks it to max", () => {
    expect(squareCrop(1200, 800, 512)).toEqual({ sx: 200, sy: 0, side: 800, out: 512 });
    expect(squareCrop(300, 501, 512)).toEqual({ sx: 0, sy: 100, side: 300, out: 300 });
    expect(squareCrop(64, 64, 512)).toEqual({ sx: 0, sy: 0, side: 64, out: 64 });
  });
});

describe("pasteTarget", () => {
  it("leaves pastes in text fields and pastes without files alone", () => {
    expect(pasteTarget(true, true, "pane", true)).toBeNull();
    expect(pasteTarget(false, false, "channel", false)).toBeNull();
  });
  it("sends files to the thread only when it was last touched and is open", () => {
    expect(pasteTarget(false, true, "pane", true)).toBe("pane");
    expect(pasteTarget(false, true, "pane", false)).toBe("channel");
    expect(pasteTarget(false, true, "channel", true)).toBe("channel");
    expect(pasteTarget(false, true, null, true)).toBe("channel");
  });
});

describe("appearanceSync", () => {
  it("takes the newer copy", () => {
    expect(appearanceSync(0, 5)).toBe("pull"); // fresh device
    expect(appearanceSync(10, 5)).toBe("push"); // edited here since
    expect(appearanceSync(5, 10)).toBe("pull"); // edited elsewhere since
    expect(appearanceSync(7, 7)).toBe("keep");
    expect(appearanceSync(7, null)).toBe("push"); // nothing on the server yet
    expect(appearanceSync(0, null)).toBe("keep"); // nothing anywhere
  });
});

describe("denied", () => {
  it("drops a community only when it says I am not a member and I was one", () => {
    expect(denied(Code.PermissionDenied, "join this community first", true)).toBe("drop"); // kicked or banned
    expect(denied(Code.PermissionDenied, "you are no longer a member", true)).toBe("drop"); // kicked mid-subscribe
    expect(denied(Code.PermissionDenied, "join this community first", false)).toBe("join"); // a default I never joined
  });
  it("retries anything that is not that answer", () => {
    expect(denied(Code.PermissionDenied, "HTTP 403", true)).toBeNull(); // a proxy, not the community
    expect(denied(Code.Unauthenticated, "missing bearer token", true)).toBeNull(); // signed out or token trouble
    expect(denied(Code.ResourceExhausted, "subscription fell behind; reconnect with your last seq", true)).toBeNull(); // the kick itself
    expect(denied(Code.Unavailable, "", true)).toBeNull();
  });
});

describe("communitiesSync", () => {
  const A = "https://a.example", B = "https://b.example", C = "https://c.example";
  it("unions on the first sign-in of a browser that has its own list", () => {
    expect(communitiesSync([C, A], 0, { urls: [A, B], updatedAt: 5 }, 99)).toEqual({ order: [A, B, C], at: 99, push: true });
  });
  it("takes the account's list on a fresh browser", () => {
    expect(communitiesSync(null, 0, { urls: [B, A], updatedAt: 5 }, 99)).toEqual({ order: [B, A], at: 5, push: false });
  });
  it("lets the newer list win whole once synced, so removals stick", () => {
    expect(communitiesSync([A, B], 5, { urls: [B], updatedAt: 9 }, 99)).toEqual({ order: [B], at: 9, push: false });
    expect(communitiesSync([A], 9, { urls: [A, B], updatedAt: 5 }, 99)).toEqual({ order: [A], at: 9, push: true });
    expect(communitiesSync([A], 9, { urls: [A], updatedAt: 9 }, 99)).toEqual({ order: [A], at: 9, push: false });
  });
  it("seeds the account from this browser, but not with the defaults", () => {
    expect(communitiesSync([A], 0, null, 99)).toEqual({ order: [A], at: 99, push: true });
    expect(communitiesSync([A], 7, null, 99)).toEqual({ order: [A], at: 7, push: true });
    expect(communitiesSync(null, 0, null, 99)).toEqual({ order: null, at: 0, push: false });
  });
});

describe("plugins", () => {
  it("names a plugin after its file", () => {
    expect(pluginNameFromFile("Dice Roller.js")).toBe("dice-roller");
    expect(pluginNameFromFile("../welcome.JS")).toBe("..-welcome");
    expect(pluginNameFromFile("x".repeat(40) + ".js")).toHaveLength(32);
  });
  it("checks the install form", () => {
    expect(pluginFormError("dice", "1")).toBe("");
    expect(pluginFormError("d", "1")).toMatch(/2 to 32/);
    expect(pluginFormError("a/b", "1")).toMatch(/2 to 32/);
    expect(pluginFormError("dice", "  ")).toMatch(/Choose/);
    expect(pluginFormError("dice", "x".repeat(MAX_PLUGIN_BYTES))).toBe("");
    // Bytes, not characters: "é" is two bytes.
    expect(pluginFormError("dice", "é".repeat(MAX_PLUGIN_BYTES / 2 + 1))).toMatch(/256 KB/);
  });
  it("labels status", () => {
    expect(pluginStatus({ enabled: false, running: false, error: "x" })).toEqual({ label: "Off", tone: "off" });
    expect(pluginStatus({ enabled: true, running: false, error: "SyntaxError" }).tone).toBe("bad");
    expect(pluginStatus({ enabled: true, running: true, error: "" })).toEqual({ label: "Running", tone: "ok" });
    expect(pluginStatus({ enabled: true, running: true, error: "onCommand: boom" }).tone).toBe("bad");
  });
  it("leaves plugin bots out of the token bots", () => {
    const bots = [{ username: "dice" }, { username: "kiln-bot" }];
    expect(tokenBots(bots, [{ name: "dice" }])).toEqual([{ username: "kiln-bot" }]);
  });
  it("bumps pluginsRev on plugins_changed", () => {
    const e = create(EventSchema, { seq: 5n, kind: { case: "pluginsChanged", value: true } });
    const c = applyEvent(applyEvent(emptyCommunity("u"), e, 0, null), create(EventSchema, { seq: 6n, kind: { case: "pluginsChanged", value: true } }), 0, null);
    expect(c.pluginsRev).toBe(2);
  });
});

describe("toolsInside", () => {
  it("moves the toolbar inside only near the scroller top", () => {
    expect(toolsInside(100, 100)).toBe(true);
    expect(toolsInside(135, 100)).toBe(true);
    expect(toolsInside(136, 100)).toBe(false);
    expect(toolsInside(400, 100)).toBe(false);
  });
});

describe("keyboard and screen readers (1188)", () => {
  it("moves through a menu with wrapping", () => {
    expect(listMove(0, 3, "ArrowDown")).toBe(1);
    expect(listMove(2, 3, "ArrowDown")).toBe(0);
    expect(listMove(0, 3, "ArrowUp")).toBe(2);
    expect(listMove(-1, 3, "ArrowUp")).toBe(2);
    expect(listMove(-1, 3, "ArrowDown")).toBe(0);
    expect(listMove(1, 3, "Home")).toBe(0);
    expect(listMove(1, 3, "End")).toBe(2);
    expect(listMove(1, 3, "a")).toBe(-1);
    expect(listMove(0, 0, "ArrowDown")).toBe(-1);
  });
  it("moves through a grid with short rows by position", () => {
    // Section one: a full row of 3 and a short row of 1. Section two starts a new row below its header.
    const cells = [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 },
      { x: 0, y: 10 },
      { x: 0, y: 40 }, { x: 10, y: 40 }, { x: 20, y: 40 },
    ];
    expect(gridMove(cells, 2, "ArrowDown")).toBe(3); // nearest row, closest column
    expect(gridMove(cells, 3, "ArrowDown")).toBe(4);
    expect(gridMove(cells, 6, "ArrowUp")).toBe(3);
    expect(gridMove(cells, 5, "ArrowUp")).toBe(3);
    expect(gridMove(cells, 1, "ArrowUp")).toBe(1); // top row stays
    expect(gridMove(cells, 6, "ArrowDown")).toBe(6);
    expect(gridMove(cells, 3, "ArrowRight")).toBe(4);
    expect(gridMove(cells, 0, "ArrowLeft")).toBe(0);
    expect(gridMove(cells, 6, "ArrowRight")).toBe(6);
    expect(gridMove(cells, 3, "End")).toBe(6);
    expect(gridMove(cells, 3, "Enter")).toBe(-1);
  });
  it("announces only new messages from other people", () => {
    const members = { ana: create(MemberSchema, { id: "ana", displayName: "Ana" }) };
    const msg = (authorId: string, at: number, text = "kiln is hot") => create(MessageSchema, { id: `${authorId}${at}`, authorId, createdAtMs: BigInt(at), text, seq: 1n });
    expect(arrivalText([msg("ana", 200)], 100, "me", members)).toBe("Ana: kiln is hot");
    expect(arrivalText([msg("ana", 200, "hi <@ana>")], 100, "me", members)).toBe("Ana: hi @Ana");
    expect(arrivalText([msg("ana", 50)], 100, "me", members)).toBe(""); // history
    expect(arrivalText([msg("me", 200)], 100, "me", members)).toBe(""); // your own
    expect(arrivalText([msg("ana", 200), msg("ana", 50)], 100, "me", members)).toBe(""); // only the newest counts
    expect(arrivalText([msg("gone", 200, "")], 100, "me", members)).toBe("Someone: 0 attachments");
    expect(arrivalText([], 100, "me", members)).toBe("");
  });
});

describe("loading skeletons", () => {
  const m = create(MessageSchema, { id: "m1" });
  it("waits long enough that fast loads skip it, short enough to feel instant", () => {
    expect(SKELETON_DELAY_MS).toBeGreaterThanOrEqual(150);
    expect(SKELETON_DELAY_MS).toBeLessThanOrEqual(300);
  });
  it("picks what the top of a list shows", () => {
    expect(listPhase(undefined)).toBe("skeleton");
    expect(listPhase({ items: [], hasMore: true, loading: true })).toBe("skeleton");
    expect(listPhase({ items: [m], hasMore: true, loading: true })).toBe("more");
    expect(listPhase({ items: [m], hasMore: true })).toBe("more");
    expect(listPhase({ items: [], hasMore: false })).toBe("start");
    expect(listPhase({ items: [], hasMore: true, loading: true, error: "Can't reach it" })).toBe("error");
  });
  it("shapes rows that look like chat and stay the same", () => {
    const rows = skeletonRows(9);
    expect(rows).toEqual(skeletonRows(9));
    expect(rows[0].head).toBe(true);
    expect(rows.filter((r) => !r.head)).toHaveLength(3);
    for (const r of rows) {
      expect(r.lines.length).toBeGreaterThan(0);
      for (const w of [r.name, ...r.lines]) expect(w).toBeGreaterThan(10), expect(w).toBeLessThanOrEqual(100);
    }
    expect(new Set(rows.map((r) => r.lines[0])).size).toBeGreaterThan(4);
  });
});

describe("who can post (1308)", () => {
  const as = (role: MemberRole, ...roleIds: string[]) => create(MemberSchema, { id: "me", role, roleIds });
  const chan = (...postRoleIds: string[]) => create(ChannelSchema, { id: "a", kind: ChannelKind.TEXT, postRoleIds });
  it("lets everyone post with no list, and admins and the owner always", () => {
    for (const r of [MemberRole.MEMBER, MemberRole.MODERATOR, MemberRole.ADMIN]) expect(mayPost(chan(), as(r))).toBe(true);
    expect(mayPost(chan("admin"), as(MemberRole.ADMIN))).toBe(true);
    expect(mayPost(chan("admin"), as(MemberRole.OWNER))).toBe(true);
    expect(mayPost(chan("admin"), undefined)).toBe(false);
    expect(mayPost(chan("admin"), create(MemberSchema, { id: "bot", kind: MemberKind.BOT }))).toBe(true);
  });
  it("lets moderators in only when chosen, and custom roles by id", () => {
    expect(mayPost(chan("admin"), as(MemberRole.MODERATOR))).toBe(false);
    expect(mayPost(chan("admin", "moderator"), as(MemberRole.MODERATOR))).toBe(true);
    expect(mayPost(chan("admin", "moderator"), as(MemberRole.MEMBER))).toBe(false);
    expect(mayPost(chan("admin", "r1"), as(MemberRole.MEMBER, "r1"))).toBe(true);
    expect(mayPost(chan("admin", "r1"), as(MemberRole.MEMBER, "r2"))).toBe(false);
  });
  it("names who can post, admins first, skipping deleted roles", () => {
    const roles = [create(RoleSchema, { id: "r1", name: "Staff" }), create(RoleSchema, { id: "r2", name: "Mentors" })];
    expect(posterNames(["admin"], roles)).toBe("admins");
    expect(posterNames(["admin", "moderator"], roles)).toBe("admins and moderators");
    expect(posterNames(["admin", "gone", "moderator", "r1", "r2"], roles)).toBe("admins, moderators, Staff, and Mentors");
  });
});

describe("DM titles (1309)", () => {
  const members = {
    me: create(MemberSchema, { id: "me", displayName: "Ian" }),
    ana: create(MemberSchema, { id: "ana", displayName: "Ana" }),
    ben: create(MemberSchema, { id: "ben", displayName: "Ben" }),
  };
  const dm = (...ids: string[]) => create(ChannelSchema, { id: "d", kind: ChannelKind.DM, memberIds: ids });
  it("names the others, or you with (you) in a self DM", () => {
    expect(channelLabel(dm("me", "ana"), members, "me")).toBe("Ana");
    expect(channelLabel(dm("ana", "me", "ben"), members, "me")).toBe("Ana, Ben");
    expect(channelLabel(dm("me"), members, "me")).toBe("Ian (you)");
    expect(channelLabel(dm("me"), {}, "me")).toBe("You (you)");
  });
  it("picks the other member, or you in a self DM", () => {
    expect(dmPeer(dm("me", "ana"), "me")).toBe("ana");
    expect(dmPeer(dm("ana", "me"), "me")).toBe("ana");
    expect(dmPeer(dm("me"), "me")).toBe("me");
  });
});

describe("pinchView (1316)", () => {
  const c = { x: 100, y: 100 };
  it("keeps the point under the fingers in place and pans with one finger", () => {
    // Spread to 2x around (150, 100): that point stays put, so the center moves left by 50.
    expect(pinchView({ x: 0, y: 0, s: 1 }, { x: 150, y: 100 }, { x: 150, y: 100 }, 2, c)).toEqual({ s: 2, x: -50, y: 0 });
    expect(pinchView({ x: 10, y: 0, s: 2 }, { x: 0, y: 0 }, { x: 5, y: 30 }, 1, c)).toEqual({ s: 2, x: 15, y: 30 });
    expect(pinchView({ x: 0, y: 0, s: 5 }, c, c, 10, c).s).toBe(6);
  });
});

describe("tailnetUrl", () => {
  it("maps dev server URLs to tailscale serve ports and leaves others alone", () => {
    const t = "box.example.ts.net";
    expect(tailnetUrl("http://auth.sblurp.localhost:1355/oauth/token", t)).toBe("https://box.example.ts.net:18081/oauth/token");
    expect(tailnetUrl("http://owls.sblurp.localhost:1355", t)).toBe("https://box.example.ts.net:18083");
    expect(tailnetUrl("http://localhost:8082/files/a?sig=1", t)).toBe("https://box.example.ts.net:18082/files/a?sig=1");
    expect(tailnetUrl("http://nope.sblurp.localhost:1355/x", t)).toBe("http://nope.sblurp.localhost:1355/x");
    expect(tailnetUrl("http://localhost:80821/x", t)).toBe("http://localhost:80821/x");
    expect(tailnetUrl("https://sblurp.chat/x", t)).toBe("https://sblurp.chat/x");
  });
});

describe("drawer swipe (1354)", () => {
  it("locks to an axis only after 10px", () => {
    expect(swipeAxis(false, 6, 2)).toBe(null);
    expect(swipeAxis(false, 20, 3)).toBe("open");
    expect(swipeAxis(true, -20, 3)).toBe("close");
  });
  it("leaves vertical and wrong-way moves to scrolling", () => {
    expect(swipeAxis(false, 12, 30)).toBe("none");
    expect(swipeAxis(false, -20, 0)).toBe("none");
    expect(swipeAxis(true, 20, 0)).toBe("none");
  });
  it("settles by flick, else by halfway", () => {
    expect(swipeEnds(0.2, 0.8)).toBe(true);
    expect(swipeEnds(0.9, -0.8)).toBe(false);
    expect(swipeEnds(0.6, 0)).toBe(true);
    expect(swipeEnds(0.4, 0.1)).toBe(false);
  });
});

describe("allDMs (1369)", () => {
  it("puts unread first, then rail order, then newest within a community, and skips channels", () => {
    const dm = (id: string, lastMessageSeq: bigint) => create(ChannelSchema, { id, kind: ChannelKind.DM, memberIds: ["me", id], lastMessageSeq });
    const a = emptyCommunity("https://a.test");
    a.channels = { a1: dm("a1", 3n), a2: dm("a2", 90n), gen: create(ChannelSchema, { id: "gen", kind: ChannelKind.TEXT }) };
    const b = emptyCommunity("https://b.test");
    b.channels = { b1: dm("b1", 1n), b2: dm("b2", 2n) };
    b.reads = { b1: create(ReadStateSchema, { channelId: "b1", unreadCount: 2, mentionCount: 1 }) };
    const got = allDMs({ [a.url]: a, [b.url]: b }, [a.url, b.url, "https://gone.test"]);
    expect(got.map((x) => x.ch.id)).toEqual(["b1", "a2", "a1", "b2"]);
    expect(got[0]).toMatchObject({ url: "https://b.test", unread: true, mentions: 1 });
    expect(got[1]).toMatchObject({ unread: false, mentions: 0 });
  });
});

import { tabBadges } from "./logic";

describe("tabBadges (1386)", () => {
  it("splits channels and DMs and leaves the open channel out of the back count", () => {
    const rs = (channelId: string, unreadCount: number, mentionCount: number) => create(ReadStateSchema, { channelId, unreadCount, mentionCount });
    const a = emptyCommunity("https://a.test");
    a.channels = {
      gen: create(ChannelSchema, { id: "gen", kind: ChannelKind.TEXT }),
      dev: create(ChannelSchema, { id: "dev", kind: ChannelKind.TEXT }),
      d1: create(ChannelSchema, { id: "d1", kind: ChannelKind.DM, memberIds: ["me", "x"] }),
      d2: create(ChannelSchema, { id: "d2", kind: ChannelKind.DM, memberIds: ["me", "y"] }),
    };
    a.reads = { gen: rs("gen", 5, 2), dev: rs("dev", 1, 0), d1: rs("d1", 3, 0), d2: rs("d2", 0, 0) };
    expect(tabBadges({ [a.url]: a })).toEqual({ home: { unread: true, mentions: 2 }, dms: 1, back: 3 });
    expect(tabBadges({ [a.url]: a }, { url: a.url, channelId: "gen" }).back).toBe(1);
    expect(tabBadges({ [a.url]: a }, { url: a.url, channelId: "d1" }).back).toBe(2);
    a.reads = { dev: rs("dev", 4, 0) };
    expect(tabBadges({ [a.url]: a })).toEqual({ home: { unread: true, mentions: 0 }, dms: 0, back: 0 });
  });
});
