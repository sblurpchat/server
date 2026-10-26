// Links in the iOS and Android apps (apps/). WKWebView drops a target=_blank link (it asks for a
// new web view, which wry does not make on iOS), so a click on one becomes a navigation in place
// (ticket 1362). Rust catches it and opens the link in a sheet over the app (SFSafariViewController,
// a Custom Tab). With "Open links in the browser" on, the navigation is sblurp-browser:<link>, and
// Rust opens the system browser instead (browser_link in apps/src-tauri/src/lib.rs, ticket 1363).
//
// Every target=_blank web link off the app, auth and joined community hosts first asks in a
// "Leaving Sblurp" dialog, with the host in bold so a look-alike shows (1447). One click handler
// covers messages, link previews and the rest.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AUTH_URL } from "./auth";
import { PLATFORM } from "./downloads";
import { hostOf, leavingParts, shareToDeepLink } from "./logic";
import { get } from "./store";
import { readKey, writeKey } from "./storage";
import { AUTOFOCUS, Dialog, Icon } from "./ui";

const KEY = "sblurp.linksInBrowser";

/** True in the iOS and Android apps, where a link can open in a sheet. */
export const sheetApp = ["ios", "android"].includes(PLATFORM);

export const linksInBrowser = () => readKey(KEY) === "1";
export const setLinksInBrowser = (on: boolean) => writeKey(KEY, on ? "1" : null);

const TRUST = "sblurp.trustedHosts";

function trusted(): string[] {
  try {
    return JSON.parse(readKey(TRUST) ?? "[]");
  } catch {
    return [];
  }
}

const trust = (host: string) => writeKey(TRUST, JSON.stringify([...trusted(), host]));

function open(href: string) {
  if (sheetApp) location.href = linksInBrowser() ? `sblurp-browser:${href}` : href;
  // The desktop app opens a new window in the system browser (on_new_window in apps/src-tauri/src/lib.rs).
  else window.open(href, "_blank", "noopener,noreferrer");
}

const root = document.createElement("div");
document.body.append(root);
const leave = createRoot(root);

document.addEventListener("click", (e) => {
  const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>("a[href]") : null;
  if (!a || e.defaultPrevented || a.target !== "_blank" || !/^https?:$/.test(a.protocol) || shareToDeepLink(a.href, AUTH_URL)) return;
  const safe = [location.host, hostOf(AUTH_URL), ...Object.keys(get().cs).map(hostOf), ...trusted()];
  const parts = leavingParts(a.href, safe);
  if (!parts && !sheetApp) return; // the browser opens it in a new tab
  e.preventDefault();
  if (!parts) return open(a.href);
  const href = a.href;
  leave.render(<LeaveDialog key={Date.now()} href={href} parts={parts} onDone={() => leave.render(null)} />);
});

function LeaveDialog({ href, parts: [pre, host, post], onDone }: { href: string; parts: [string, string, string]; onDone: () => void }) {
  const [remember, setRemember] = useState(false);
  return (
    <Dialog label="Leaving Sblurp" className="confirm leaving-link" onClose={onDone}>
      <h2>Leaving Sblurp</h2>
      <p className="muted">This link goes to a website outside Sblurp. Check that the address is the one you expect.</p>
      <p className="leaving-url">
        <Icon name="external" size={16} />
        <span>
          {pre}
          <b>{host}</b>
          {post}
        </span>
      </p>
      <label className="leaving-trust">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        Trust {host} from now on
      </label>
      <div className="row-end">
        <button className="btn ghost" onClick={onDone}>
          Cancel
        </button>
        <button
          className="btn primary"
          autoFocus={AUTOFOCUS}
          onClick={() => {
            if (remember) trust(host);
            open(href);
            onDone();
          }}
        >
          Open
        </button>
      </div>
    </Dialog>
  );
}

/** The Settings section for it, only where a sheet is possible. */
export function LinksSetting() {
  const [on, setOn] = useState(linksInBrowser);
  if (!sheetApp) return null;
  return (
    <section>
      <h3>
        Links <small className="scope">On this device</small>
      </h3>
      <label className="toggle-row">
        <span>
          <b>Open links in the browser</b>
          <small>When off, links open inside Sblurp.</small>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          checked={on}
          onChange={(e) => {
            setLinksInBrowser(e.target.checked);
            setOn(e.target.checked);
          }}
        />
      </label>
    </section>
  );
}
