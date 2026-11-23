import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { layout, visibleView } from './tractor-browser-helpers.mjs';
const base = process.env.DESKPARK_URL || 'http://127.0.0.1:8788';
const dir = 'apps/web/tractor-evidence/refinements-modern';
await mkdir(dir, { recursive: true });
const report = [];
for (const [name, type] of [
  ['chromium', chromium],
  ['webkit', webkit],
]) {
  const browser = await type.launch();
  try {
    for (const [width, height] of [
      [1280, 800],
      [1024, 768],
      [1024, 660],
      [768, 1024],
      [844, 390],
      [390, 844],
    ]) {
      const page = await browser.newPage({ viewport: { width, height }, hasTouch: true });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.addInitScript(() => {
        Math.random = () => 3 / 4294967296;
      });
      await page.goto(base + '/#/play/tractor');
      await page.locator('.tractor').waitFor();
      assert.equal(await page.locator('.tractor__info').innerText(), '', 'no round/phase prose');
      assert.equal(await page.locator('.tractor__declarer').count(), 0, 'no declarer prose');
      assert.equal(
        await page.locator('.tractor__trump .pcard').count(),
        1,
        'upper-left playing-card badge',
      );
      assert.equal(await page.locator('.tractor__declarations button').count(), 5);
      const dealTimes = [];
      let prev = 0;
      const start = Date.now();
      while (Date.now() - start < 15000) {
        const v = await visibleView(page);
        if (v.hand.length !== prev) {
          const declarations = await page
            .locator('.tractor__seat [data-cid]')
            .evaluateAll((es) => es.map((e) => e.dataset.cid).join(','));
          dealTimes.push({ n: v.hand.length, time: Date.now(), declarations });
          prev = v.hand.length;
        }
        if (v.paused) break;
        await page.waitForTimeout(10);
      }
      const v = await visibleView(page);
      assert(v.paused);
      assert.equal(v.hand.length, 14);
      const before = await page
        .locator('.tractor__seat[data-seat="1"] [data-cid]')
        .evaluateAll((es) => es.map((e) => Number(e.dataset.cid)));
      assert.deepEqual(before, [67], 'actual computer announcement attributed to seat1');
      await page.waitForTimeout(3600);
      assert.deepEqual(await visibleView(page), v, 'indefinite decision freezes bots/system');
      await page.locator('.tractor__declarations [data-suit="J"]').click();
      await page.waitForFunction(() => document.querySelector('.tractor').dataset.trump === 'J');
      assert.equal(
        await page.locator('.tractor__trump .pcard').count(),
        0,
        'no-trump uses no playing-card badge',
      );
      assert.match(await page.locator('.tractor__trump').innerText(), /无主/);
      assert.deepEqual(
        await page
          .locator('.tractor__seat[data-seat="1"] [data-cid]')
          .evaluateAll((es) => es.map((e) => Number(e.dataset.cid))),
        [67],
      );
      assert.deepEqual(
        (
          await page
            .locator('.tractor__seat[data-seat="0"] [data-cid]')
            .evaluateAll((es) => es.map((e) => Number(e.dataset.cid)))
        ).sort((a, b) => a - b),
        [53, 107],
      );
      assert.equal(
        await page.locator('.pcard--joker svg').count(),
        await page.locator('.pcard--joker').count(),
      );
      assert.equal(
        await page
          .locator('.pcard--joker')
          .evaluateAll((es) => es.some((e) => /大王|小王/.test(e.textContent))),
        false,
      );
      const geometry = await layout(page);
      const centerClear = await page.locator('.tractor__center').evaluate((e) => {
        const r = e.getBoundingClientRect();
        return [...document.querySelectorAll('.tractor__seat')].every((s) => {
          const b = s.getBoundingClientRect();
          return (
            Math.min(r.right, b.right) <= Math.max(r.left, b.left) ||
            Math.min(r.bottom, b.bottom) <= Math.max(r.top, b.top)
          );
        });
      });
      assert(centerClear, 'center tally must never overlap player names or cards');
      const areas = await page.locator('.tractor__seat').evaluateAll((es) =>
        es.map((e) => {
          const r = e.getBoundingClientRect(),
            a = e.querySelector('.tractor__played-cards').getBoundingClientRect();
          return {
            seat: e.dataset.seat,
            contained:
              a.top >= r.top && a.bottom <= r.bottom && a.left >= r.left && a.right <= r.right,
            height: a.height,
            cards: [...e.querySelectorAll('.pcard')].map((c) => {
              const x = c.getBoundingClientRect();
              return { w: x.width, h: x.height };
            }),
          };
        }),
      );
      assert(
        areas.every(
          (a) => a.contained && a.height >= 72 && a.cards.every((c) => c.w >= 50 && c.h >= 70),
        ),
        JSON.stringify(areas),
      );
      await page.locator('.tractor').evaluate((e) => (e.scrollTop = 0));
      await page.screenshot({
        path: `${dir}/${name}-${width}x${height}-overcall.png`,
        fullPage: true,
      });
      await page.waitForFunction(
        () => !['dealing', 'reveal'].includes(document.querySelector('.tractor').dataset.phase),
        {},
        { timeout: 18000 },
      );
      assert.equal(await page.locator('.tractor__seat [data-cid]').count(), 0, 'clear at bury');
      assert.deepEqual(errors, []);
      // Initial worker render is not a clock tick; accepted bot declarations reschedule the next deal.
      const intervals = dealTimes
        .slice(1)
        .flatMap((d, i) =>
          dealTimes[i].n > 0 && d.declarations === dealTimes[i].declarations
            ? [d.time - dealTimes[i].time]
            : [],
        );
      assert(
        intervals.filter((ms) => ms >= 420 && ms < 700).length >= 8,
        JSON.stringify({ intervals, dealTimes }),
      );
      report.push({ name, width, height, holdMs: 3600, intervals, areas, geometry, errors });
      await writeFile(`${dir}/browser-report.json`, JSON.stringify({ base, report }, null, 2));
      await page.close();
      console.log('PASS refinements', name, width, height);
    }
  } finally {
    await browser.close();
  }
}
