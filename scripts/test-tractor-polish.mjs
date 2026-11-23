import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { layout, visibleView } from './tractor-browser-helpers.mjs';
const base = process.env.DESKPARK_URL || 'http://127.0.0.1:8788';
const report = [];
for (const [name, type] of [
  ['chromium', chromium],
  ['webkit', webkit],
]) {
  const browser = await type.launch();
  try {
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 1024, height: 660 },
      { width: 768, height: 1024 },
      { width: 844, height: 390 },
      { width: 390, height: 844 },
    ]) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.addInitScript(() => {
        Math.random = () => 24 / 4294967296;
      });
      await page.goto(base + '/#/play/tractor');
      await page.locator('.tractor[data-paused="true"]').waitFor();
      assert.equal(await page.locator('.tractor__declarations button[data-suit]').count(), 5);
      const before = await visibleView(page);
      assert.equal(before.hand.length, 2);
      await page.waitForTimeout(3500);
      assert.deepEqual(
        await visibleView(page),
        before,
        'real wall-clock freezes bots, human timeout and system',
      );
      const compass = await page
        .locator('.tractor__compass [data-position]')
        .evaluateAll((es) =>
          Object.fromEntries(es.map((e) => [e.dataset.position, Number(e.dataset.seat)])),
        );
      assert.deepEqual(compass, { top: 2, left: 3, right: 1, bottom: 0 });
      const geometry = await layout(page);
      await page.locator('.tractor').evaluate((e) => {
        e.scrollTop = 0;
      });
      if (viewport.width >= 768 && viewport.height >= 660) {
        const bottom = await page
          .locator('.tractor__hand')
          .evaluate((e) => e.getBoundingClientRect().bottom);
        assert(
          bottom <= viewport.height,
          'paused hand visible together with declaration choices on tablets',
        );
      }
      await page.screenshot({
        path: `apps/web/tractor-evidence/polish-${name}-${viewport.width}x${viewport.height}-real-pause.png`,
        fullPage: true,
      });
      await page.locator('.tractor__declarations button[data-suit="H"]').click();
      await page.waitForFunction(
        () =>
          document.querySelector('.tractor').dataset.dealer === '0' &&
          document.querySelector('.tractor').dataset.trump === 'H',
      );
      assert.equal(await page.locator('.tractor').getAttribute('data-paused'), 'false');
      await page.waitForFunction(
        () => document.querySelectorAll('.tractor__hand button').length > 2,
      );
      assert.deepEqual(errors, []);
      report.push({ name, viewport, heldMs: 3500, humanFirstReveal: true, geometry, errors });
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
await writeFile(
  'apps/web/tractor-evidence/polish-real-timer-report.json',
  JSON.stringify({ base, report }, null, 2),
);
console.log('PASS', report.length, 'unaccelerated original browser freeze/reveal/resume layouts');
