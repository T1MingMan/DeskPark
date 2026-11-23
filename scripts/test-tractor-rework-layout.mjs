import assert from 'node:assert/strict';
import { networkInterfaces } from 'node:os';
import { chromium } from 'playwright';
const lanIp =
  networkInterfaces().en0?.find((a) => a.family === 'IPv4' && !a.internal)?.address || '127.0.0.1';
const base = process.env.DESKPARK_URL || `http://${lanIp}:8787`;
const browser = await chromium.launch();
try {
  for (const viewport of [
    { width: 844, height: 390 },
    { width: 1024, height: 660 },
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport });
    await page.goto(base + '/#/play/tractor');
    await page.locator('.tractor').waitFor();
    assert.equal(
      await page.getByRole('button', { name: '提示', exact: true }).count(),
      0,
      'no human hint feature',
    );
    assert.equal(
      await page.locator('.tractor').getAttribute('data-phase'),
      'dealing',
      'real progressive deal',
    );
    await page.waitForTimeout(1300);
    const n = await page.locator('.tractor__hand button').count();
    assert(n > 0 && n < 25, 'hand grows during deal');
    const overlap = await page.evaluate(() => {
      const selectors = ['.tractor__info', '.tractor__score', '.tractor__arena', '.tractor__dock'];
      const rs = selectors.map((s) => document.querySelector(s).getBoundingClientRect());
      return rs.slice(1).some((r, i) => r.top < rs[i].bottom - 1);
    });
    assert.equal(overlap, false, 'principal bands must not collide');
    await page.screenshot({
      path: `apps/web/tractor-evidence/rework-${viewport.width}x${viewport.height}-deal.png`,
    });
    await page.close();
    console.log('PASS original layout/deal', viewport);
  }
} finally {
  await browser.close();
}
