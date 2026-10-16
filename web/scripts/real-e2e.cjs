// Real-mode run against make dev (auth 8081, servers 8082/8083, web 5173): sign up, PKCE sign-in,
// join both communities, send, reload. Screenshots go to artifacts/integ/. Run: node scripts/real-e2e.cjs

const { chromium } = require('playwright');
const out = require('path').join(__dirname, '../../artifacts/integ/'); require('fs').mkdirSync(out, { recursive: true });
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => m.type() === 'error' && errs.push('console: ' + m.text()));
  let step = 0; const shot = async n => { await p.waitForTimeout(800); await p.screenshot({ path: out + `${String(++step).padStart(2,'0')}-${n}.png` }); console.log('shot', n, p.url()); };
  await p.goto('http://localhost:5173/'); await shot('signed-out');
  await p.getByRole('link', { name: /sign in/i }).or(p.getByRole('button', { name: /sign in/i })).first().click();
  await p.waitForURL(/8081/); await shot('auth-login');
  await p.goto('http://localhost:8081/signup');
  const u = 'ian' + Date.now().toString().slice(-5);
  await p.fill('#email', u + '@example.com'); await p.fill('#username', u); await p.fill('#password', 'slushie-straw-77'); await p.fill('#dob', '1980-01-01');
  await p.check('input[name=terms]'); await p.getByRole('button', { name: /create|sign up/i }).click(); await p.waitForLoadState(); await shot('after-signup');
  await p.goto('http://localhost:5173/');
  await p.getByRole('link', { name: /sign in/i }).or(p.getByRole('button', { name: /sign in/i })).first().click();
  await p.waitForURL(/5173/, { timeout: 15000 }); await shot('back-in-client');
  await p.waitForTimeout(2000); await shot('after-load');
  errs.length = 0;
  await p.getByRole('button', { name: /^Join Sblurp Community/ }).click();
  await p.locator('.msg').first().waitFor({ timeout: 10000 }); await shot('joined-community');
  const t = 'hello from real mode ' + Date.now();
  const c = p.locator('.channel .composer-input'); await c.fill(t); await c.press('Enter');
  await p.locator('.channel .msg', { hasText: t }).waitFor({ timeout: 10000 }); await shot('sent');
  await p.getByRole('button', { name: /^Night Owls/ }).click(); await p.waitForTimeout(1500);
  await p.getByRole('button', { name: /^Join Night Owls/ }).click();
  await p.locator('.msg').first().waitFor({ timeout: 10000 }); await shot('joined-owls');
  await p.reload(); await p.locator('.msg').first().waitFor({ timeout: 10000 }); await shot('after-reload');
  console.log('errors:', JSON.stringify(errs.slice(0, 10)));
  await b.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
