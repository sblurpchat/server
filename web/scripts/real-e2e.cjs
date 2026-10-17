// Real-mode run against make dev (portless names; WEB_URL/AUTH_URL override, e.g. PORTLESS=0 ports): sign up, PKCE sign-in,
// join both communities, browse/preview/join/leave (OPT_IN) and a role-gated channel (ROLES), send, thread reply, react, upload, edit, delete, reload, reconnect after a
// server restart (tmux window sblurp7:owls), token refresh in two tabs at once, and screenshots
// (light, dark, 390px) into artifacts/integ/. Run: node scripts/real-e2e.cjs
// TMUX_TARGET overrides the window to restart; SKIP_RESTART=1 skips that step.

const { chromium } = require('playwright');
const { execSync } = require('child_process');
const out = require('path').join(__dirname, '../../artifacts/integ/');
require('fs').rmSync(out, { recursive: true, force: true }); require('fs').mkdirSync(out, { recursive: true });
const WEB = process.env.WEB_URL ?? 'http://app.sblurp.localhost:1355/';
const AUTH = process.env.AUTH_URL ?? 'http://auth.sblurp.localhost:1355';
const at = (base) => (url) => url.href.startsWith(base);
const ok = (cond, what) => { if (!cond) throw new Error(what); console.log('ok', what); };

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route('http://localhost:8090/**', r => r.abort()); // devnotes overlay stays out of screenshots
  const p = await ctx.newPage();
  const errs = [];
  const watch = (pg, tag) => {
    pg.on('pageerror', e => errs.push(`${tag} ${e.message}`));
    pg.on('console', m => m.type() === 'error' && errs.push(`${tag} console: ${m.text()}`));
    pg.on('requestfailed', r => console.log(tag, 'request failed', r.url(), r.failure()?.errorText));
  };
  watch(p, 'tab1');
  let step = 0;
  const shot = async (n, pg = p) => { await pg.waitForTimeout(600); await pg.screenshot({ path: out + `${String(++step).padStart(2, '0')}-${n}.png` }); console.log('shot', n); };
  const signIn = (pg) => pg.getByRole('link', { name: /sign in/i }).or(pg.getByRole('button', { name: /sign in/i })).first().click();

  // Sign up, then PKCE sign-in.
  await p.goto(WEB); await shot('signed-out');
  await signIn(p); await p.waitForURL(at(AUTH)); await shot('auth-login');
  // Auth allows 20 sign-ups an hour per address, so repeated runs fall back to other loopback
  // addresses, straight to the port. Those leave no session cookie, so sign-in may show the login form.
  const u = 'ian' + Date.now().toString().slice(-5);
  let signedUp = false;
  for (const base of [AUTH, 'http://127.0.0.1:8081', 'http://[::1]:8081']) {
    await p.goto(`${base}/signup`);
    await p.fill('#email', u + '@example.com'); await p.fill('#username', u); await p.fill('#password', 'slushie-straw-77'); await p.fill('#dob', '1980-01-01');
    await p.check('input[name=terms]'); await p.getByRole('button', { name: /create|sign up/i }).click(); await p.waitForLoadState();
    if (!(await p.getByText(/too many sign-ups/i).count())) { signedUp = true; break; }
  }
  await shot('after-signup'); ok(signedUp, 'signed up ' + u);
  // The account stays locked until the email is confirmed; dev mail lists newest first.
  const mail = await (await p.request.get(AUTH + '/dev/mail')).text();
  const link = mail.slice(mail.indexOf(u + '@example.com')).match(/\/verify\?token=[\w-]+/);
  ok(link, 'verify mail for ' + u); await p.goto(AUTH + link[0]);
  await p.goto(WEB); await signIn(p);
  await p.waitForURL(u => at(WEB)(u) || at(AUTH)(u), { timeout: 15000 });
  if (p.url().startsWith(AUTH)) {
    await p.fill('#login', u); await p.fill('#password', 'slushie-straw-77'); await p.getByRole('button', { name: 'Sign in' }).click();
  }
  await p.waitForURL(at(WEB), { timeout: 15000 });
  await p.getByRole('button', { name: /^Join Sblurp Community/ }).waitFor({ timeout: 10000 }); await shot('join-card');
  errs.length = 0;

  // Join both communities. Each lands on #general when it has one.
  await p.getByRole('button', { name: /^Join Sblurp Community/ }).click();
  await p.locator('.msg').first().waitFor({ timeout: 10000 });
  ok(await p.locator('.chan-title').innerText() === 'general', 'join lands on #general');
  ok(await p.locator('.mebar .presence.on').count() === 1, 'own avatar shows online');
  await shot('joined-community');

  // Sblurp Community is OPT_IN: a new member starts in the default channels and browses the rest.
  const sideChan = (name) => p.locator('.side-scroll .chan', { hasText: new RegExp(`^${name}$`) });
  ok(await sideChan('help').count() === 1 && await sideChan('random').count() === 0, 'opt-in: only default channels at first');
  await p.getByRole('button', { name: 'Browse channels' }).click();
  await p.locator('.browse-open', { hasText: 'random' }).click();
  await p.locator('.join-bar', { hasText: 'previewing #random' }).waitFor({ timeout: 10000 });
  await p.locator('.channel .msg').first().waitFor({ timeout: 10000 });
  ok(await sideChan('random').count() === 0, 'browse previews #random without joining');
  await shot('preview');
  await p.getByRole('button', { name: 'Join channel' }).click();
  await p.locator('.channel .composer').waitFor({ timeout: 10000 });
  await sideChan('random').waitFor({ timeout: 10000 }); ok(true, 'join puts #random in the sidebar');
  await p.getByRole('button', { name: '#random options' }).click();
  await p.getByRole('menuitem', { name: 'Leave channel' }).click();
  await sideChan('random').waitFor({ state: 'detached', timeout: 10000 }); ok(true, 'leave takes #random out');
  await sideChan('general').click(); await p.locator('.channel .msg').first().waitFor();

  const sent = (pg, text) => pg.locator('.channel .msg[data-pending=false]', { hasText: text });
  const row = (text, scope = '.channel') => p.locator(`${scope} .msg`, { hasText: text });
  const tool = async (r, name) => { await r.hover(); await r.getByRole('button', { name }).click(); };
  const composer = p.locator('.channel .composer-input');
  const t = 'hello from real mode ' + Date.now();
  await composer.fill(t); await composer.press('Enter');
  await sent(p, t).waitFor({ timeout: 10000 }); ok(true, 'send is confirmed');

  // Thread reply.
  await tool(row(t), 'Reply in thread');
  const reply = 'a reply in the thread ' + Date.now();
  const tc = p.locator('.pane .composer-input'); await tc.fill(reply); await tc.press('Enter');
  await row(reply, '.pane').waitFor({ timeout: 10000 });
  await row(t).locator('.thread-link', { hasText: '1 reply' }).waitFor({ timeout: 10000 });
  ok(true, 'thread reply shows in pane and "1 reply" under the root');
  await shot('thread');
  await p.getByRole('button', { name: 'Close thread' }).click();

  // React.
  await tool(row(t), 'Add reaction');
  await p.locator('.emoji-grid button').first().click();
  await row(t).locator('.reaction[aria-pressed=true]', { hasText: '1' }).waitFor({ timeout: 10000 });
  ok(true, 'reaction pill shows 1, pressed');

  // Upload an image (a screenshot of the page itself) and send it.
  const png = await p.screenshot({ clip: { x: 0, y: 0, width: 120, height: 80 } });
  await p.locator('.channel input[type=file]').setInputFiles({ name: 'rail.png', mimeType: 'image/png', buffer: png });
  await p.locator('.channel .chip:not([aria-busy=true])').waitFor({ timeout: 10000 });
  ok(await p.locator('.channel .chip[data-error=true]').count() === 0, 'upload accepted: ' + await p.locator('.channel .chip').innerText());
  const cap = 'image caption ' + Date.now();
  await composer.fill(cap); await composer.press('Enter');
  const img = row(cap).locator('.att-img img');
  await img.waitFor({ timeout: 10000 });
  await p.waitForFunction(el => el.complete && el.naturalWidth > 0, await img.elementHandle(), { timeout: 10000 });
  ok(true, 'uploaded image renders from the server');
  await shot('upload');

  // Edit.
  await tool(row(t), 'Edit message');
  const edited = t + ' (now edited)';
  const eb = p.locator('.channel .edit-box textarea'); await eb.fill(edited); await eb.press('Enter');
  await row(edited).locator('.edited').waitFor({ timeout: 10000 });
  ok(true, 'edit shows new text and "(edited)"');

  // Search jumps to the hit in context: a channel message, then a thread reply.
  const find = async (q) => {
    await p.locator('.chan-search input').fill(q); await p.locator('.chan-search input').press('Enter');
    await p.locator('.result').first().click();
  };
  await find(edited.split(' ')[4]);
  await p.locator('.channel .msg[data-focus=true]', { hasText: edited }).waitFor({ timeout: 10000 });
  await find(reply.split(' ').pop());
  await p.locator('.pane .msg[data-focus=true]', { hasText: reply }).waitFor({ timeout: 10000 });
  ok(true, 'search results jump to and highlight the message and the thread reply');
  await shot('search-jump');
  await p.getByRole('button', { name: 'Close thread' }).click();

  // Delete (the caption message; the edited one keeps its thread).
  await tool(row(cap), 'More actions');
  await p.getByRole('menuitem', { name: 'Delete message' }).click();
  await p.locator('dialog').getByRole('button', { name: 'Delete' }).click();
  await row(cap).waitFor({ state: 'detached', timeout: 10000 });
  ok(true, 'deleted message is gone');

  // Night Owls has no #general.
  await p.getByRole('button', { name: /^Night Owls/ }).click();
  await p.getByRole('button', { name: /^Join Night Owls/ }).click();
  await p.locator('.msg').first().waitFor({ timeout: 10000 }); await shot('joined-owls');
  // Night Owls is ROLES: everyone is in every channel they can see, and #film-club needs the Film club role.
  ok(await p.locator('.side-scroll .chan', { hasText: 'now-reading' }).count() === 1, 'roles mode: in every visible channel');
  // The first person to join a fresh server owns it, and admins see every channel.
  await p.locator('.side-head').click();
  const admin = await p.getByRole('menuitem', { name: 'Community settings' }).count() === 1;
  await p.keyboard.press('Escape');
  ok(await p.locator('.side-scroll .chan', { hasText: 'film-club' }).count() === (admin ? 1 : 0), `role-gated #film-club is ${admin ? 'shown to an admin' : 'hidden without the role'}`);
  ok(await p.getByRole('button', { name: 'Browse channels' }).count() === 0, 'roles mode has no Browse channels');
  await p.reload(); await p.locator('.msg').first().waitFor({ timeout: 10000 });
  ok(await p.locator('.chan-title').count() === 1, 'reload restores the channel');

  // Reconnect after the server restarts.
  if (!process.env.SKIP_RESTART) {
    execSync(`tmux respawn-window -k -t ${process.env.TMUX_TARGET ?? 'sblurp7:owls'}`);
    await p.locator('.banner').waitFor({ timeout: 15000 }); await shot('reconnecting');
    await p.locator('.banner').waitFor({ state: 'detached', timeout: 90000 });
    errs.splice(0); // failed fetches while the server was down are expected
    const back = 'back after restart ' + Date.now();
    await composer.fill(back); await composer.press('Enter');
    await sent(p, back).waitFor({ timeout: 10000 }); ok(true, 'banner cleared and sending works after restart');
  }

  // Token refresh with two tabs open. Tokens issued from now on claim 61s of life, so with the
  // 60s refresh margin every call refreshes, and both tabs rotate the one refresh token at once.
  let refreshes = 0;
  await ctx.route(AUTH + '/oauth/token', async r => {
    const res = await r.fetch(); const j = await res.json();
    if (j.access_token) { j.expires_in = 61; refreshes++; }
    await r.fulfill({ response: res, json: j });
  });
  const p2 = await ctx.newPage(); watch(p2, 'tab2');
  await p2.goto(WEB); await p2.locator('.msg').first().waitFor({ timeout: 15000 });
  await p.waitForTimeout(1500);
  await Promise.all([p, p2].map(async (pg, i) => {
    const s = `tab ${i + 1} after refresh ${Date.now()}`;
    const c = pg.locator('.channel .composer-input');
    await c.fill(s); await c.press('Enter');
    await sent(pg, s).waitFor({ timeout: 20000 });
  }));
  ok(true, 'both tabs send after a concurrent refresh');
  ok(refreshes >= 4, `tokens refreshed (${refreshes} times)`);
  ok(await p.locator('.signin').count() === 0 && await p2.locator('.signin').count() === 0, 'neither tab signed out');
  await p2.close(); await ctx.unroute(AUTH + '/oauth/token');
  errs.splice(0, errs.length, ...errs.filter(e => !/ERR_NETWORK_CHANGED|Failed to load resource.*(net::|8090)/.test(e)));

  // Screenshots: light, dark, 390px.
  await p.getByRole('button', { name: /^Sblurp Community/ }).click(); await p.locator('.msg').first().waitFor();
  for (const theme of ['light', 'dark']) {
    await p.emulateMedia({ colorScheme: theme });
    await p.mouse.move(0, 899);
    await shot(`${theme}-desktop`);
    await tool(row(edited), 'Reply in thread'); await row(reply, '.pane').waitFor(); await p.mouse.move(0, 899); await shot(`${theme}-thread`);
    await p.getByRole('button', { name: 'Close thread' }).click();
    await p.setViewportSize({ width: 390, height: 844 }); await shot(`${theme}-mobile`);
    await p.getByRole('button', { name: /^Open communities and channels/ }).click(); await shot(`${theme}-mobile-drawer`);
    await p.locator('.sidebar .chan[aria-current=page]').click();
    await p.setViewportSize({ width: 1440, height: 900 });
  }

  // Leave Night Owls on the server; it drops off the rail. A second tab still has it open, and
  // the server ends its stream, so that tab shows the removed state instead of reconnecting.
  const rail = (pg) => pg.getByRole('navigation', { name: 'Communities' }).getByRole('button', { name: /^Night Owls/ });
  const owls = rail(p);
  const p3 = await ctx.newPage(); watch(p3, 'tab3');
  await p3.goto(WEB); await p3.locator('.msg').first().waitFor({ timeout: 15000 });
  await owls.click(); await p.locator('.msg').first().waitFor();
  await p.locator('.side-head').click(); await p.getByRole('menuitem', { name: 'Leave community' }).click();
  await p.locator('dialog').getByRole('button', { name: 'Leave' }).click();
  await owls.waitFor({ state: 'detached', timeout: 10000 });
  ok(true, 'leave removes the community');
  await rail(p3).click();
  await p3.getByRole('heading', { name: 'You were removed from Night Owls' }).waitFor({ timeout: 30000 });
  ok(await p3.locator('.banner').count() === 0, 'the other tab shows "removed", not a reconnect loop');
  await shot('removed', p3); await p3.close();
  // Calls that tab made between the server dropping it and the denied reconnect.
  errs.splice(0, errs.length, ...errs.filter(e => !/^tab3 console: Failed to load resource: (net::ERR_FAILED|.*403)/.test(e)));

  console.log('errors:', JSON.stringify(errs.slice(0, 10)));
  ok(errs.length === 0, 'no page errors');
  await b.close();
  console.log('PASS');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
