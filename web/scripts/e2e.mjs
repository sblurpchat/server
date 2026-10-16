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

  if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`);
  console.log("e2e: ok (load, switch community, send, thread, reply, who reacted, drop)");
} catch (e) {
  failed = true;
  console.error("e2e: FAILED", e.message);
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
