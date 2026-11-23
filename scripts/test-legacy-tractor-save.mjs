import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { visibleView, choose, engine } from './tractor-browser-helpers.mjs';
const evidence =
  process.env.SAVE_EVIDENCE || 'apps/web/legacy-tractor-evidence/save-resume-browser';
await mkdir(evidence, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const name = new URL(req.url, 'http://localhost').pathname.split('/').pop() || 'index.html';
    const body = await readFile(
      new URL('../apps/web/dist-legacy-tractor/' + name, import.meta.url),
    );
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
const key = 'deskpark:legacy-tractor:local:v1';
const reports = [];
try {
  for (const [name, type] of [
    ['chromium', chromium],
    ['webkit', webkit],
  ]) {
    const browser = await type.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
      await context.addInitScript(() => {
        Date.now = () => 79;
        window.holdAutomation = true;
        const timer = window.setTimeout;
        window.setTimeout = (fn, ms, ...args) => {
          if (!(ms >= 200 && ms <= 2500)) return timer(fn, ms, ...args);
          const run = () => {
            if (window.holdAutomation) timer(run, 10);
            else fn(...args);
          };
          return timer(run, 30);
        };
      });
      let page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const stored = () => page.evaluate((k) => localStorage.getItem(k), key);
      const hold = () => page.evaluate(() => (window.holdAutomation = true));
      const run = () => page.evaluate(() => (window.holdAutomation = false));
      async function reloadContinue(label) {
        await hold();
        const text = await stored();
        const view = await visibleView(page, true);
        await page.reload();
        await page.getByRole('button', { name: '继续上次牌局', exact: true }).waitFor();
        assert.equal(
          await page.locator('[data-phase]').count(),
          0,
          'welcome never silently continues',
        );
        await page.waitForTimeout(150);
        assert.equal(await stored(), text, 'welcome never advances/overwrites');
        await page.getByRole('button', { name: '继续上次牌局', exact: true }).click();
        assert.deepEqual(await visibleView(page, true), view, label + ' exact rendered state');
        assert.equal(await stored(), text, label + ' exact full checkpoint');
        await page.screenshot({ path: `${evidence}/${name}-${label}.png`, fullPage: true });
        return text;
      }
      await page.goto(base);
      await page.evaluate(() => localStorage.setItem('deskpark:modern:sentinel', 'untouched'));
      await page.getByRole('button', { name: '开始游戏', exact: true }).click();
      await run();
      await page.waitForSelector('[data-paused="true"]');
      const paused = await reloadContinue('declaration-pause');
      await run();
      await page.waitForTimeout(650);
      assert.equal(await stored(), paused, 'resumed declaration pause stays indefinite');
      // Lobby cancel and accept both save, then closing the tab still retains the checkpoint.
      let warning = '';
      page.once('dialog', async (d) => {
        warning = d.message();
        await d.dismiss();
      });
      await page.getByRole('link', { name: '返回大厅', exact: true }).click();
      assert(warning.includes('已保存') && !warning.includes('不会保存'));
      assert.equal(await page.locator('[data-phase]').count(), 1);
      page.once('dialog', (d) => d.accept());
      await page.getByRole('link', { name: '返回大厅', exact: true }).click();
      await page.waitForURL('**/classic/');
      await page.close();
      page = await context.newPage();
      await page.goto(base);
      assert.equal(await stored(), paused);
      // New game cancel must preserve bytes; acceptance resets the game.
      page.once('dialog', (d) => d.dismiss());
      await page.getByRole('button', { name: '开始新游戏', exact: true }).click();
      assert.equal(await stored(), paused);
      page.once('dialog', (d) => d.accept());
      await page.getByRole('button', { name: '开始新游戏', exact: true }).click();
      assert.equal(JSON.parse(await stored()).state.dealt, 0);
      await run();
      for (let i = 0; i < 100; i++) {
        const v = await visibleView(page, true);
        if (!['dealing', 'reveal'].includes(v.phase)) break;
        const choice = page.locator('[data-declare]:enabled');
        if (await choice.count()) await choice.first().click();
        else {
          const resume = page.locator('.resume:enabled');
          if (await resume.count()) await resume.click();
        }
        await page.waitForTimeout(35);
      }
      await page.waitForSelector('[data-phase="bury"][data-turn="0"]');
      await reloadContinue('bury');
      assert.equal(await page.locator('.hand button').count(), 33);
      const v = await visibleView(page, true);
      await choose(page, engine.recommend(v).cards, true);
      await page.getByRole('button', { name: '扣下8张', exact: true }).click();
      await reloadContinue('play');
      await run();
      let plays = 0;
      for (let i = 0; i < 1000; i++) {
        const view = await visibleView(page, true);
        if (view.phase === 'roundOver') break;
        if (view.phase === 'play' && view.turn === 0) {
          const action = engine.recommend(view);
          await choose(page, action.cards, true);
          await page.getByRole('button', { name: '出牌', exact: true }).click();
          plays++;
        }
        await page.waitForTimeout(30);
      }
      const round = { plays };
      assert(plays > 0);
      await reloadContinue('roundOver');
      assert.equal((await visibleView(page, true)).phase, 'roundOver');
      await page.getByRole('button', { name: '准备下一局', exact: true }).click();
      await run();
      await page.waitForSelector('[data-round="2"]');
      await page.waitForSelector('[data-paused="true"]');
      await reloadContinue('next-round');
      assert.equal(
        await page.evaluate(() => localStorage.getItem('deskpark:modern:sentinel')),
        'untouched',
      );
      await page.close();
      await context.close();
      // Invalid/future versions never auto-delete or execute; new-game cancellation retains raw bytes.
      for (const raw of ['{bad', '{"format":"deskpark-legacy-tractor","version":999}']) {
        const p = await browser.newPage();
        await p.goto(base);
        await p.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key, raw });
        await p.reload();
        assert.match(await p.getByRole('alert').innerText(), /损坏或版本不支持/);
        assert.equal(await p.getByRole('button', { name: '继续上次牌局', exact: true }).count(), 0);
        p.once('dialog', (d) => d.dismiss());
        await p.getByRole('button', { name: '开始新游戏', exact: true }).click();
        assert.equal(await p.evaluate((k) => localStorage.getItem(k), key), raw);
        p.once('dialog', (d) => d.accept());
        await p.getByRole('button', { name: '开始新游戏', exact: true }).click();
        await p.waitForSelector('[data-phase]');
        await p.close();
      }
      for (const failure of ['getter', 'quota', 'silent']) {
        const p = await browser.newPage();
        await p.addInitScript((failure) => {
          if (failure === 'getter')
            Object.defineProperty(window, 'localStorage', {
              get() {
                throw Error('SecurityError');
              },
            });
          else
            Storage.prototype.setItem = function () {
              if (failure === 'quota') throw Error('QuotaExceededError');
            };
        }, failure);
        await p.goto(base);
        await p.getByRole('button', { name: '开始游戏', exact: true }).click();
        assert.match(await p.getByRole('alert').innerText(), /无法保存/);
        let text = '';
        p.once('dialog', async (d) => {
          text = d.message();
          await d.dismiss();
        });
        await p.getByRole('link', { name: '返回大厅', exact: true }).click();
        assert.match(text, /保存失败/);
        assert.equal(await p.locator('[data-phase]').count(), 1);
        await p.close();
      }
      assert.deepEqual(errors, []);
      reports.push({
        name,
        reloadPhases: ['declaration-pause', 'bury', 'play', 'roundOver', 'next-round'],
        round,
        lobbyCancelAccept: true,
        closeReopen: true,
        newGameCancelAccept: true,
        corruptAndFuture: 2,
        storageFailures: 3,
        namespaceIsolated: true,
        errors,
      });
      console.log('PASS', name, JSON.stringify(reports.at(-1)));
    } finally {
      await browser.close();
    }
  }
  await writeFile(evidence + '/report.json', JSON.stringify({ base, reports }, null, 2));
} finally {
  await new Promise((r) => server.close(r));
}
