const path = require('path');
const pw = require(require.resolve('playwright', { paths: [process.env.NODE_PATH] }));
(async () => {
  const browser = await pw.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
  await page.goto('file://' + path.resolve(__dirname, 'icon.svg'));
  await page.screenshot({ path: path.resolve(__dirname, '..', 'AppIcon-1024.png'), omitBackground: true });
  await browser.close();
  console.log('wrote AppIcon-1024.png');
})();
