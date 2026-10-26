import { describe, expect, it, vi } from "vitest";

// The iOS app: Tauri, an iPhone, and a page with no DOM but events.
const store = new Map<string, string>([["sblurp.refreshToken", "rt"]]);
const page = new EventTarget();
const loc = { href: "", hostname: "localhost", origin: "http://localhost" };
const fetches: string[] = [];
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});
vi.stubGlobal("__TAURI_INTERNALS__", {});
vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", maxTouchPoints: 5 });
vi.stubGlobal("location", loc);
vi.stubGlobal("document", { readyState: "complete", visibilityState: "visible", addEventListener: () => {} });
vi.stubGlobal("addEventListener", page.addEventListener.bind(page));
vi.stubGlobal("fetch", async (u: string, init: { body: string }) => {
  fetches.push(`${new URL(u).pathname} ${init.body}`);
  return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 900 }));
});

const { shouldAsk, ASK_AGAIN_MS, offerPush, enablePush, notNowPush, setPush, pushState } = await import("./push");
const status = (s: string) => page.dispatchEvent(new CustomEvent("sblurp-push-status", { detail: s }));
const token = "ab".repeat(32);

describe("shouldAsk", () => {
  it("asks only before iOS has asked, and not for a week after Not now", () => {
    expect(shouldAsk("notDetermined", 0, 1e12)).toBe(true);
    expect(shouldAsk("unknown", 0, 1e12)).toBe(false);
    expect(shouldAsk("denied", 0, 1e12)).toBe(false);
    expect(shouldAsk("authorized", 0, 1e12)).toBe(false);
    expect(shouldAsk("notDetermined", 1e12, 1e12 + ASK_AGAIN_MS - 1)).toBe(false);
    expect(shouldAsk("notDetermined", 1e12, 1e12 + ASK_AGAIN_MS)).toBe(true);
  });
});

describe("the iOS notification flow", () => {
  it("never prompts on start, asks with the sheet at a moment, and only Enable prompts", async () => {
    await new Promise((r) => setTimeout(r));
    expect(loc.href).toBe("sblurp-push:status"); // start only reads the permission
    loc.href = "";
    offerPush(); // opened a DM before the status came
    expect(pushState().asking).toBe(false);
    status("notDetermined");
    expect(pushState().asking).toBe(true);
    expect(loc.href).toBe(""); // the sheet, not the iOS prompt

    notNowPush();
    expect(pushState().asking).toBe(false);
    offerPush(); // opening a DM right after
    expect(pushState().asking).toBe(false);

    store.delete("sblurp.pushAskedAt"); // a week later
    offerPush();
    expect(pushState().asking).toBe(true);
    enablePush();
    expect(pushState().asking).toBe(false);
    expect(loc.href).toBe("sblurp-push:register");

    page.dispatchEvent(new CustomEvent("sblurp-push", { detail: { token, sandbox: true } }));
    await vi.waitFor(() => expect(store.get("sblurp.pushDevice")).toBe(token));
    expect(fetches.at(-1)).toBe(`/api/push/devices {"platform":"apns","token":"${token}","sandbox":true,"preview":false}`);
    status("authorized");
    expect(pushState().on).toBe(true);
  });

  it("turns off in Settings by removing the device, and opens iOS Settings when denied", async () => {
    setPush(false);
    await vi.waitFor(() => expect(fetches.at(-1)).toBe(`/api/push/devices/remove {"token":"${token}"}`));
    expect(pushState().on).toBe(false);
    expect(store.has("sblurp.pushDevice")).toBe(false);
    // Off stays off: a token arriving now is not registered.
    const n = fetches.length;
    page.dispatchEvent(new CustomEvent("sblurp-push", { detail: { token, sandbox: true } }));
    await new Promise((r) => setTimeout(r, 10));
    expect(fetches).toHaveLength(n);

    status("denied");
    loc.href = "";
    setPush(true);
    expect(loc.href).toBe("sblurp-push:settings");
    status("authorized"); // allowed in iOS Settings, back in the app
    expect(loc.href).toBe("sblurp-push:register");
  });
});
