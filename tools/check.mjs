// Web smoke tests for Analog Brick (headless Chromium + SwiftShader WebGL).
//
//   node tools/check.mjs [--out build/web-shots] [--only modes|pages|unlock]
//
// 1. Every registered visual mode renders without errors and isn't a blank frame,
//    at full size and as a small thumbnail, and survives a crossfade to another mode.
// 2. setup.html and lock.html (primary + secondary) load against their mocks without errors.
// 3. The unlock ritual works end to end through the real lock UI: PIN ×3, each followed by
//    "are you sure?" whose confirm button is refused until the delay has passed, then 'ending'.
// Exits non-zero on any failure.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './serve.mjs';

const require = createRequire(import.meta.url);
function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* fall through */ }
  for (const dir of (process.env.NODE_PATH || '').split(':').filter(Boolean)) {
    try { return require(require.resolve('playwright', { paths: [dir] })); } catch (e) { /* next */ }
  }
  throw new Error('playwright not found; run `npm i -D playwright` or set NODE_PATH');
}
const { chromium } = loadPlaywright();

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const OUT = path.resolve(args.out || 'build/web-shots');
fs.mkdirSync(OUT, { recursive: true });

const failures = [];
const fail = (what, why) => { failures.push(`${what}: ${why}`); console.log(`  ✗ ${what}: ${why}`); };
const pass = (what) => console.log(`  ✓ ${what}`);

const { server, url: base } = await startServer(0);
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

async function openPage(urlPath, { w = 1440, h = 900 } = {}) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()); });
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  await page.goto(new URL(urlPath, base).toString(), { waitUntil: 'load' });
  return { page, errors };
}

/** Mean and std-dev of luminance of a screenshot, computed in a scratch page. */
async function imageStats(png) {
  const p = await browser.newPage();
  const stats = await p.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 160; c.height = Math.max(1, Math.round(160 * img.height / img.width));
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let sum = 0, sum2 = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      sum += l; sum2 += l * l; n++;
    }
    const mean = sum / n;
    return { mean, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)) };
  }, png.toString('base64'));
  await p.close();
  return stats;
}

// ───────────────────────── 1. visual modes ─────────────────────────
async function checkModes() {
  console.log('Visual modes');
  const { page: probe } = await openPage('preview.html');
  const modes = await probe.evaluate(() => BrickVisuals.list().map((m) => ({ id: m.id, name: m.name, tagline: m.tagline })));
  await probe.close();
  const expected = ['aurora', 'drift', 'breath', 'horizon', 'night', 'pulse', 'gallery'];
  for (const id of expected) if (!modes.find((m) => m.id === id)) fail(`mode ${id}`, 'not registered');
  for (const m of modes) {
    if (!m.name || !m.tagline) fail(`mode ${m.id}`, 'missing name or tagline');
    const extra = m.id === 'pulse' ? '&audio=synthetic' : m.id === 'gallery' ? '&images=3' : '';
    for (const [label, w, h] of [['full', 1440, 900], ['thumb', 320, 200]]) {
      const { page, errors } = await openPage(`preview.html?mode=${m.id}${extra}`, { w, h });
      await page.waitForTimeout(label === 'full' ? 3500 : 2000);
      const shot = await page.screenshot({ path: path.join(OUT, `mode-${m.id}-${label}.png`) });
      const active = await page.evaluate(() => window.__stage && window.__stage.layers.map((l) => l.def.id));
      const s = await imageStats(shot);
      if (errors.length) fail(`mode ${m.id} (${label})`, errors.join(' | '));
      else if (active && active.includes('__fallback')) fail(`mode ${m.id} (${label})`, 'fell back to the fallback visual');
      else if (s.mean < 1.5 && s.std < 1.5) fail(`mode ${m.id} (${label})`, `frame looks blank (mean ${s.mean.toFixed(1)})`);
      else pass(`mode ${m.id} (${label}) mean ${s.mean.toFixed(1)} std ${s.std.toFixed(1)}`);
      if (label === 'full') {
        // Crossfade away and back: exercises destroy() and re-create.
        const other = m.id === 'aurora' ? 'night' : 'aurora';
        await page.evaluate((o) => window.__stage.setMode(o, { transition: 300 }), other);
        await page.waitForTimeout(700);
        await page.evaluate((id) => window.__stage.setMode(id, { transition: 300 }), m.id);
        await page.waitForTimeout(900);
        const layers = await page.evaluate(() => window.__stage.layers.length);
        if (errors.length) fail(`mode ${m.id} crossfade`, errors.join(' | '));
        else if (layers !== 1) fail(`mode ${m.id} crossfade`, `${layers} layers left after transition`);
        else pass(`mode ${m.id} crossfade`);
      }
      await page.close();
    }
  }
}

// ───────────────────────── 2. pages ─────────────────────────
async function checkPages() {
  console.log('Pages');
  const pages = [
    ['setup', 'setup.html', 1040, 720],
    ['setup-missing', 'setup.html?focus=missing&spotify=undetermined&audio=denied&login=requiresApproval&stats=empty', 1040, 720],
    ['lock-primary', 'lock.html?minutes=50&elapsed=12&mode=aurora&intention=Chapter%203%20outline', 1440, 900],
    ['lock-secondary', 'lock.html?role=secondary&display=1&mode=night', 1440, 900],
    ['lock-pulse', 'lock.html?mode=pulse&audio=1', 1440, 900],
    ['lock-nospotify', 'lock.html?spotify=off', 1440, 900],
  ];
  for (const [name, url, w, h] of pages) {
    const { page, errors } = await openPage(url, { w, h });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(OUT, `page-${name}.png`) });
    if (errors.length) fail(`page ${name}`, errors.join(' | '));
    else pass(`page ${name}`);
    await page.close();
  }
}

// ───────────────────────── 3. the unlock ritual ─────────────────────────
async function checkUnlock() {
  console.log('Unlock ritual (via the lock UI and its mock)');
  const { page, errors } = await openPage('lock.html?minutes=25&elapsed=3&pin=2468');
  await page.evaluate(() => {
    window.__unlockLog = [];
    window.__ending = null;
    Brick.on('unlock', (s) => window.__unlockLog.push(s));
    Brick.on('ending', (e) => { window.__ending = e; });
  });
  await page.waitForTimeout(1200);
  const last = () => page.evaluate(() => window.__unlockLog[window.__unlockLog.length - 1] || null);
  const waitFor = async (pred, ms = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const s = await last();
      if (s && pred(s)) return s;
      await page.waitForTimeout(100);
    }
    return null;
  };

  // Open the flow the way a user would: the U shortcut (falls back to the bridge if the UI ignores it).
  await page.mouse.move(400, 400);
  await page.keyboard.press('KeyU');
  let s = await waitFor((x) => x.stage === 'pin', 1500);
  if (!s) {
    await page.evaluate(() => Brick.send('unlock.begin', {}));
    s = await waitFor((x) => x.stage === 'pin');
  }
  if (!s) { fail('unlock', 'never reached the PIN stage'); await page.close(); return; }

  // A wrong PIN first.
  await page.keyboard.type('1111', { delay: 40 });
  s = await waitFor((x) => x.error === 'wrong-pin');
  if (!s) fail('unlock wrong PIN', 'no wrong-pin error'); else pass('wrong PIN is rejected');

  for (let step = 1; step <= 3; step++) {
    await page.waitForTimeout(400);
    await page.keyboard.type('2468', { delay: 40 });
    s = await waitFor((x) => x.stage === 'confirm' && x.step === step);
    if (!s) { fail(`unlock step ${step}`, 'PIN did not lead to confirm'); break; }
    await page.screenshot({ path: path.join(OUT, `unlock-confirm-${step}.png`) });
    // Too early: the native side (mock) must refuse.
    await page.evaluate(() => Brick.send('unlock.confirm', {}));
    await page.waitForTimeout(300);
    const still = await last();
    if (still.stage !== 'confirm' || still.step !== step) fail(`unlock step ${step}`, 'confirm accepted before the delay');
    else pass(`step ${step}: early confirm refused`);
    await page.waitForTimeout(s.confirmDelayMs + 200);
    // Click the real "I'm sure" button if we can find it, otherwise use the bridge.
    const clicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        b.offsetParent !== null && !b.disabled && /sure|unlock/i.test(b.textContent) && !/keep|stay|back/i.test(b.textContent));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!clicked) await page.evaluate(() => Brick.send('unlock.confirm', {}));
    if (step < 3) {
      s = await waitFor((x) => x.stage === 'pin' && x.step === step + 1);
      if (!s) { fail(`unlock step ${step}`, 'did not advance'); break; }
      pass(`step ${step} confirmed${clicked ? ' (button)' : ' (bridge)'}`);
    } else {
      s = await waitFor((x) => x.stage === 'unlocked');
      if (!s) fail('unlock', 'never unlocked'); else pass('unlocked after 3 PINs + 3 confirmations');
    }
  }
  await page.waitForTimeout(2000);
  const ending = await page.evaluate(() => window.__ending);
  if (!ending || ending.reason !== 'unlocked') fail('unlock ending', 'no ending{reason:"unlocked"} event');
  else pass('ending event received');
  await page.screenshot({ path: path.join(OUT, 'unlock-ending.png') });
  if (errors.length) fail('unlock page errors', errors.join(' | '));
  await page.close();
}

try {
  const only = args.only;
  if (!only || only === 'modes') await checkModes();
  if (!only || only === 'pages') await checkPages();
  if (!only || only === 'unlock') await checkUnlock();
} finally {
  await browser.close();
  server.close();
}

console.log(failures.length ? `\n${failures.length} failure(s)` : '\nAll web checks passed');
console.log('Screenshots in', OUT);
process.exit(failures.length ? 1 : 0);
