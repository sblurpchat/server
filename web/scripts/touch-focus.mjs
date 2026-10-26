// On a touch phone no dialog or sheet focuses a field or button when it opens (1430): node scripts/touch-focus.mjs
// Starts its own Vite server on 5197. The switcher (Cmd-K) keeps its field focused on purpose.
import { webkit } from "playwright";
import { createServer } from "vite";

const server = await createServer({ server: { host: "127.0.0.1", port: 5197, strictPort: true }, logLevel: "error" });
await server.listen();
const browser = await webkit.launch();
const ctx = await browser.newContext({ viewport: { width: 402, height: 874 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
await ctx.route("http://localhost:8090/**", (r) => r.abort());
const page = await ctx.newPage();
await page.goto("http://127.0.0.1:5197/?fake=1&quiet=1");
await page.locator(".msg").first().waitFor();
const focused = () => page.evaluate(() => {
  const a = document.activeElement;
  return `${a.tagName.toLowerCase()}${a.className ? "." + String(a.className).split(" ")[0] : ""}`;
});
const bad = (f) => /^(input|textarea|button|select)/.test(f);
let failed = false;
const check = (name, f) => {
  if (bad(f)) failed = true;
  console.log(`${bad(f) ? "FAIL" : "ok  "} ${name}: ${f}`);
};
const modals = await page.evaluate(async () => {
  const s = (await import("/src/store.ts")).get();
  const c = s.cs[s.url];
  const other = Object.values(c?.members ?? {}).find((m) => m.id !== c.me?.id);
  const msg = c?.lists[s.channelId]?.items?.find((m) => m.authorId !== c.me?.id);
  return [
    { t: "settings" }, { t: "add" }, { t: "info" }, { t: "invite" }, { t: "leave" }, { t: "channel" }, { t: "community" },
    { t: "newdm" }, { t: "browse" }, { t: "profile" }, { t: "setup" },
    ...(other ? [{ t: "remove", url: s.url, memberId: other.id, ban: true }, { t: "block", url: s.url, memberId: other.id }] : []),
    ...(msg ? [{ t: "delete", id: msg.id }] : []),
  ];
});
for (const m of modals) {
  await page.evaluate(async (m) => (await import("/src/store.ts")).set({ modal: m }), m);
  if (!(await page.locator("dialog[open]").first().isVisible({ timeout: 2000 }).catch(() => false))) continue;
  await page.waitForTimeout(100);
  check(`modal ${m.t}`, await focused());
  await page.evaluate(async () => (await import("/src/store.ts")).set({ modal: null }));
  await page.waitForTimeout(250);
}
// A settings sub page, then back to the list.
await page.evaluate(async () => (await import("/src/store.ts")).set({ modal: { t: "settings" } }));
await page.locator(".settings [data-page]").first().tap();
await page.waitForTimeout(100);
check("settings sub page", await focused());
await page.locator(".settings-back").tap();
await page.waitForTimeout(100);
check("settings back", await focused());
await page.evaluate(async () => (await import("/src/store.ts")).set({ modal: null }));
await page.waitForTimeout(250);
// The profile sheet, as from a tap on an author.
await page.evaluate(async () => {
  const { get, set } = await import("/src/store.ts");
  const s = get();
  const c = s.cs[s.url];
  const other = Object.values(c.members).find((m) => m.id !== c.me?.id);
  set({ popover: { url: s.url, memberId: other.id, rect: new DOMRect(20, 300, 30, 30) } });
});
await page.waitForTimeout(150);
check("profile sheet", await focused());
await page.evaluate(async () => (await import("/src/store.ts")).set({ popover: null }));
// The drawer from the menu button.
await page.waitForTimeout(250);
const menu = page.locator(".menu-btn").first();
if (await menu.isVisible()) {
  await menu.tap();
  await page.waitForTimeout(250);
  check("drawer", await focused());
}
await browser.close();
await server.close();
process.exit(failed ? 1 : 0);
