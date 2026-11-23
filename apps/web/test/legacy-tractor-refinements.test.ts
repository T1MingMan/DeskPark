import { describe, expect, it } from 'vitest';
import { LegacyTractorSession } from '../legacy-tractor/session';
import { tractor, recommend, type TractorView } from '../../../packages/engine/src/games/tractor';

describe('public declaration cards at each compass seat', () => {
  it('records actual human and computer announcements including overcalls, and clears on bury and next round', () => {
    let human = 0,
      bots = 0,
      overcalls = 0;
    for (const seed of [10, 24, 79]) {
      const game = new LegacyTractorSession(seed);
      const history = () =>
        (game as LegacyTractorSession & { revealedDeclarations: NonNullable<TractorView['bid']>[] })
          .revealedDeclarations;
      expect(history()).toEqual([]);
      let previous = 0;
      for (let n = 0; n < 100 && ['dealing', 'reveal'].includes(game.view.phase); n++) {
        if (game.awaitingDeclaration) {
          const option = game.declarations.find((o) => o.cards.length)!;
          const actual = game.view.hand.filter((c) => option.cards.includes(c.id));
          expect(game.act({ type: 'reveal', cards: option.cards })).toBeNull();
          expect(history().find((b) => b.seat === 0)?.cards).toEqual(game.view.bid?.cards);
          expect(game.view.bid?.cards).toEqual(actual);
          human++;
        }
        game.skipDeclaration();
        game.step();
        const v = game.view;
        if (!['dealing', 'reveal'].includes(v.phase)) break;
        const bid = v.bid;
        if (bid && bid.strength > previous) {
          expect(history().find((b) => b.seat === bid.seat)).toEqual(bid);
          if (bid.seat !== 0) bots++;
          if (previous) overcalls++;
          previous = bid.strength;
        }
        // Test fixture may inspect deck; production history must contain only public bid cards.
        let fixture = tractor.setup({
          seed,
          options: tractor.defaultOptions,
          players: [0, 1, 2, 3].map(() => ({ name: 'p', isBot: false })),
        });
        for (let dealt = 0; dealt < v.dealt; dealt++)
          fixture = tractor.apply(fixture, -1, { type: 'deal' });
        for (const shown of history()) {
          expect(shown.cards.length).toBeGreaterThan(0);
          expect(shown.cards.length).toBeLessThanOrEqual(2);
          for (const c of shown.cards) expect(fixture.hands[shown.seat]).toContainEqual(c);
        }
      }
      expect(game.view.phase).toBe('bury');
      expect(history()).toEqual([]);
      for (let n = 0; n < 1500 && game.view.round === 1; n++) {
        if (game.isHumanActive) {
          const action = recommend(game.view);
          if (action) game.act(action);
        }
        game.step();
        expect(history()).toEqual([]);
      }
      expect(game.view.round).toBe(2);
      expect(history()).toEqual([]);
    }
    expect(human).toBeGreaterThan(0);
    expect(bots).toBeGreaterThan(0);
    expect(overcalls).toBeGreaterThan(0);
  });
});
