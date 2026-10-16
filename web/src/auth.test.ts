import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const { pkceChallenge, getToken, SignedOutError, AUTH_URL } = await import("./auth");

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
