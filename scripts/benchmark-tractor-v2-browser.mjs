import { build } from 'esbuild';
import { transformAsync } from '@babel/core';
import { parse } from 'acorn';
import { chromium, webkit } from 'playwright';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const dir = 'apps/web/tractor-evidence/strategy/v2';
const bundle = await build({
  stdin: {
    contents:
      "import 'core-js/stable'; export * from './packages/engine/src/games/tractor/index.ts';",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'Strategy',
  platform: 'browser',
  target: 'es2018',
});
const es5 = (
  await transformAsync(bundle.outputFiles[0].text, {
    babelrc: false,
    configFile: false,
    presets: [['@babel/preset-env', { targets: { ie: '11' }, modules: false, useBuiltIns: false }]],
    comments: false,
    compact: true,
  })
).code;
parse(es5, { ecmaVersion: 5 });
const output = [];
for (const [name, type] of [
  ['chromium-cpu4x', chromium],
  ['webkit', webkit],
]) {
  const browser = await type.launch();
  try {
    const page = await browser.newPage();
    if (name.startsWith('chromium')) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    }
    await page.evaluate(() => {
      Array.prototype.flat = undefined;
      Array.prototype.flatMap = undefined;
      Object.fromEntries = undefined;
      window.structuredClone = undefined;
    });
    await page.addScriptTag({ content: es5 });
    const result = await page.evaluate(() => {
      const { tractor, recommend } = window.Strategy;
      const players = Array.from({ length: 4 }, () => ({ name: 'bot', isBot: true }));
      const times = { bury33: [], play: [], declaration25: [], stress33: [] };
      let actions = 0;
      const time = (s, phase, seat) => {
        const v = tractor.view(s, seat),
          before = JSON.stringify(v),
          t = performance.now();
        const a = recommend(v);
        times[phase].push(performance.now() - t);
        if (tractor.validate(s, seat, a) !== null || JSON.stringify(v) !== before)
          throw Error('illegal or mutating');
        actions++;
        return a;
      };
      for (let seed = 1; seed <= 12; seed++) {
        let s = tractor.setup({ players, seed, options: { rounds: 1 } });
        while (s.phase === 'dealing') s = tractor.apply(s, -1, { type: 'deal' });
        time(s, 'declaration25', 0);
        s = tractor.apply(s, -1, { type: 'closeReveal' });
        s = tractor.apply(s, s.turn, time(s, 'bury33', s.turn));
        for (let i = 0; i < 40; i++) {
          const auto = tractor.autoAdvance(s);
          if (auto) s = tractor.apply(s, -1, auto.action);
          else if (s.phase === 'play') {
            const seat = s.turn;
            s = tractor.apply(s, seat, time(s, 'play', seat));
          } else break;
        }
      }
      // 33 effective trumps: S 12 ranks×2 = 24, H2/C2 trumps = 4, two small + one big joker = 3, plus two natural side cards.
      const deck = [];
      let id = 0;
      for (const rank of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
        for (let copy = 0; copy < 2; copy++) deck.push({ id: id++, suit: 'S', rank });
      for (const suit of ['H', 'C'])
        for (let copy = 0; copy < 2; copy++) deck.push({ id: id++, suit, rank: 2 });
      deck.push({ id: id++, suit: 'J', rank: 16 }, { id: id++, suit: 'J', rank: 16 });
      deck.push({ id: id++, suit: 'J', rank: 17 });
      deck.push({ id: id, suit: 'D', rank: 7 });
      deck.push({ id: id + 100, suit: 'D', rank: 8 });
      // Targeted 33-effective-trump hand, not a real deal, to exercise maximum follow search.
      let s = tractor.setup({ players, seed: 7, options: { rounds: 1 } });
      s.phase = 'play';
      s.turn = 1;
      s.level = 2;
      s.trump = 'S';
      s.hands = [[], deck, [], []];
      s.trick = [
        {
          seat: 0,
          cards: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].slice(0, 8).map((n) => ({
            id: 80 + n,
            suit: 'D',
            rank: ((n - 1) % 13) + 2,
          })),
        },
      ];
      s.playedHistory = [];
      if (deck.length !== 33) throw Error('stress setup ' + deck.length);
      time(s, 'stress33', 1);
      const stats = {};
      for (const [k, vs] of Object.entries(times)) {
        vs.sort((a, b) => a - b);
        stats[k] = {
          n: vs.length,
          medianMs: vs[Math.floor(vs.length * 0.5)],
          p95Ms: vs[Math.floor(vs.length * 0.95)],
          maxMs: vs[vs.length - 1],
        };
      }
      return { actions, illegal: 0, stats };
    });
    assert(result.stats.bury33.p95Ms < 200);
    assert(result.stats.stress33.p95Ms < 300);
    output.push({ name, ...result });
    await page.close();
  } finally {
    await browser.close();
  }
}
await writeFile(
  `${dir}/browser-performance.json`,
  JSON.stringify(
    {
      es5: true,
      note: 'Desktop WebKit and Chromium CPU4x proxies, NOT physical iOS12 measurements',
      output,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify(output, null, 2));
