import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { parse } from 'acorn';
import { chromium, webkit } from 'playwright';
const lanIp =
  networkInterfaces().en0?.find((a) => a.family === 'IPv4' && !a.internal)?.address || '127.0.0.1';
const url = process.env.LEGACY_URL || `http://${lanIp}:8787/legacy/`;
const dir = new URL('../apps/web/dist-legacy/', import.meta.url);
const html = await readFile(new URL('index.html', dir), 'utf8');
assert(!/type="module"|nomodule/.test(html), 'classic script only');
for (const name of await readdir(dir))
  if (name.endsWith('.js')) parse(await readFile(new URL(name, dir), 'utf8'), { ecmaVersion: 5 });
console.log('PASS: all shipped JavaScript parses as ES5');
for (const [name, browserType] of [
  ['chromium', chromium],
  ['webkit', webkit],
]) {
  const browser = await browserType.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 768 }, hasTouch: true });
    const errors = [],
      external = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => {
      if (new URL(r.url()).origin !== new URL(url).origin) external.push(r.url());
    });
    // API deprivation is a regression probe, NOT an iOS 12 emulator.
    await page.addInitScript(() => {
      delete Array.prototype.at;
      delete Array.prototype.flat;
      delete Array.prototype.flatMap;
      delete Object.fromEntries;
      delete window.ResizeObserver;
      delete window.PointerEvent;
      delete window.structuredClone;
    });
    await page.goto(url);
    await page.getByRole('button', { name: '开始游戏', exact: true }).click();
    await page.waitForSelector('[data-phase]');
    let humanPlayed = false,
      turns = 0,
      cardTapped = false;
    while (!(await page.locator('[data-result]').count()) && turns++ < 1000) {
      const bid = page.getByRole('button', { name: '3 分', exact: true });
      const hint = page.getByRole('button', { name: '提示', exact: true });
      if ((await bid.isVisible()) && (await bid.isEnabled())) await bid.click();
      else if ((await hint.isVisible()) && (await hint.isEnabled())) {
        if (!cardTapped) {
          const card = page.locator('.legacy-hand button').first();
          await card.tap();
          assert.equal(await card.getAttribute('aria-pressed'), 'true');
          cardTapped = true;
        }
        await hint.click();
        const play = page.getByRole('button', { name: '出牌', exact: true });
        if (await play.isEnabled()) {
          const before = await page.locator('.legacy-hand button').count();
          await play.click();
          assert(
            (await page.locator('.legacy-hand button').count()) < before,
            'human play removes cards',
          );
          humanPlayed = true;
        } else await page.getByRole('button', { name: '不出', exact: true }).click();
      } else await page.waitForTimeout(100);
    }
    assert(humanPlayed && cardTapped, 'human touch selection and play');
    assert(await page.locator('[data-result]').count(), 'round completes');
    await page.getByRole('button', { name: '继续下一局', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-round="2"]'));
    await page.setViewportSize({ width: 768, height: 1024 });
    assert((await page.locator('.legacy-hand button').count()) >= 17);
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'portrait no horizontal overflow',
    );
    await page.screenshot({
      path: fileURLToPath(new URL(`../apps/web/dist-legacy/${name}-checked.png`, import.meta.url)),
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log(
      `PASS ${name}: missing-modern-API boot, start, touch card, bid, hint, human play, bots, round result, next round, portrait; no page errors/external requests`,
    );
  } finally {
    await browser.close();
  }
}
