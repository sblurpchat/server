import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { ChannelKind, ChannelSchema, EventSchema, GetStateResponseSchema, MemberSchema, MessageSchema, NotifyLevel, NotifySettingSchema, TypingEventSchema, type Event } from "./gen/sblurp/v1/sblurp_pb";
import { applyEvent, applySnapshot, blockedRows, emptyCommunity, levelOf, snoozedUntil, snoozeEnd, type Community } from "./logic";

const ev = (seq: bigint, kind: Event["kind"]) => create(EventSchema, { seq, kind });

describe("blocking (1118)", () => {
  it("takes the blocked list from the snapshot and follows the events", () => {
    let c = applySnapshot(emptyCommunity("u"), create(GetStateResponseSchema, { blockedMemberIds: ["bob"], seq: 1n }));
    expect(c.blocked).toEqual(["bob"]);
    c = applyEvent(c, ev(2n, { case: "memberBlocked", value: "eve" }), 0, null);
    c = applyEvent(c, ev(3n, { case: "memberBlocked", value: "eve" }), 0, null);
    expect(c.blocked).toEqual(["bob", "eve"]);
    c = applyEvent(c, ev(4n, { case: "memberUnblocked", value: "bob" }), 0, null);
    expect(c.blocked).toEqual(["eve"]);
  });
  it("lists blocks across communities, naming members who left", () => {
    const a = { ...emptyCommunity("https://a.test"), blocked: ["m1", "gone"], members: { m1: create(MemberSchema, { id: "m1", username: "eve", displayName: "" }) } };
    const b = { ...emptyCommunity("https://b.test", { name: "Night Owls", description: "", iconUrl: "", accentColor: "", memberCount: 1 }), blocked: ["m2"] };
    expect(blockedRows(["https://a.test", "https://b.test"], { "https://a.test": a, "https://b.test": b })).toEqual([
      { url: "https://a.test", id: "m1", name: "eve", community: "a.test" },
      { url: "https://a.test", id: "gone", name: "Former member", community: "a.test" },
      { url: "https://b.test", id: "m2", name: "Former member", community: "Night Owls" },
    ]);
  });
});

describe("muting (1293) and blocking skip unread, mentions and typing (1244)", () => {
  it("follows mute events and leaves quiet members out", () => {
    const channels = { c1: create(ChannelSchema, { id: "c1", kind: ChannelKind.TEXT }) };
    let c: Community = { ...applySnapshot(emptyCommunity("u"), create(GetStateResponseSchema, { me: create(MemberSchema, { id: "me" }), mutedMemberIds: ["bob"], blockedMemberIds: ["eve"], seq: 1n })), channels };
    expect(c.muted).toEqual(["bob"]);
    const msg = (seq: bigint, authorId: string) => ev(seq, { case: "messageCreated", value: create(MessageSchema, { id: `m${seq}`, channelId: "c1", authorId, text: "hi <@me>", seq }) });
    const typing = (memberId: string) => ev(0n, { case: "typing", value: create(TypingEventSchema, { channelId: "c1", memberId }) });
    for (const [i, who] of ["bob", "eve"].entries()) {
      c = applyEvent(c, msg(BigInt(i + 2), who), 0, null);
      c = applyEvent(c, typing(who), 0, null);
    }
    expect(c.reads.c1?.unreadCount ?? 0).toBe(0);
    expect(c.reads.c1?.mentionCount ?? 0).toBe(0);
    expect(c.typing.c1 ?? {}).toEqual({});
    c = applyEvent(c, ev(4n, { case: "memberUnmuted", value: "bob" }), 0, null);
    c = applyEvent(c, ev(5n, { case: "memberMuted", value: "cat" }), 0, null);
    expect(c.muted).toEqual(["cat"]);
    c = applyEvent(c, msg(6n, "bob"), 0, null);
    c = applyEvent(c, typing("bob"), 0, null);
    expect([c.reads.c1.unreadCount, c.reads.c1.mentionCount]).toEqual([1, 1]);
    expect(Object.keys(c.typing.c1)).toEqual(["bob"]);
  });
});

describe("notification levels (1498)", () => {
  it("follows the snapshot and events, and counts what the level allows", () => {
    const text = create(ChannelSchema, { id: "c1", kind: ChannelKind.TEXT });
    const dm = create(ChannelSchema, { id: "d1", kind: ChannelKind.DM });
    const snap = create(GetStateResponseSchema, {
      me: create(MemberSchema, { id: "me" }),
      notifyLevels: [create(NotifySettingSchema, { channelId: "", level: NotifyLevel.MENTIONS })],
      seq: 1n,
    });
    let c: Community = { ...applySnapshot(emptyCommunity("u"), snap), channels: { c1: text, d1: dm } };
    expect(levelOf(c.levels, text)).toBe(NotifyLevel.MENTIONS);
    expect(levelOf(c.levels, dm)).toBe(NotifyLevel.ALL); // DMs skip the community level
    const msg = (seq: bigint, channelId: string, t: string) => ev(seq, { case: "messageCreated", value: create(MessageSchema, { id: `m${seq}`, channelId, authorId: "bob", text: t, seq }) });
    c = applyEvent(c, msg(2n, "c1", "plain"), 0, null);
    c = applyEvent(c, msg(3n, "c1", "hi <@me>"), 0, null);
    expect([c.reads.c1.unreadCount, c.reads.c1.mentionCount]).toEqual([0, 1]);
    const set = (seq: bigint, channelId: string, level: NotifyLevel) => ev(seq, { case: "notifyLevel", value: create(NotifySettingSchema, { channelId, level }) });
    c = applyEvent(c, set(4n, "c1", NotifyLevel.NOTHING), 0, null);
    c = applyEvent(c, msg(5n, "c1", "hi again <@me>"), 0, null);
    expect(c.reads.c1.mentionCount).toBe(0);
    c = applyEvent(c, set(6n, "c1", NotifyLevel.UNSPECIFIED), 0, null);
    c = applyEvent(c, set(7n, "", NotifyLevel.UNSPECIFIED), 0, null);
    expect(c.levels).toEqual({});
    c = applyEvent(c, msg(8n, "c1", "plain"), 0, null);
    expect(c.reads.c1.unreadCount).toBe(1);
  });
});

describe("notification follow-ups (1515)", () => {
  const dm = create(ChannelSchema, { id: "d1", kind: ChannelKind.DM });
  it("a community set to Nothing quiets DMs unless the DM has its own level", () => {
    expect(levelOf({ "": NotifyLevel.NOTHING }, dm)).toBe(NotifyLevel.NOTHING);
    expect(levelOf({ "": NotifyLevel.NOTHING, d1: NotifyLevel.ALL }, dm)).toBe(NotifyLevel.ALL);
    expect(levelOf({ "": NotifyLevel.MENTIONS }, dm)).toBe(NotifyLevel.ALL);
    let c: Community = { ...emptyCommunity("u"), me: create(MemberSchema, { id: "me" }), channels: { d1: dm }, levels: { "": NotifyLevel.NOTHING } };
    c = applyEvent(c, ev(2n, { case: "messageCreated", value: create(MessageSchema, { id: "m2", channelId: "d1", authorId: "bob", text: "hi", seq: 2n }) }), 0, null);
    expect([c.reads.d1.unreadCount, c.reads.d1.mentionCount]).toEqual([0, 0]);
  });
  it("snooze ends in 1 or 8 hours, or tomorrow at 8:00 local time", () => {
    const now = new Date(2026, 9, 26, 23, 30);
    expect(snoozeEnd("1h", now)).toBe(new Date(2026, 9, 27, 0, 30).getTime());
    expect(snoozeEnd("8h", now)).toBe(new Date(2026, 9, 27, 7, 30).getTime());
    expect(snoozeEnd("tomorrow", now)).toBe(new Date(2026, 9, 27, 8, 0).getTime());
    expect(snoozeEnd("tomorrow", new Date(2026, 11, 31, 0, 10))).toBe(new Date(2027, 0, 1, 8, 0).getTime());
  });
  it("follows the snapshot and events, and shows the latest running snooze", () => {
    let c = applySnapshot(emptyCommunity("u"), create(GetStateResponseSchema, { me: create(MemberSchema, { id: "me" }), snoozeUntil: 5000n, seq: 1n }));
    expect(c.snoozeUntil).toBe(5000);
    c = applyEvent(c, ev(2n, { case: "snoozeUntil", value: 9000n }), 0, null);
    const other = { ...emptyCommunity("v"), snoozeUntil: 7000 };
    expect(snoozedUntil([c, other], 1000)).toBe(9000);
    expect(snoozedUntil([c, other], 9000)).toBe(0);
    expect(snoozedUntil([], 0)).toBe(0);
  });
});
