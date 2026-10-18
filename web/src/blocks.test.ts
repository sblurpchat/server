import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { ChannelKind, ChannelSchema, EventSchema, GetStateResponseSchema, MemberSchema, MessageSchema, TypingEventSchema, type Event } from "./gen/sblurp/v1/sblurp_pb";
import { applyEvent, applySnapshot, blockedRows, emptyCommunity, type Community } from "./logic";

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
