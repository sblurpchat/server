// Ticket screenshots: node scripts/tshots.mjs <prefix> <shot> [w h]
import { chromium } from "playwright";
import { createServer } from "vite";
const [prefix, shot, w = "1280", h = "900"] = process.argv.slice(2);
const OUT = new URL("../../artifacts/tickets/", import.meta.url).pathname;
const server = await createServer({ server: { host: "127.0.0.1", port: 5198, strictPort: true }, logLevel: "error" });
await server.listen();
const browser = await chromium.launch();
const jump = async (p, q) => {
  await p.keyboard.press("Control+k");
  await p.getByPlaceholder("Jump to a channel or person").fill(q);
  await p.keyboard.press("Enter");
  await p.locator(".msg, .chan-start").first().waitFor();
};
const shots = {
  menu: async (p) => {
    await jump(p, "design");
    await p.getByRole("button", { name: "#design options" }).click();
  },
  composer: () => jump(globalThis.page, "help"),
  code: () => jump(globalThis.page, "self-hosting"),
  // Scrollbars: idle (hidden) and with the pointer over the message list (thin thumb).
  scroll: () => jump(globalThis.page, "general"),
  scrollhover: async (p) => {
    await jump(p, "general");
    await p.locator(".scroller").hover();
  },
};
for (const [vw, vh] of [[+w, +h], [390, 844]]) for (const theme of ["dark", "light"]) {
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 2, colorScheme: theme });
  await ctx.route("http://localhost:8090/**", (r) => r.abort());
  await ctx.addInitScript((v) => localStorage.setItem("sblurp.fake.appearance", v), JSON.stringify({ theme }));
  const page = (globalThis.page = await ctx.newPage());
  page.on("pageerror", (e) => console.error(e.message));
  await page.goto("http://127.0.0.1:5198/?fake=1&quiet=1", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => document.fonts.ready);
  await page.locator(".msg, .chan-start").first().waitFor();
  await jump(page, "general");
  await shots[shot](page);
  await page.waitForTimeout(300);
  const f = `${OUT}${prefix}-${shot}-${vw}-${theme}.png`;
  await page.screenshot({ path: f });
  console.log(f);
  await ctx.close();
}
await browser.close();
await server.close();
