import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const dir = 'apps/web/tractor-evidence/strategy/v3';
await mkdir(dir, { recursive: true });

await build({
  entryPoints: ['packages/engine/src/games/tractor/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: `${dir}/candidate.mjs`,
});

const { tractor, thinkTractor, basicRecommend, followError, currentTrickWinner, score, power } =
  await import(`../${dir}/candidate.mjs?${Date.now()}`);
const { recommend: frozenV2 } = await import(`../${dir}/v2-frozen.mjs`);

const players = Array.from({ length: 4 }, () => ({ name: 'bot', isBot: true }));
const budgetMs = Number(process.env.THINK_BUDGET_MS || 360);
const maxWorlds = Number(process.env.THINK_MAX_WORLDS || 28);

function style(v, kind) {
  const fallback = basicRecommend(v);
  if (v.phase !== 'play') return frozenV2(v);
  const lead = v.trick[0]?.cards ?? [];
  if (lead.length > 1) return fallback;
  const legal = v.hand.filter((c) => !followError(v.hand, [c], lead, v.level, v.trump));
  const partner =
    v.trick.length === 3 && currentTrickWinner(v.trick, v.level, v.trump) % 2 === v.seat % 2;
  legal.sort((a, b) =>
    kind === 'aggressive'
      ? power(b, v.level, v.trump) - power(a, v.level, v.trump)
      : kind === 'feed' && partner
        ? score([b]) - score([a])
        : score([a]) - score([b]) || power(a, v.level, v.trump) - power(b, v.level, v.trump),
  );
  return legal.length ? { type: 'play', cards: [legal[0].id] } : fallback;
}

const samples = [];
const latency = { play: [], criticalPlay: [], bury: [] };

function runDeal(seed, newTeam, mode) {
  let s = tractor.setup({ players, seed, options: { rounds: 1 } });
  s.dealer = seed % 4;
  s.turn = s.dealer;
  s.level = 2 + (seed % 13);
  s.levels = [s.level, s.level];
  while (s.phase === 'dealing') s = tractor.apply(s, -1, { type: 'deal' });
  s = tractor.apply(s, -1, { type: 'closeReveal' });
  s.trump = ['S', 'H', 'C', 'D', 'J'][seed % 5];
  const dealer = s.dealer;
  const level = s.level;
  const trump = s.trump;
  let steps = 0;
  let newActions = 0;

  while (!tractor.isOver(s) && ++steps < 600) {
    const auto = tractor.autoAdvance(s);
    const seat = auto ? -1 : tractor.activeSeats(s)[0];
    let a = auto?.action;
    if (!a) {
      const upgraded =
        mode !== 'control' &&
        seat % 2 === newTeam &&
        (mode === 'team' || seat === newTeam + 2 * (seed % 2));
      const v = tractor.view(s, seat);
      const before = JSON.stringify(v);
      const proxy =
        ['aggressive', 'passive', 'feed'].includes(mode) && Math.floor(seat / 2) !== seed % 2;

      if (proxy) {
        a = style(v, mode);
      } else if (upgraded) {
        let shortCircuited = false;
        const t0 = performance.now();
        a = thinkTractor(v, { budgetMs, maxWorlds }, (diag) => {
          shortCircuited = diag.shortCircuited;
        });
        const dt = performance.now() - t0;
        if (s.phase === 'bury') {
          latency.bury.push(dt);
        } else {
          latency.play.push(dt);
          if (!shortCircuited) latency.criticalPlay.push(dt);
        }
        newActions++;
      } else {
        a = frozenV2(v);
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

function stats(xs) {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, xs.length - 1));
  return {
    n: xs.length,
    mean,
    ci95: [mean - (1.96 * sd) / Math.sqrt(xs.length), mean + (1.96 * sd) / Math.sqrt(xs.length)],
  };
}

// 1. Symmetry control (20 seeds / 40 games: frozenV2 vs frozenV2)
const controlRows = [];
for (let seed = 60001; seed < 60021; seed++) {
  controlRows.push(runDeal(seed, 0, 'control'));
  controlRows.push(runDeal(seed, 1, 'control'));
}
const controlWins = controlRows.filter((r) => r.newWin).length;
assert.equal(controlWins, 20, 'symmetry control must be exact 50%');

// 2. Fresh untouched release lockbox vs frozen adaptive-v2
const count = Number(process.env.PAIRED_SEEDS || 200);
const start = Number(process.env.SEED_START || 50001);
const tag = process.env.BENCH_TAG || 'lockbox-v3-vs-v2';
const modes = (process.env.BENCH_MODES || 'team,mixed,aggressive,passive,feed').split(',');

for (const mode of modes) {
  for (let seed = start; seed < start + count; seed++) {
    for (const side of [0, 1]) samples.push(runDeal(seed, side, mode));
    if ((seed - start + 1) % 50 === 0) {
      console.log('progress', mode, seed, samples.length);
    }
  }
}

// 3. Independent full-round progressive declaration + play evaluation (200 paired seeds = 400 games)
const declRows = [];
for (let seed = 70001; seed < 70201; seed++) {
  for (const newTeam of [0, 1]) {
    let s = tractor.setup({ players, seed, options: { rounds: 1 } });
    // Vary initial round>1 vs round=1 scenarios fairly
    if (seed % 2 === 0) {
      s.round = 2;
      s.dealer = seed % 4;
      s.turn = s.dealer;
      s.options = { rounds: 2 };
    }
    const startLevels = [...s.levels];
    let guard = 0;
    while (s.phase !== 'roundOver' && s.phase !== 'matchOver' && ++guard < 800) {
      if (s.phase === 'dealing' || s.phase === 'reveal') {
        for (const seat of [0, 1, 2, 3]) {
          if (!['dealing', 'reveal'].includes(s.phase)) break;
          const v = tractor.view(s, seat);
          const a = seat % 2 === newTeam ? thinkTractor(v, { budgetMs, maxWorlds }) : frozenV2(v);
          if (a.type === 'reveal' && !tractor.validate(s, seat, a)) {
            s = tractor.apply(s, seat, a);
          } else if (!s.ready.includes(seat)) {
            s = tractor.apply(s, seat, { type: 'pass' });
          }
        }
        const auto = tractor.autoAdvance(s);
        if (auto) s = tractor.apply(s, -1, auto.action);
        continue;
      }
      const auto = tractor.autoAdvance(s);
      if (auto) {
        s = tractor.apply(s, -1, auto.action);
        continue;
      }
      const seat = tractor.activeSeats(s)[0];
      const v = tractor.view(s, seat);
      const a = seat % 2 === newTeam ? thinkTractor(v, { budgetMs, maxWorlds }) : frozenV2(v);
      assert.equal(tractor.validate(s, seat, a), null);
      s = tractor.apply(s, seat, a);
    }
    const dealerBeforeEnd = (s.dealer + (s.points >= 80 ? 3 : 2)) % 4; // reverse rotation to check round dealer
    const attacker = 1 - (dealerBeforeEnd % 2);
    const win = (s.points >= 80 ? attacker : dealerBeforeEnd % 2) === newTeam;
    const lvlDiff =
      s.levels[newTeam] - startLevels[newTeam] - (s.levels[1 - newTeam] - startLevels[1 - newTeam]);
    declRows.push({ seed, newTeam, win, lvlDiff, points: s.points });
  }
}

const result = {
  baseline: 'adaptive-v2 (frozen)',
  challenger: 'tractor-think-v3',
  budgetMs,
  maxWorlds,
  seedStart: start,
  seedCount: count,
  rounds: samples.length,
  illegalMoves: 0,
  symmetryControl: { seeds: 20, games: 40, wins: 20, winRate: 0.5 },
  metrics: {},
  fullDeclarationAndPlay: {
    seeds: 200,
    games: declRows.length,
    wins: declRows.filter((r) => r.win).length,
    winRate: stats(
      Array.from(
        { length: 200 },
        (_, i) =>
          declRows.filter((r) => r.seed === 70001 + i).reduce((n, r) => n + Number(r.win), 0) / 2,
      ),
    ),
    levelDelta: stats(
      Array.from(
        { length: 200 },
        (_, i) =>
          declRows.filter((r) => r.seed === 70001 + i).reduce((n, r) => n + r.lvlDiff, 0) / 2,
      ),
    ),
  },
  latency: {},
};

for (const mode of modes) {
  const rows = samples.filter((r) => r.mode === mode);
  const paired = [];
  for (let seed = start; seed < start + count; seed++) {
    const pair = rows.filter((r) => r.seed === seed);
    const atk = pair.find((r) => r.newTeam !== r.dealer % 2);
    const def = pair.find((r) => r.newTeam === r.dealer % 2);
    paired.push(atk.attackingPoints - def.attackingPoints);
  }
  result.metrics[mode] = {
    wins: rows.filter((r) => r.newWin).length,
    rounds: rows.length,
    winRate: stats(
      Array.from(
        { length: count },
        (_, i) =>
          rows.filter((r) => r.seed === start + i).reduce((n, r) => n + Number(r.newWin), 0) / 2,
      ),
    ),
    pairedAttackPointDifference: stats(paired),
    levelDelta: stats(
      Array.from(
        { length: count },
        (_, i) =>
          rows.filter((r) => r.seed === start + i).reduce((n, r) => n + r.levelDelta, 0) / 2,
      ),
    ),
    regressingSeedsCount: paired.filter((n) => n < 0).length,
    regressingSeeds: paired
      .map((n, i) => ({ seed: i + start, pointDifference: n }))
      .filter((r) => r.pointDifference < 0),
  };
}

for (const [phase, x] of Object.entries(latency)) {
  x.sort((a, b) => a - b);
  result.latency[phase] = {
    n: x.length,
    medianMs: Number((x[Math.floor(x.length * 0.5)] ?? 0).toFixed(2)),
    p95Ms: Number((x[Math.floor(x.length * 0.95)] ?? 0).toFixed(2)),
    maxMs: Number((x.at(-1) ?? 0).toFixed(2)),
  };
}

await writeFile(`${dir}/${tag}-paired-deals.json`, JSON.stringify(samples, null, 2));
await writeFile(`${dir}/${tag}-benchmark.json`, JSON.stringify(result, null, 2));

console.log(
  JSON.stringify(
    {
      ...result,
      metrics: Object.fromEntries(
        Object.entries(result.metrics).map(([k, v]) => [
          k,
          {
            wins: v.wins,
            rounds: v.rounds,
            winRate: v.winRate,
            pairedAttackPointDifference: v.pairedAttackPointDifference,
            levelDelta: v.levelDelta,
            regressingSeedsCount: v.regressingSeedsCount,
          },
        ]),
      ),
    },
    null,
    2,
  ),
);
