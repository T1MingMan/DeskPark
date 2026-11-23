import { it, expect } from 'vitest';
import { tractor, recommend } from '../src/games/tractor';
const players = Array.from({ length: 4 }, () => ({ name: 'bot', isBot: true }));
it('produces only legal actions and never mutates views across mixed throws, shortages and endgames', () => {
  for (let seed = 1; seed <= 60; seed++) {
    let s = tractor.setup({ players, options: { rounds: 1 }, seed });
    let steps = 0;
    while (s.phase !== 'matchOver' && steps++ < 900) {
      const auto = tractor.autoAdvance!(s);
      const seat = auto ? -1 : tractor.activeSeats(s)[0];
      const view = auto ? null : tractor.view(s, seat);
      const before = view ? JSON.stringify(view) : '';
      let action = auto?.action;
      if (!action) action = recommend(view!);
      if (seed % 3 === 0 && seat >= 0 && s.phase === 'play' && !s.trick.length) {
        // Deliberate mixed same-suit throw, sometimes failing and penalised by the engine.
        const hand = view!.hand;
        const same = hand.filter(
          (c) =>
            `${c.suit}${c.rank === s.level || c.suit === 'J' ? 'J' : c.suit}` ===
            `${hand[0].suit}${hand[0].rank === s.level || hand[0].suit === 'J' ? 'J' : hand[0].suit}`,
        );
        if (same.length > 1 && same.length <= 6)
          action = { type: 'play', cards: same.map((c) => c.id) };
      }
      const error = tractor.validate(s, seat, action!);
      if (error && s.trick.length) throw new Error(`seed ${seed} step ${steps}: ${error}`);
      if (error) action = recommend(view!);
      expect(tractor.validate(s, seat, action!), `seed ${seed} step ${steps}`).toBe(null);
      if (view) expect(JSON.stringify(view)).toBe(before);
      const next = tractor.apply(s, seat, action!);
      expect(s).not.toBe(next);
      s = next;
    }
    expect(s.phase).toBe('matchOver');
  }
});
it('takes the last trick with trump when it is the only way to secure the kitty', () => {
  const s = tractor.setup({ players, options: { rounds: 1 }, seed: 3 });
  s.phase = 'play';
  s.turn = 3;
  s.level = 2;
  s.trump = 'S';
  s.hands = [
    [],
    [],
    [],
    [
      { id: 0, suit: 'J', rank: 17 },
      { id: 1, suit: 'D', rank: 3 },
    ],
  ];
  s.trick = [
    { seat: 0, cards: [{ id: 90, suit: 'H', rank: 4 }] },
    { seat: 1, cards: [{ id: 91, suit: 'H', rank: 5 }] },
    { seat: 2, cards: [{ id: 92, suit: 'H', rank: 6 }] },
  ];
  expect(recommend(tractor.view(s, 3))).toEqual({ type: 'play', cards: [0] });
});
