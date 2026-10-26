// Desktop message toolbar stays in the accessibility tree when not hovered, adds no Tab stops,
// and looks the same on hover (1516): node scripts/desktop-toolbar.mjs. Screenshots go to ../artifacts/1516/.
import { chromium } from "playwright";
import { createServer } from "vite";

const server = await createServer({ server: { host: "127.0.0.1", port: 5198, strictPort: true }, logLevel: "error" });
await server.listen();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
await page.route("http://localhost:8090/**", (r) => r.abort());
await page.goto("http://127.0.0.1:5198/?fake=1&quiet=1");
const msg = page.locator(".channel .msg:not(.deleted):not(.blocked)").last();
await msg.waitFor();
await page.mouse.move(5, 5);
let failed = false;
const check = (ok, name) => (console.log(`${ok ? "ok  " : "FAIL"} ${name}`), ok || (failed = true));

const snap = await msg.ariaSnapshot();
console.log(snap);
check(/button "Reply in thread"/.test(snap) && /button "More actions"/.test(snap), "toolbar buttons in the aria snapshot while not hovered");
const clip = await msg.locator(".toolbar").evaluate((t) => getComputedStyle(t).clipPath);
check(clip.startsWith("inset(50%"), `toolbar clipped while not hovered (${clip})`);

await page.locator(".scroller").first().focus();
await page.keyboard.press("Tab");
check(!(await page.evaluate(() => !!document.activeElement.closest(".toolbar"))), "Tab from the message list skips hidden toolbars");

await msg.hover();
const hb = await msg.locator(".toolbar").boundingBox();
check(hb.width > 100 && hb.height > 30, `toolbar shown on hover (${hb.width}x${hb.height})`);
await page.screenshot({ path: "../artifacts/1516/hover.png" });

await page.mouse.move(5, 5);
await msg.focus();
let reached = false;
for (let i = 0; i < 12 && !reached; i++) {
  await page.keyboard.press("Tab");
  reached = await page.evaluate(() => !!document.activeElement.closest(".toolbar"));
}
check(reached, "Tab from a focused message reaches its toolbar");
await page.screenshot({ path: "../artifacts/1516/focus.png" });

await browser.close();
await server.close();
process.exit(failed ? 1 : 0);
