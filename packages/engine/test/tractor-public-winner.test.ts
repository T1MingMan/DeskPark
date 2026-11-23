import { describe, expect, it } from 'vitest';
import { currentTrickWinner, tractor, type Play } from '../src/games/tractor';
import type { Card, Suit } from '../src/core/cards';
let id = 0;
const cards = (suit: Suit, ranks: number[]): Card[] =>
  ranks.map((rank) => ({ id: id++, suit, rank }));
const play = (seat: number, suit: Suit, ranks: number[]): Play => ({
  seat,
  cards: cards(suit, ranks),
});
describe('public partial trick winner uses settlement comparison', () => {
  it('has no winner for an empty trick', () => expect(currentTrickWinner([], 2, 'S')).toBeNull());
  it.each([
    [[play(2, 'H', [10]), play(3, 'H', [14])], 3],
    [[play(2, 'H', [14]), play(3, 'D', [14])], 2],
    [[play(2, 'H', [14]), play(3, 'S', [3])], 3],
    [[play(2, 'S', [2]), play(3, 'J', [16])], 3],
    [[play(2, 'H', [2]), play(3, 'C', [2])], 2],
    [[play(2, 'H', [8, 8]), play(3, 'J', [17, 16])], 2],
    [[play(2, 'H', [8, 8]), play(3, 'S', [3, 3])], 3],
    [[play(2, 'H', [8, 8, 9, 9]), play(3, 'S', [5, 5, 7, 7])], 2],
    [[play(2, 'H', [8, 8, 9, 9]), play(3, 'S', [5, 5, 6, 6])], 3],
    [[play(2, 'H', [8, 8, 14]), play(3, 'S', [5, 5, 14]), play(0, 'S', [6, 6, 3])], 0],
  ] as [Play[], number][])('compares public plays %# correctly', (trick, winner) => {
    expect(currentTrickWinner(trick, 2, 'S')).toBe(winner);
    const s = tractor.setup({
      seed: 42,
      options: { rounds: 0 },
      players: [0, 1, 2, 3].map(() => ({ name: 'p', isBot: false })),
    });
    s.phase = 'play';
    s.level = 2;
    s.trump = 'S';
    // Complete with equal copies: ties preserve the first winning play.
    const full = [...trick];
    while (full.length < 4)
      full.push({
        seat: (full[full.length - 1].seat + 1) % 4,
        cards: full[0].cards.map((c) => ({ ...c, id: id++ })),
      });
    s.trick = full.slice(0, 3);
    s.turn = full[3].seat;
    s.hands[s.turn] = full[3].cards;
    const settled = tractor.apply(s, s.turn, {
      type: 'play',
      cards: full[3].cards.map((c) => c.id),
    });
    expect(settled.winner).toBe(currentTrickWinner(full, 2, 'S'));
  });
});
