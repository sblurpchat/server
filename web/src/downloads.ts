// The app downloads (ticket 1325). auth keeps a copy (auth/cmd/auth/static/downloads.json, kept equal by
// a test there), so the marketing site, its docs and this settings page show the same platforms and links.
import list from "./downloads.json";

/** One platform's app. An empty url means coming soon. icon is a Simple Icons path. */
export type Download = { id: string; name: string; action: string; url: string; hint: string; icon: string };

export const DOWNLOADS: Download[] = list;

/** The platform an installed app runs on, or "" in a browser. iPadOS says Macintosh, so touch tells it apart. */
export function appPlatform(installed: boolean, ua: string, touch: boolean): string {
  if (!installed) return "";
  if (/iPhone|iPad/.test(ua) || (/Mac/.test(ua) && touch)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Mac/.test(ua)) return "macos";
  if (/Win/.test(ua)) return "windows";
  if (/Linux/.test(ua)) return "linux";
  return "";
}

/** The platform this page runs in as an installed app (Tauri, including dev builds), or "" in a browser. */
export const PLATFORM = appPlatform("__TAURI_INTERNALS__" in globalThis, navigator.userAgent, navigator.maxTouchPoints > 1);

/** The downloads to offer: inside an installed app, every platform but its own. */
export const offered = (all: Download[], here: string) => all.filter((d) => d.id !== here);
