import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
const evidence = 'apps/web/legacy-tractor-evidence/refinements';
await mkdir(evidence, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const name = new URL(req.url, 'http://localhost').pathname.split('/').pop() || 'index.html';
    const body = await readFile('apps/web/dist-legacy-tractor/' + name);
    res.setHeader(
      'Content-Type',
      name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html',
    );
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
      for (const [width, height] of [
        [1024, 768],
        [1024, 660],
        [768, 1024],
      ]) {
        const p = await browser.newPage({ viewport: { width, height } });
        await p.addInitScript(() => (Date.now = () => 10));
        await p.goto(base);
        await p.getByRole('button', { name: '开始游戏', exact: true }).click();
        await p.waitForSelector('[data-paused=true]');
        const badge = p.locator('.trump-banner');
        assert.equal(
          await badge.locator('.pcard').count(),
          1,
          'level/trump represented by visible card',
        );
        assert(
          !/第\s*\d+\s*局|亮主|默认黑桃|打\s*2/.test(await p.locator('.table-info').innerText()),
          'no redundant phase/declarer prose',
        );
        const panelBefore = await p.locator('.declaration-panel').boundingBox();
        const legal = p.locator('[data-declare]:enabled').first();
        const suit = await legal.getAttribute('data-declare');
        const expected = await p
          .locator(`.hand button[data-suit="${suit}"][data-rank="2"]`)
          .evaluateAll((es) => es.map((e) => e.dataset.cid).sort());
        await legal.click();
        const actual = await p
          .locator('.compass-0 [data-revealed=true] [data-cid]')
          .evaluateAll((es) => es.map((e) => e.dataset.cid).sort());
        assert.deepEqual(actual, expected, 'human actual level cards appear at own compass seat');
        await p.screenshot({
          path: `${evidence}/after-${name}-${width}x${height}-human.png`,
          fullPage: true,
        });
        let botCount = 0,
          overcallCount = 0,
          last = Number(await p.locator('[data-phase]').getAttribute('data-bid-strength'));
        for (let n = 0; n < 150; n++) {
          const snapshot = await p.locator('[data-phase]').evaluate((e) => ({
            phase: e.dataset.phase,
            paused: e.dataset.paused === 'true',
            seat: Number(e.dataset.bidSeat),
            strength: Number(e.dataset.bidStrength),
            ids: JSON.parse(e.dataset.bidCards || '[]'),
            shown: [...e.querySelectorAll('[data-revealed=true]')].map((x) => ({
              seat: Number(x.closest('[data-seat]').dataset.seat),
              ids: [...x.querySelectorAll('[data-cid]')].map((c) => Number(c.dataset.cid)),
            })),
          }));
          if (!['dealing', 'reveal'].includes(snapshot.phase)) {
            assert.equal(snapshot.shown.length, 0, 'declarations disappear on bury/play');
            break;
          }
          if (snapshot.strength > last) {
            overcallCount++;
            last = snapshot.strength;
            if (snapshot.seat !== 0) {
              botCount++;
              assert.deepEqual(
                snapshot.shown.find((s) => s.seat === snapshot.seat)?.ids,
                snapshot.ids,
                'bot actual public bid cards at correct seat',
              );
              await p.screenshot({
                path: `${evidence}/after-${name}-${width}x${height}-bot.png`,
                fullPage: true,
              });
            }
          }
          if (snapshot.paused)
            await p.getByRole('button', { name: '暂不亮 / 继续发牌', exact: true }).click();
          await p.waitForTimeout(150);
        }
        assert(botCount > 0, 'observed actual bot announcement');
        assert(overcallCount > 0, 'observed actual overcall');
        const geometry = await p.locator('.compass .play-cards').evaluateAll((es) =>
          es.map((e) => {
            const r = e.getBoundingClientRect();
            return { w: r.width, h: r.height };
          }),
        );
        assert(
          geometry.every((g) => g.h >= 70),
          'each play area supports large cards',
        );
        const panelAfter = await p.locator('.declaration-panel').count();
        assert.equal(panelAfter, 0);
        report.push({
          name,
          width,
          height,
          panelBefore,
          geometry,
          botCount,
          overcallCount,
          humanActualCards: actual,
        });
        await p.close();
      }
      // Seed3: a computer's public heart2 remains visible during a genuine later human pause.
      const p = await browser.newPage({ viewport: { width: 1024, height: 660 } });
      await p.addInitScript(() => {
        Date.now = () => 3;
        window.__dealTicks = [];
        document.addEventListener('DOMContentLoaded', () => {
          let last = '';
          new MutationObserver(() => {
            const table = document.querySelector('[data-phase]');
            const dealt = table?.dataset.dealt;
            if (dealt && dealt !== last) {
              last = dealt;
              window.__dealTicks.push({ dealt: Number(dealt), at: performance.now() });
            }
          }).observe(document.body, {
            attributes: true,
            attributeFilter: ['data-dealt'],
            childList: true,
            subtree: true,
          });
        });
      });
      await p.goto(base);
      await p.getByRole('button', { name: '开始游戏', exact: true }).click();
      await p.waitForSelector('[data-paused=true]');
      const frozen = () =>
        p.locator('[data-phase]').evaluate((e) => ({
          dealt: e.dataset.dealt,
          bid: e.dataset.bidSeat,
          strength: e.dataset.bidStrength,
          cards: [...e.querySelectorAll('[data-revealed=true] [data-cid]')].map(
            (c) => c.dataset.cid,
          ),
        }));
      const held = await frozen();
      assert.equal(held.dealt, '14');
      assert.equal(held.bid, '1');
      assert.deepEqual(held.cards, ['67']);
      await p.waitForTimeout(3600);
      assert.deepEqual(
        await frozen(),
        held,
        'bot public announcement and deal frozen past eight 450ms deadlines',
      );
      await p.screenshot({
        path: `${evidence}/after-${name}-bot-reveal-paused.png`,
        fullPage: true,
      });
      await p.locator('[data-declare="J"]').click();
      assert.equal(await p.locator('[data-phase]').getAttribute('data-bid-seat'), '0');
      const artwork = await p.locator('.compass-0 .pcard--joker').evaluateAll((es) =>
        es.map((e) => ({
          name: e.getAttribute('aria-label'),
          text: e.textContent,
          color: getComputedStyle(e).color,
          svg: !!e.querySelector('svg'),
          width: e.getBoundingClientRect().width,
          height: e.getBoundingClientRect().height,
        })),
      );
      assert.equal(artwork.length, 2);
      assert(
        artwork.every(
          (c) =>
            c.name === '大王' &&
            c.text === '' &&
            c.svg &&
            c.color === 'rgb(177, 47, 53)' &&
            c.width >= 50 &&
            c.height >= 70,
        ),
      );
      assert.equal((await p.locator('.trump-banner').innerText()).trim(), '无主');
      assert.equal(
        await p.locator('.compass-1 [data-revealed=true] .pcard').count(),
        1,
        'previous bot announcement remains at its own seat after human overcall',
      );
      await p.screenshot({
        path: `${evidence}/after-${name}-human-joker-overcall.png`,
        fullPage: true,
      });
      const ticks = await p.evaluate(() => window.__dealTicks);
      const dealIntervalsMs = ticks
        .filter((t) => t.dealt > 1 && t.dealt <= 14)
        .map((t) => t.at - ticks.find((x) => x.dealt === t.dealt - 1).at);
      assert.equal(dealIntervalsMs.length, 13);
      assert(
        dealIntervalsMs.every((ms) => ms >= 400 && ms < 650),
        'actual incremental deal cadence is 450ms, not old1100ms or bot650ms',
      );
      report.push({
        name,
        seed: 3,
        frozenMs: 3600,
        held,
        dealIntervalsMs,
        humanJokerOvercall: true,
        artwork,
      });
      await p.close();
    } finally {
      await browser.close();
    }
  }
  await writeFile(
    `${evidence}/refinements-browser.json`,
    JSON.stringify({ base, report }, null, 2),
  );
  console.log('PASS refinements', report.length, 'tablet/browser cases');
} finally {
  await new Promise((r) => server.close(r));
}
