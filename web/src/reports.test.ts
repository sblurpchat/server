import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { ChannelSchema, EventSchema, MemberSchema } from "./gen/sblurp/v1/sblurp_pb";
import { applyEvent, emptyCommunity, reportDetail, reportPlace } from "./logic";

describe("reports (1119)", () => {
  const channels = { c1: create(ChannelSchema, { id: "c1", name: "general" }) };
  it("opens a channel the moderator can see, never a DM", () => {
    expect(reportPlace({ dm: false, message: { channelId: "c1" } }, channels)).toEqual({ label: "#general", open: true });
    expect(reportPlace({ dm: true, message: { channelId: "c1" } }, channels)).toEqual({ label: "Direct message", open: false });
    expect(reportPlace({ dm: false, message: { channelId: "secret" } }, channels)).toEqual({ label: "A channel you cannot see", open: false });
  });
  it("names the reporter and the day", () => {
    const now = new Date(2026, 9, 18, 12).getTime();
    const ana = create(MemberSchema, { username: "ana", displayName: "Ana Ruiz" });
    expect(reportDetail(now - 60_000, ana, now)).toBe("Reported today by Ana Ruiz");
    expect(reportDetail(now - 86_400_000, undefined, now)).toBe("Reported yesterday by a former member");
    expect(reportDetail(now - 60_000, ana, now, "Resolved")).toBe("Resolved today by Ana Ruiz");
  });
  it("tracks the open report count from events (1255)", () => {
    const ev = (n: number, seq: bigint) => create(EventSchema, { seq, kind: { case: "openReports", value: n } });
    const c = applyEvent(emptyCommunity("u"), ev(3, 1n), 0, null);
    expect(c.openReports).toBe(3);
    expect(applyEvent(c, ev(0, 2n), 0, null).openReports).toBe(0);
  });
});
