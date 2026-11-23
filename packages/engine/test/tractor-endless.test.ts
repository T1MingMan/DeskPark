import { expect, it } from 'vitest';
import { tractor } from '../src/games/tractor';
import { Rng } from '../src/core/rng';
const players = Array.from({ length: 4 }, (_, i) => ({ name: String(i), isBot: true }));
it('defaults to endless and continues 30 seeded rounds with a finite harness', () => {
  expect(tractor.defaultOptions.rounds).toBe(0);
  for (const seed of [1, 42, 777]) {
    let s = tractor.setup({ players, seed, options: tractor.defaultOptions });
    const rng = new Rng(seed);
    let steps = 0;
    while (s.round <= 30 && steps++ < 20000) {
      expect(tractor.isOver(s)).toBe(false);
      const auto = tractor.autoAdvance!(s);
      const seat = auto ? -1 : tractor.activeSeats(s)[0];
      const a = auto?.action ?? tractor.bot(tractor.view(s, seat), seat, rng);
      expect(tractor.validate(s, seat, a), `${seed} ${steps}`).toBeNull();
      s = tractor.apply(s, seat, a);
    }
    expect(s.round).toBe(31);
    expect(steps).toBeLessThan(20000);
  }
});
it('wraps ranks through A back to 2 without ending an endless session', () => {
  const s = tractor.setup({ players, seed: 1, options: tractor.defaultOptions });
  s.phase = 'trickOver';
  s.hands = [[], [], [], []];
  s.levels = [14, 2];
  s.points = 0;
  s.winner = 0;
  s.lastTrick = [{ seat: 0, cards: [{ id: 0, suit: 'H', rank: 3 }] }];
  const next = tractor.apply(s, -1, { type: 'continue' });
  expect(next.levels[0]).toBe(4);
  expect(next.phase).toBe('roundOver');
});
it('treats negative attacking points after a failed throw as a shutout', () => {
  const s = tractor.setup({ players, seed: 1, options: tractor.defaultOptions });
  s.phase = 'trickOver';
  s.hands = [[], [], [], []];
  s.points = -10;
  s.winner = 0;
  s.lastTrick = [{ seat: 0, cards: [{ id: 0, suit: 'H', rank: 3 }] }];
  expect(tractor.apply(s, -1, { type: 'continue' }).levels[0]).toBe(5);
});
