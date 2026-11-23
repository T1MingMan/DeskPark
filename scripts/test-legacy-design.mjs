import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
const dir = new URL('../apps/web/dist-legacy/', import.meta.url);
const shots = new URL('../apps/web/legacy-evidence/', import.meta.url);
await mkdir(shots, { recursive: true });
const css = await readFile(new URL('../apps/web/legacy/legacy.css', import.meta.url), 'utf8');
assert(
  !/(?:\bgap\s*:|clamp\(|\bmin\(|\bmax\(|aspect-ratio\s*:|backdrop-filter\s*:)/.test(css),
  'Safari12-safe CSS',
);
const server = createServer(async (req, res) => {
  try {
    const name = new URL(req.url, 'http://localhost').pathname.split('/').pop() || 'index.html';
    const body = await readFile(new URL(name, dir));
    res.writeHead(200, {
      'Content-Type': name.endsWith('.js')
        ? 'text/javascript'
        : name.endsWith('.css')
          ? 'text/css'
          : 'text/html',
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
try {
  for (const [name, type] of [
    ['chromium', chromium],
    ['webkit', webkit],
  ]) {
    const browser = await type.launch();
    try {
      for (const [orientation, width, height] of [
        ['landscape', 1024, 768],
        ['portrait', 768, 1024],
      ]) {
        const page = await browser.newPage({ viewport: { width, height }, hasTouch: true });
        await page.addInitScript(() => {
          Date.now = () => 42;
        });
        await page.goto(`http://127.0.0.1:${server.address().port}/legacy/?check=3`);
        await page.getByRole('button', { name: '开始游戏', exact: true }).click();
        const bid = page.getByRole('button', { name: '3 分', exact: true });
        await bid.waitFor();
        await bid.click();
        await page.waitForSelector('[data-phase="playing"]');
        assert.equal(
          await page.locator('.legacy-hand button').count(),
          20,
          'human landlord full hand',
        );
        assert.equal(
          await page.locator('.table-surface').count(),
          1,
          'dedicated table composition',
        );
        assert.equal(
          await page.locator('.seat-avatar').count(),
          3,
          'three readable player identities',
        );
        const metrics = await page.evaluate(() => {
          const rects = [...document.querySelectorAll('.legacy-hand button')].map((e) => {
            const r = e.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
          });
          const cards = [...document.querySelectorAll('.legacy-hand .pcard')].map((e) => {
            const r = e.getBoundingClientRect();
            return { x: r.x, right: r.right, bottom: r.bottom };
          });
          return {
            rects,
            cards,
            sw: document.documentElement.scrollWidth,
            sh: document.documentElement.scrollHeight,
          };
        });
        assert(metrics.sw <= width, 'no horizontal overflow');
        assert(metrics.sh <= height, 'full iPad table fits viewport');
        for (const r of metrics.rects)
          assert(r.w >= 44 && r.h >= 44, 'exposed card touch target at least 44px');
        for (const r of metrics.cards)
          assert(
            r.x >= 0 && r.right <= width && r.bottom <= height,
            'all 20 cards fully inside viewport',
          );
        for (let i = 0; i < 20; i++) {
          const button = page.locator('.legacy-hand button').nth(i);
          const r = await button.boundingBox();
          await page.touchscreen.tap(r.x + 15, r.y + 35);
          assert.equal(
            await button.getAttribute('aria-pressed'),
            'true',
            `exposed card ${i} selectable`,
          );
        }
        await page.getByRole('button', { name: '清空选择', exact: true }).click();
        await page.getByRole('button', { name: '提示', exact: true }).click();
        assert(await page.locator('.legacy-hand button[aria-pressed="true"]').count());
        await page.screenshot({
          path: fileURLToPath(new URL(`${name}-${orientation}-20cards.png`, shots)),
        });
        await page.getByRole('button', { name: '出牌', exact: true }).click();
        assert((await page.locator('.legacy-hand button').count()) < 20);
        await page.close();
        console.log(
          `PASS ${name} ${orientation}: 20 cards, all touch targets, viewport fit, clear/hint/play`,
        );
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise((r) => server.close(r));
}
