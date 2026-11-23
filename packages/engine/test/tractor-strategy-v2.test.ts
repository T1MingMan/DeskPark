import { describe, it, expect } from 'vitest';
import { tractor, recommend, type TractorState } from '../src/games/tractor';
const players = Array.from({ length: 4 }, () => ({ name: 'bot', isBot: true }));
function threshold(points: number): TractorState {
  const s = tractor.setup({ players, options: { rounds: 1 }, seed: 8 });
  s.phase = 'play';
  s.turn = 3;
  s.dealer = 0;
  s.points = points;
  s.trick = [
    { seat: 0, cards: [{ id: 90, suit: 'H', rank: 10 }] },
    { seat: 1, cards: [{ id: 91, suit: 'H', rank: 3 }] },
    { seat: 2, cards: [{ id: 92, suit: 'H', rank: 9 }] },
  ];
  s.hands[3] = [
    { id: 0, suit: 'J', rank: 17 },
    { id: 1, suit: 'D', rank: 3 },
    { id: 2, suit: 'D', rank: 4 },
    { id: 3, suit: 'C', rank: 6 },
    { id: 4, suit: 'C', rank: 7 },
    { id: 5, suit: 'D', rank: 8 },
  ];
  return s;
}
describe('v2 round goals', () => {
  it('offers a cheap proven-void entry, but does not gift a king instead of cashing an ace', () => {
    const s = threshold(30);
    s.turn = 0;
    s.trick = [];
    s.hands[2] = [{ id: 70, suit: 'S', rank: 9 }];
    s.hands[0] = [
      { id: 0, suit: 'C', rank: 6 },
      { id: 1, suit: 'H', rank: 3 },
    ];
    s.playedHistory = [
      [
        { seat: 1, cards: [{ id: 80, suit: 'H', rank: 8 }] },
        { seat: 2, cards: [{ id: 81, suit: 'D', rank: 4 }] },
        { seat: 3, cards: [{ id: 82, suit: 'H', rank: 9 }] },
        { seat: 0, cards: [{ id: 83, suit: 'H', rank: 7 }] },
      ],
    ];
    const entry = recommend(tractor.view(s, 0));
    expect(entry).toEqual({ type: 'play', cards: [1] });
    s.playedHistory = [];
    expect(recommend(tractor.view(s, 0))).not.toEqual(entry);
    s.playedHistory = [
      [
        { seat: 1, cards: [{ id: 80, suit: 'H', rank: 8 }] },
        { seat: 2, cards: [{ id: 81, suit: 'D', rank: 4 }] },
        { seat: 3, cards: [{ id: 82, suit: 'J', rank: 16 }] },
        { seat: 0, cards: [{ id: 83, suit: 'H', rank: 7 }] },
      ],
    ];
    s.hands[0] = [
      { id: 0, suit: 'C', rank: 14 },
      { id: 1, suit: 'H', rank: 13 },
    ];
    expect(recommend(tractor.view(s, 0))).toEqual({ type: 'play', cards: [0] });
    const v = tractor.view(s, 0);
    s.hands[1] = [...s.hands[1]].reverse();
    s.rng = 999;
    expect(tractor.view(s, 0)).toEqual(v);
    expect(recommend(tractor.view(s, 0))).toEqual(recommend(v));
  });
  it('preserves sole high trump for later control unless current capture crosses 80', () => {
    const distant = recommend(tractor.view(threshold(0), 3));
    const critical = recommend(tractor.view(threshold(70), 3));
    expect(distant).toEqual({ type: 'play', cards: [1] });
    expect(critical).toEqual({ type: 'play', cards: [0] });
  });
});
