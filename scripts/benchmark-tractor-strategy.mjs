import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
const dir = 'apps/web/tractor-evidence/strategy/v1';
await build({
  entryPoints: ['packages/engine/src/games/tractor/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: `${dir}/candidate.mjs`,
});
const { tractor, recommend } = await import(`../${dir}/candidate.mjs?${Date.now()}`);
const { recommend: old } = await import(`../${dir}/baseline.mjs`);
const players = Array.from({ length: 4 }, () => ({ name: 'bot', isBot: true }));
const samples = [],
  latency = { play: [], bury: [], declaration: [] };
function run(seed, newTeam, mode) {
  let s = tractor.setup({ players, seed, options: { rounds: 1 } });
  s.dealer = seed % 4;
  s.turn = s.dealer;
  s.level = 2 + (seed % 13);
  s.levels = [s.level, s.level];
  while (s.phase === 'dealing') s = tractor.apply(s, -1, { type: 'deal' });
  s = tractor.apply(s, -1, { type: 'closeReveal' });
  s.trump = ['S', 'H', 'C', 'D', 'J'][seed % 5];
  const dealer = s.dealer,
    level = s.level,
    trump = s.trump;
  let steps = 0,
    newActions = 0;
  while (!tractor.isOver(s) && ++steps < 600) {
    const auto = tractor.autoAdvance(s);
    const seat = auto ? -1 : tractor.activeSeats(s)[0];
    let a = auto?.action;
    if (!a) {
      const upgraded =
        mode !== 'control' &&
        seat % 2 === newTeam &&
        (mode === 'team' || seat === newTeam + 2 * (seed % 2));
      const v = tractor.view(s, seat),
        before = JSON.stringify(v);
      const t = performance.now();
      a = upgraded ? recommend(v) : old(v);
      if (upgraded) {
        latency[s.phase === 'bury' ? 'bury' : 'play'].push(performance.now() - t);
        newActions++;
      }
      assert.equal(JSON.stringify(v), before, 'mutated observation');
    }
    assert.equal(
      tractor.validate(s, seat, a),
      null,
      JSON.stringify({ seed, mode, seat, a, phase: s.phase }),
    );
    s = tractor.apply(s, seat, a);
  }
  assert.equal(s.phase, 'matchOver');
  const attacker = 1 - (dealer % 2);
  const win = (s.points >= 80 ? attacker : dealer % 2) === newTeam;
  const levelDelta = s.levels[newTeam] - level - (s.levels[1 - newTeam] - level);
  return {
    seed,
    newTeam,
    mode,
    dealer,
    level,
    trump,
    attackingPoints: s.points,
    newWin: win,
    levelDelta,
    newActions,
    steps,
  };
}
const count = Number(process.env.PAIRED_SEEDS || 120);
const start = Number(process.env.SEED_START || 1);
const tag = process.env.BENCH_TAG || 'development';
const modes = (process.env.BENCH_MODES || 'team,mixed').split(',');
for (const mode of modes)
  for (let seed = start; seed < start + count; seed++) {
    for (const side of [0, 1]) samples.push(run(seed, side, mode));
  }
function stats(xs) {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
  return {
    n: xs.length,
    mean,
    ci95: [mean - (1.96 * sd) / Math.sqrt(xs.length), mean + (1.96 * sd) / Math.sqrt(xs.length)],
  };
}
const result = {
  seedCount: count,
  rounds: samples.length,
  illegalMoves: 0,
  metrics: {},
  latency: {},
};
for (const mode of modes) {
  const rows = samples.filter((r) => r.mode === mode);
  const paired = [];
  for (let seed = start; seed < start + count; seed++) {
    const pair = rows.filter((r) => r.seed === seed);
    const atk = pair.find((r) => r.newTeam !== r.dealer % 2),
      def = pair.find((r) => r.newTeam === r.dealer % 2);
    paired.push(atk.attackingPoints - def.attackingPoints);
  }
  result.metrics[mode] = {
    wins: rows.filter((r) => r.newWin).length,
    rounds: rows.length,
    winRate: stats(rows.map((r) => Number(r.newWin))),
    pairedAttackPointDifference: stats(paired),
    levelDelta: stats(rows.map((r) => r.levelDelta)),
    regressingSeeds: paired
      .map((n, i) => ({ seed: i + start, pointDifference: n }))
      .filter((r) => r.pointDifference < 0),
  };
}
for (const [phase, x] of Object.entries(latency)) {
  x.sort((a, b) => a - b);
  result.latency[phase] = {
    n: x.length,
    medianMs: x[Math.floor(x.length * 0.5)],
    p95Ms: x[Math.floor(x.length * 0.95)],
    maxMs: x.at(-1),
  };
}
await writeFile(`${dir}/${tag}-paired-deals.json`, JSON.stringify(samples, null, 2));
await writeFile(
  `${dir}/${tag}-benchmark.json`,
  JSON.stringify(
    {
      ...result,
      seedStart: start,
      contract:
        'fixed public dealer/level/trump, common shuffle; actual engine scoring and level cap',
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify(
    {
      ...result,
      metrics: Object.fromEntries(
        Object.entries(result.metrics).map(([k, v]) => [
          k,
          { ...v, regressingSeeds: v.regressingSeeds.length },
        ]),
      ),
    },
    null,
    2,
  ),
);
