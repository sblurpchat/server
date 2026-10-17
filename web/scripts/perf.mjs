// Seeds #show-and-tell with BIG messages (default 5000), scrolls all of it into the list, then measures
// scroll frame times and channel switch times. Prints numbers; fails only if something does not load.
import { chromium } from "playwright";
import { createServer } from "vite";

const BIG = Number(process.env.BIG ?? 5000);
const server = await createServer({ server: { host: "127.0.0.1", port: 5196, strictPort: true }, logLevel: "error" });
await server.listen();
const browser = await chromium.launch();
let failed = false;
try {
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await p.route("http://localhost:8090/**", (r) => r.abort());
  p.on("pageerror", (e) => console.error("page error:", e.message));
  await p.goto(`http://127.0.0.1:5196/?fake=1&quiet=1&big=${BIG}`);
  await p.locator(".msg").first().waitFor();
  const open = async (name) => {
    const t = Date.now();
    await p.locator(".sidebar a, .sidebar button").filter({ hasText: new RegExp(`^\\s*${name}\\s*$`) }).first().click();
    await p.locator(".channel .msg").first().waitFor();
    return Date.now() - t;
  };
  const first = await open("show-and-tell");
  // The list is column-reverse, so the top is a negative scrollTop. Load every page by scrolling to the top until the channel start shows.
  const t0 = Date.now();
  while (!(await p.locator(".chan-start").count())) {
    await p.locator(".channel .scroller").evaluate((s) => (s.scrollTop = -s.scrollHeight));
    await p.waitForTimeout(30);
    if (Date.now() - t0 > 240_000) throw new Error(`history never finished loading (${await p.locator(".channel .msg").count()} in the DOM)`);
  }
  const loadAll = Date.now() - t0;
  const dom = await p.locator(".channel .msg").count();
  // Scroll the full list in 120 steps, one per frame, and record frame gaps.
  const frames = await p.locator(".channel .scroller").evaluate(
    (s) =>
      new Promise((done) => {
        const gaps = [];
        let i = 0, last = performance.now();
        const step = () => {
          const now = performance.now();
          gaps.push(now - last);
          last = now;
          s.scrollTop = -(s.scrollHeight * i) / 120;
          if (++i <= 120) requestAnimationFrame(step);
          else done(gaps.slice(1));
        };
        requestAnimationFrame(step);
      }),
  );
  frames.sort((a, b) => a - b);
  const pct = (q) => frames[Math.floor(frames.length * q)].toFixed(1);
  const away = await open("general");
  const back = await open("show-and-tell");
  console.log(
    `perf: ${BIG} seeded, ${dom} in the DOM; first open ${first}ms, load all ${(loadAll / 1000).toFixed(1)}s; scroll frame median ${pct(0.5)}ms, p95 ${pct(0.95)}ms, max ${frames.at(-1).toFixed(1)}ms; switch away ${away}ms, back ${back}ms`,
  );
} catch (e) {
  failed = true;
  console.error("perf: FAILED", e.message);
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
