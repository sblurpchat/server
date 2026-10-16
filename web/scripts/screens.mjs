// Screenshots of fake mode for visual review: node scripts/screens.mjs [name-filter]
// Starts its own Vite server on 5199 and stops it when done.
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { createServer } from "vite";

const OUT = new URL("../../artifacts/web/", import.meta.url).pathname;
const only = process.argv[2] ?? "";
mkdirSync(OUT, { recursive: true });
const server = await createServer({ server: { host: "127.0.0.1", port: 5199, strictPort: true }, logLevel: "error" });
await server.listen();
const base = "http://127.0.0.1:5199/?fake=1&quiet=1";
const browser = await chromium.launch();

const jump = async (page, q) => {
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder("Jump to a channel or person").fill(q);
  await page.keyboard.press("Enter");
  await page.locator(".msg, .chan-start").first().waitFor();
};

const shots = {
  main: async () => {},
  thread: async (p) => {
    await p.locator(".thread-link").first().click();
    await p.locator(".pane .msg").first().waitFor();
  },
  members: async (p) => {
    await p.getByRole("button", { name: "Members" }).click();
    await p.locator(".member").first().waitFor();
  },
  add: async (p) => {
    await p.getByRole("button", { name: "Add a community" }).click();
    await p.getByLabel("Community address or invite link").fill("letterpress.club");
    await p.getByRole("button", { name: "Continue" }).click();
    await p.locator(".consent").waitFor();
  },
  switcher: async (p) => {
    await p.keyboard.press("Control+k");
    await p.getByPlaceholder("Jump to a channel or person").fill("de");
  },
  settings: async (p) => {
    await p.getByRole("button", { name: "Settings" }).click();
    await p.locator(".settings").waitFor();
  },
  empty: (p) => jump(p, "ideas-box"),
  dm: (p) => jump(p, "Ana"),
  profile: async (p) => {
    await p.locator(".msg .avatar-btn").last().click();
    await p.locator(".profile .btn, .profile .fine").first().waitFor();
  },
  drawer: async (p) => {
    if ((p.viewportSize()?.width ?? 0) >= 768) return "skip";
    await p.getByRole("button", { name: "Open communities and channels" }).click();
  },
  signin: "signedout",
};

for (const scheme of ["light", "dark"]) {
  for (const [vw, vh, tag] of [[1440, 900, "desktop"], [390, 844, "mobile"]]) {
    const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 2, colorScheme: scheme });
    for (const [name, act] of Object.entries(shots)) {
      if (only && !name.includes(only)) continue;
      const page = await ctx.newPage();
      page.on("pageerror", (e) => console.error(`[${name}] ${e.message}`));
      await page.goto(act === "signedout" ? `${base}&signedout=1` : base, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => document.fonts.ready);
      if (act === "signedout") await page.locator(".signin").waitFor();
      else {
        await page.locator(".msg").first().waitFor();
        if ((await act(page)) === "skip") {
          await page.close();
          continue;
        }
      }
      await page.waitForTimeout(250);
      const file = `${OUT}${name}-${tag}-${scheme}.png`;
      await page.screenshot({ path: file });
      console.log(file);
      await page.close();
    }
    await ctx.close();
  }
}
await browser.close();
await server.close();
