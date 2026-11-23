import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

const source = fileURLToPath(new URL('../apps/web/classic/', import.meta.url));
const evidence = fileURLToPath(new URL('../apps/web/classic-evidence/', import.meta.url));
const production = join(homedir(), '.local/share/deskpark/web');
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const classic = pathname.startsWith('/classic/');
  const root = classic ? source : production;
  const rel = classic ? pathname.slice('/classic/'.length) : pathname.slice(1);
  const path = resolve(root, rel.endsWith('/') || !rel ? rel + 'index.html' : rel);
  if (!path.startsWith(root.replace(/\/$/, '') + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const bytes = await readFile(path);
    res.writeHead(200, {
      'content-type': path.endsWith('.js')
        ? 'text/javascript'
        : path.endsWith('.css')
          ? 'text/css'
          : 'text/html',
    });
    res.end(bytes);
  } catch {
    res.writeHead(404).end('Not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = process.env.DESKPARK_URL || `http://127.0.0.1:${server.address().port}`;
await mkdir(evidence, { recursive: true });
try {
  const response = await fetch(base + '/classic/');
  assert.equal(response.status, 200, 'independent classic home exists');
  const html = await response.text();
  assert(html.includes('旧版棋牌室'), 'classic identity is explicit');
  assert(!/<script\b/i.test(html), 'home works without JavaScript');
  assert(
    !/(?:\bgap\s*:|clamp\(|\bmin\(|\bmax\(|:has\(|backdrop-filter\s*:)/.test(html),
    'Safari12-safe CSS',
  );
  for (const [engine, browserType] of [
    ['chromium', chromium],
    ['webkit', webkit],
  ]) {
    const browser = await browserType.launch();
    try {
      for (const [width, height] of [
        [1024, 768],
        [1024, 660],
        [768, 1024],
        [375, 667],
      ]) {
        const page = await browser.newPage({ viewport: { width, height }, hasTouch: true });
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(base + '/classic/');
        await page.getByRole('heading', { name: '旧版棋牌室', exact: true }).waitFor();
        const metrics = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth > innerWidth,
          links: Array.from(document.querySelectorAll('a')).map((e) => {
            const r = e.getBoundingClientRect();
            return { width: r.width, height: r.height, href: e.getAttribute('href') };
          }),
        }));
        assert(!metrics.overflow, 'no horizontal clipping');
        assert(
          metrics.links.every((r) => r.width >= 44 && r.height >= 44),
          'large touch targets',
        );
        assert.deepEqual(
          metrics.links.map((r) => r.href),
          ['/legacy/', '/legacy-tractor/', '/'],
        );
        await page.screenshot({
          path: join(evidence, `${engine}-${width}x${height}.png`),
          fullPage: true,
        });
        for (const [href, title] of [
          ['/legacy/', '斗地主'],
          ['/legacy-tractor/', '拖拉机'],
        ]) {
          await page.locator(`a[href="${href}"]`).click();
          assert.equal(
            new URL(page.url()).pathname,
            href,
            'game opens its isolated existing route',
          );
          await page.getByRole('button', { name: '开始游戏', exact: true }).waitFor();
          assert((await page.locator('body').innerText()).includes(title));
          await page.goBack();
          await page.getByRole('heading', { name: '旧版棋牌室', exact: true }).waitFor();
        }
        assert.deepEqual(errors, [], 'no JavaScript errors across home and both game entries');
        await page.locator('a[href="/"]').click();
        assert.equal(new URL(page.url()).pathname, '/', 'modern entry stays at original address');
        await page.close();
        console.log(
          `PASS ${engine} ${width}x${height}: layout, touch targets, both game entries and back, modern link`,
        );
      }
      const noJS = await browser.newPage({ javaScriptEnabled: false });
      await noJS.goto(base + '/classic/');
      await noJS.getByRole('heading', { name: '旧版棋牌室', exact: true }).waitFor();
      assert.equal(await noJS.locator('a').count(), 3);
      await noJS.close();
    } finally {
      await browser.close();
    }
  }
  console.log('PASS classic homepage: 8 browser/viewport cases and 2 JavaScript-disabled cases');
} finally {
  await new Promise((r) => server.close(r));
}
