// Loading-state screenshots: fake mode with every call 1.5s late (?lag), caught mid-load.
// node scripts/loading.mjs -> artifacts/loading/<state>-<width>-<theme>.png. Starts Vite on 5195 and stops it.
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { createServer } from "vite";

const OUT = new URL("../../artifacts/loading/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const server = await createServer({ server: { host: "127.0.0.1", port: 5195, strictPort: true }, logLevel: "error" });
await server.listen();
const browser = await chromium.launch();
const mid = (p) => p.waitForTimeout(700); // past the 200ms skeleton delay, before the 1.5s answer
const drawer = async (p) => {
  if (p.viewportSize().width < 768) await p.getByRole("button", { name: "Open communities and channels" }).click();
};
const states = {
  bans: async (p) => {
    await drawer(p);
    await p.locator(".side-head").click();
    await p.getByRole("menuitem", { name: "Community settings" }).click();
    await p.getByRole("tab", { name: "Bans" }).click();
  },
  channel: async (p) => {
    await drawer(p);
    await p.locator(".chan", { hasText: "design" }).first().click();
  },
  thread: (p) => p.locator(".thread-link").first().click(),
  search: async (p) => {
    const s = p.locator(".chan-search input");
    await s.fill("kiln");
    await s.press("Enter");
  },
  older: async (p) => {
    await drawer(p);
    await p.locator(".chan", { hasText: "show-and-tell" }).first().click();
    await p.locator(".channel .msg").first().waitFor();
    await p.waitForTimeout(300);
    await p.locator(".channel .scroller").evaluate((el) => (el.scrollTop = -el.scrollHeight));
  },
};
for (const [w, h] of [[1280, 860], [390, 844]])
  for (const theme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, colorScheme: theme });
    await ctx.route("http://localhost:8090/**", (r) => r.abort());
    const p = await ctx.newPage();
    p.on("pageerror", (e) => console.error(e.message));
    await p.goto("http://127.0.0.1:5195/?fake=1&quiet=1&lag=1500&big=200", { waitUntil: "domcontentloaded" });
    await p.locator(".skel-set[data-shown=true]").first().waitFor();
    await p.screenshot({ path: `${OUT}connect-${w}-${theme}.png` });
    for (const [name, go] of Object.entries(states)) {
      await p.reload({ waitUntil: "domcontentloaded" });
      await p.locator(".msg").first().waitFor({ timeout: 60_000 });
      await p.waitForTimeout(1600);
      await go(p);
      await mid(p);
      await p.screenshot({ path: `${OUT}${name}-${w}-${theme}.png` });
      console.log(`${OUT}${name}-${w}-${theme}.png`);
    }
    await ctx.close();
  }
await browser.close();
await server.close();
