import { describe, expect, it } from 'vitest';
import { tractor } from '../../../packages/engine/src/games/tractor';
import { LegacyTractorSession } from '../legacy-tractor/session';

describe('legacy iPad tractor async bot adapter & fallback safety', () => {
  it('returns null during dealing/reveal or human declaration pause, and falls back on invalid/timeout actions', () => {
    const session = new LegacyTractorSession(42);
    // During dealing, peekPendingBot must be null so progressive dealing rhythm is untouched
    expect(session.peekPendingBot()).toBeNull();

    // Advance through dealing & reveal into bury/play
    let guard = 0;
    while (guard++ < 200) {
      if (session.awaitingDeclaration) session.skipDeclaration();
      if (session.view.phase === 'bury' || session.view.phase === 'play') break;
      session.step();
    }

    // Move past human turn if human is active
    while (session.isHumanActive && guard++ < 250) {
      const v = session.view;
      const act = tractor.bot(v, 0, { next: () => 0.5, int: () => 0 } as never);
      expect(session.act(act)).toBeNull();
      if (session.view.phase === 'trickOver') session.step();
    }

    const pending = session.peekPendingBot();
    expect(pending).not.toBeNull();
    expect(pending!.seat).toBeGreaterThan(0);
    expect('hands' in (pending!.view as unknown as Record<string, unknown>)).toBe(false);

    // Stale version is safely discarded without throwing or mutating state
    const snapBefore = JSON.stringify(session.view);
    expect(session.applyBotDecision(pending!.seat, pending!.version + 99, null)).toBe(false);
    expect(JSON.stringify(session.view)).toBe(snapBefore);

    // Invalid remote action or timeout (`null`) seamlessly falls back to local lightweight bot
    expect(
      session.applyBotDecision(pending!.seat, pending!.version, {
        type: 'play',
        cards: [-999],
      }),
    ).toBe(true);
    expect(JSON.stringify(session.view)).not.toBe(snapBefore);
  });
});
