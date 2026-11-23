import { describe, expect, it } from 'vitest';
import { LegacyTractorSession } from '../legacy-tractor/session';
import { recommend } from '../../../packages/engine/src/games/tractor';
describe('isolated tractor local adapter', () => {
  it('deals progressively, lets bots reveal during dealing, and runs four endless rounds without a human hint API', () => {
    const game = new LegacyTractorSession(42);
    expect(game.view.hand).toHaveLength(0);
    expect('hint' in game).toBe(false);
    expect(game.act({ type: 'bury', cards: [] })).toBeTruthy();
    const phases = new Set<string>();
    let ticks = 0;
    let bidDuringDeal = false;
    while (game.view.round <= 4 && ticks++ < 3000) {
      const v = game.view;
      phases.add(v.phase);
      if (v.phase === 'dealing' || v.phase === 'reveal') {
        const a = recommend(v);
        expect(game.act(a)).toBeNull(); // pass acknowledges an optional human declaration too
        expect(game.step()).toBe(true);
        if (game.view.phase === 'dealing' && game.view.bid) bidDuringDeal = true;
      } else if (game.isHumanActive) expect(game.act(recommend(v))).toBeNull();
      else expect(game.step()).toBe(true);
    }
    expect(ticks).toBeLessThan(3000);
    expect(game.view.round).toBe(5);
    expect(bidDuringDeal).toBe(true);
    expect([...phases]).toEqual(
      expect.arrayContaining(['dealing', 'reveal', 'bury', 'play', 'trickOver', 'roundOver']),
    );
  });
});
