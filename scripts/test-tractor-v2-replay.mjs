import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { visibleView, choose, engine } from './tractor-browser-helpers.mjs';
const evidence = 'apps/web/tractor-evidence/strategy/v2';
await mkdir(evidence, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const name = new URL(req.url, 'http://localhost').pathname.split('/').pop() || 'index.html';
    res.setHeader(
      'Content-Type',
      name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html',
    );
    res.end(await readFile('apps/web/dist-legacy-tractor/' + name));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const modern = process.env.DESKPARK_URL || 'http://127.0.0.1:8788';
const legacyBase =
  process.env.DESKPARK_LEGACY_URL || `http://127.0.0.1:${server.address().port}/legacy-tractor/`;
const report = [];
async function save(page, legacy, name, phase) {
  await page
    .getByRole('button', {
      name: legacy ? '玩法说明' : phase === 'roundOver' ? '规则 / 复盘' : '规则',
      exact: true,
    })
    .click();
  const contrast = await page
    .getByRole('button', { name: '保存复盘', exact: true })
    .evaluate((e) => {
      const rgb = (s) => s.match(/[\d.]+/g).map(Number);
      const lum = (c) =>
        c
          .slice(0, 3)
          .map((x) => x / 255)
          .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2))
          .reduce((n, x, i) => n + x * [0.2126, 0.7152, 0.0722][i], 0);
      let p = e,
        bg = rgb(getComputedStyle(p).backgroundColor);
      while (bg.length === 4 && bg[3] === 0 && p.parentElement) {
        p = p.parentElement;
        bg = rgb(getComputedStyle(p).backgroundColor);
      }
      const a = lum(rgb(getComputedStyle(e).color)),
        b = lum(bg);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
  assert(contrast >= 4.5, 'save replay text must be readable: contrast ' + contrast);
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存复盘', exact: true }).click();
  const download = await event;
  const path = `${evidence}/replay-${name}-${legacy ? 'old' : 'modern'}-${phase}.json`;
  await download.saveAs(path);
  const text = await readFile(path, 'utf8'),
    data = JSON.parse(text);
  assert.equal(data.schema, 'deskpark.tractor.public-replay.v2');
  assert.equal(data.strategyVersion, 'adaptive-v2');
  assert(text.includes('partial'));
  assert(Buffer.byteLength(text) <= 524288);
  assert(!/"(?:hands|rng|drawPile|declarationAcknowledged|botReason)"/.test(text));
  assert.equal(data.seat, 0);
  assert(data.steps.every((s) => s.seat === 0 && s.round === data.round));
  for (const s of data.steps) {
    assert(s.ownHand.length <= 33);
    assert(s.visibleKitty.length === 0 || s.visibleKitty.length === 8);
    if (!['roundOver', 'matchOver', 'bury'].includes(s.phase) && s.dealer !== 0)
      assert.equal(s.visibleKitty.length, 0);
    for (const c of s.ownDecision?.candidates ?? [])
      assert(c.cards.every((id) => s.ownHand.some((x) => x.id === id)));
  }
  assert(data.steps.some((s) => s.phase === phase));
  if (phase === 'play' || phase === 'roundOver')
    assert(data.steps.some((s) => s.ownDecision?.candidates.length));
  await page.getByText('无法下载？展开复制 JSON', { exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: '复盘 JSON' }).inputValue(), text);
  await page.getByRole('textbox', { name: '复盘 JSON' }).focus();
  assert(
    await page
      .getByRole('textbox', { name: '复盘 JSON' })
      .evaluate((e) => e.selectionEnd === e.value.length),
  );
  await page.screenshot({
    path: `${evidence}/replay-${name}-${legacy ? 'old' : 'modern'}-${phase}.png`,
    fullPage: true,
  });
  await page
    .getByRole('button', { name: legacy ? '知道了，回到牌桌' : '关闭', exact: true })
    .click();
  return { path, bytes: Buffer.byteLength(text), steps: data.steps.length, round: data.round };
}
try {
  for (const [name, type] of [
    ['chromium', chromium],
    ['webkit', webkit],
  ]) {
    const browser = await type.launch();
    try {
      for (const legacy of [false, true]) {
        const page = await browser.newPage({
          viewport: { width: 1024, height: 768 },
          hasTouch: true,
          acceptDownloads: true,
        });
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.addInitScript(() => {
          Date.now = () => 79;
          Math.random = () => 79 / 4294967296;
          const timeout = window.setTimeout;
          window.setTimeout = (fn, ms, ...args) =>
            timeout(fn, ms >= 200 && ms <= 2500 ? 35 : ms, ...args);
        });
        await page.goto(legacy ? legacyBase : modern + '/#/play/tractor');
        if (legacy) await page.getByRole('button', { name: '开始游戏', exact: true }).click();
        else await page.locator('.tractor').waitFor();
        assert.equal(
          await page.getByRole('button', { name: '保存复盘', exact: true }).count(),
          0,
          'not on table',
        );
        let playExport = null,
          roundExport = null,
          resetExport = null;
        for (let i = 0; i < 1500; i++) {
          const v = await visibleView(page, legacy);
          if (!v) {
            await page.waitForTimeout(20);
            continue;
          }
          if (v.round >= 2) {
            resetExport = await save(page, legacy, name, v.phase);
            break;
          }
          if (v.phase === 'roundOver') {
            roundExport = await save(page, legacy, name, 'roundOver');
            await page.getByRole('button', { name: '准备下一局', exact: true }).click();
            continue;
          }
          if (['dealing', 'reveal', 'trickOver'].includes(v.phase) || v.turn !== 0) {
            if (v.paused)
              await page.getByRole('button', { name: '暂不亮 / 继续发牌', exact: true }).click();
            await page.waitForTimeout(25);
            continue;
          }
          if (v.phase === 'play' && !playExport)
            playExport = await save(page, legacy, name, 'play');
          const a = engine.recommend(v);
          await choose(page, a.cards, legacy);
          await page
            .getByRole('button', { name: v.phase === 'bury' ? '扣下8张' : '出牌', exact: true })
            .click();
        }
        assert(playExport && roundExport && resetExport);
        assert.equal(resetExport.round, 2);
        assert.deepEqual(errors, []);
        report.push({ name, legacy, playExport, roundExport, resetExport, errors });
        console.log('PASS replay controls/full-round/reset', name, legacy);
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }
  await writeFile(
    `${evidence}/replay-integration.json`,
    JSON.stringify({ modern, legacyBase, report }, null, 2),
  );
} finally {
  await new Promise((r) => server.close(r));
}
