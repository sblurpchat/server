// Fake-mode smoke test: load, switch community, send, open a thread, reply.
// Starts its own Vite server on 5198 and stops it when done. Exits non-zero on failure.
import { chromium } from "playwright";
import { createServer } from "vite";

const server = await createServer({ server: { host: "127.0.0.1", port: 5198, strictPort: true }, logLevel: "error" });
await server.listen();
const browser = await chromium.launch();
let failed = false;
try {
  const page = await browser.newPage();
  await page.route("http://localhost:8090/**", (r) => r.abort());
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:5198/?fake=1&quiet=1", { waitUntil: "domcontentloaded" });
  await page.locator(".msg, .chan-start").first().waitFor();

  // Switch community from the rail.
  await page.getByRole("button", { name: /^Pottery Thursdays/ }).click();
  await page.locator(".side-head", { hasText: "Pottery Thursdays" }).waitFor();
  await page.waitForFunction(() => location.hash.startsWith("#/c/pottery"));

  // Send and see it in the channel.
  const text = `kiln check ${Date.now()}`;
  const composer = page.locator(".channel .composer-input");
  await composer.fill(text);
  await composer.press("Enter");
  const sent = page.locator(".channel .msg", { hasText: text });
  await sent.waitFor();
  if ((await composer.inputValue()) !== "") throw new Error("composer not cleared after send");

  // Open a thread on it and reply.
  await sent.hover();
  await sent.getByRole("button", { name: "Reply in thread" }).click();
  await page.locator(".pane .msg", { hasText: text }).waitFor();
  const reply = `reply ${Date.now()}`;
  const threadComposer = page.locator(".pane .composer-input");
  await threadComposer.fill(reply);
  await threadComposer.press("Enter");
  await page.locator(".pane .msg", { hasText: reply }).waitFor();
  await sent.locator(".thread-link", { hasText: "1 reply" }).waitFor();
  if (await page.locator(".channel .msg", { hasText: reply }).count()) throw new Error("thread reply leaked into the channel");

  // React, then right-click the chip to see who reacted.
  await sent.hover();
  await sent.getByRole("toolbar").getByRole("button", { name: "Add reaction" }).click();
  await page.getByRole("option", { name: "thumbsup" }).click();
  const chip = sent.getByRole("button", { name: "You reacted with 👍" });
  await chip.click({ button: "right" });
  await page.locator(".pop.who li", { hasText: "You" }).waitFor();
  await page.keyboard.press("Escape");

  // Drop a file on the message list (not the composer): it shows the overlay, then a chip.
  const dt = await page.evaluateHandle(() => {
    const d = new DataTransfer();
    d.items.add(new File(["glaze notes"], "glaze.txt", { type: "text/plain" }));
    return d;
  });
  await page.dispatchEvent(".channel .scroller", "dragover", { dataTransfer: dt });
  if ((await page.locator(".channel").getAttribute("data-drag")) !== "true") throw new Error("no drop overlay over the channel");
  await page.dispatchEvent(".channel .scroller", "drop", { dataTransfer: dt });
  await page.locator(".channel .chip", { hasText: "glaze.txt" }).waitFor();
  if (await page.locator(".channel").getAttribute("data-drag")) throw new Error("drop overlay stayed after the drop");
  await page.locator(".channel .chip", { hasText: "glaze.txt" }).getByRole("button", { name: "Remove glaze.txt" }).click();

  // Private channel: add someone, then remove them.
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder("Jump to a channel or person").fill("core-team");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Members" }).click();
  await page.locator(".members-head", { hasText: "Only these 3 people" }).waitFor();
  await page.getByRole("button", { name: "Add people" }).click();
  await page.getByLabel("Search people").fill("jun");
  await page.locator(".pick-list label", { hasText: "Jun Park" }).click();
  await page.getByRole("button", { name: "Add 1 person" }).click();
  await page.locator(".members-head", { hasText: "Only these 4 people" }).waitFor();
  await page.locator(".member-row", { hasText: "Jun Park" }).hover();
  await page.getByRole("button", { name: "Remove Jun Park from #core-team" }).click();
  await page.locator(".members-head", { hasText: "Only these 3 people" }).waitFor();

  // Invites: as owner of Sblurp Community, make a link and revoke it.
  await page.locator(".side-head", { hasText: "Sblurp Community" }).click();
  await page.getByRole("menuitem", { name: "Invite people" }).click();
  await page.getByRole("button", { name: "Create link" }).click();
  const made = page.locator(".invite-list li").first();
  await made.locator("small", { hasText: "0 uses, expires in 7 days" }).waitFor();
  const code = await made.locator("code").textContent();
  await page.getByRole("button", { name: `Revoke invite ${code}` }).click();
  await page.locator(".invite-list code", { hasText: code }).waitFor({ state: "detached" });
  await page.keyboard.press("Escape");

  // An invite link fills in the server and the code; a bad code is refused.
  await page.getByRole("button", { name: "Add a community" }).click();
  await page.getByLabel("Community address or invite link").fill("https://letterpress.club/invite/WRONG");
  await page.getByRole("button", { name: "Continue" }).click();
  const codeInput = page.getByLabel("Invite code");
  if ((await codeInput.inputValue()) !== "WRONG") throw new Error("invite code not filled from the link");
  await page.getByRole("button", { name: "Join Letterpress Club" }).click();
  await page.getByRole("alert").filter({ hasText: "invite code doesn't work" }).waitFor();
  await codeInput.fill("inkstained");
  await page.getByRole("button", { name: "Join Letterpress Club" }).click();
  await page.locator(".side-head", { hasText: "Letterpress Club" }).waitFor();

  if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`);
  console.log("e2e: ok (load, switch community, send, thread, reply, who reacted, drop, private members, invites)");
} catch (e) {
  failed = true;
  console.error("e2e: FAILED", e.message);
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
