import { describe, expect, it } from 'vitest';
import type { Card } from '../src/core/cards';
import {
  isPubliclySafeThrow,
  sampleSmartBeliefs,
  thinkTractor,
  tractor,
  type TractorState,
} from '../src/games/tractor';

const c = (id: number, suit: Card['suit'], rank: number): Card => ({ id, suit, rank });
const players = Array.from({ length: 4 }, () => ({ name: 'bot', isBot: true }));

function makePlayState(seed = 11): TractorState {
  let s = tractor.setup({ players, options: { rounds: 1 }, seed });
  while (s.phase === 'dealing') s = tractor.apply(s, -1, { type: 'deal' });
  s = tractor.apply(s, -1, { type: 'closeReveal' });
  const bury = thinkTractor(tractor.view(s, s.turn), { budgetMs: 80 });
  expect(tractor.validate(s, s.turn, bury)).toBeNull();
  s = tractor.apply(s, s.turn, bury);
  return s;
}

describe('tractor-think-v3 deep search', () => {
  it('enforces strict view-only information isolation and zero view mutation', () => {
    const s = makePlayState(19);
    const seat = s.turn;
    const view1 = tractor.view(s, seat);
    const snapBefore = JSON.stringify(view1);
    const act1 = thinkTractor(view1, { maxWorlds: 8, budgetMs: 500, clock: () => 0 });
    expect(JSON.stringify(view1)).toBe(snapBefore);
    expect(tractor.validate(s, seat, act1)).toBeNull();

    // Permute opponent concealed hands, kitty (for non-dealer), and hidden RNG
    const otherA = (seat + 1) % 4;
    const otherB = (seat + 3) % 4;
    const swapped = [...s.hands[otherA]];
    s.hands[otherA] = [...s.hands[otherB]];
    s.hands[otherB] = swapped;
    s.rng = 987654321;

    const view2 = tractor.view(s, seat);
    expect(view2).toEqual(view1);
    const act2 = thinkTractor(view2, { maxWorlds: 8, budgetMs: 500, clock: () => 0 });
    expect(act2).toEqual(act1);
  });

  it('identifies 100% publicly safe throws and rejects unsafe mixed throws', () => {
    const myCards = [c(1, 'H', 14), c(2, 'H', 14), c(3, 'H', 13)];
    // Unseen has only one H13 and lower cards -> neither AA nor K can be beaten in hearts!
    const safeUnseen = [c(10, 'H', 13), c(11, 'H', 10), c(12, 'H', 9)];
    expect(isPubliclySafeThrow(myCards, safeUnseen, 2, 'S')).toBe(true);

    // If an unseen Heart Ace exists when leading AK, single K can be beaten -> unsafe!
    const unsafeCombo = [c(1, 'H', 14), c(3, 'H', 13)];
    const unsafeUnseen = [c(2, 'H', 14), c(11, 'H', 9)];
    expect(isPubliclySafeThrow(unsafeCombo, unsafeUnseen, 2, 'S')).toBe(false);
  });

  it('changes tactical choice on identical hand when public history flips partner vs enemy void', () => {
    const base = tractor.setup({ players, options: { rounds: 1 }, seed: 5 });
    base.phase = 'play';
    base.level = 2;
    base.trump = 'S';
    base.dealer = 1;
    base.turn = 0;
    base.trick = [];
    // Seat 0 holds a 10-point Heart King and a low Diamond
    base.hands = [
      [c(0, 'H', 13), c(1, 'D', 4), c(2, 'C', 6)],
      [c(10, 'C', 8), c(11, 'D', 7), c(12, 'S', 9)],
      [c(20, 'S', 10), c(21, 'C', 9), c(22, 'D', 8)],
      [c(30, 'C', 11), c(31, 'D', 9), c(32, 'H', 6)],
    ];
    base.kitty = [
      c(40, 'C', 3),
      c(41, 'C', 4),
      c(42, 'C', 5),
      c(43, 'D', 3),
      c(44, 'D', 5),
      c(45, 'H', 3),
      c(46, 'H', 4),
      c(47, 'H', 7),
    ];

    // Scenario A: Enemy (seat 1, dealer) is publicly proven void in Hearts and holds trumps
    const enemyVoidState: TractorState = {
      ...base,
      playedHistory: [
        [
          { seat: 0, cards: [c(80, 'H', 8)] },
          { seat: 1, cards: [c(81, 'C', 7)] }, // seat 1 showed Heart void!
          { seat: 2, cards: [c(82, 'H', 9)] },
          { seat: 3, cards: [c(83, 'H', 11)] },
        ],
      ],
    };
    const actEnemyVoid = thinkTractor(tractor.view(enemyVoidState, 0), { budgetMs: 120 });
    expect(actEnemyVoid).not.toEqual({ type: 'play', cards: [0] }); // Never gift H-K into enemy void!

    // Scenario B: Partner (seat 2) is publicly proven void in Hearts and enemies followed Hearts
    const partnerVoidState: TractorState = {
      ...base,
      hands: [
        [c(0, 'H', 3), c(1, 'D', 8), c(2, 'C', 8)],
        base.hands[1],
        base.hands[2],
        base.hands[3],
      ],
      playedHistory: [
        [
          { seat: 1, cards: [c(80, 'H', 8)] },
          { seat: 2, cards: [c(81, 'C', 7)] }, // partner seat 2 showed Heart void!
          { seat: 3, cards: [c(82, 'H', 9)] },
          { seat: 0, cards: [c(83, 'H', 11)] },
        ],
      ],
    };
    const actPartnerVoid = thinkTractor(tractor.view(partnerVoidState, 0), { budgetMs: 120 });
    expect(actPartnerVoid).toEqual({ type: 'play', cards: [0] });
  });

  it('respects smart belief constraints and completes full rounds with zero illegal moves', () => {
    for (const seed of [101, 102, 103]) {
      let s = tractor.setup({ players, options: { rounds: 1 }, seed });
      let steps = 0;
      while (!tractor.isOver(s) && steps++ < 400) {
        const auto = tractor.autoAdvance!(s);
        if (auto) {
          s = tractor.apply(s, -1, auto.action);
          continue;
        }
        const seat = tractor.activeSeats(s)[0];
        const v = tractor.view(s, seat);
        if (v.phase === 'play' && steps % 17 === 0) {
          const b = sampleSmartBeliefs(v, 6);
          expect(b.worlds.length).toBeGreaterThan(0);
          for (const w of b.worlds) {
            expect(w.hands[seat]).toEqual(v.hand);
            expect(w.kitty).toHaveLength(8);
          }
        }
        const act = thinkTractor(v, { budgetMs: 40, maxWorlds: 8 });
        expect(tractor.validate(s, seat, act)).toBeNull();
        s = tractor.apply(s, seat, act);
      }
      expect(tractor.isOver(s)).toBe(true);
    }
  });
});
