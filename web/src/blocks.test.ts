import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { EventSchema, GetStateResponseSchema, MemberSchema, type Event } from "./gen/sblurp/v1/sblurp_pb";
import { applyEvent, applySnapshot, blockedRows, emptyCommunity } from "./logic";

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
