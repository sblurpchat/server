// Login against sblurp.chat (Authorization Code + PKCE) and per-community access tokens.
import { tailnetUrl, tokenFresh } from "./logic";

export const AUTH_URL: string = import.meta.env.VITE_AUTH_URL ?? "http://localhost:8081";
// Dev pages served over tailscale serve (the iOS dev app on a phone, ticket 1336) reach the dev
// servers through the tailnet. Every fetch goes through here, so one patch covers them all.
const tailnet = import.meta.env.DEV && globalThis.location?.hostname.endsWith(".ts.net") ? location.hostname : "";
export const reach = (u: string) => (tailnet ? tailnetUrl(u, tailnet) : u);
if (tailnet) {
  const f = globalThis.fetch;
  globalThis.fetch = (i, o) => f(i instanceof Request ? new Request(reach(i.url), i) : reach(String(i)), o);
}
const CLIENT_ID = "sblurp-web";
const RT_KEY = "sblurp.refreshToken";
// Set by signOut until a sign-in succeeds: the next sign-in sends prompt=login, so sblurp.chat asks
// for the password even if its browser session survived, and another account can sign in (ticket 1311).
const REAUTH_KEY = "sblurp.reauth";
// The packaged desktop and mobile apps (apps/) sign in through the system browser, which returns
// to the app on this custom scheme (RFC 8252). The dev app loads Vite and signs in like the browser.
export const nativeApp = () => "__TAURI_INTERNALS__" in globalThis && !import.meta.env.DEV;
const redirectUri = () => (nativeApp() ? "sblurp://auth/callback" : `${location.origin}/auth/callback`);

export class SignedOutError extends Error {
  constructor() {
    super("Signed out");
  }
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

export function authorizeUrl(challenge: string, state: string, signup: boolean): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  if (!signup && localStorage.getItem(REAUTH_KEY)) q.set("prompt", "login");
  const path = `/oauth/authorize?${q}`;
  // Signup is a separate page that continues to the authorize step afterwards.
  return signup ? `${AUTH_URL}/signup?${new URLSearchParams({ next: path })}` : AUTH_URL + path;
}

// PKCE verifiers live in localStorage keyed by state, so the login can finish in another tab
// (the email confirmation link opens one). Each lasts 10 minutes and is deleted once used.
const PKCE_KEY = "sblurp.pkce";
const PKCE_TTL = 10 * 60_000;
type Pending = Record<string, { verifier: string; exp: number }>;
function pending(now: number): Pending {
  let all: Pending = {};
  try {
    all = JSON.parse(localStorage.getItem(PKCE_KEY) ?? "{}") ?? {};
  } catch {}
  return Object.fromEntries(Object.entries(all).filter(([, p]) => p?.exp > now && typeof p.verifier === "string"));
}
export function savePkce(state: string, verifier: string, now = Date.now()) {
  localStorage.setItem(PKCE_KEY, JSON.stringify({ ...pending(now), [state]: { verifier, exp: now + PKCE_TTL } }));
}
/** The verifier saved for exactly this state, removed so it can't be used twice. */
export function takePkce(state: string, now = Date.now()): string | null {
  const all = pending(now);
  const hit = Object.hasOwn(all, state) ? all[state].verifier : null;
  delete all[state];
  localStorage.setItem(PKCE_KEY, JSON.stringify(all));
  return hit;
}

export async function startLogin(signup = false) {
  const verifier = randomToken();
  const state = randomToken();
  savePkce(state, verifier);
  location.assign(reach(authorizeUrl(await pkceChallenge(verifier), state, signup)));
}

export const hasSession = () => !!localStorage.getItem(RT_KEY);

const cache = new Map<string, { token: string; exp: number }>();
const inflight = new Map<string, Promise<string>>();

async function tokenRequest(body: URLSearchParams): Promise<string> {
  body.set("client_id", CLIENT_ID);
  const res = await fetch(`${AUTH_URL}/oauth/token`, { method: "POST", body });
  const j = await res.json().catch(() => ({}));
  // invalid_grant: the refresh token (or code) is used, expired or revoked. Anything else, like
  // invalid_target for an audience the auth server refuses, is not a reason to sign out.
  if (j.error === "invalid_grant") throw new SignedOutError();
  if (!res.ok) throw new Error(j.error_description ?? j.error ?? `sblurp.chat returned ${res.status}`);
  localStorage.setItem(RT_KEY, j.refresh_token);
  const aud = body.get("audience") ?? AUTH_URL;
  cache.set(aud, { token: j.access_token, exp: Date.now() + (j.expires_in ?? 900) * 1000 });
  return j.access_token;
}

/** Called on /auth/callback. Returns true when signed in. */
export async function finishLogin(params: URLSearchParams): Promise<boolean> {
  const verifier = takePkce(params.get("state") ?? "");
  const code = params.get("code");
  // iss guards against a code from a different authorization server (RFC 9207).
  if (!verifier || !code || params.get("iss")?.replace(/\/+$/, "") !== AUTH_URL.replace(/\/+$/, "")) return false;
  await tokenRequest(new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri(), code_verifier: verifier }));
  localStorage.removeItem(REAUTH_KEY);
  return true;
}

// Refresh tokens rotate on every use, so refreshes must never overlap: not across audiences in
// this tab, and not across tabs. The Web Lock serializes both; the refresh token is re-read from
// localStorage inside the lock so a rotation done by another tab is seen.
let tail: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  if (globalThis.navigator?.locks) return navigator.locks.request("sblurp-refresh", fn);
  const p = tail.then(fn, fn);
  tail = p.catch(() => {});
  return p;
}

/** Access token for one audience (a community base URL, or AUTH_URL for the account API). */
export function getToken(aud: string): Promise<string> {
  const c = cache.get(aud);
  if (c && tokenFresh(c.exp, Date.now())) return Promise.resolve(c.token);
  let p = inflight.get(aud);
  if (!p) {
    p = withLock(async () => {
      const again = cache.get(aud);
      if (again && tokenFresh(again.exp, Date.now())) return again.token;
      const rt = localStorage.getItem(RT_KEY);
      if (!rt) throw new SignedOutError();
      const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt });
      if (aud !== AUTH_URL) body.set("audience", aud);
      try {
        return await tokenRequest(body);
      } catch (e) {
        if (e instanceof SignedOutError && localStorage.getItem(RT_KEY) === rt) localStorage.removeItem(RT_KEY);
        throw e;
      }
    }).finally(() => inflight.delete(aud));
    inflight.set(aud, p);
  }
  return p;
}

export interface Profile {
  username: string;
  displayName: string;
  avatarUrl: string;
  bio: string;
}

export async function fetchProfile(): Promise<Profile> {
  const res = await fetch(`${AUTH_URL}/api/me`, { headers: { Authorization: `Bearer ${await getToken(AUTH_URL)}` } });
  if (res.status === 401) throw new SignedOutError();
  if (!res.ok) throw new Error(`sblurp.chat returned ${res.status}`);
  const j = await res.json();
  return {
    username: j.username ?? j.preferred_username ?? "",
    displayName: j.display_name ?? j.displayName ?? j.name ?? j.username ?? "",
    avatarUrl: j.avatar_url ?? j.avatarUrl ?? "",
    bio: j.bio ?? "",
  };
}

/** The account's synced appearance (opaque JSON) and its edit time, or null if none is saved. */
export async function fetchAppearance(): Promise<{ data: unknown; updatedAt: number } | null> {
  const res = await fetch(`${AUTH_URL}/api/appearance`, { headers: { Authorization: `Bearer ${await getToken(AUTH_URL)}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`sblurp.chat returned ${res.status}`);
  const j = await res.json();
  return { data: j.data, updatedAt: Number(j.updated_at) || 0 };
}

export async function saveAppearance(data: unknown, updatedAt: number) {
  const res = await fetch(`${AUTH_URL}/api/appearance`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await getToken(AUTH_URL)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ data, updated_at: updatedAt }),
  });
  if (!res.ok) throw new Error(`sblurp.chat returned ${res.status}`);
}

/** The account's synced community list (base URLs in rail order) and its edit time, or null if none. */
export async function fetchCommunities(): Promise<{ urls: string[]; updatedAt: number } | null> {
  const res = await fetch(`${AUTH_URL}/api/communities`, { headers: { Authorization: `Bearer ${await getToken(AUTH_URL)}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`sblurp.chat returned ${res.status}`);
  const j = await res.json();
  return { urls: Array.isArray(j.urls) ? j.urls.filter((u: unknown) => typeof u === "string") : [], updatedAt: Number(j.updated_at) || 0 };
}

export async function saveCommunities(urls: string[], updatedAt: number) {
  const res = await fetch(`${AUTH_URL}/api/communities`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await getToken(AUTH_URL)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ urls, updated_at: updatedAt }),
  });
  if (!res.ok) throw new Error(`sblurp.chat returned ${res.status}`);
}

export function signOut() {
  const rt = localStorage.getItem(RT_KEY);
  localStorage.removeItem(RT_KEY);
  cache.clear();
  localStorage.setItem(REAUTH_KEY, "1");
  if (rt) {
    fetch(`${AUTH_URL}/oauth/revoke`, {
      method: "POST",
      // end_session also signs out the sblurp.chat browser session that approved this app, so the
      // iOS sign-in sheet, which shares Safari's cookies, does not sign straight back in.
      body: new URLSearchParams({ token: rt, client_id: CLIENT_ID, end_session: "1" }),
    }).catch(() => {});
  }
}
