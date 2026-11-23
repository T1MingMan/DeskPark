import { expect, it } from 'vitest';
import { tractor } from '../src/games/tractor';
const players = Array.from({ length: 4 }, (_, i) => ({ name: String(i), isBot: true }));
it('deals visible cards progressively and accepts immediate out-of-turn overcalls without leaking undealt cards', () => {
  let s = tractor.setup({ players, seed: 42, options: tractor.defaultOptions });
  expect(s.phase).toBe('dealing');
  expect(s.hands.flat()).toHaveLength(0);
  for (let i = 0; i < 25; i++) {
    const auto = tractor.autoAdvance!(s)!;
    expect(auto.delayMs).toBeGreaterThanOrEqual(200);
    expect(tractor.validate(s, -1, auto.action)).toBeNull();
    s = tractor.apply(s, -1, auto.action);
    expect(s.hands.map((h) => h.length)).toEqual([i + 1, i + 1, i + 1, i + 1]);
    for (const seat of [0, 1, 2, 3, null]) {
      const v = tractor.view(s, seat);
      expect('drawPile' in v).toBe(false);
      expect('rng' in v).toBe(false);
      expect(v.kitty).toEqual([]);
      expect(v.hand).toHaveLength(seat === null ? 0 : i + 1);
    }
  }
  expect(s.phase).toBe('reveal');
  expect(tractor.autoAdvance!(s)!.delayMs).toBeGreaterThanOrEqual(2000);
  s = tractor.apply(s, -1, tractor.autoAdvance!(s)!.action);
  expect(s.phase).toBe('bury');
});
it('accepts a revealed level as soon as dealt, with another seat overcalling before the last card', () => {
  let s = tractor.setup({ players, seed: 1, options: tractor.defaultOptions });
  s.hands[2] = [{ id: 0, suit: 'H', rank: 2 }];
  s.hands[0] = [
    { id: 1, suit: 'S', rank: 2 },
    { id: 2, suit: 'S', rank: 2 },
  ];
  expect(tractor.validate(s, 2, { type: 'reveal', cards: [0] })).toBeNull();
  s = tractor.apply(s, 2, { type: 'reveal', cards: [0] });
  expect(tractor.validate(s, 0, { type: 'reveal', cards: [1, 2] })).toBeNull();
  s = tractor.apply(s, 0, { type: 'reveal', cards: [1, 2] });
  expect(s.phase).toBe('dealing');
  expect(s.trump).toBe('S');
  expect(tractor.view(s, null).bid?.cards.map((c) => c.id)).toEqual([1, 2]);
});
