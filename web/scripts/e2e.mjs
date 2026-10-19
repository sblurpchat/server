// Fake-mode smoke test: load, switch community, send, open a thread, reply.
// Starts its own Vite server on 5198 and stops it when done. Exits non-zero on failure.
import { chromium } from "playwright";
import { createServer } from "vite";

const server = await createServer({ server: { host: "127.0.0.1", port: 5198, strictPort: true }, logLevel: "error" });
await server.listen();
const browser = await chromium.launch();
let failed = false;
const jumpTo = async (page, q) => {
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder("Jump to a channel or person").fill(q);
  await page.keyboard.press("Enter");
};
// Reduced motion: a closing dialog or pane leaves a fading copy for 120-160 ms (1297), and
// the steps act faster than that.
const page = await (await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"], reducedMotion: "reduce" })).newPage();
const errors = [];
try {
  await page.route("http://localhost:8090/**", (r) => r.abort());

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

  // Shift+Enter is still a new line; Cmd/Ctrl+Shift+Enter posts the box as a highlighted snippet (1269).
  await composer.fill("def kiln(temp):");
  await composer.press("Shift+Enter");
  await composer.pressSequentially("    return temp > 1200");
  if (!(await composer.inputValue()).includes("\n")) throw new Error("Shift+Enter did not add a new line");
  await composer.press("ControlOrMeta+Shift+Enter");
  await page.locator(".channel .snippet", { hasText: "snippet.py" }).locator(".hljs-keyword").first().waitFor();
  if ((await composer.inputValue()) !== "") throw new Error("composer not cleared after snippet");

  // `:` plus two letters opens the named emoji list; Enter inserts the character, a time does not trigger it (1265).
  await composer.pressSequentially("at 10:30 nice :+1");
  await page.getByRole("option", { name: ":+1:" }).waitFor();
  await composer.press("Enter");
  if ((await composer.inputValue()) !== "at 10:30 nice 👍 ") throw new Error(`emoji autocomplete gave ${JSON.stringify(await composer.inputValue())}`);
  await composer.pressSequentially(":thu");
  await page.locator(".channel .ac").waitFor();
  await composer.press("Escape");
  if (await page.locator(".channel .ac").count()) throw new Error("Escape did not close the emoji list");
  await composer.fill("");

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
  await sent.getByRole("group", { name: "Message actions" }).getByRole("button", { name: "Add reaction" }).click();
  await page.getByRole("button", { name: "thumbsup" }).first().click();
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

  // Everyday: group message, profile status, copy a message link and open it, mark all as read.
  await page.getByRole("button", { name: "New message" }).click();
  await page.getByLabel("Search people").fill("an");
  await page.locator(".pick-list label", { hasText: "Ana Ruiz" }).click();
  await page.getByLabel("Search people").fill("mei");
  await page.locator(".pick-list label", { hasText: "Mei Chen" }).click();
  await page.getByRole("button", { name: "Start group message" }).click();
  await page.locator(".chan-title", { hasText: "Ana Ruiz, Mei Chen" }).waitFor();

  await page.locator(".me-btn").click();
  await page.getByRole("button", { name: "Edit profile and status" }).click();
  await page.getByLabel("Status", { exact: true }).fill("Testing lists");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.locator(".mebar", { hasText: "Testing lists" }).waitFor();

  const list = `- one\n- two ${Date.now()}`;
  await page.locator(".channel .composer-input").fill(list);
  await page.locator(".channel .composer-input").press("Enter");
  const listed = page.locator(".channel .msg", { has: page.locator("ul li", { hasText: "two" }) }).last();
  await listed.waitFor();
  await listed.hover();
  await listed.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Copy link" }).click();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  // Copy link makes a share link on the auth site (1298) whose path matches the app route.
  if (!/^\/c\/[^/]+\/[^/]+\/[^/]+$/.test(new URL(link).pathname)) throw new Error(`bad message link: ${link}`);
  await jumpTo(page, "general");
  await page.evaluate((h) => (location.hash = h), "#" + new URL(link).pathname);
  await page.locator(".channel .msg[data-focus='true'] ul li", { hasText: "two" }).waitFor();

  await page.locator(".side-head").click();
  await page.getByRole("menuitem", { name: "Mark all as read" }).click();
  if (await page.locator(".sidebar .chan[data-unread='true']").count()) throw new Error("unread channels left after Mark all as read");

  // Block (1118): confirm from the profile, messages collapse, click shows one, Settings unblocks. Close a DM.
  await jumpTo(page, "general");
  await page.locator(".channel .composer-input[placeholder='Message #general']").waitFor();
  const other = page.locator(".channel .msg[data-head='true']:not([data-mine='true'])").first();
  const who = await other.locator(".msg-head .name").textContent();
  await other.locator(".msg-head .name").click();
  await page.locator(".pop.profile").getByRole("button", { name: "Block" }).click();
  await page.getByRole("dialog", { name: `Block ${who}` }).getByRole("button", { name: "Block" }).click();
  const collapsed = page.locator(".channel .msg.blocked").first();
  await collapsed.waitFor();
  if (await page.locator(".channel .msg-head .name", { hasText: who }).count()) throw new Error(`${who}'s message still shows after blocking`);
  await collapsed.getByRole("button", { name: /messages? from a blocked member/i }).click();
  await page.locator(".channel .msg[data-revealed='true'] .msg-head .name", { hasText: who }).first().waitFor();
  await page.getByRole("button", { name: "Settings" }).click();
  const blockedRow = page.locator(".blocked-list li", { hasText: who });
  await blockedRow.getByRole("button", { name: "Unblock" }).click();
  await blockedRow.waitFor({ state: "detached" });
  await page.keyboard.press("Escape");
  if (await page.locator(".channel .msg.blocked").count()) throw new Error("messages still collapsed after unblocking");
  const dmRow = page.locator(".sidebar li", { hasText: "Ana Ruiz, Mei Chen" });
  await dmRow.hover();
  await dmRow.getByRole("button", { name: /Close conversation/ }).click();
  await dmRow.waitFor({ state: "detached" });

  // Report (1119): report someone's message with a note, see it in the moderator queue, resolve it, jump to another.
  await jumpTo(page, "general");
  await page.locator(".channel .composer-input[placeholder='Message #general']").waitFor();
  const reported = page.locator(".channel .msg[data-head='true']:not([data-mine='true'])").last();
  const reportedText = (await reported.locator(".msg-text").first().textContent()).trim().slice(0, 30);
  await reported.hover();
  await reported.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Report message" }).click();
  const reportDialog = page.getByRole("dialog", { name: "Report message" });
  await reportDialog.getByLabel("Note for moderators (optional)").fill("e2e note");
  await reportDialog.getByRole("button", { name: "Report" }).click();
  await page.getByRole("dialog", { name: "Report sent" }).getByRole("button", { name: "Done" }).click();
  await page.locator(".side-head").click();
  await page.getByRole("menuitem", { name: "Reports" }).click();
  const mine = page.locator(".report-list li", { hasText: "e2e note" });
  await mine.waitFor();
  if (!(await mine.textContent()).includes(reportedText)) throw new Error("report row lacks the message text");
  await mine.getByRole("button", { name: /^Resolve report/ }).click();
  await mine.waitFor({ state: "detached" });
  const seeded = page.locator(".report-list li").first();
  await seeded.getByRole("button", { name: "Go to message" }).click();
  await page.getByRole("dialog", { name: "Reports" }).waitFor({ state: "detached" });

  // Appearance: theme, density and text size apply at once and survive a reload.
  // The switch runs inside a view transition (1268), so read after the pending update lands.
  const settle = () => page.evaluate(() => document.activeViewTransition?.updateCallbackDone.catch(() => {}));
  const bg = async () => { await settle(); return page.evaluate(() => getComputedStyle(document.body).backgroundColor); };
  const before = await bg();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("radio", { name: "Dark", exact: true }).check();
  if ((await bg()) !== "rgb(29, 31, 45)") throw new Error(`Dark gave ${await bg()}`);
  await page.getByRole("radio", { name: "Light", exact: true }).check();
  if ((await bg()) !== "rgb(255, 255, 255)") throw new Error(`Light gave ${await bg()}`);
  await page.getByRole("radio", { name: "Midnight" }).check();
  if ((await bg()) === before || (await bg()) !== "rgb(23, 34, 48)") throw new Error(`Midnight did not repaint the page: ${await bg()}`);
  // Custom theme: starts from the theme on screen, fixes unreadable text, takes a pasted string.
  await page.getByRole("radio", { name: "Custom" }).check();
  const shared = page.getByLabel("Theme to share");
  if ((await shared.inputValue()).split(",")[2] !== "#172230") throw new Error(`Custom did not start from Midnight: ${await shared.inputValue()}`);
  await page.getByLabel("Message text").fill("#172230");
  await page.getByText(/Message text was too close to the background/).waitFor();
  const fg = await page.evaluate(() => getComputedStyle(document.body).color);
  if (fg === "rgb(23, 34, 48)") throw new Error("unreadable custom text was not adjusted");
  await page.getByLabel("Paste a theme").fill("nonsense");
  await page.getByRole("button", { name: "Apply" }).click();
  await page.getByRole("alert").filter({ hasText: "That is not a theme" }).waitFor();
  await page.getByLabel("Paste a theme").fill("#3f0e40,#ffffff,#1a1d21,#d1d2d3,#1164a3,#cd2553");
  await page.getByRole("button", { name: "Apply" }).click();
  if ((await bg()) !== "rgb(26, 29, 33)") throw new Error(`pasted theme gave ${await bg()}`);
  await page.getByRole("radio", { name: "Midnight" }).check();
  if ((await bg()) !== "rgb(23, 34, 48)") throw new Error(`leaving Custom left ${await bg()}`);
  await page.getByRole("radio", { name: "Compact" }).first().check();
  await settle();
  if (await page.locator(".channel .msg .avatar-btn").first().isVisible()) throw new Error("compact density still shows avatars");
  await page.getByRole("slider", { name: /Text size/ }).fill("18");
  await settle();
  const px = await page.evaluate(() => getComputedStyle(document.body).fontSize);
  if (px !== "18px") throw new Error(`text size 18 gave ${px}`);
  await page.reload();
  await page.locator(".channel .msg").first().waitFor();
  if ((await bg()) !== "rgb(23, 34, 48)" || (await page.locator(".channel .msg .avatar-btn").first().isVisible())) throw new Error("appearance did not survive a reload");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("radio", { name: "Match system" }).first().check();
  await page.getByRole("radio", { name: "Cozy" }).first().check();
  await page.getByRole("slider", { name: /Text size/ }).fill("15");
  await page.keyboard.press("Escape");
  await page.locator(".channel .msg .avatar-btn").first().waitFor();

  // Admin: create a channel, edit it, move it; then make and delete a bot.
  await page.locator(".side-head").click();
  await page.getByRole("menuitem", { name: "Create channel" }).click();
  await page.getByLabel("Name").fill("Book Club");
  await page.getByText("Saved as #book-club").waitFor();
  await page.getByLabel("Category").fill("Talk");
  await page.getByRole("button", { name: "Create channel" }).click();
  await page.locator(".chan-title", { hasText: "book-club" }).waitFor();
  const talk = page.locator(".side-sec", { hasText: "Talk" });
  if ((await talk.locator(".chan").last().textContent()) !== "book-club") throw new Error("new channel not last in Talk");
  await page.getByRole("button", { name: "#book-club options" }).click();
  await page.getByRole("menuitem", { name: "Edit channel" }).click();
  await page.getByLabel("Topic").fill("Reading together");
  await page.getByRole("button", { name: "Move up" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.locator(".chan-topic", { hasText: "Reading together" }).waitFor();
  const names = await talk.locator(".chan").allTextContents();
  if (names.at(-2) !== "book-club") throw new Error(`Move up did not reorder: ${names}`);

  await page.locator(".side-head").click();
  await page.getByRole("menuitem", { name: "Community settings" }).click();
  await page.getByRole("tab", { name: "Bots" }).click();
  await page.getByLabel("Username").fill("kiln-bot");
  await page.getByRole("button", { name: "Create bot" }).click();
  const tok = await page.getByLabel(/^Token for /).inputValue();
  if (!tok.startsWith("sbb_")) throw new Error("no bot token shown");
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Delete kiln-bot" }).click();
  await page.getByRole("button", { name: "Delete kiln-bot" }).click();
  await page.locator(".admin-list", { hasText: "kiln-bot" }).waitFor({ state: "detached" });
  await page.getByRole("tab", { name: "Members" }).click();
  await page.getByLabel("Permission for Jun Park").selectOption({ label: "Moderator" });
  await page.locator(".members-head, .cs-panel").first().waitFor();
  await page.keyboard.press("Escape");

  // Channel modes and roles (ticket 1011). Sblurp Community is OPT_IN in fake mode.
  const side = page.locator(".side-scroll");
  await page.getByRole("button", { name: "Browse channels" }).click();
  await page.locator(".browse-open", { hasText: "reading-room" }).click();
  await page.locator(".join-bar", { hasText: "previewing #reading-room" }).waitFor();
  await page.locator(".channel .msg", { hasText: "Chapter 2" }).waitFor();
  if (await side.locator(".chan", { hasText: "reading-room" }).count()) throw new Error("a previewed channel is in the sidebar");
  await page.getByRole("button", { name: "Join channel" }).click();
  await page.locator(".channel .composer").waitFor();
  await side.locator(".chan", { hasText: "reading-room" }).waitFor();
  await page.getByRole("button", { name: "#reading-room options" }).click();
  await page.getByRole("menuitem", { name: "Leave channel" }).click();
  await side.locator(".chan", { hasText: "reading-room" }).waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Browse channels" }).click();
  await page.getByRole("button", { name: "Join #off-topic" }).click();
  await page.getByRole("button", { name: "Leave #off-topic" }).waitFor();
  await page.keyboard.press("Escape");
  await side.locator(".chan", { hasText: "off-topic" }).waitFor();

  await jumpTo(page, "general");
  await page.locator(".channel .msg", { hasText: "Reminder: design crit" }).locator(".avatar-btn").click();
  const anaRoles = page.getByRole("list", { name: "Ana Ruiz's roles" });
  await anaRoles.getByText("Designers").waitFor();
  await page.getByRole("button", { name: "Edit roles" }).click();
  await page.getByRole("checkbox", { name: "Helpers" }).check();
  await anaRoles.getByText("Helpers").waitFor();
  await page.keyboard.press("Escape");

  await page.locator(".side-head").click();
  await page.getByRole("menuitem", { name: "Community settings" }).click();
  await page.getByRole("tab", { name: "Roles" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Film club");
  await page.getByRole("button", { name: "Create role" }).click();
  await page.getByLabel("Name of Film club").waitFor();
  await page.getByRole("button", { name: "Move Film club up" }).click();
  await page.waitForFunction(() => [...document.querySelectorAll(".roles-list li input.input")].map((i) => i.value).join() === "Maintainers,Designers,Film club,Helpers");
  await page.getByRole("button", { name: "Delete Maintainers" }).click();
  await page.getByRole("button", { name: "Delete Maintainers" }).click();
  await page.getByRole("alert").filter({ hasText: "#maintainers" }).waitFor();
  await page.getByRole("tab", { name: "Channels" }).click();
  await page.locator(".access-list summary", { hasText: "#general" }).click();
  await page.getByRole("checkbox", { name: "Film club" }).check();
  await page.locator(".access-list summary", { hasText: "Film club" }).waitFor();
  await page.getByRole("radio", { name: /Everyone is in every channel/ }).check();
  await side.locator(".chan", { hasText: "reading-room" }).waitFor();
  if (await page.getByRole("button", { name: "Browse channels" }).count()) throw new Error("Browse channels shown in ROLES mode");
  await page.getByRole("radio", { name: /People pick the channels/ }).check();
  await page.getByRole("button", { name: "Browse channels" }).waitFor();
  await page.keyboard.press("Escape");

  // Keyboard: Ctrl+/ opens the shortcuts sheet; arrow keys, Home and End move focus between messages.
  await page.keyboard.press("Control+/");
  await page.getByRole("dialog", { name: "Keyboard shortcuts" }).locator("dt").first().waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Keyboard shortcuts" }).waitFor({ state: "hidden" });
  await page.locator(".channel .scroller").focus();
  const focusedAt = () =>
    page.evaluate(() => {
      const all = [...document.querySelectorAll(".channel .scroller .msg")];
      return `${all.indexOf(document.activeElement)}/${all.length}`;
    });
  await page.keyboard.press("End");
  const [atEnd, n] = (await focusedAt()).split("/").map(Number);
  await page.keyboard.press("ArrowUp");
  const up = Number((await focusedAt()).split("/")[0]);
  await page.keyboard.press("Home");
  const home = Number((await focusedAt()).split("/")[0]);
  if (atEnd !== n - 1 || up !== n - 2 || home !== 0) throw new Error(`message focus End/Up/Home went to ${atEnd}, ${up}, ${home} of ${n}`);

  // Quick switcher: the query filters across communities, ArrowDown moves the choice, Enter opens it.
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder("Jump to a channel or person").fill("general");
  const options = page.getByRole("listbox", { name: "Channels" }).getByRole("option");
  if ((await options.count()) < 2) throw new Error("switcher did not list #general from more than one community");
  await page.keyboard.press("ArrowDown");
  const picked = options.nth(1);
  if ((await picked.getAttribute("aria-selected")) !== "true") throw new Error("ArrowDown did not move the switcher choice");
  const pickedIn = (await picked.locator(".sw-community").innerText()).trim();
  await page.keyboard.press("Enter");
  await page.locator(".side-head", { hasText: pickedIn }).waitFor();
  if (await page.getByPlaceholder("Jump to a channel or person").count()) throw new Error("switcher stayed open after Enter");

  // Up arrow in an empty composer edits your last message; Enter saves it.
  const typo = `glaze mesage ${Date.now()}`;
  await composer.fill(typo);
  await composer.press("Enter");
  await page.locator(".channel .msg", { hasText: typo }).waitFor();
  await composer.press("ArrowUp");
  const editBox = page.locator(".channel").getByRole("textbox", { name: "Edit message" });
  if ((await editBox.inputValue()) !== typo) throw new Error(`Up arrow edited "${await editBox.inputValue()}", not the last message`);
  await editBox.fill(typo.replace("mesage", "message"));
  await editBox.press("Enter");
  await page.locator(".channel .msg", { hasText: typo.replace("mesage", "message") }).locator(".edited").waitFor();

  // An invite link fills in the server and the code; a bad code is refused.
  await page.getByRole("button", { name: "Add a community" }).click();
  await page.getByLabel("Community address or invite link").fill("https://letterpress.club/invite/WRONG");
  await page.getByRole("button", { name: "Continue" }).click();
  const codeInput = page.getByLabel("Invite code");
  if ((await codeInput.inputValue()) !== "WRONG") throw new Error("invite code not filled from the link");
  const answer = page.getByLabel("What press do you print on?");
  await answer.fill("no");
  await page.getByRole("button", { name: "Join Letterpress Club" }).click();
  await page.getByRole("alert").filter({ hasText: "invite code doesn't work" }).waitFor();
  await codeInput.fill("inkstained");
  // Join questions: a short answer is refused with the community's own reason, shown inline.
  await page.getByRole("button", { name: "Join Letterpress Club" }).click();
  await page.getByRole("alert").filter({ hasText: "Tell us a little about your press so we know you print." }).waitFor();
  await answer.fill("An Adana 8x5 in the shed");
  await page.getByRole("button", { name: "Join Letterpress Club" }).click();
  await page.locator(".side-head", { hasText: "Letterpress Club" }).waitFor();

  // Phone width: the drawer opens from the header, picking a channel closes it and shows that channel.
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  phone.on("pageerror", (e) => errors.push(e.message));
  await phone.route("http://localhost:8090/**", (r) => r.abort());
  await phone.goto("http://127.0.0.1:5198/?fake=1&quiet=1", { waitUntil: "domcontentloaded" });
  await phone.locator(".channel .msg").first().waitFor();
  if (await phone.locator(".sidebar").isVisible()) throw new Error("sidebar visible at 390px before opening the drawer");
  await phone.getByRole("button", { name: "Open communities and channels" }).click();
  await phone.locator(".sidebar .chan", { hasText: "design" }).click();
  await phone.locator(".channel .composer-input[placeholder='Message #design']").waitFor();
  await phone.waitForFunction(() => document.querySelector(".app")?.getAttribute("data-drawer") === "false");
  if (await phone.locator(".sidebar").isVisible()) throw new Error("drawer stayed open after picking a channel");
  await phone.close();

  if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`);
  console.log("e2e: ok (load, switch community, send, thread, reply, who reacted, drop, private members, invites, admin, new message, profile, message link, mark all read, block and unblock, close a DM, report and resolve, light, dark and midnight themes, custom theme, appearance, browse, preview, join, leave, roles, channel access, channel mode, join questions, shortcuts sheet, message keyboard focus, quick switcher, up-arrow edit, phone drawer)");
} catch (e) {
  failed = true;
  console.error("e2e: FAILED", e.message, errors.join("; "));
  await page.screenshot({ path: new URL("../../artifacts/web/e2e-failure.png", import.meta.url).pathname }).catch(() => {});
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
