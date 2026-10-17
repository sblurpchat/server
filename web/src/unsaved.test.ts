import { describe, expect, it } from "vitest";
import { unsavedBlock } from "./logic";

describe("unsaved settings (1183)", () => {
  it("lets you leave when nothing is unsaved", () => {
    expect(unsavedBlock([], "about", null)).toBeNull();
    expect(unsavedBlock([], "about", "emoji")).toBeNull();
  });
  it("blocks closing and switching tabs, pointing at the first unsaved form", () => {
    expect(unsavedBlock(["about-form", "retention-form"], "about", null)).toBe("about-form");
    expect(unsavedBlock(["retention-form"], "about", "members")).toBe("retention-form");
  });
  it("does not block a click on the tab you are on", () => {
    expect(unsavedBlock(["retention-form"], "about", "about")).toBeNull();
  });
});
