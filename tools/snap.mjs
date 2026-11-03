// Screenshot a page of web/ in headless Chromium (WebGL via SwiftShader).
//
//   node tools/snap.mjs --url "preview.html?mode=aurora" --out shots/aurora.png
//        [--w 1440] [--h 900] [--dpr 1] [--wait 2500] [--shots 1] [--interval 2000]
//        [--eval "js to run after load"] [--click "#selector"] [--type "1234"] [--full]
//
// Prints console errors/warnings and page errors. Exit code 2 if the page threw.
// With --shots N > 1, writes out-1.png, out-2.png, … spaced --interval ms apart.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { startServer } from './serve.mjs';

// Resolve Playwright from the project, NODE_PATH, or a global install (ESM ignores NODE_PATH).
const require = createRequire(import.meta.url);
function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* fall through */ }
  for (const dir of (process.env.NODE_PATH || '').split(':').filter(Boolean)) {
    try { return require(require.resolve('playwright', { paths: [dir] })); } catch (e) { /* next */ }
  }
  throw new Error('playwright not found; run `npm i -D playwright` or set NODE_PATH');
}
const { chromium } = loadPlaywright();

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const key = k.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { a[key] = true; } else { a[key] = next; i++; }
  }
  return a;
}

const args = parseArgs(process.argv);
if (!args.url || !args.out) {
  console.error('usage: node tools/snap.mjs --url "preview.html?mode=aurora" --out shots/x.png [--w 1440 --h 900 --dpr 1 --wait 2500 --shots 1 --interval 2000 --eval js --click sel --type text]');
  process.exit(1);
}
const W = +args.w || 1440, H = +args.h || 900, DPR = +args.dpr || 1;
const WAIT = args.wait != null ? +args.wait : 2500;
const SHOTS = +args.shots || 1, INTERVAL = +args.interval || 2000;

const { server, url: base } = await startServer(0);
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--autoplay-policy=no-user-gesture-required']
});
let threw = false;
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
  page.on('console', (msg) => {
    const t = msg.type();
    if (t === 'error' || t === 'warning') console.log(`[console.${t}] ${msg.text()}`);
  });
  page.on('pageerror', (err) => { threw = true; console.log(`[pageerror] ${err.message}`); });
  page.on('requestfailed', (r) => console.log(`[requestfailed] ${r.url()} ${r.failure()?.errorText || ''}`));
  page.on('response', (r) => { if (r.status() >= 400) console.log(`[http ${r.status()}] ${r.url()}`); });

  await page.goto(new URL(args.url, base).toString(), { waitUntil: 'load' });
  if (args.eval) await page.evaluate(args.eval);
  if (args.click) await page.click(args.click);
  if (args.type) await page.keyboard.type(String(args.type), { delay: 60 });
  await page.waitForTimeout(WAIT);

  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  for (let i = 0; i < SHOTS; i++) {
    const out = SHOTS === 1 ? args.out : args.out.replace(/(\.png)?$/, `-${i + 1}.png`);
    await page.screenshot({ path: out, fullPage: !!args.full });
    console.log('wrote', out);
    if (i < SHOTS - 1) await page.waitForTimeout(INTERVAL);
  }
  const fps = await page.evaluate(() => (window.__stage && window.__stage.fps) || null).catch(() => null);
  if (fps) console.log('stage fps (swiftshader, not representative of a Mac GPU):', fps);
} finally {
  await browser.close();
  server.close();
}
process.exit(threw ? 2 : 0);
