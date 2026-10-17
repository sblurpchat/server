import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import css from "./app.css?raw";
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
  THEMES,
  banDetail,
  readDelay,
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
  timeLabel,
  acQuery,
  listStep,
  applyEvent,
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
  channelSlug,
  reorderChannel,
  parseHash,
  messageHash,
  parseInline,
  parseMarkdown,
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
  paneQuery,
  parsePane,
  bannerFileError,
  squareCrop,
  cssUrl,
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
      { t: "ul", items: [t("milk"), [{ t: "b", c: t("eggs") }, { t: "text", v: "\nlarge ones" }]] },
      { t: "ol", start: 3, items: [t("three"), t("four")] },
      { t: "p", c: t("after") },
    ]);
    expect(parseMarkdown("-not a list")).toEqual([{ t: "p", c: t("-not a list") }]);
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
  it("backs off exponentially with jitter and caps at 30s", () => {
    expect(backoffMs(0, 0)).toBe(500);
    expect(backoffMs(0, 0.999999)).toBe(1000);
    expect(backoffMs(3, 0)).toBe(4000);
    expect(backoffMs(10, 0)).toBe(15000);
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

describe("helpers", () => {
  it("ranks prefix over substring over subsequence", () => {
    expect(matchScore("gen", "general")).toBeGreaterThan(matchScore("gen", "regenerate"));
    expect(matchScore("gen", "regenerate")).toBeGreaterThan(matchScore("gnl", "general"));
    expect(matchScore("xyz", "general")).toBe(-1);
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
    expect(parseAppearance(null)).toEqual({ theme: "system", accent: "", density: "cozy", sidebar: "cozy", fontSize: 15, clock: "12", motion: "system", custom: "" });
    expect(parseAppearance("dark")).toMatchObject({ theme: "system" });
    const bad = parseAppearance({ theme: "neon", accent: "red", density: "COMPACT", sidebar: 1, fontSize: "18", clock: 24, motion: true });
    expect(bad).toEqual({ theme: "system", accent: "", density: "cozy", sidebar: "cozy", fontSize: 15, clock: "12", motion: "system", custom: "" });
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
