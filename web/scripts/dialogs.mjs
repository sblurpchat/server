// Every dialog at phone and tablet size in WebKit (1307): node scripts/dialogs.mjs
// Fails if the page or a dialog scrolls sideways, and saves screenshots to artifacts/1307-*.png.
// Safe areas are faked the same way as scripts/movies.mjs. Starts its own Vite server on 5196.
import { mkdirSync } from "node:fs";
import { devices, webkit } from "playwright";
import { createServer } from "vite";

const OUT = new URL("../../artifacts/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const server = await createServer({ server: { host: "127.0.0.1", port: 5196, strictPort: true }, logLevel: "error" });
await server.listen();
const browser = await webkit.launch();
const targets = [
  { name: "iphone15", dev: devices["iPhone 15"], inset: { top: 59, bottom: 34 }, schemes: ["dark", "light"] },
  { name: "ipadmini", dev: { ...devices["iPad Mini"], viewport: { width: 744, height: 1133 } }, inset: { top: 24, bottom: 20 }, schemes: ["dark"] },
];
// A picture far wider than any screen, for the lightbox (1312).
const WIDE = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="1500"><rect width="4000" height="1500" fill="#c86"/><circle cx="2000" cy="750" r="600" fill="#357"/></svg>')}`;
// Modals that need ids get them from the open community in the page.
const modals = (s, WIDE) => {
  const c = s.cs[s.url];
  const other = Object.values(c?.members ?? {}).find((m) => m.id !== c.me?.id);
  const msg = c?.lists[s.channelId]?.items?.find((m) => m.authorId !== c.me?.id);
  return [
    { t: "settings" }, { t: "add" }, { t: "switcher" }, { t: "info" }, { t: "invite" }, { t: "leave" },
    { t: "channel" }, { t: "community" }, { t: "newdm" }, { t: "browse" }, { t: "keys" }, { t: "profile" },
    { t: "reports" }, { t: "setup" }, { t: "lightbox", src: WIDE, name: "wide-panorama.svg" },
    ...(other ? [{ t: "remove", url: s.url, memberId: other.id, ban: true }, { t: "block", url: s.url, memberId: other.id }] : []),
    ...(msg ? [{ t: "report", url: s.url, message: msg }, { t: "delete", id: msg.id }] : []),
  ];
};
let failed = false;
for (const t of targets) {
  for (const scheme of t.schemes) {
    const { defaultBrowserType, ...dev } = t.dev;
    const ctx = await browser.newContext({ ...dev, colorScheme: scheme, reducedMotion: "reduce" });
    await ctx.route("http://localhost:8090/**", (r) => r.abort());
    await ctx.route(/\/src\/.*\.css/, async (r) => {
      const res = await r.fetch();
      const body = (await res.text())
        .replaceAll("env(safe-area-inset-top)", `${t.inset.top}px`)
        .replaceAll("env(safe-area-inset-bottom)", `${t.inset.bottom}px`)
        .replace(/env\(safe-area-inset-(left|right)\)/g, "0px");
      await r.fulfill({ response: res, body });
    });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.error(`[${t.name}] ${e.message}`));
    await page.goto("http://127.0.0.1:5196/?fake=1&quiet=1", { waitUntil: "domcontentloaded" });
    await page.locator(".msg").first().waitFor();
    // The composer sits just above the home bar (1310): the inset, not the inset plus a row.
    const gap = await page.evaluate(() => innerHeight - document.querySelector(".channel .composer-box").getBoundingClientRect().bottom);
    const gapOk = gap <= Math.max(20, t.inset.bottom) + 1;
    if (!gapOk) failed = true;
    console.log(`[${t.name}-${scheme}] composer gap ${gap}px, inset ${t.inset.bottom}px: ${gapOk ? "ok" : "TOO BIG"}`);
    await page.screenshot({ path: `${OUT}1307-${t.name}-${scheme}-composer.png` });
    const list = await page.evaluate(`(async () => (${modals})((await import("/src/store.ts")).get(), ${JSON.stringify(WIDE)}))()`);
    for (const m of list) {
      await page.evaluate(async (m) => (await import("/src/store.ts")).set({ modal: m }), m);
      const d = page.locator("dialog[open]").first();
      if (!(await d.isVisible({ timeout: 2000 }).catch(() => false))) {
        console.log(`[${t.name}-${scheme}] ${m.t}: no dialog`, await page.evaluate(async () => { const s = (await import("/src/store.ts")).get(); return [s.modal?.t, s.auth, document.querySelectorAll("dialog").length, location.href]; }));
        continue;
      }
      await page.waitForTimeout(400);
      const r = await page.evaluate(() => {
        const wide = (el) => el.scrollWidth > el.clientWidth;
        const d = document.querySelector("dialog[open]");
        if (!d) return null;
        const bad = [d, ...d.querySelectorAll("*")].filter((el) => wide(el) && !["auto", "scroll"].includes(getComputedStyle(el).overflowX) || el === d && wide(el));
        const dr = d.getBoundingClientRect();
        const out = [...d.querySelectorAll("*")].filter((el) => { const b = el.getBoundingClientRect(); return b.width && (b.right > dr.right + 0.5 || b.left < dr.left - 0.5); }).slice(0, 5)
          .map((el) => `${el.tagName}.${el.className} ${Math.round(el.getBoundingClientRect().left)}-${Math.round(el.getBoundingClientRect().right)}`);
        return { page: [document.scrollingElement.scrollWidth, document.scrollingElement.clientWidth], dialog: [d.scrollWidth, d.clientWidth], cls: d.className, bad: bad.map((el) => `${el.tagName}.${el.className}`).slice(0, 5), out, box: [Math.round(dr.left), Math.round(dr.right)] };
      });
      if (!r) {
        console.log(`[${t.name}-${scheme}] ${m.t}: closed by itself`);
        continue;
      }
      const ok = r.page[0] <= r.page[1] && r.dialog[0] <= r.dialog[1] && !r.out.length;
      if (!ok) failed = true;
      console.log(`[${t.name}-${scheme}] ${m.t}: ${ok ? "ok" : "OVERFLOW"} page ${r.page.join("/")} dialog ${r.dialog.join("/")} box ${r.box.join("-")}${ok ? "" : ` ${JSON.stringify({ bad: r.bad, out: r.out })}`}`);
      await page.screenshot({ path: `${OUT}1307-${t.name}-${scheme}-${m.t}.png` });
      if (await page.evaluate(() => { const d = document.querySelector("dialog[open]"); d.scrollTop = d.scrollHeight; return d.scrollHeight > d.clientHeight; })) {
        await page.waitForTimeout(100);
        await page.screenshot({ path: `${OUT}1307-${t.name}-${scheme}-${m.t}-end.png` });
      }
      await page.evaluate(async () => (await import("/src/store.ts")).set({ modal: null }));
      await page.waitForTimeout(150);
    }
    await ctx.close();
  }
}
await browser.close();
await server.close();
process.exit(failed ? 1 : 0);
