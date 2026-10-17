import { describe, expect, it } from "vitest";
import { shrinkPlan } from "./avatar";

describe("shrinkPlan", () => {
  it("leaves small images alone", () => {
    expect(shrinkPlan(512, 300, "image/gif")).toBeNull();
    expect(shrinkPlan(64, 64, "image/png")).toBeNull();
  });
  it("fits the longer side to 512 and keeps the aspect", () => {
    expect(shrinkPlan(4032, 3024, "image/jpeg")).toEqual({ w: 512, h: 384, type: "image/jpeg" });
    expect(shrinkPlan(1000, 2000, "image/png")).toEqual({ w: 256, h: 512, type: "image/png" });
    expect(shrinkPlan(10000, 10, "image/webp")).toEqual({ w: 512, h: 1, type: "image/png" });
  });
  it("keeps transparency as PNG and turns HEIC into JPEG", () => {
    expect(shrinkPlan(900, 900, "image/webp")?.type).toBe("image/png");
    expect(shrinkPlan(900, 900, "image/heic")?.type).toBe("image/jpeg");
  });
});
