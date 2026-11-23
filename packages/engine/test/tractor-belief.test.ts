import { describe, it, expect } from 'vitest';
import { tractor, basicRecommend, effective } from '../src/games/tractor';
import * as adaptive from '../src/games/tractor/adaptive';
import { strategicPlay } from '../src/games/tractor/strategy';
const players = Array.from({ length: 4 }, () => ({ name: 'bot', isBot: true }));
function dealt() {
  let s = tractor.setup({ players, options: { rounds: 1 }, seed: 47 });
  while (s.phase === 'dealing') s = tractor.apply(s, -1, { type: 'deal' });
  s = tractor.apply(s, -1, { type: 'closeReveal' });
  s = tractor.apply(s, s.turn, basicRecommend(tractor.view(s, s.turn)));
  return s;
}
describe('public constrained belief', () => {
  it('constructs reproducible complete worlds, respects public cards, counts, kitty and voids', () => {
    let s = dealt();
    let checked = 0;
    for (let i = 0; i < 90 && s.phase !== 'matchOver'; i++) {
      if (s.phase === 'play' && i % 9 === 0) {
        const v = tractor.view(s, s.turn),
          before = JSON.stringify(v);
        const b = adaptive.sampleBeliefs(v, 4);
        expect(b.worlds.length).toBe(4);
        expect(adaptive.sampleBeliefs(v, 4)).toEqual(b);
        for (const w of b.worlds) {
          expect(w.hands.map((h) => h.length)).toEqual(v.handCounts);
          expect(w.hands[v.seat!]).toEqual(v.hand);
          expect(w.kitty).toHaveLength(8);
          const seen = [
            ...w.hands.flat(),
            ...w.kitty,
            ...(v.playedHistory ?? []).flatMap((t) => t.flatMap((p) => p.cards)),
            ...v.trick.flatMap((p) => p.cards),
          ];
          expect(new Set(seen.map((c) => c.id)).size).toBe(108);
          for (let seat = 0; seat < 4; seat++)
            for (const suit of b.voids[seat])
              expect(w.hands[seat].some((c) => effective(c, v.level, v.trump) === suit)).toBe(
                false,
              );
        }
        expect(JSON.stringify(v)).toBe(before);
        checked++;
      }
      const auto = tractor.autoAdvance!(s);
      const seat = auto ? -1 : s.turn;
      const a = auto?.action ?? basicRecommend(tractor.view(s, seat));
      expect(tractor.validate(s, seat, a)).toBe(null);
      s = tractor.apply(s, seat, a);
    }
    expect(checked).toBeGreaterThan(4);
  });
  it('pins still-held nondealer public declaration without reading any hidden hand', () => {
    const s = dealt();
    s.bid = { seat: 1, strength: 1, cards: [s.hands[1][0]] };
    const v = tractor.view(s, 0);
    const b = adaptive.sampleBeliefs(v, 4);
    expect(b.worlds).toHaveLength(4);
    for (const w of b.worlds) expect(w.hands[1]).toContainEqual(s.bid.cards[0]);
    s.hands[1] = [...s.hands[1]].reverse();
    s.rng = 9911;
    expect(adaptive.sampleBeliefs(tractor.view(s, 0), 4)).toEqual(b);
  });
  it('bounds public-view-only rollout and returns reproducible uncertainty diagnostics', () => {
    const s = dealt(),
      v = tractor.view(s, s.turn);
    const a = basicRecommend(v);
    const r = adaptive.evaluateCandidates(v, [
      { cs: v.hand.filter((c) => 'cards' in a && a.cards.includes(c.id)), value: 0 },
    ]);
    expect(r.samples).toBeGreaterThan(1);
    expect(r.nodes).toBeLessThanOrEqual(144);
    expect(r.ranked[0].value).toBeTypeOf('number');
    expect(
      adaptive.evaluateCandidates(v, [
        { cs: v.hand.filter((c) => 'cards' in a && a.cards.includes(c.id)), value: 0 },
      ]),
    ).toEqual(r);
  });
  it('remembers earlier public overcalls after bury and constrains every still-held nondealer reveal', () => {
    let s = tractor.setup({ players, options: { rounds: 0 }, seed: 3 });
    while (s.phase === 'dealing') s = tractor.apply(s, -1, { type: 'deal' });
    s.round = 2;
    s.dealer = 3;
    for (const [seat, ids] of [
      [1, [67]],
      [0, [107, 53]],
    ] as const) {
      const a = { type: 'reveal' as const, cards: [...ids] };
      expect(tractor.validate(s, seat, a)).toBe(null);
      s = tractor.apply(s, seat, a);
    }
    const accepted = tractor.view(s, 2).declarationHistory;
    s = tractor.apply(s, -1, { type: 'closeReveal' });
    s = tractor.apply(s, 3, basicRecommend(tractor.view(s, 3)));
    expect(tractor.view(s, 2)).toHaveProperty('publicReveals', accepted);
    const b = adaptive.sampleBeliefs(tractor.view(s, 2), 4);
    expect(b.worlds).toHaveLength(4);
    for (const w of b.worlds) {
      expect(w.hands[1].some((c) => c.id === 67)).toBe(true);
      expect(w.hands[0].filter((c) => [107, 53].includes(c.id))).toHaveLength(2);
    }
  });
  it('keeps dealer shown cards in dealer hand OR unknown kitty, never another hand', () => {
    const s = dealt();
    s.dealer = 3;
    const card = s.hands[3][0];
    s.publicReveals = [{ seat: 3, cards: [card] }];
    const b = adaptive.sampleBeliefs(tractor.view(s, 0), 6);
    expect(b.worlds).toHaveLength(6);
    for (const w of b.worlds)
      expect([...w.hands[3], ...w.kitty].some((c) => c.id === card.id)).toBe(true);
  });
  it('completes a real sampled round with zero invalid simulated transitions and no mutation', () => {
    let s = dealt(),
      sampled = 0,
      steps = 0;
    while (!tractor.isOver(s) && steps++ < 300) {
      const auto = tractor.autoAdvance!(s);
      const seat = auto ? -1 : s.turn;
      const v = tractor.view(s, auto ? null : seat),
        before = JSON.stringify(v);
      const action =
        auto?.action ??
        strategicPlay(v, (d) => {
          expect(d.invalid).toBe(0);
          expect(d.nodes).toBeLessThanOrEqual(144);
          if (d.samples > 1) sampled++;
        });
      expect(JSON.stringify(v)).toBe(before);
      expect(tractor.validate(s, seat, action)).toBe(null);
      s = tractor.apply(s, seat, action);
    }
    expect(tractor.isOver(s)).toBe(true);
    expect(sampled).toBeGreaterThan(5);
  });
  it('falls back on partial DOM-style observations instead of assuming full engine metadata', () => {
    const v = tractor.view(dealt(), 0);
    Object.assign(v, { bid: { strength: 4 }, levels: undefined, options: undefined });
    expect(adaptive.sampleBeliefs(v).worlds).toEqual([]);
  });
  it('reports infeasible partial observations instead of fabricating a distribution', () => {
    const v = tractor.view(dealt(), 0);
    v.handCounts[1] = 99;
    expect(adaptive.sampleBeliefs(v, 4).worlds).toEqual([]);
    expect(adaptive.sampleBeliefs(v, 4).fallback).toBeTruthy();
  });
});
