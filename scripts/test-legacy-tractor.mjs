import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { parse } from 'acorn';
import { completeRound, layout } from './tractor-browser-helpers.mjs';
const dir = new URL('../apps/web/dist-legacy-tractor/', import.meta.url);
await mkdir('apps/web/legacy-tractor-evidence', { recursive: true });
const html = await readFile(new URL('index.html', dir), 'utf8');
assert(!html.includes('type="module"'));
for (const [, src] of html.matchAll(/<script[^>]+src="([^"]+)"/g))
  parse(await readFile(new URL(src.split('/').pop(), dir), 'utf8'), { ecmaVersion: 5 });
const css = await readFile('apps/web/legacy-tractor/tractor.css', 'utf8');
assert(!/(?:\bgap\s*:|clamp\(|\bmin\(|\bmax\(|aspect-ratio\s*:|backdrop-filter\s*:)/.test(css));
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
const base =
  process.env.DESKPARK_LEGACY_URL || `http://127.0.0.1:${server.address().port}/legacy-tractor/`;
const report = [];
try {
  for (const [name, type] of [
    ['chromium', chromium],
    ['webkit', webkit],
  ]) {
    const browser = await type.launch();
    try {
      // Real wall-clock timers: do not accelerate this opportunity/race acceptance check.
      const real = await browser.newPage({ viewport: { width: 1024, height: 768 } });
      await real.addInitScript(() => {
        Date.now = () => 10;
      });
      await real.goto(base);
      await real.getByRole('button', { name: '开始游戏', exact: true }).click();
      const start = performance.now();
      await real.waitForSelector('[data-dealt="1"]');
      const firstCardMs = performance.now() - start;
      assert(firstCardMs >= 400 && firstCardMs < 1000, 'actual 450ms incremental dealing');
      await real.waitForSelector('[data-paused="true"]', { timeout: 35000 });
      const snapshot = () =>
        real.locator('[data-phase]').evaluate((e) => ({
          dealt: e.dataset.dealt,
          bid: e.dataset.bidSeat,
          strength: e.dataset.bidStrength,
          cards: Array.from(e.querySelectorAll('.hand button')).map((c) => c.dataset.cid),
        }));
      const held = await snapshot();
      await real.waitForTimeout(3600);
      assert.deepEqual(
        await snapshot(),
        held,
        'deal AND computer reveal freeze past multiple ticks',
      );
      assert.equal(await real.locator('[data-declare]').count(), 5);
      await real.screenshot({
        path: `apps/web/legacy-tractor-evidence/ux-${name}-real-paused.png`,
        fullPage: true,
      });
      await real.locator('[data-declare]:enabled').first().click();
      assert.equal(
        await real.locator('[data-phase]').getAttribute('data-bid-seat'),
        '0',
        'human declares before computer can steal decision',
      );
      await real.waitForSelector('[data-paused="true"]', { timeout: 35000 });
      const second = await snapshot();
      assert(second.dealt !== held.dealt, 'later new stronger/changed option pauses again');
      await real.waitForTimeout(2600);
      assert.deepEqual(await snapshot(), second);
      await real.getByRole('button', { name: '暂不亮 / 继续发牌', exact: true }).click();
      await real.waitForFunction(
        (dealt) => document.querySelector('[data-phase]').dataset.dealt !== dealt,
        second.dealt,
      );
      report.push({
        name,
        realTimers: true,
        firstCardMs,
        held,
        second,
        frozenMs: 6200,
        humanBeforeBot: true,
        skipResumed: true,
      });
      await real.close();
      const race = await browser.newPage({ viewport: { width: 1024, height: 768 } });
      await race.addInitScript(() => {
        Date.now = () => 24;
      });
      await race.goto(base);
      await race.getByRole('button', { name: '开始游戏', exact: true }).click();
      await race.waitForSelector('[data-paused="true"]', { timeout: 10000 });
      await race.waitForTimeout(3600);
      assert.equal(await race.locator('[data-phase]').getAttribute('data-dealt'), '2');
      assert.equal(
        await race.locator('[data-phase]').getAttribute('data-bid-seat'),
        '-1',
        'two bots with legal reveals cannot act while human decision is pending',
      );
      await race.locator('[data-declare]:enabled').first().click();
      assert.equal(await race.locator('[data-phase]').getAttribute('data-bid-seat'), '0');
      report.push({
        name,
        simultaneousLegalBots: [1, 2],
        seed: 24,
        frozenMs: 3600,
        humanWonFirstDeclaration: true,
      });
      await race.close();
      for (const [orientation, width, height] of [
        ['landscape', 1024, 768],
        ['portrait', 768, 1024],
        ['bars', 1024, 660],
        ['phone-landscape', 844, 390],
      ]) {
        const page = await browser.newPage({ viewport: { width, height }, hasTouch: true });
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.addInitScript(() => {
          Date.now = () => 79;
          const timeout = window.setTimeout;
          window.setTimeout = (fn, ms, ...args) =>
            timeout(fn, ms >= 200 && ms <= 2500 ? 45 : ms, ...args);
          window.Worker = undefined;
          window.ResizeObserver = undefined;
          window.PointerEvent = undefined;
          window.structuredClone = undefined;
          Array.prototype.flat = undefined;
          Array.prototype.flatMap = undefined;
          Object.fromEntries = undefined;
        });
        await page.goto(base);
        await page.getByRole('button', { name: '开始游戏', exact: true }).click();
        assert.equal(await page.locator('#legacy-diagnostics').isVisible(), false);
        assert.equal(await page.getByRole('button', { name: '提示', exact: true }).count(), 0);
        // No hidden test interface: expose a human level from actual visible card labels while the deal is still underway.
        let revealed = false;
        for (let n = 0; n < 80; n++) {
          const table = page.locator('[data-phase]');
          const phase = await table.getAttribute('data-phase');
          if (phase !== 'dealing' && phase !== 'reveal') break;
          const declaration = page.locator('[data-declare]:enabled');
          if (await declaration.count()) {
            await declaration.first().click();
            revealed = true;
            break;
          }
          await page.waitForTimeout(10);
        }
        const flow = await completeRound(page, {
          legacy: true,
          shot: (phase) =>
            `apps/web/legacy-tractor-evidence/rework-${name}-${orientation}-${phase}.png`,
        });
        assert(revealed, 'human reveal during progressive dealing');
        assert(flow.buries > 0, 'human dealer gets 33 then buries 8');
        assert.deepEqual(errors, []);
        await layout(page, true);
        await page.evaluate(() => window.DeskParkLegacy.fail(new Error('late diagnostic test')));
        assert(await page.locator('#legacy-diagnostics').isVisible());
        report.push({ name, orientation, width, height, revealed, ...flow, errors });
        console.log(
          `PASS ${name} ${orientation}: ES5/API deletion, progressive human reveal, 33-card bury, play/throw, next round, geometry, diagnostics`,
        );
        await page.close();
      }
      const nojs = await browser.newPage({ javaScriptEnabled: false });
      await nojs.goto(base);
      assert(await nojs.locator('#legacy-diagnostics').isVisible());
      await nojs.close();
      const blocked = await browser.newPage();
      await blocked.route('**/game-*.js', (r) => r.abort());
      await blocked.goto(base);
      await blocked.waitForSelector('#legacy-diagnostics[data-state="error"]');
      await blocked.close();
    } finally {
      await browser.close();
    }
  }
  await writeFile(
    'apps/web/legacy-tractor-evidence/rework-browser-report.json',
    JSON.stringify({ base, report }, null, 2),
  );
} finally {
  await new Promise((r) => server.close(r));
}
