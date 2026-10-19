import { describe, expect, it } from "vitest";
import { appPlatform, DOWNLOADS, offered } from "./downloads";

describe("downloads", () => {
  it("lists every platform, with Android coming soon", () => {
    expect(DOWNLOADS.map((d) => d.id)).toEqual(["macos", "windows", "linux", "ios", "android"]);
    expect(DOWNLOADS.find((d) => d.id === "android")).toMatchObject({ url: "", action: "Coming soon" });
    expect(DOWNLOADS.find((d) => d.id === "ios")?.url).toBe("https://testflight.apple.com/join/sXkCrZ3z");
  });
  it("finds the installed app's platform", () => {
    const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
    expect(appPlatform(false, mac, false)).toBe("");
    expect(appPlatform(true, mac, false)).toBe("macos");
    expect(appPlatform(true, mac, true)).toBe("ios");
    expect(appPlatform(true, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", true)).toBe("ios");
    expect(appPlatform(true, "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36", true)).toBe("android");
    expect(appPlatform(true, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", false)).toBe("windows");
    expect(appPlatform(true, "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15", false)).toBe("linux");
  });
  it("leaves out only the installed app's own platform", () => {
    expect(offered(DOWNLOADS, "").length).toBe(5);
    expect(offered(DOWNLOADS, "windows").map((d) => d.id)).toEqual(["macos", "linux", "ios", "android"]);
  });
});
