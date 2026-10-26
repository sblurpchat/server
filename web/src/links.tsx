// Links in the iOS and Android apps (apps/). WKWebView drops a target=_blank link (it asks for a
// new web view, which wry does not make on iOS), so a click on one becomes a navigation in place
// (ticket 1362). Rust catches it and opens the link in a sheet over the app (SFSafariViewController,
// a Custom Tab). With "Open links in the browser" on, the navigation is sblurp-browser:<link>, and
// Rust opens the system browser instead (browser_link in apps/src-tauri/src/lib.rs, ticket 1363).
import { useState } from "react";
import { AUTH_URL } from "./auth";
import { appPlatform } from "./downloads";
import { shareToDeepLink } from "./logic";

const KEY = "sblurp.linksInBrowser";

/** True in the iOS and Android apps, where a link can open in a sheet. */
export const sheetApp = ["ios", "android"].includes(appPlatform("__TAURI_INTERNALS__" in globalThis, navigator.userAgent, navigator.maxTouchPoints > 1));

export function linksInBrowser(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setLinksInBrowser(on: boolean) {
  try {
    if (on) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    // storage blocked: links keep opening in the sheet
  }
}

if (sheetApp) {
  document.addEventListener("click", (e) => {
    const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>("a[href]") : null;
    if (!a || e.defaultPrevented || a.target !== "_blank" || !/^https?:$/.test(a.protocol) || shareToDeepLink(a.href, AUTH_URL)) return;
    e.preventDefault();
    location.href = linksInBrowser() ? `sblurp-browser:${a.href}` : a.href;
  });
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
