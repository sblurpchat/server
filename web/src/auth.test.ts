import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const { pkceChallenge, getToken, SignedOutError, AUTH_URL, savePkce, takePkce, authorizeUrl, signOut, finishLogin } = await import("./auth");

describe("PKCE verifier storage", () => {
  beforeEach(() => store.clear());
  it("gives each state only its own verifier, once", () => {
    savePkce("s1", "v1", 0);
    savePkce("s2", "v2", 0);
    expect(takePkce("s3", 1)).toBeNull();
    expect(takePkce("s2", 1)).toBe("v2");
    expect(takePkce("s2", 1)).toBeNull();
    expect(takePkce("s1", 1)).toBe("v1");
    expect(takePkce("__proto__", 1)).toBeNull();
  });
  it("expires after 10 minutes and sweeps old entries", () => {
    savePkce("old", "v0", 0);
    savePkce("new", "v1", 9 * 60_000);
    expect(takePkce("old", 10 * 60_000)).toBeNull();
    expect(store.get("sblurp.pkce")).not.toContain("old");
    expect(takePkce("new", 10 * 60_000)).toBe("v1");
  });
  it("survives junk in storage", () => {
    store.set("sblurp.pkce", "{not json");
    savePkce("s", "v", 0);
    expect(takePkce("s", 1)).toBe("v");
  });
});

describe("PKCE", () => {
  it("matches the RFC 7636 appendix B vector", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("getToken", () => {
  beforeEach(() => store.clear());

  it("serializes refreshes so each rotated refresh token is used once", async () => {
    store.set("sblurp.refreshToken", "rt0");
    const used: string[] = [];
    let active = 0;
    let maxActive = 0;
    vi.stubGlobal("fetch", async (_url: string, init: { body: URLSearchParams }) => {
      active++;
      maxActive = Math.max(maxActive, active);
      const rt = init.body.get("refresh_token")!;
      used.push(`${rt}@${init.body.get("audience")}`);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      const n = Number(rt.slice(2)) + 1;
      return new Response(JSON.stringify({ access_token: `at${n}`, refresh_token: `rt${n}`, expires_in: 900 }));
    });
    const [a, b, a2] = await Promise.all([getToken("https://a.test"), getToken("https://b.test"), getToken("https://a.test")]);
    expect(maxActive).toBe(1);
    expect(used).toEqual(["rt0@https://a.test", "rt1@https://b.test"]);
    expect([a, b, a2]).toEqual(["at1", "at2", "at1"]);
    expect(store.get("sblurp.refreshToken")).toBe("rt2");
    // Cached and fresh: no new request.
    expect(await getToken("https://b.test")).toBe("at2");
    expect(used).toHaveLength(2);
  });

  it("signs out when the refresh token is rejected", async () => {
    store.set("sblurp.refreshToken", "bad");
    vi.stubGlobal("fetch", async () => new Response('{"error":"invalid_grant"}', { status: 400 }));
    await expect(getToken("https://c.test")).rejects.toBeInstanceOf(SignedOutError);
    expect(store.has("sblurp.refreshToken")).toBe(false);
  });

  it("stays signed in when one audience is refused", async () => {
    store.set("sblurp.refreshToken", "good");
    vi.stubGlobal("fetch", async () => new Response('{"error":"invalid_target"}', { status: 400 }));
    const e = await getToken("https://d.test").catch((x) => x);
    expect(e).not.toBeInstanceOf(SignedOutError);
    expect(e.message).toBe("invalid_target");
    expect(store.get("sblurp.refreshToken")).toBe("good");
  });

  it("omits audience for the account API", async () => {
    store.set("sblurp.refreshToken", "rt5");
    let body: URLSearchParams | undefined;
    vi.stubGlobal("fetch", async (_u: string, init: { body: URLSearchParams }) => {
      body = init.body;
      return new Response(JSON.stringify({ access_token: "x", refresh_token: "rt6" }));
    });
    await getToken(AUTH_URL);
    expect(body?.has("audience")).toBe(false);
  });
});

describe("authorizeUrl redirect", () => {
  const redirect = () => new URL(authorizeUrl("ch", "st", false)).searchParams.get("redirect_uri");
  vi.stubGlobal("location", { origin: "https://app.sblurp.chat" });

  it("returns to the page origin in a browser", () => {
    vi.stubEnv("DEV", false);
    expect(redirect()).toBe("https://app.sblurp.chat/auth/callback");
    vi.unstubAllEnvs();
  });

  it("returns to the sblurp: scheme in the packaged app, but not in the dev app", () => {
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      vi.stubEnv("DEV", false);
      expect(redirect()).toBe("sblurp://auth/callback");
      const signup = new URL(authorizeUrl("ch", "st", true));
      expect(new URL(signup.searchParams.get("next")!, AUTH_URL).searchParams.get("redirect_uri")).toBe("sblurp://auth/callback");
      vi.stubEnv("DEV", true);
      expect(redirect()).toBe("https://app.sblurp.chat/auth/callback");
    } finally {
      delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
      vi.unstubAllEnvs();
    }
  });
});

describe("sign out, then sign in again (ticket 1311)", () => {
  beforeEach(() => store.clear());
  const prompt = (signup = false) => {
    const u = new URL(authorizeUrl("ch", "st", signup));
    return signup ? new URL(u.searchParams.get("next")!, AUTH_URL).searchParams.get("prompt") : u.searchParams.get("prompt");
  };

  it("ends the sblurp.chat session and asks for the password on the next sign-in only", async () => {
    expect(prompt()).toBeNull();
    store.set("sblurp.refreshToken", "rt1");
    let body: URLSearchParams | undefined;
    vi.stubGlobal("fetch", async (_u: string, init: { body: URLSearchParams }) => {
      body = init.body;
      return new Response("{}");
    });
    signOut();
    expect(body?.get("token")).toBe("rt1");
    expect(body?.get("end_session")).toBe("1");
    expect(body?.get("client_id")).toBe("sblurp-web");
    expect(prompt()).toBe("login");
    expect(prompt(true)).toBeNull(); // a new account has nothing to re-enter

    // A sign-in that fails keeps the flag.
    vi.stubGlobal("fetch", async () => new Response('{"error":"invalid_grant"}', { status: 400 }));
    savePkce("s1", "v1");
    await finishLogin(new URLSearchParams({ state: "s1", code: "c", iss: AUTH_URL })).catch(() => {});
    expect(prompt()).toBe("login");

    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ access_token: "a", refresh_token: "rt2" })));
    savePkce("s2", "v2");
    expect(await finishLogin(new URLSearchParams({ state: "s2", code: "c", iss: AUTH_URL }))).toBe(true);
    expect(prompt()).toBeNull();
  });
});
