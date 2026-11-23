import { describe, expect, it } from 'vitest';
import { doudizhu } from '../../../packages/engine/src/games/doudizhu';
import { LegacySession } from '../legacy/session';

describe('isolated legacy human vs bots', () => {
  it('deals, rejects out-of-turn actions, and completes a round using the existing engine', () => {
    const game = new LegacySession(7);
    expect(game.view.hand).toHaveLength(17);
    if (game.view.turn !== 0) expect(game.act({ type: 'bid', score: 3 })).toBeTruthy();
    let actions = 0;
    while (!game.view.result && actions++ < 500) {
      if (game.view.turn === 0) {
        const action =
          game.view.phase === 'bidding' ? { type: 'bid' as const, score: 3 as const } : game.hint();
        expect(game.act(action)).toBeNull();
      } else expect(game.stepBot()).toBe(true);
    }
    expect(game.view.result).not.toBeNull();
    expect(game.view.scores.reduce((a, b) => a + b, 0)).toBe(0);
    expect(game.act({ type: 'ready' })).toBeNull();
    game.stepBot();
    game.stepBot();
    expect(game.view.round).toBe(2);
    expect(game.view.hand).toHaveLength(17);
    expect(doudizhu.meta.id).toBe('doudizhu');
  });
});
