// Notifications in the iOS app (tickets 0300, 1428). The webview has no IPC, so it talks to Rust
// (apps/src-tauri/src/lib.rs) by navigating to sblurp-push:status, :register or :settings. Rust
// answers with a sblurp-push-status event (the iOS permission) and a sblurp-push event (the APNs
// device token), which goes to sblurp.chat. Community tokens then carry a push handle.
//
// The iOS prompt can be shown only once, so it never fires on start: at a moment that makes sense
// (opening a DM, not right after sign-in, 1500) a sheet explains it first, and only its Enable shows the prompt.
import { AUTH_URL, forgetCommunityTokens, getToken, hasSession } from "./auth";
import { PLATFORM } from "./downloads";
import { readKey as get, writeKey as put } from "./storage";

export const PUSH_KEY = "sblurp.pushDevice"; // the registered device token
const ASKED_KEY = "sblurp.pushAskedAt"; // when Not now was tapped
const OFF_KEY = "sblurp.pushOff"; // turned off in Settings
export const ASK_AGAIN_MS = 7 * 24 * 3600 * 1000;

export type PushStatus = "unknown" | "notDetermined" | "denied" | "authorized";

/** Whether to show the sheet: iOS has not asked yet, and Not now was not tapped in the last week. */
export function shouldAsk(status: PushStatus, askedAt: number, now: number): boolean {
  return status === "notDetermined" && !(now - askedAt < ASK_AGAIN_MS);
}

export const iosApp = () => PLATFORM === "ios";

const post = async (path: string, body: object) =>
  fetch(`${AUTH_URL}/api/push/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await getToken(AUTH_URL)}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const native = (what: "status" | "register" | "settings") => (location.href = `sblurp-push:${what}`);

// A tiny store for the sheet and the Settings row (useSyncExternalStore).
let state = { status: "unknown" as PushStatus, asking: false, on: false };
let wanted = false; // a moment to ask came before the status did
const subs = new Set<() => void>();
const update = (p: Partial<typeof state>) => {
  state = { ...state, ...p };
  subs.forEach((f) => f());
};
export const pushState = () => state;
export const onPush = (f: () => void) => (subs.add(f), () => subs.delete(f));

/** A good moment to ask: shows the sheet if iOS has not asked yet and Not now has cooled off. */
export function offerPush() {
  if (!iosApp() || !hasSession()) return;
  wanted = true;
  if (shouldAsk(state.status, Number(get(ASKED_KEY) ?? 0), Date.now())) update({ asking: true });
}

/** The sheet's Enable: shows the iOS prompt. */
export function enablePush() {
  update({ asking: false });
  setPush(true);
}

/** The sheet's Not now: no sheet again for a week. */
export function notNowPush() {
  wanted = false;
  update({ asking: false });
  put(ASKED_KEY, String(Date.now()));
}

/** The Settings switch. Denied by iOS: open the iOS Settings app, the only place to allow it. */
export function setPush(on: boolean) {
  put(OFF_KEY, on ? null : "1");
  if (!on) {
    update({ on: false });
    return void removeDevice();
  }
  native(state.status === "denied" ? "settings" : "register");
}

async function removeDevice() {
  const token = get(PUSH_KEY);
  if (!token) return;
  put(PUSH_KEY, null);
  await post("devices/remove", { token }).catch(() => {});
}

async function registerDevice(d: { token: string; sandbox: boolean }) {
  if (get(OFF_KEY)) return;
  const res = await post("devices", { platform: "apns", token: d.token, sandbox: d.sandbox, preview: false });
  if (!res.ok) return;
  const first = get(PUSH_KEY) !== d.token;
  put(PUSH_KEY, d.token);
  update({ on: true });
  // Fresh community tokens carry the handle, so servers learn it now instead of in 15 minutes.
  if (first) forgetCommunityTokens();
}

function onStatus(status: PushStatus) {
  const was = state.status;
  update({ status, on: status === "authorized" && !get(OFF_KEY) && !!get(PUSH_KEY) });
  // Allowed already: register quietly on every start (keeps the device from expiring after 60
  // days) and when it was just allowed in iOS Settings. No prompt shows for an allowed app.
  if (status === "authorized" && was !== "authorized" && hasSession() && !get(OFF_KEY)) native("register");
  if (wanted && shouldAsk(status, Number(get(ASKED_KEY) ?? 0), Date.now())) update({ asking: true });
}

if (iosApp()) {
  addEventListener("sblurp-push", (e) => void registerDevice((e as CustomEvent).detail).catch(() => {}));
  addEventListener("sblurp-push-status", (e) => onStatus((e as CustomEvent).detail));
  // Ask again on return, since the permission may have changed in iOS Settings.
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && native("status"));
  if (document.readyState === "complete") setTimeout(() => native("status"));
  else addEventListener("load", () => native("status"));
}
