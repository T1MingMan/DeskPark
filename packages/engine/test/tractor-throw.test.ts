import { describe, expect, it } from 'vitest';
import { tractor, followError } from '../src/games/tractor';
import type { Card } from '../src/core/cards';
import { Rng } from '../src/core/rng';
import { effective } from '../src/games/tractor';
const c = (id: number, suit: Card['suit'], rank: number): Card => ({ id, suit, rank });
const p = (id: number, suit: Card['suit'], rank: number) => [
  c(id, suit, rank),
  c(id + 1, suit, rank),
];
const players = Array.from({ length: 4 }, (_, i) => ({ name: String(i), isBot: true }));
function fixture(hands: Card[][]) {
  const s = tractor.setup({ players, seed: 1, options: { rounds: 0 } });
  s.phase = 'play';
  s.turn = 0;
  s.hands = hands;
  s.trump = 'S';
  s.level = 2;
  return s;
}
const play = (cards: Card[]) => ({ type: 'play' as const, cards: cards.map((c) => c.id) });
describe('server-authoritative throws', () => {
  it('finishes 40 seeded rounds with deliberate view-only throw attempts and legal view-only followers', () => {
    let failures = 0,
      mixed = 0;
    for (let seed = 1; seed <= 20; seed++) {
      let s = tractor.setup({ players, seed, options: { rounds: 2 } });
      const rng = new Rng(seed);
      let ticks = 0;
      while (!tractor.isOver(s) && ticks++ < 2000) {
        const auto = tractor.autoAdvance!(s);
        const seat = auto ? -1 : tractor.activeSeats(s)[0];
        const v = tractor.view(s, seat === -1 ? null : seat);
        let a = auto?.action ?? tractor.bot(v, seat, rng);
        if (s.phase === 'play' && !s.trick.length && ticks % 3 === 0) {
          const own = v.hand.filter(
            (c) => effective(c, v.level, v.trump) === effective(v.hand[0], v.level, v.trump),
          );
          a = play(own);
        }
        expect(
          tractor.validate(s, seat, a),
          `seed ${seed} tick ${ticks} ${JSON.stringify(a)}`,
        ).toBeNull();
        const before = s.hands.flat().length;
        s = tractor.apply(s, seat, a);
        if (a.type === 'play') {
          const removed = s.trick[s.trick.length - 1].cards.length;
          expect(s.hands.flat().length).toBe(before - removed);
          if (s.trick.length === 1) {
            if (s.throwFailure) failures++;
            else if (removed > 2) mixed++;
          }
        }
      }
      expect(s.phase).toBe('matchOver');
    }
    expect(failures).toBeGreaterThan(10);
    expect(mixed).toBeGreaterThan(0);
  });
  it('accepts an unbeatable mixed pair/single lead and preserves ordinary following', () => {
    const lead = [...p(0, 'H', 13), c(2, 'H', 14)];
    let s = fixture([
      lead,
      [...p(10, 'H', 9), c(12, 'H', 10)],
      [...p(20, 'H', 8), c(22, 'H', 11)],
      [c(30, 'C', 4), c(31, 'D', 5), c(32, 'D', 6)],
    ]);
    expect(tractor.validate(s, 0, play(lead))).toBeNull();
    s = tractor.apply(s, 0, play(lead));
    expect(s.trick[0].cards).toHaveLength(3);
    for (let seat = 1; seat < 4; seat++) {
      expect(tractor.validate(s, seat, play(s.hands[seat]))).toBeNull();
      s = tractor.apply(s, seat, play(s.hands[seat]));
    }
    expect(s.winner).toBe(0);
  });
  it('does not require pairs when an all-single throw is followed', () => {
    const lead = [c(90, 'H', 14), c(91, 'H', 13)];
    const hand = [...p(0, 'H', 3), c(2, 'H', 5), c(3, 'H', 6)];
    expect(followError(hand, [hand[0], hand[2]], lead, 2, 'S')).toBeNull();
  });
  it('collapses a failed throw to the smallest weakest beatable component, returns other cards and transfers 10 per returned card', () => {
    const lead = [...p(0, 'H', 13), c(2, 'H', 8), c(3, 'H', 9)];
    const s = fixture([
      lead,
      [c(10, 'H', 10), c(11, 'C', 3), c(12, 'C', 4), c(13, 'C', 5)],
      p(20, 'H', 14),
      [c(30, 'D', 4)],
    ]);
    expect(tractor.validate(s, 0, play(lead))).toBeNull();
    const next = tractor.apply(s, 0, play(lead));
    expect(next.trick[0].cards.map((c) => c.id)).toEqual([2]);
    expect(next.hands[0].map((c) => c.id)).toEqual([0, 1, 3]);
    expect(next.points).toBe(30);
    expect(next.throwFailure).toMatchObject({
      seat: 0,
      challenger: 1,
      penalty: 30,
      forced: [c(2, 'H', 8)],
    });
    const v = tractor.view(next, null);
    expect(JSON.stringify(v)).not.toContain('"id":10');
    expect(tractor.validate(next, 1, play([s.hands[1][1]]))).not.toBeNull();
    expect(tractor.validate(next, 1, play([s.hands[1][0]]))).toBeNull();
    expect(JSON.stringify(s.trick)).toBe('[]');
  });
  it('detects failed tractor components and does not treat a higher unpaired card as beating a pair', () => {
    const run = [...p(0, 'H', 7), ...p(2, 'H', 8)];
    const lead = [...run, c(4, 'H', 14)];
    const s = fixture([lead, [...p(10, 'H', 9), ...p(12, 'H', 10), c(14, 'H', 11)], [], []]);
    const n = tractor.apply(s, 0, play(lead));
    expect(n.trick[0].cards).toHaveLength(4);
    expect(n.throwFailure?.penalty).toBe(10);
    const good = [...p(0, 'H', 13), c(2, 'H', 14)];
    const t = fixture([good, [c(10, 'H', 14), c(11, 'H', 12), c(12, 'H', 11)], [], []]);
    expect(tractor.apply(t, 0, play(good)).throwFailure).toBeNull();
  });
  it('requires the throw tractor before pairs, then pairs before singles, including shortages', () => {
    const lead = [...p(90, 'H', 10), ...p(92, 'H', 11), ...p(94, 'H', 13), c(96, 'H', 14)];
    const h = [...p(0, 'H', 3), ...p(2, 'H', 4), ...p(4, 'H', 6), ...p(6, 'H', 8), c(8, 'H', 9)];
    expect(followError(h, [...h.slice(0, 2), ...h.slice(4, 8), h[8]], lead, 2, 'S')).toMatch(
      '拖拉机',
    );
    expect(followError(h, h.slice(0, 7), lead, 2, 'S')).toBeNull();
    const short = [...p(0, 'H', 3), c(2, 'H', 5), c(3, 'S', 6), ...p(4, 'D', 9), c(6, 'C', 3)];
    expect(followError(short, short, lead, 2, 'S')).toBeNull();
  });
  it('compares multiple mixed ruffs by highest pair, ignores higher singleton, and keeps first equal', () => {
    const lead = [...p(0, 'H', 13), c(2, 'H', 14)];
    let s = fixture([
      lead,
      [...p(10, 'S', 5), c(12, 'S', 14)],
      [...p(20, 'S', 7), c(22, 'S', 3)],
      [...p(30, 'S', 7), c(32, 'J', 17)],
    ]);
    for (let i = 0; i < 4; i++) s = tractor.apply(s, i, play(s.hands[i]));
    expect(s.winner).toBe(2);
  });
  it('only a void full matching trump structure can ruff a tractor throw; mixed partial void cannot', () => {
    const lead = [...p(0, 'H', 12), ...p(2, 'H', 13), c(4, 'H', 14)];
    let s = fixture([
      lead,
      [...p(10, 'S', 5), ...p(12, 'S', 7), c(14, 'J', 17)],
      [...p(20, 'S', 3), ...p(22, 'S', 4), c(24, 'S', 8)],
      [c(30, 'H', 3), ...p(31, 'S', 8), ...p(33, 'S', 9)],
    ]);
    for (let i = 0; i < 4; i++) {
      expect(tractor.validate(s, i, play(s.hands[i]))).toBeNull();
      s = tractor.apply(s, i, play(s.hands[i]));
    }
    expect(s.winner).toBe(2);
  });
  it('a partner can defeat a throw and an attacking failed throw deducts instead of adding penalty', () => {
    const lead = [c(0, 'H', 6), c(1, 'H', 14)];
    const s = fixture([lead, [], [c(20, 'H', 7)], []]);
    s.dealer = 1;
    s.points = 0;
    const n = tractor.apply(s, 0, play(lead));
    expect(n.throwFailure?.challenger).toBe(2);
    expect(n.points).toBe(-10);
  });
});
