import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
const evidence = 'apps/web/classic-evidence/senior';
await mkdir(evidence, { recursive: true });
const server = createServer(async (req, res) => {
  const p = new URL(req.url, 'http://localhost').pathname;
  const root = p.startsWith('/legacy-tractor/')
    ? 'apps/web/dist-legacy-tractor/'
    : p.startsWith('/legacy/')
      ? 'apps/web/dist-legacy/'
      : 'apps/web/classic/';
  const name = p.split('/').pop() || 'index.html';
  try {
    const b = await readFile(root + name);
    res.writeHead(200, {
      'content-type': name.endsWith('.js')
        ? 'text/javascript'
        : name.endsWith('.css')
          ? 'text/css'
          : 'text/html',
    });
    res.end(b);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = process.env.DESKPARK_URL || `http://127.0.0.1:${server.address().port}`;
const report = [];
try {
  for (const [engine, type] of [
    ['chromium', chromium],
    ['webkit', webkit],
  ]) {
    const browser = await type.launch();
    try {
      for (const [width, height] of [
        [1024, 768],
        [1024, 660],
        [768, 1024],
        [375, 667],
      ]) {
        for (const route of process.env.ONLY_TRACTOR
          ? ['/legacy-tractor/']
          : ['/legacy/', '/legacy-tractor/']) {
          const page = await browser.newPage({ viewport: { width, height }, hasTouch: true });
          const errors = [];
          page.on('pageerror', (e) => errors.push(e.message));
          await page.addInitScript(() => {
            Date.now = () => 24;
          });
          await page.goto(base + route);
          const link = page.getByRole('link', { name: '返回大厅', exact: true });
          const failures = [];
          if ((await link.count()) !== 1) failures.push('missing 返回大厅');
          else {
            assert.equal(await link.getAttribute('href'), '/classic/');
            const r = await link.boundingBox();
            assert(r.width >= 44 && r.height >= 44);
          }
          if (await page.locator('nav a:not([href="/classic/"])').count())
            failures.push('game has forbidden direct navigation');
          await page.getByRole('button', { name: '开始游戏', exact: true }).click();
          if (route.includes('tractor')) await page.waitForSelector('[data-paused="true"]');
          else await page.getByRole('button', { name: '3 分', exact: true }).click();
          const geometry = await page.evaluate(() => {
            const sels = [
              '.topbar',
              '.summary',
              '.trump-banner',
              '.compass .play',
              '.bottom',
              '.table-center',
              '.player-area',
            ];
            const rs = sels.flatMap((s) =>
              Array.from(document.querySelectorAll(s)).map((e) => ({
                s,
                r: e.getBoundingClientRect().toJSON(),
              })),
            );
            const collisions = [];
            for (let i = 0; i < rs.length; i++)
              for (let j = i + 1; j < rs.length; j++) {
                const a = rs[i].r,
                  b = rs[j].r;
                if (
                  Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
                  Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
                )
                  collisions.push([rs[i].s, rs[j].s]);
              }
            const hand = Array.from(
              document.querySelectorAll('.hand button,.legacy-hand button'),
            ).map((e) => e.getBoundingClientRect());
            const tiny = hand.filter((r) => r.width < 44 || r.height < 44).length;
            const outside = hand.filter(
              (r) =>
                r.left < 0 ||
                r.right > innerWidth + 1 ||
                (innerWidth >= 768 && r.bottom > innerHeight + 1),
            ).length;
            const bar = document.querySelector('.topbar').getBoundingClientRect();
            const headerOutside = Array.from(
              document.querySelectorAll('.topbar h1,.topbar nav'),
            ).some((e) => {
              const r = e.getBoundingClientRect();
              return r.top < bar.top || r.bottom > bar.bottom;
            });
            return {
              collisions,
              tiny,
              outside,
              headerOutside,
              overflow: document.documentElement.scrollWidth > innerWidth,
            };
          });
          if (geometry.collisions.length)
            failures.push('overlapping top/seat bands ' + JSON.stringify(geometry.collisions));
          assert(!geometry.overflow);
          assert.equal(geometry.tiny, 0);
          assert.equal(geometry.outside, 0);
          assert(!geometry.headerOutside);
          await page.screenshot({
            path: `${evidence}/${engine}-${width}x${height}-${route.includes('tractor') ? 'tractor' : 'ddz'}.png`,
            fullPage: true,
          });
          if (!failures.length) {
            let dialog = '';
            page.once('dialog', async (d) => {
              dialog = d.message();
              await d.dismiss();
            });
            await link.click();
            assert(dialog.includes('当前牌局'), 'exit warns about lost game');
            assert.equal(new URL(page.url()).pathname, route);
            page.once('dialog', (d) => d.accept());
            await link.click();
            await page.waitForURL('**/classic/');
            await page.goto(base + route);
            await page.getByRole('link', { name: '返回大厅', exact: true }).click();
            await page.waitForURL('**/classic/');
          }
          report.push({ engine, width, height, route, geometry, failures, errors });
          await writeFile(`${evidence}/report.json`, JSON.stringify({ base, report }, null, 2));
          assert.deepEqual(failures, []);
          assert.deepEqual(errors, []);
          console.log(`PASS senior ${engine} ${width}x${height} ${route}`);
          await page.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise((r) => server.close(r));
}
