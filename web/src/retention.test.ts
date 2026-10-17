import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { MessageSchema } from "./gen/sblurp/v1/sblurp_pb";
import { isExpired, retained } from "./logic";

const NOW = Date.UTC(2026, 9, 16, 12);
const DAY = 86_400_000;
const at = (id: string, daysAgo: number, seq = 1n) => create(MessageSchema, { id, seq, createdAtMs: BigInt(NOW - daysAgo * DAY) });

describe("retention (1072)", () => {
  const items = [at("old", 31), at("edge", 30), at("new", 2), at("unsent", 40, 0n)];
  it("keeps everything when retention is off", () => {
    expect(retained(items, 0, NOW)).toBe(items);
  });
  it("drops sent messages older than the cutoff", () => {
    expect(retained(items, 30, NOW).map((m) => m.id)).toEqual(["edge", "new", "unsent"]);
    expect(retained(items, 1, NOW).map((m) => m.id)).toEqual(["unsent"]);
  });
  it("marks the oldest loaded message expired so paging stops", () => {
    expect(isExpired(items[0], 30, NOW)).toBe(true);
    expect(isExpired(items[2], 30, NOW)).toBe(false);
    expect(isExpired(items[0], 0, NOW)).toBe(false);
  });
});
