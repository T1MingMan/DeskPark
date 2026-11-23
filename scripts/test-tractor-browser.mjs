import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { completeRound } from './tractor-browser-helpers.mjs';
const base = process.env.DESKPARK_URL || 'http://127.0.0.1:8788';
await mkdir('apps/web/tractor-evidence', { recursive: true });
const browserName = process.env.DESKPARK_BROWSER || 'chromium';
const browser = await (browserName === 'webkit' ? webkit : chromium).launch();
const report = [];
try {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 1024, height: 660 },
    { width: 768, height: 1024 },
    { width: 844, height: 390 },
    { width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport, hasTouch: true });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => {
      Math.random = () => 79 / 4294967296;
      const timeout = window.setTimeout;
      window.setTimeout = (fn, ms, ...args) =>
        timeout(fn, ms >= 200 && ms <= 2500 ? 45 : ms, ...args);
    });
    await page.goto(base + '/#/play/tractor');
    await page.locator('.tractor').waitFor();
    assert.equal(await page.getByRole('button', { name: '提示', exact: true }).count(), 0);
    await page.locator('.tractor__declarations button:not(:disabled)').first().waitFor();
    await page.locator('.tractor__declarations button:not(:disabled)').first().click();
    const flow = await completeRound(page, {
      touch: true,
      shot: (phase) =>
        `apps/web/tractor-evidence/polish-full-${browserName}-${viewport.width}x${viewport.height}-${phase}.png`,
    });
    assert.equal(await page.locator('.tractor').getAttribute('data-round'), '2');
    assert(flow.buries > 0);
    assert.deepEqual(errors, []);
    report.push({ viewport, ...flow, errors });
    console.log('PASS original real round/throw/next-round', viewport, flow.plays);
    await page.close();
  }
  await writeFile(
    `apps/web/tractor-evidence/polish-full-${browserName}-report.json`,
    JSON.stringify({ base, browserName, report }, null, 2),
  );
} finally {
  await browser.close();
}
