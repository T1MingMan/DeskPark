import { afterEach, describe, expect, it, vi } from 'vitest';
import { LegacyTractorSession } from '../legacy-tractor/session';
import { tractor, basicRecommend } from '../../../packages/engine/src/games/tractor';
afterEach(() => vi.restoreAllMocks());

describe('human declaration opportunity gate', () => {
  it('preempts actual simultaneous legal computer reveals, not only deal advancement', () => {
    // Gate regression deliberately injects an eager legal policy, independent of suit strategy.
    vi.spyOn(tractor, 'bot').mockImplementation((v) => basicRecommend(v));
    const game = new LegacyTractorSession(24);
    let s = tractor.setup({
      seed: 24,
      options: { rounds: 0 },
      players: [0, 1, 2, 3].map(() => ({ name: 'p', isBot: false })),
    });
    for (let i = 0; i < 2; i++) {
      game.step();
      s = tractor.apply(s, -1, { type: 'deal' });
    }
    expect(game.awaitingDeclaration).toBe(true);
    expect([1, 2].map((seat) => basicRecommend(tractor.view(s, seat)).type)).toEqual([
      'reveal',
      'reveal',
    ]);
    expect(game.step()).toBe(false);
    expect(game.view.bid).toBeNull();
    const option = game.declarations.find((o) => o.cards.length)!;
    expect(game.act({ type: 'reveal', cards: option.cards })).toBeNull();
    expect(game.view.bid?.seat).toBe(0);
  });
  it('freezes both deal and computer declarations until a human decides, then skips without livelock and repauses for a new option', () => {
    const game = new LegacyTractorSession(10);
    expect(game.delayMs).toBe(450);
    for (let i = 0; i < 25 && !game.awaitingDeclaration; i++) game.step();
    expect(game.awaitingDeclaration).toBe(true);
    const before = JSON.stringify(game.view);
    for (let i = 0; i < 20; i++) expect(game.step()).toBe(false);
    expect(JSON.stringify(game.view)).toBe(before);
    const first = game.declarations.find((o) => o.cards.length)!;
    expect(game.act({ type: 'reveal', cards: first.cards })).toBeNull();
    expect(game.view.bid?.seat).toBe(0);
    expect(game.awaitingDeclaration).toBe(false);
    let pauses = 0;
    for (let i = 0; i < 100 && ['dealing', 'reveal'].includes(game.view.phase); i++) {
      if (game.awaitingDeclaration) {
        pauses++;
        const snapshot = JSON.stringify(game.view);
        expect(game.step()).toBe(false);
        expect(JSON.stringify(game.view)).toBe(snapshot);
        game.skipDeclaration();
        expect(game.awaitingDeclaration).toBe(false);
      }
      expect(game.step()).toBe(true);
    }
    expect(pauses).toBeGreaterThan(0);
    expect(game.view.phase).toBe('bury');
  });
  it('offers exactly five fixed choices and each enabled choice is accepted by the real engine', () => {
    for (const seed of [42, 79, 123, 987]) {
      const game = new LegacyTractorSession(seed);
      for (let i = 0; i < 30 && ['dealing', 'reveal'].includes(game.view.phase); i++) {
        expect(game.declarations.map((o) => o.suit)).toEqual(['S', 'H', 'C', 'D', 'J']);
        if (game.awaitingDeclaration) {
          const option = game.declarations.find((o) => o.cards.length)!;
          expect(game.act({ type: 'reveal', cards: option.cards })).toBeNull();
        }
        game.skipDeclaration();
        game.step();
      }
      expect(game.view.phase).toBe('bury');
    }
  });
  it('skip releases real computer reveals and advances the deal without recurring on the same offer', () => {
    vi.spyOn(tractor, 'bot').mockImplementation((v) => basicRecommend(v));
    const game = new LegacyTractorSession(24);
    game.step();
    game.step();
    expect(game.awaitingDeclaration).toBe(true);
    game.skipDeclaration();
    expect(game.awaitingDeclaration).toBe(false);
    expect(game.step()).toBe(true);
    expect(game.view.dealt).toBe(3);
    expect(game.view.bid?.seat).toBe(1);
    let ticks = 0;
    while (['dealing', 'reveal'].includes(game.view.phase) && ticks++ < 40) {
      game.skipDeclaration();
      expect(game.step()).toBe(true);
    }
    expect(game.view.phase).toBe('bury');
  });
});
