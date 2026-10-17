// axe-core scan of fake mode in light and dark, desktop and 390px: the main views, dialogs and panes.
// Fails on serious or critical violations, and on dialog panels that overflow sideways. Starts its own Vite server on 5197 and stops it when done.
import { createRequire } from "node:module";
import { chromium } from "playwright";
import { createServer } from "vite";

const axePath = createRequire(import.meta.url).resolve("axe-core");
const server = await createServer({ server: { host: "127.0.0.1", port: 5197, strictPort: true }, logLevel: "error" });
await server.listen();
const browser = await chromium.launch();
const found = [];
let failed = false;

const open = (p, name) => p.locator(".side-head").click().then(() => p.getByRole("menuitem", { name }).click());
const drawer = async (p) => {
  if ((p.viewportSize()?.width ?? 0) < 768) await p.getByRole("button", { name: "Open communities and channels" }).click();
};
// Each view starts from #general with nothing open.
const views = {
  main: async () => {},
  thread: (p) => p.locator(".thread-link").first().click().then(() => p.locator(".pane .msg").first().waitFor()),
  members: (p) => p.getByRole("button", { name: "Members" }).click().then(() => p.locator(".member").first().waitFor()),
  switcher: (p) => p.keyboard.press("Control+k"),
  keys: (p) => p.keyboard.press("Control+/").then(() => p.locator(".keys-list").waitFor()),
  settings: async (p) => {
    await drawer(p);
    await p.getByRole("button", { name: "Settings" }).click();
  },
  admin: async (p) => {
    await drawer(p);
    await open(p, "Community settings");
    await p.locator(".admin-list li").first().waitFor();
  },
  roles: async (p) => {
    await views.admin(p);
    await p.getByRole("tab", { name: "Roles" }).click();
  },
  access: async (p) => {
    await views.admin(p);
    await p.getByRole("tab", { name: "Channels" }).click();
    await p.locator(".access-list summary").first().click();
  },
  browse: async (p) => {
    await drawer(p);
    await p.getByRole("button", { name: "Browse channels" }).click();
    await p.locator(".browse-open").first().waitFor();
  },
  profile: (p) => p.locator(".channel .msg .avatar-btn").last().click().then(() => p.locator(".profile-body").waitFor()),
  drawer: async (p) => {
    if ((p.viewportSize()?.width ?? 0) >= 768) return;
    await drawer(p);
  },
  newchannel: async (p) => {
    await drawer(p);
    await open(p, "Create channel");
  },
  join: async (p) => {
    await drawer(p);
    await p.getByRole("button", { name: "Add a community" }).click();
    await p.getByLabel("Community address or invite link").fill("https://letterpress.club/invite/INKSTAINED");
    await p.getByRole("button", { name: "Continue" }).click();
    await p.locator(".consent").waitFor();
  },
};

try {
  for (const scheme of ["light", "dark"]) {
    for (const [w, h] of [[1280, 800], [390, 844]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, reducedMotion: "reduce" });
      await ctx.route("http://localhost:8090/**", (r) => r.abort());
      for (const [name, act] of Object.entries(views)) {
        if (process.env.ONLY && !process.env.ONLY.split(",").includes(name)) continue;
        const p = await ctx.newPage();
        await p.goto("http://127.0.0.1:5197/?fake=1&quiet=1", { waitUntil: "domcontentloaded" });
        await p.locator(".msg").first().waitFor();
        await p.keyboard.press("Control+k");
        await p.getByPlaceholder("Jump to a channel or person").fill("general");
        await p.keyboard.press("Enter");
        await p.locator(".channel .msg").first().waitFor();
        await act(p);
        await p.waitForTimeout(150);
        // Scrolling panels in dialogs scroll down, never sideways (the admin list once overflowed at 390px).
        const wide = await p.evaluate(() =>
          [...document.querySelectorAll("dialog[open] *")]
            .filter((e) => getComputedStyle(e).overflowY === "auto" && !e.matches("[role=tablist], textarea") && e.scrollWidth > e.clientWidth + 1)
            .map((e) => `.${e.className} is ${e.scrollWidth}px wide in ${e.clientWidth}px`),
        );
        if (wide.length) found.push(`${scheme} ${w}px ${name}: sideways overflow: ${wide.join(", ")}`);
        await p.addScriptTag({ path: axePath });
        const v = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ["violations"] })).violations);
        for (const x of v.filter((x) => x.impact === "serious" || x.impact === "critical"))
          found.push(`${scheme} ${w}px ${name}: ${x.id} (${x.impact}) ${x.nodes.length}x ${x.nodes.slice(0, 3).map((n) => `${n.target.join(" ")} ${n.any[0]?.message ?? ""}`).join(" | ")}`);
        await p.close();
      }
      await ctx.close();
    }
  }
  if (found.length) throw new Error(`${found.length} problems (serious or critical axe violations, sideways overflow):\n${found.join("\n")}`);
  console.log(`a11y: ok (${Object.keys(views).length} views x light, dark x 1280px, 390px; no serious or critical axe violations)`);
} catch (e) {
  failed = true;
  console.error("a11y: FAILED", e.message);
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
