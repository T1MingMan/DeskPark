import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
const dir = 'apps/web/tractor-evidence/strategy/v1';
await build({
  entryPoints: ['packages/engine/src/games/tractor/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: `${dir}/candidate.mjs`,
});
const { tractor, recommend } = await import(`../${dir}/candidate.mjs?${Date.now()}`);
const players = Array.from({ length: 4 }, () => ({ name: 'bot', isBot: true }));
let declared = 0,
  passes = 0,
  partnerOvercalls = 0,
  enemyOvercalls = 0,
  quality = [];
for (let seed = 1; seed <= 200; seed++) {
  let s = tractor.setup({ players, seed, options: { rounds: 1 } });
  for (let tick = 0; tick < 26; tick++) {
    for (const seat of [0, 1, 2, 3]) {
      if (!['dealing', 'reveal'].includes(s.phase)) break;
      const a = recommend(tractor.view(s, seat));
      if (a.type === 'reveal') {
        if (!tractor.validate(s, seat, a)) {
          const trumps = s.hands[seat].filter(
            (c) =>
              c.suit === 'J' ||
              c.rank === s.level ||
              c.suit === a.cards.map((id) => s.hands[seat].find((x) => x.id === id).suit)[0],
          ).length;
          quality.push(trumps);
          if (s.bid) {
            if (s.bid.seat % 2 === seat % 2) partnerOvercalls++;
            else enemyOvercalls++;
          }
          declared++;
          s = tractor.apply(s, seat, a);
        }
      } else {
        passes++;
        s = tractor.apply(s, seat, { type: 'pass' });
      }
    }
    if (s.phase === 'dealing') s = tractor.apply(s, -1, { type: 'deal' });
  }
  while (s.phase === 'dealing') s = tractor.apply(s, -1, { type: 'deal' });
}
quality.sort((a, b) => a - b);
const out = {
  seeds: 200,
  declarations: declared,
  passes,
  partnerOvercalls,
  enemyOvercalls,
  trumpHeldAtDeclaration: {
    median: quality[Math.floor(quality.length * 0.5)],
    p10: quality[Math.floor(quality.length * 0.1)],
    p90: quality[Math.floor(quality.length * 0.9)],
    n: quality.length,
  },
};
await writeFile(`${dir}/declaration-benchmark.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
