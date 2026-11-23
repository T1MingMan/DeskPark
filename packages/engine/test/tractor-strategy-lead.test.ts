import { it, expect } from 'vitest';
import { tractor, recommend, type TractorState } from '../src/games/tractor';
import type { Card } from '../src/core/cards';
const c = (id: number, suit: Card['suit'], rank: number): Card => ({ id, suit, rank });
const players = Array.from({ length: 4 }, () => ({ name: 'bot', isBot: true }));
function base(): TractorState {
  const s = tractor.setup({ players, options: { rounds: 1 }, seed: 1 });
  s.phase = 'play';
  s.level = 2;
  s.trump = 'S';
  s.dealer = 0;
  s.trick = [];
  s.playedHistory = [];
  s.kitty = [];
  return s;
}
it('leads a proven-void partner into a cheap ruff instead of cashing a side winner', () => {
  const s = base();
  s.turn = 0;
  s.trump = 'S';
  // Public trick: partner seat1 is void in clubs (only a diamond follows a club pair).
  s.hands = [
    [c(0, 'H', 4), c(1, 'C', 13), c(2, 'C', 6), c(3, 'H', 6)],
    [c(30, 'C', 9)],
    [c(20, 'S', 3), c(21, 'S', 4)],
    [c(40, 'D', 9), c(41, 'D', 10)],
  ];
  // Partner seat2 is proven club-void (only a diamond followed the club pair).
  s.playedHistory = [
    [
      { seat: 1, cards: [c(86, 'C', 12), c(87, 'C', 12)] },
      { seat: 2, cards: [c(88, 'D', 5), c(89, 'D', 6)] },
      { seat: 3, cards: [c(90, 'C', 8), c(91, 'C', 10)] },
      { seat: 0, cards: [c(92, 'C', 4), c(93, 'C', 7)] },
    ],
  ];
  const a = recommend(tractor.view(s, 0));
  expect(tractor.validate(s, 0, a)).toBe(null);
  // Low club into proven partner void, not the club king or a side heart.
  expect(a).toEqual({ type: 'play', cards: [2] });
});
it('does not lead a suit when an enemy has proven void and can ruff the points', () => {
  const s = base();
  s.turn = 0;
  s.hands = [
    [c(0, 'C', 13), c(1, 'C', 13), c(2, 'D', 4), c(3, 'H', 3)],
    [c(30, 'H', 6)],
    [c(20, 'S', 3)],
    [c(40, 'H', 9)],
  ];
  s.playedHistory = [
    [
      { seat: 0, cards: [c(80, 'H', 5)] },
      { seat: 1, cards: [c(81, 'D', 3)] },
      { seat: 2, cards: [c(82, 'D', 6)] },
      { seat: 3, cards: [c(83, 'D', 7)] },
    ],
  ];
  const a = recommend(tractor.view(s, 0));
  expect(a.type === 'play' && a.cards).not.toEqual([0, 1]);
});
