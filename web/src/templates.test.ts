import { describe, expect, it } from "vitest";
import { TEMPLATES, templateChannels } from "./templates";

describe("community templates (1286)", () => {
  it("offers the five scenarios plus start from scratch", () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual(["team", "community", "product", "gaming", "private", "scratch"]);
  });

  for (const t of TEMPLATES) {
    describe(t.name, () => {
      const chans = templateChannels(t);
      it("uses names the server accepts, each once", () => {
        for (const c of chans) expect(c.name).toMatch(/^[a-z0-9_-]{1,80}$/);
        expect(new Set(chans.map((c) => c.name)).size).toBe(chans.length);
      });
      it("reuses #general as the first channel of its section", () => {
        const sec = t.sections.find(([, cs]) => cs.some((c) => c.name === "general"));
        expect(sec?.[1][0].name).toBe("general");
        expect(chans.filter((c) => c.name === "general")).toHaveLength(1);
      });
      it("posts its welcome where everyone can read it", () => {
        const w = chans.find((c) => c.name === t.welcome);
        expect(w).toBeDefined();
        expect(w?.private).toBeFalsy();
        expect(t.message).toContain("{name}");
      });
      it("keeps topics short and defaults to Slack-style only", () => {
        for (const c of chans) expect(c.topic.length).toBeLessThanOrEqual(60);
        if (!t.optIn) expect(chans.some((c) => c.default)).toBe(false);
        expect(t.description.length).toBeLessThanOrEqual(120);
      });
    });
  }

  it("start from scratch is just #general", () => {
    expect(templateChannels(TEMPLATES.at(-1)!).map((c) => c.name)).toEqual(["general"]);
  });

  it("product template covers the support basics", () => {
    const names = templateChannels(TEMPLATES.find((t) => t.id === "product")!).map((c) => c.name);
    for (const n of ["announcements", "support", "feature-requests", "bug-reports", "changelog"]) expect(names).toContain(n);
  });
});
