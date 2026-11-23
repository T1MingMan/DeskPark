import { describe, it, expect } from 'vitest';
import { tractor, shape, followError, effective, score } from '../src/games/tractor';
import { Rng } from '../src/core/rng';
import type { Card } from '../src/core/cards';
const c = (id: number, suit: Card['suit'], rank: number): Card => ({ id, suit, rank });
const pair = (id: number, suit: Card['suit'], rank: number) => [
  c(id, suit, rank),
  c(id + 1, suit, rank),
];
const players = Array.from({ length: 4 }, (_, i) => ({ name: `P${i}`, isBot: true }));
function setupDealt(ctx: Parameters<typeof tractor.setup>[0]) {
  let s = tractor.setup(ctx);
  while (s.phase === 'dealing') s = tractor.apply(s, -1, { type: 'deal' });
  return s;
}
describe('tractor', () => {
  it('awards trump kills only for matching shape and keeps first equal trump', () => {
    for (const [hands, winner] of [
      [[[c(0, 'H', 14)], [c(1, 'S', 3)], [c(2, 'C', 2)], [c(3, 'D', 2)]], 2],
      [[pair(0, 'H', 14), pair(2, 'S', 3), [c(4, 'C', 2), c(5, 'D', 2)], pair(6, 'D', 3)], 1],
      [[[c(0, 'H', 14)], [c(1, 'S', 3)], [c(2, 'S', 3)], [c(3, 'D', 3)]], 1],
    ] as [Card[][], number][]) {
      let s = setupDealt({ players, options: { rounds: 1 }, seed: 1 });
      s.phase = 'play';
      s.hands = hands;
      s.trump = 'S';
      s.level = 2;
      for (let seat = 0; seat < 4; seat++) {
        const a = { type: 'play' as const, cards: hands[seat].map((c) => c.id) };
        expect(tractor.validate(s, seat, a)).toBe(null);
        s = tractor.apply(s, seat, a);
      }
      expect(s.phase).toBe('trickOver');
      expect(s.winner).toBe(winner);
    }
  });
  it('accepts a maximal long run when equivalent off-level pairs coexist', () => {
    const hand = [
      ...pair(0, 'S', 14),
      ...pair(2, 'H', 2),
      ...pair(4, 'C', 2),
      ...pair(6, 'S', 2),
      ...pair(8, 'J', 17),
    ];
    const lead = [
      ...pair(20, 'S', 10),
      ...pair(22, 'S', 11),
      ...pair(24, 'S', 12),
      ...pair(26, 'S', 13),
    ];
    expect(followError(hand, hand.slice(0, 8), lead, 2, 'S')).toBe(null);
  });
  it('rejects malformed network actions without throwing', () => {
    const s = setupDealt({ players, options: { rounds: 1 }, seed: 1 });
    expect(() => tractor.validate(s, 0, { type: 'play' } as never)).not.toThrow();
    expect(tractor.validate(s, 0, { type: 'play' } as never)).not.toBe(null);
  });
  it('supports reveal overcall, default trump, exact bury and hidden kitty', () => {
    let s = setupDealt({ players, options: { rounds: 1 }, seed: 1 });
    s.kitty = Array.from({ length: 8 }, (_, i) => c(100 + i, 'D', 3));
    s.hands[0] = pair(0, 'H', 2);
    s.hands[1] = pair(2, 'S', 2);
    s.hands[2] = pair(4, 'J', 16);
    s.hands[3] = pair(6, 'J', 17);
    s = tractor.apply(s, 0, { type: 'reveal', cards: [0] });
    expect(s.trump).toBe('H');
    s = tractor.apply(s, 1, { type: 'reveal', cards: [2, 3] });
    expect(s.trump).toBe('S');
    s = tractor.apply(s, 2, { type: 'reveal', cards: [4, 5] });
    expect(s.trump).toBe('J');
    expect(tractor.validate(s, 3, { type: 'reveal', cards: [6, 7] })).toBe(null);
    s = tractor.apply(s, 3, { type: 'reveal', cards: [6, 7] });
    for (let i = 0; i < 4; i++) s = tractor.apply(s, s.turn, { type: 'pass' });
    s = tractor.apply(s, -1, { type: 'closeReveal' });
    expect(s.phase).toBe('bury');
    expect(tractor.view(s, 1).kitty).toEqual([]);
    expect(tractor.validate(s, 0, { type: 'bury', cards: [0] })).not.toBe(null);
    const ids = s.hands[0].slice(0, 8).map((c) => c.id);
    s = tractor.apply(s, 0, { type: 'bury', cards: ids });
    expect(tractor.view(s, 0).kitty).toHaveLength(8);
    expect(tractor.view(s, 2).kitty).toEqual([]);
    expect(tractor.view(s, null).kitty).toEqual([]);
    let d = setupDealt({ players, options: { rounds: 1 }, seed: 2 });
    for (let i = 0; i < 4; i++) d = tractor.apply(d, i, { type: 'pass' });
    d = tractor.apply(d, -1, { type: 'closeReveal' });
    expect(d.trump).toBe('S');
    expect(d.hands[0]).toHaveLength(33);
  });
  it('connects trump A to off-level, main level and jokers, with no-trump adjacency', () => {
    expect(shape([...pair(0, 'S', 14), ...pair(2, 'H', 2)], 2, 'S')).toBe('tractor');
    expect(shape([...pair(0, 'H', 2), ...pair(2, 'J', 16)], 2, 'J')).toBe('tractor');
    expect(shape([...pair(0, 'H', 2), ...pair(2, 'C', 2)], 2, 'S')).toBe(null);
    expect(effective(c(0, 'H', 2), 2, 'S')).toBe('J');
  });
  it('enforces suits, pairs and longest tractor obligation', () => {
    const lead = [...pair(90, 'H', 7), ...pair(92, 'H', 8)];
    const hand = [...pair(0, 'H', 3), ...pair(2, 'H', 4), ...pair(4, 'H', 6), c(6, 'S', 5)];
    expect(followError(hand, [...pair(0, 'H', 3), ...pair(4, 'H', 6)], lead, 2, 'S')).toMatch(
      '拖拉机',
    );
    expect(followError(hand, hand.slice(0, 4), lead, 2, 'S')).toBe(null);
    expect(followError(hand, [...hand.slice(0, 3), hand[6]], lead, 2, 'S')).toMatch('花色');
    expect(followError(hand, [hand[0], hand[2]], pair(90, 'H', 7), 2, 'S')).toMatch('跟对');
  });
  it('completes 50 seeded three-round games using view-only legal bots', () => {
    for (let seed = 1; seed <= 50; seed++) {
      let s = setupDealt({ players, options: { rounds: 3 }, seed });
      const rng = new Rng(seed);
      let steps = 0;
      while (!tractor.isOver(s) && steps++ < 2000) {
        const auto = tractor.autoAdvance!(s);
        const seat = auto ? -1 : tractor.activeSeats(s)[0];
        const a = auto?.action ?? tractor.bot(tractor.view(s, seat), seat, rng);
        expect(
          tractor.validate(s, seat, a),
          `seed ${seed} step ${steps} ${JSON.stringify(a)}`,
        ).toBe(null);
        s = tractor.apply(s, seat, a);
      }
      expect(s.phase).toBe('matchOver');
      expect(s.round).toBe(3);
      expect(s.hands.flat()).toHaveLength(0);
      expect(score(s.kitty)).toBeGreaterThanOrEqual(0);
    }
  });
  it('bots lead a tractor when available rather than reducing the game to singles', () => {
    const s = setupDealt({ players, options: { rounds: 1 }, seed: 1 });
    s.phase = 'play';
    s.hands[0] = [...pair(0, 'H', 3), ...pair(2, 'H', 4)];
    const a = tractor.bot(tractor.view(s, 0), 0, new Rng(1));
    expect(a.type).toBe('play');
    expect('cards' in a && a.cards.length).toBe(4);
  });
  it('settles kitty multipliers, rank advancement and dealer rotation', () => {
    for (const [points, win, lead, expected, levels, dealer] of [
      [0, 0, [c(20, 'H', 3)], 0, [5, 2], 2],
      [30, 0, [c(20, 'H', 3)], 30, [4, 2], 2],
      [60, 0, [c(20, 'H', 3)], 60, [3, 2], 2],
      [60, 1, [c(20, 'H', 3)], 80, [2, 2], 1],
      [80, 1, pair(20, 'H', 3), 120, [2, 3], 1],
      [80, 1, [...pair(20, 'H', 3), ...pair(22, 'H', 4)], 160, [2, 4], 1],
    ] as const) {
      const s = setupDealt({ players, options: { rounds: 1 }, seed: 1 });
      s.phase = 'trickOver';
      s.hands = [[], [], [], []];
      s.points = points;
      s.winner = win;
      s.kitty = [c(50, 'D', 10)];
      s.lastTrick = [{ seat: 0, cards: [...lead] }];
      const next = tractor.apply(s, -1, { type: 'continue' });
      expect(next.points).toBe(expected);
      expect(next.levels).toEqual(levels);
      expect(next.dealer).toBe(dealer);
      expect(next.phase).toBe('matchOver');
    }
  });
  it('deals two decks with an eight-card hidden kitty and immutable actions', () => {
    const s = setupDealt({ players, options: { rounds: 1 }, seed: 1 });
    expect(s.hands.map((h) => h.length)).toEqual([25, 25, 25, 25]);
    expect(s.kitty).toHaveLength(8);
    expect(tractor.view(s, 0).hand).toHaveLength(25);
    expect(tractor.view(s, null).hand).toEqual([]);
    expect('hands' in tractor.view(s, 0)).toBe(false);
    expect(tractor.view(s, 0).kitty).toEqual([]);
    const before = JSON.stringify(s);
    tractor.apply(s, 0, { type: 'pass' });
    expect(JSON.stringify(s)).toBe(before);
  });
});
