// Phone and tablet movies of fake mode in WebKit (1297): node scripts/movies.mjs <tag> [filter]
// Records real touch flows on iPhone 15, Pixel 7 and iPad mini, light and dark, into
// artifacts/1297-<tag>/. Safe areas are faked by rewriting env(safe-area-inset-*) in the CSS,
// and a red tint marks the notch and home bar so overlaps show in the frames.
// Starts its own Vite server on 5197 and stops it when done.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { devices, webkit } from "playwright";
import { createServer } from "vite";

const tag = process.argv[2] ?? "run";
const only = process.argv[3] ?? "";
const OUT = new URL(`../../artifacts/1297-${tag}/`, import.meta.url).pathname;
const MEDIA = process.env.MEDIA ?? new URL("../../artifacts/1297-media/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const server = await createServer({ server: { host: "127.0.0.1", port: 5197, strictPort: true }, logLevel: "error" });
await server.listen();
const base = "http://127.0.0.1:5197/?fake=1&quiet=1";
const browser = await webkit.launch();

const targets = [
  { name: "iphone15", dev: devices["iPhone 15"], inset: { top: 59, bottom: 34 } },
  { name: "pixel7", dev: devices["Pixel 7"], inset: { top: 24, bottom: 16 } },
  { name: "ipadmini", dev: { ...devices["iPad Mini"], viewport: { width: 744, height: 1133 } }, inset: { top: 24, bottom: 20 } },
];

// Show each tap as a dot, and tint the fake notch and home bar.
const overlay = ({ top, bottom }) => {
  addEventListener("DOMContentLoaded", () => {
    const s = document.createElement("style");
    s.textContent = `.t-dot{position:fixed;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:50%;background:#f0f6;pointer-events:none;z-index:2147483647}
      .t-safe{position:fixed;left:0;right:0;pointer-events:none;z-index:2147483646;background:#ff000026}`;
    document.head.append(s);
    for (const [k, h] of [["top", top], ["bottom", bottom]]) {
      const d = document.createElement("div");
      d.className = "t-safe";
      d.style.cssText = `${k}:0;height:${h}px`;
      document.body.append(d);
    }
  });
  addEventListener(
    "pointerdown",
    (e) => {
      const d = document.createElement("div");
      d.className = "t-dot";
      d.style.left = `${e.clientX}px`;
      d.style.top = `${e.clientY}px`;
      document.body.append(d);
      setTimeout(() => d.remove(), 350);
    },
    true,
  );
};

const longPress = async (page, loc) => {
  const b = await loc.boundingBox();
  const x = b.x + Math.min(b.width / 2, 120), y = b.y + Math.min(b.height / 2, 14);
  const opts = { pointerType: "touch", isPrimary: true, bubbles: true, clientX: x, clientY: y };
  await loc.dispatchEvent("pointerdown", opts);
  await loc.dispatchEvent("touchstart");
  await page.waitForTimeout(650);
  await loc.dispatchEvent("pointerup", opts);
  await loc.dispatchEvent("touchend");
};

const drawer = async (p) => {
  if ((p.viewportSize()?.width ?? 0) < 768 && (await p.locator(".app").getAttribute("data-drawer")) !== "true") await p.locator(".menu-btn").tap();
  await p.waitForTimeout(400);
};

// Tap targets under 44px, horizontal scroll and content under the fake notch or home bar.
const audit = (inset) => {
  const small = new Set();
  for (const el of document.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, [role=menuitem], [role=tab]")) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || el.closest(".msg-text, .visually-hidden, .skip-link, p")) continue;
    if (getComputedStyle(el).visibility === "hidden" || el.closest("[inert]")) continue;
    if (r.right < 0 || r.left > innerWidth || r.bottom < 0 || r.top > innerHeight) continue;
    if (r.width < 44 || r.height < 44) small.add(`${Math.round(r.width)}x${Math.round(r.height)} ${el.className || el.tagName} "${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24)}"`);
  }
  const under = [...document.querySelectorAll("button, h1, h2, input, textarea")].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.height && !el.closest("[inert]") && getComputedStyle(el).visibility !== "hidden" && r.left < innerWidth && r.right > 0 && ((r.top < inset.top && r.bottom > 0) || (r.bottom > innerHeight - inset.bottom && r.top < innerHeight));
  }).map((el) => `${el.className || el.tagName} "${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24)}"`);
  return { hscroll: document.scrollingElement.scrollWidth > innerWidth, small: [...small], under };
};

const flow = [
  ["open", async () => {}],
  ["switch community", async (p) => {
    await drawer(p);
    await p.locator(".rail-btn").nth(1).tap();
    await p.waitForTimeout(500);
    await drawer(p);
    await p.locator(".drawer .chan").first().tap();
  }],
  ["drawer and back", async (p) => {
    await drawer(p);
    const v = p.viewportSize();
    if (v.width < 768) await p.touchscreen.tap(v.width - 16, v.height / 2);
  }],
  ["back to first community, #general", async (p) => {
    await drawer(p);
    await p.locator(".rail-btn").first().tap();
    await p.waitForTimeout(400);
    await drawer(p);
    await p.locator(".drawer .chan", { hasText: "general" }).first().tap();
  }],
  ["scroll", async (p) => {
    await p.locator(".channel .scroller").evaluate((el) => el.scrollBy({ top: -1200, behavior: "smooth" }));
    await p.waitForTimeout(900);
    await p.locator(".channel .scroller").evaluate((el) => el.scrollBy({ top: 5000, behavior: "smooth" }));
  }],
  ["thread", async (p) => {
    await p.locator(".channel .thread-link").last().tap();
    await p.locator(".pane .msg").first().waitFor();
    await p.waitForTimeout(800);
    await p.getByRole("button", { name: "Close thread" }).tap();
  }],
  ["members and profile", async (p) => {
    await p.getByRole("button", { name: "Members", exact: true }).tap();
    await p.locator(".member").first().waitFor();
    await p.waitForTimeout(600);
    await p.locator(".member").nth(1).tap();
    await p.waitForTimeout(900);
    await p.touchscreen.tap(10, p.viewportSize().height - 120);
    await p.waitForTimeout(300);
    if (await p.getByRole("button", { name: "Close members" }).isVisible()) await p.getByRole("button", { name: "Close members" }).tap();
  }],
  ["message tap and long press", async (p) => {
    const m = p.locator(".channel .msg").last();
    await m.locator(".msg-text").tap();
    await p.waitForTimeout(700);
    await longPress(p, m.locator(".msg-text"));
    await p.waitForTimeout(700);
    await m.locator(".msg-text").tap(); // a tap outside closes the menu, as on a phone
  }],
  ["react", async (p) => {
    const m = p.locator(".channel .msg").last();
    await longPress(p, m.locator(".msg-text"));
    await p.waitForTimeout(300);
    await p.getByRole("menuitem", { name: "Add reaction" }).tap();
    await p.waitForTimeout(600);
    await p.locator(".pop .emoji-grid button, .pop [role=gridcell], .pop button.emoji").first().tap();
  }],
  ["send", async (p) => {
    await p.locator(".channel .composer-input").tap();
    await p.waitForTimeout(300);
    await p.keyboard.type("Kiln is loaded, firing tonight.", { delay: 20 });
    await p.keyboard.press("Enter");
  }],
  ["attach image and movies", async (p) => {
    await p.locator('.channel input[aria-label="Attach files"]').setInputFiles([`${MEDIA}pot.jpg`, `${MEDIA}kiln.mp4`, `${MEDIA}glaze.mov`]);
    await p.waitForTimeout(900);
    await p.locator(".channel .composer-input").tap();
    await p.keyboard.press("Enter");
    await p.waitForTimeout(800);
  }],
  ["lightbox", async (p) => {
    await p.locator(".channel .att-img").last().tap();
    await p.waitForTimeout(900);
    await p.locator(".lightbox").getByRole("button", { name: "Close" }).tap();
    await p.waitForTimeout(400);
    const max = p.locator(".channel .att-max").last();
    await max.scrollIntoViewIfNeeded();
    await max.tap();
    await p.waitForTimeout(900);
    await p.locator(".lightbox").getByRole("button", { name: "Close" }).tap();
  }],
  ["settings", async (p) => {
    await drawer(p);
    await p.getByRole("button", { name: "Settings" }).tap();
    await p.locator(".settings").waitFor();
    await p.waitForTimeout(700);
    await p.locator("dialog[open]").getByRole("button", { name: "Close" }).first().tap();
  }],
  ["community settings", async (p) => {
    await drawer(p);
    await p.locator(".side-head").tap();
    await p.waitForTimeout(500);
    await p.getByRole("menuitem", { name: "Community settings" }).tap();
    await p.locator("dialog[open]").first().waitFor();
    await p.waitForTimeout(700);
    await p.locator("dialog[open]").getByRole("button", { name: "Close" }).first().tap();
  }],
  ["add community", async (p) => {
    await drawer(p);
    await p.getByRole("button", { name: "Add a community" }).tap();
    await p.waitForTimeout(500);
    await p.getByLabel("Community address or invite link").fill("https://letterpress.club/invite/INKSTAINED");
    await p.getByRole("button", { name: "Continue" }).tap();
    await p.locator(".consent").waitFor();
    await p.waitForTimeout(800);
    await p.keyboard.press("Escape");
  }],
];

const setupFlow = async (p) => {
  await p.locator(".msg").first().waitFor();
  await drawer(p);
  await p.getByRole("button", { name: /^Saturday Climbers/ }).tap();
  await p.locator("dialog[open]").first().waitFor();
  for (let i = 0; i < 5; i++) {
    await p.waitForTimeout(700);
    const next = p.locator("dialog[open]").getByRole("button", { name: /^(Continue|Next|Set up|Create|Done|Finish)/ }).first();
    if (!(await next.isVisible().catch(() => false))) break;
    await next.tap();
  }
  await p.waitForTimeout(800);
};

for (const t of targets) {
  for (const scheme of ["dark", "light"]) {
    const name = `${t.name}-${scheme}`;
    if (only && !name.includes(only)) continue;
    const { defaultBrowserType, ...dev } = t.dev;
    const ctx = await browser.newContext({ ...dev, colorScheme: scheme, recordVideo: { dir: OUT, size: dev.viewport } });
    await ctx.route("http://localhost:8090/**", (r) => r.abort());
    await ctx.route(/\/src\/.*\.css/, async (r) => {
      const res = await r.fetch();
      const body = (await res.text())
        .replaceAll("env(safe-area-inset-top)", `${t.inset.top}px`)
        .replaceAll("env(safe-area-inset-bottom)", `${t.inset.bottom}px`)
        .replace(/env\(safe-area-inset-(left|right)\)/g, "0px");
      await r.fulfill({ response: res, body });
    });
    await ctx.addInitScript(overlay, t.inset);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.error(`[${name}] ${e.message}`));
    const t0 = Date.now();
    const marks = [];
    const audits = [];
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.locator(".msg").first().waitFor();
    for (const [step, act] of flow) {
      marks.push([((Date.now() - t0) / 1000).toFixed(1), step]);
      try {
        await act(page);
      } catch (e) {
        console.error(`[${name}] ${step}: ${e.message.split("\n")[0]}`);
        await page.keyboard.press("Escape").catch(() => {});
      }
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${OUT}${name}-${String(marks.length).padStart(2, "0")}-${step.replace(/\W+/g, "-")}.png` });
      audits.push([step, await page.evaluate(audit, t.inset)]);
    }
    const video = page.video();
    await page.close();
    await video.saveAs(`${OUT}${name}.webm`);
    writeFileSync(`${OUT}${name}.audit.json`, JSON.stringify(audits, null, 1));
    writeFileSync(`${OUT}${name}.marks.txt`, marks.map((m) => m.join("  ")).join("\n") + "\n");

    const setup = await ctx.newPage();
    await setup.goto(`${base}&setup=1`, { waitUntil: "domcontentloaded" });
    await setupFlow(setup).catch((e) => console.error(`[${name}] setup: ${e.message.split("\n")[0]}`));
    await setup.screenshot({ path: `${OUT}${name}-setup.png` });
    const sv = setup.video();
    await setup.close();
    await sv.saveAs(`${OUT}${name}-setup.webm`);
    await ctx.close();
    console.log(`${OUT}${name}.webm`);
  }
}
await browser.close();
await server.close();
for (const f of readdirSync(OUT)) if (f.startsWith("page@")) rmSync(OUT + f); // saveAs leaves the original
