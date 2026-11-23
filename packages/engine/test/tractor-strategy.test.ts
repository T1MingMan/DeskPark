import { describe, it, expect } from 'vitest';
import { tractor, recommend, type TractorState } from '../src/games/tractor';
import { publicKnowledge } from '../src/games/tractor/strategy';
import type { Card } from '../src/core/cards';
const c = (id: number, suit: Card['suit'], rank: number): Card => ({ id, suit, rank });
const players = Array.from({ length: 4 }, () => ({ name: 'bot', isBot: true }));
function state(): TractorState {
  const s = tractor.setup({ players, options: { rounds: 1 }, seed: 1 });
  s.phase = 'play';
  s.turn = 3;
  s.hands = [[], [], [], [c(0, 'H', 3), c(1, 'H', 13)]];
  s.trick = [
    { seat: 0, cards: [c(90, 'H', 7)] },
    { seat: 1, cards: [c(91, 'H', 14)] },
    { seat: 2, cards: [c(92, 'H', 9)] },
  ];
  return s;
}
describe('public-only partner strategy', () => {
  it('persists only completed public tricks, deep clones reconnect views and clears next round', () => {
    const s = state();
    const before = JSON.stringify(s);
    const next = tractor.apply(s, 3, { type: 'play', cards: [0] });
    expect(JSON.stringify(s)).toBe(before);
    const v = tractor.view(next, null) as ReturnType<typeof tractor.view> & {
      playedHistory: { seat: number; cards: Card[] }[][];
    };
    expect(v.playedHistory).toEqual([next.trick]);
    v.playedHistory[0][0].cards[0].rank = 3;
    expect(tractor.view(next, null)).not.toEqual(v);
    expect('hands' in v || 'drawPile' in v || 'rng' in v).toBe(false);
    next.phase = 'roundOver';
    next.options.rounds = 0;
    next.ready = [0, 1, 2];
    expect(
      (tractor.apply(next, 3, { type: 'continue' }) as unknown as { playedHistory: unknown[] })
        .playedHistory,
    ).toEqual([]);
  });
  it('captures an enemy ten with the cheapest sufficient card, preserving the ace', () => {
    const s = state();
    s.trick[1].cards = [c(91, 'H', 10)];
    s.trick[2].cards = [c(92, 'H', 11)];
    s.hands[3] = [c(0, 'H', 3), c(1, 'H', 12), c(2, 'H', 14)];
    // Seat2 is the enemy of seat3; partner seat1 is no longer winning.
    expect(recommend(tractor.view(s, 3))).toEqual({ type: 'play', cards: [1] });
  });
  it('leads a publicly proven partner void to offer a cheap ruff entry', () => {
    const s = state();
    s.turn = 0;
    s.trick = [];
    s.hands[0] = [c(0, 'C', 3), c(1, 'H', 6)];
    s.hands[2] = [c(20, 'S', 9)];
    s.playedHistory = [
      [
        { seat: 1, cards: [c(80, 'H', 8)] },
        { seat: 2, cards: [c(81, 'D', 4)] },
        { seat: 3, cards: [c(82, 'H', 9)] },
        { seat: 0, cards: [c(83, 'H', 7)] },
      ],
    ];
    expect(recommend(tractor.view(s, 0))).toEqual({ type: 'play', cards: [1] });
  });
  it('does not feed an early vulnerable partner before an enemy ace can act', () => {
    const s = state();
    s.turn = 2;
    s.trick = [
      { seat: 0, cards: [c(90, 'H', 11)] },
      { seat: 1, cards: [c(91, 'H', 4)] },
    ];
    s.hands[2] = [c(0, 'H', 3), c(1, 'H', 13)];
    expect(recommend(tractor.view(s, 2))).toEqual({ type: 'play', cards: [0] });
  });
  it('does not overcall a partner merely because a legal level pair exists', () => {
    const s = state();
    s.phase = 'reveal';
    s.hands[3] = [
      c(0, 'D', 2),
      c(1, 'D', 2),
      c(2, 'H', 14),
      c(3, 'H', 10),
      c(4, 'H', 9),
      c(5, 'H', 8),
    ];
    s.bid = { seat: 1, strength: 1, cards: [c(90, 'H', 2)] };
    s.trump = 'H';
    expect(recommend(tractor.view(s, 3))).toEqual({ type: 'pass' });
  });
  it('chooses a strong declaration suit rather than the first legal rank card', () => {
    const s = state();
    s.phase = 'reveal';
    s.hands[3] = [
      c(0, 'D', 2),
      c(1, 'H', 2),
      c(2, 'H', 14),
      c(3, 'H', 14),
      c(4, 'H', 9),
      c(5, 'H', 8),
      c(6, 'H', 7),
    ];
    s.bid = null;
    expect(recommend(tractor.view(s, 3))).toEqual({ type: 'reveal', cards: [1] });
  });
  it('buries short side suits while preserving trump entries and side tractors', () => {
    const s = state();
    s.phase = 'bury';
    s.dealer = 3;
    s.hands[3] = [];
    let id = 0;
    for (const rank of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 2])
      s.hands[3].push(c(id++, 'S', rank));
    for (const rank of [16, 16, 17, 17]) s.hands[3].push(c(id++, 'J', rank));
    for (const rank of [7, 7, 8, 8, 13, 13, 14, 14]) s.hands[3].push(c(id++, 'H', rank));
    for (const rank of [3, 4, 5, 6]) s.hands[3].push(c(id++, 'D', rank));
    for (const rank of [3, 4, 6, 7]) s.hands[3].push(c(id++, 'C', rank));
    const a = recommend(tractor.view(s, 3));
    expect(tractor.validate(s, 3, a)).toBe(null);
    expect(a.type === 'bury' && a.cards.every((id) => id >= 25)).toBe(true);
  });
  it('preserves a side pair instead of splitting it to follow one cheap single', () => {
    const s = state();
    s.hands[3] = [c(0, 'H', 3), c(1, 'H', 3), c(2, 'H', 4)];
    expect(recommend(tractor.view(s, 3))).toEqual({ type: 'play', cards: [2] });
  });
  it('does not spend a big trump overtaking a secure partner when void', () => {
    const s = state();
    s.hands[3] = [c(0, 'J', 17), c(1, 'C', 13), c(2, 'D', 3)];
    expect(recommend(tractor.view(s, 3))).toEqual({ type: 'play', cards: [1] });
  });
  it('feeds early when partner top trump is publicly unbeatable', () => {
    const s = state();
    s.turn = 2;
    s.trick = [
      { seat: 0, cards: [c(90, 'J', 17)] },
      { seat: 1, cards: [c(91, 'S', 3)] },
    ];
    s.hands[2] = [c(0, 'C', 13), c(1, 'D', 3)];
    expect(recommend(tractor.view(s, 2))).toEqual({ type: 'play', cards: [0] });
  });
  it('does not burn its sole big joker on a zero-point mid-round trick', () => {
    const s = state();
    s.trick = [
      { seat: 0, cards: [c(90, 'H', 8)] },
      { seat: 1, cards: [c(91, 'H', 3)] },
      { seat: 2, cards: [c(92, 'H', 9)] },
    ];
    s.hands[3] = [
      c(0, 'J', 17),
      c(1, 'D', 3),
      c(2, 'D', 4),
      c(3, 'C', 6),
      c(4, 'C', 7),
      c(5, 'D', 8),
    ];
    expect(recommend(tractor.view(s, 3))).toEqual({ type: 'play', cards: [1] });
  });
  it('captures a mixed pair-plus-single throw with a matching economical trump cover', () => {
    const s = state();
    s.trick = [
      { seat: 0, cards: [c(90, 'H', 14), c(91, 'H', 14), c(92, 'H', 11)] },
      { seat: 1, cards: [c(93, 'H', 3), c(94, 'H', 4), c(95, 'H', 6)] },
      { seat: 2, cards: [c(96, 'H', 13), c(97, 'H', 13), c(98, 'H', 10)] },
    ];
    s.hands[3] = [
      c(0, 'S', 3),
      c(1, 'S', 3),
      c(2, 'S', 4),
      c(3, 'J', 17),
      c(4, 'C', 3),
      c(5, 'D', 3),
    ];
    const a = recommend(tractor.view(s, 3));
    expect(tractor.validate(s, 3, a)).toBe(null);
    expect(a.type === 'play' && a.cards.slice().sort()).toEqual([0, 1, 2]);
  });
  it('infers partial-follow voids only in effective lead suit, never arbitrary off-suit leads', () => {
    const s = state();
    s.trick = [];
    s.playedHistory = [
      [
        { seat: 0, cards: [c(80, 'H', 7), c(81, 'H', 7)] },
        { seat: 1, cards: [c(82, 'H', 9), c(83, 'D', 6)] },
        { seat: 2, cards: [c(84, 'H', 2), c(85, 'H', 2)] },
      ],
    ];
    const k = publicKnowledge(tractor.view(s, 3));
    expect([...k.voids[0]]).toEqual([]);
    expect([...k.voids[1]]).toEqual(['H']);
    expect([...k.voids[2]]).toEqual(['H']);
    // Heart level cards are trump: following them with a diamond proves void in TRUMP, not hearts.
    s.playedHistory = [
      [
        { seat: 0, cards: [c(80, 'H', 2)] },
        { seat: 1, cards: [c(81, 'D', 6)] },
      ],
    ];
    expect([...publicKnowledge(tractor.view(s, 3)).voids[1]]).toEqual(['J']);
  });
  it('never uses hidden opponent cards, pile, RNG or unknown kitty and never mutates a view', () => {
    const s = state();
    s.hands[0] = [c(40, 'H', 3)];
    const view = tractor.view(s, 3);
    const before = JSON.stringify(view);
    const a = recommend(view);
    s.hands[0] = [c(40, 'J', 17)];
    s.kitty = [c(50, 'D', 10)];
    s.rng = 9988;
    s.drawPile = [];
    expect(tractor.view(s, 3)).toEqual(view);
    expect(recommend(tractor.view(s, 3))).toEqual(a);
    expect(JSON.stringify(view)).toBe(before);
  });
  it('avoids an enemy proven void instead of gifting them a guaranteed point lead', () => {
    const s = state();
    s.turn = 0;
    s.trick = [];
    s.hands[0] = [c(0, 'H', 13), c(1, 'C', 3)];
    s.playedHistory = [
      [
        { seat: 0, cards: [c(80, 'H', 7)] },
        { seat: 1, cards: [c(81, 'D', 3)] },
        { seat: 2, cards: [c(82, 'S', 4)] },
        { seat: 3, cards: [c(83, 'D', 6)] },
      ],
    ];
    expect(recommend(tractor.view(s, 0))).toEqual({ type: 'play', cards: [1] });
  });
  it('takes the final trick with trump to secure kitty even if the trick has no face points', () => {
    const s = state();
    s.hands[3] = [c(0, 'J', 17), c(1, 'D', 3)];
    s.trick[1].cards = [c(91, 'H', 3)];
    s.trick[2].cards = [c(92, 'H', 9)];
    expect(recommend(tractor.view(s, 3))).toEqual({ type: 'play', cards: [0] });
  });
  it('feeds a ten-point pair when partner is winning the pair and we are last', () => {
    const s = state();
    s.trick = [
      { seat: 0, cards: [c(90, 'H', 7), c(91, 'H', 7)] },
      { seat: 1, cards: [c(92, 'H', 13), c(93, 'H', 13)] },
      { seat: 2, cards: [c(94, 'H', 9), c(95, 'H', 9)] },
    ];
    s.hands[3] = [c(0, 'H', 3), c(1, 'H', 3), c(2, 'H', 10), c(3, 'H', 10)];
    expect(recommend(tractor.view(s, 3))).toEqual({ type: 'play', cards: [2, 3] });
  });
  it('feeds ten points when last to act and partner is secure, instead of discarding zero', () => {
    const s = state();
    const a = recommend(tractor.view(s, 3));
    expect(tractor.validate(s, 3, a)).toBe(null);
    expect(a).toEqual({ type: 'play', cards: [1] });
  });
});
