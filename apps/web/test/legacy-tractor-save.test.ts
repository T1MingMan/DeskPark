import { describe, it, expect } from 'vitest';
import { LegacyTractorSession } from '../legacy-tractor/session';
import { recommend } from '../../../packages/engine/src/games/tractor';

describe('old Tractor exact local continuation', () => {
  it('roundtrips the complete paused session without advancing and preserves skip acknowledgement', () => {
    const game = new LegacyTractorSession(24);
    while (!game.awaitingDeclaration) game.step();
    const saved = game.serialize();
    const restored = LegacyTractorSession.restore(saved);
    expect(restored.serialize()).toBe(saved);
    expect(restored.awaitingDeclaration).toBe(true);
    expect(restored.step()).toBe(false);
    restored.skipDeclaration();
    const skipped = LegacyTractorSession.restore(restored.serialize());
    expect(skipped.awaitingDeclaration).toBe(false);
    expect(skipped.step()).toBe(true);
    game.skipDeclaration();
    game.step();
    expect(skipped.serialize()).toBe(game.serialize());
  });
  it('rejects corrupt, unsupported and structurally invalid checkpoints before use', () => {
    const valid = new LegacyTractorSession(24).serialize();
    const mutate = (fn: (s: ReturnType<typeof JSON.parse>) => void) => {
      const s = JSON.parse(valid);
      fn(s);
      return JSON.stringify(s);
    };
    for (const text of [
      '{',
      '{}',
      'null',
      mutate((s) => (s.version = 2)),
      mutate((s) => (s.format = 'modern')),
      mutate((s) => (s.state.phase = 'unknown')),
      mutate((s) => (s.state.hands = [])),
      mutate((s) => (s.state.drawPile[0].rank = 900)),
      mutate((s) => (s.state.drawPile[1] = s.state.drawPile[0])),
      mutate((s) => delete s.state.playedHistory),
      mutate((s) => (s.acknowledged = [5])),
      mutate((s) => (s.rng = -1)),
    ])
      expect(() => LegacyTractorSession.restore(text)).toThrow();
  });
  it('restores every transition through settlement and next round with identical future randomness', () => {
    let game = new LegacyTractorSession(79);
    const phases = new Set<string>();
    for (let n = 0; n < 1000 && game.view.round < 3; n++) {
      const restored = LegacyTractorSession.restore(game.serialize());
      expect(restored.serialize()).toBe(game.serialize());
      phases.add(game.view.phase);
      for (const session of [game, restored]) {
        if (['dealing', 'reveal'].includes(session.view.phase)) {
          expect(session.act(recommend(session.view))).toBeNull();
          session.step();
        } else if (session.isHumanActive) expect(session.act(recommend(session.view))).toBeNull();
        else session.step();
      }
      expect(restored.serialize()).toBe(game.serialize());
      const beforeReadingPause = game.serialize();
      void game.awaitingDeclaration;
      expect(game.serialize()).toBe(beforeReadingPause);
      game = restored;
    }
    expect(game.view.round).toBe(3);
    expect([...phases]).toEqual(
      expect.arrayContaining(['dealing', 'reveal', 'bury', 'play', 'trickOver', 'roundOver']),
    );
  });
});
