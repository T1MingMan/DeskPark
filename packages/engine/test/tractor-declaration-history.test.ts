import { describe, it, expect } from 'vitest';
import { tractor } from '../src/games/tractor';
const setup = () =>
  tractor.setup({
    players: ['a', 'b', 'c', 'd'].map((name) => ({ name, isBot: false })),
    options: { rounds: 0 },
    seed: 3,
  });
describe('Tractor public declaration artwork', () => {
  it('deals at 450ms without changing other phase timing', () => {
    expect(tractor.autoAdvance!(setup())?.delayMs).toBe(450);
  });
  it('retains accepted declarations only, redacts private data and clears at bury', () => {
    let s = setup();
    for (let i = 0; i < 25; i++) s = tractor.apply(s, -1, { type: 'deal' });
    const before = structuredClone(s);
    s = tractor.apply(s, 1, { type: 'reveal', cards: [67] });
    expect(before.bid).toBeNull();
    expect(tractor.view(s, null)).toHaveProperty('declarationHistory', [
      { seat: 1, cards: [s.bid!.cards[0]] },
    ]);
    s = tractor.apply(s, 0, { type: 'reveal', cards: [107, 53] });
    const v = tractor.view(s, null);
    expect(v).toHaveProperty('declarationHistory', [
      { seat: 1, cards: [s.hands[1].find((c) => c.id === 67)] },
      { seat: 0, cards: s.bid!.cards },
    ]);
    for (const key of ['hands', 'rng', 'drawPile', 'declarationAcknowledged'])
      expect(v).not.toHaveProperty(key);
    expect(v.hand).toEqual([]);
    expect(v.kitty).toEqual([]);
    // A late join receives precisely the same public announcements; views cannot mutate state.
    const late = tractor.view(s, 2) as typeof v & {
      declarationHistory: { seat: number; cards: { id: number }[] }[];
    };
    late.declarationHistory[0].cards[0].id = -1;
    expect(tractor.view(s, null)).toEqual(v);
    s = tractor.apply(s, -1, { type: 'closeReveal' });
    expect(tractor.view(s, null)).toHaveProperty('declarationHistory', []);
    expect(tractor.view(setup(), null)).toHaveProperty('declarationHistory', []);
  });
});
