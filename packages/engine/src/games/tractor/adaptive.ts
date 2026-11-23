import { createDeck, type Card, type Suit } from '../../core/cards';
import {
  effective,
  basicRecommend,
  tractor,
  score,
  currentTrickWinner,
  type TractorState,
  type TractorView,
} from './index';

export interface BeliefWorld {
  hands: Card[][];
  kitty: Card[];
}
/** Approximate constrained allocation, NOT a posterior probability or an oracle. */
export function sampleBeliefs(v: TractorView, requested = 6) {
  const voids = Array.from({ length: 4 }, () => new Set<Suit>());
  const seen = new Map<number, Card>();
  const history = [...(v.playedHistory ?? []), v.trick];
  for (const trick of history) {
    if (!trick.length) continue;
    const suit = effective(trick[0].cards[0], v.level, v.trump);
    for (const p of trick) {
      for (const c of p.cards) seen.set(c.id, c);
      if (p !== trick[0] && p.cards.some((c) => effective(c, v.level, v.trump) !== suit))
        voids[p.seat].add(suit);
    }
  }
  const worlds: BeliefWorld[] = [];
  const fail = (fallback: string) => ({ worlds, voids, fallback });
  if (v.phase !== 'play' || v.seat === null) return fail('not a playing-seat observation');
  if (
    !v.options ||
    !Array.isArray(v.levels) ||
    (v.bid && (!Array.isArray(v.bid.cards) || !Number.isInteger(v.bid.seat)))
  )
    return fail('partial observation lacks public engine metadata');
  const deck = createDeck(2);
  const announcements = [...(v.publicReveals ?? []), ...(v.bid ? [v.bid] : [])];
  const dealerShown = new Set(
    announcements.filter((p) => p.seat === v.dealer).flatMap((p) => p.cards.map((c) => c.id)),
  );
  const known = [...seen.values(), ...v.hand, ...v.kitty, ...announcements.flatMap((p) => p.cards)];
  if (known.some((c) => !deck[c.id] || deck[c.id].rank !== c.rank || deck[c.id].suit !== c.suit))
    return fail('incomplete/noncanonical public cards');
  const excluded = new Set([
    ...seen.keys(),
    ...v.hand.map((c) => c.id),
    ...v.kitty.map((c) => c.id),
  ]);
  const unseen = deck.filter((c) => !excluded.has(c.id));
  const kittyCount = 8 - v.kitty.length;
  if (
    v.handCounts[v.seat] !== v.hand.length ||
    v.handCounts.reduce((n, x) => n + x, 0) + 8 + seen.size !== 108
  )
    return fail('inconsistent public counts/history');
  // Observation-derived RNG is isolated from the deal RNG and contains no hidden seed.
  let rng = 2166136261;
  const text = JSON.stringify([
    v.hand,
    [...seen.keys()],
    v.handCounts,
    announcements,
    v.trump,
    v.level,
    v.points,
  ]);
  for (let i = 0; i < text.length; i++) rng = Math.imul(rng ^ text.charCodeAt(i), 16777619) >>> 0;
  const random = () => {
    rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
    return rng / 4294967296;
  };
  const count = Math.min(6, Math.max(0, requested));
  for (let attempt = 0; attempt < 48 && worlds.length < count; attempt++) {
    const hands: Card[][] = Array.from({ length: 4 }, () => []);
    hands[v.seat] = [...v.hand];
    const kitty = [...v.kitty],
      pinned = new Set<number>();
    // Dealer may have buried a declaration; do not falsely pin it to their remaining hand.
    for (const announcement of announcements)
      if (announcement.seat !== v.dealer && announcement.seat !== v.seat)
        for (const c of announcement.cards)
          if (!seen.has(c.id) && !pinned.has(c.id)) {
            hands[announcement.seat].push(c);
            pinned.add(c.id);
          }
    const capacities = v.handCounts.map((n, s) => (s === v.seat ? 0 : n - hands[s].length));
    capacities.push(kittyCount);
    const options = (c: Card) =>
      capacities
        .map((_, s) => s)
        .filter(
          (s) =>
            s === 4 ||
            (s !== v.seat &&
              (!dealerShown.has(c.id) || s === v.dealer) &&
              !voids[s].has(effective(c, v.level, v.trump))),
        );
    const rest = unseen
      .filter((c) => !pinned.has(c.id))
      .map((c) => ({ c, jitter: random(), n: options(c).length }))
      .sort((a, b) => a.n - b.n || a.jitter - b.jitter);
    let valid = capacities.every((n) => n >= 0);
    for (const { c } of rest) {
      const slots = options(c).filter((s) => capacities[s] > 0);
      const total = slots.reduce((n, s) => n + capacities[s], 0);
      if (!total) {
        valid = false;
        break;
      }
      let ticket = random() * total,
        chosen = slots[slots.length - 1];
      for (const s of slots) {
        ticket -= capacities[s];
        if (ticket < 0) {
          chosen = s;
          break;
        }
      }
      capacities[chosen]--;
      (chosen === 4 ? kitty : hands[chosen]).push(c);
    }
    if (
      valid &&
      capacities.every((n) => n === 0) &&
      hands.every((h, s) => !h.some((c) => voids[s].has(effective(c, v.level, v.trump))))
    )
      worlds.push({ hands, kitty });
  }
  return {
    worlds,
    voids,
    fallback: worlds.length ? '' : 'no feasible allocation within 48 attempts',
  };
}

export interface Candidate {
  cs: Card[];
  value: number;
}
/** One-trick public-policy rollout plus remaining control; at most 120 engine transitions.
 * Each simulated actor sees ONLY tractor.view(world, actor), never the sampled other hands.
 * Worlds are shared across candidates: there is no per-world root action selection.
 */
export function evaluateCandidates(v: TractorView, candidates: Candidate[]) {
  const unique = new Map<string, Candidate>();
  for (const c of [...candidates].sort((a, b) => b.value - a.value)) {
    const id = c.cs
      .map((c) => c.id)
      .sort((a, b) => a - b)
      .join(',');
    if (!unique.has(id)) unique.set(id, c);
  }
  const shortlist = [...unique.values()].slice(0, 6);
  const belief = sampleBeliefs(v, 4);
  let nodes = 0,
    invalid = 0;
  const sign = v.seat! % 2 !== v.dealer % 2 ? 1 : -1;
  const ranked = shortlist
    .map((c) => {
      const values: number[] = [];
      for (const world of belief.worlds) {
        let s: TractorState = {
          ...v,
          hands: world.hands,
          kitty: world.kitty,
          rng: 1,
          drawPile: [],
        };
        const action = { type: 'play' as const, cards: c.cs.map((x) => x.id) };
        if (tractor.validate(s, v.seat!, action)) {
          invalid++;
          continue;
        }
        s = tractor.apply(s, v.seat!, action);
        nodes++;
        while (s.phase === 'play' && nodes < 144) {
          const seat = s.turn;
          const a = basicRecommend(tractor.view(s, seat));
          if (tractor.validate(s, seat, a)) {
            invalid++;
            break;
          }
          s = tractor.apply(s, seat, a);
          nodes++;
        }
        if (s.phase !== 'trickOver') continue;
        const winner = currentTrickWinner(s.trick, s.level, s.trump)!;
        const ours = winner % 2 === v.seat! % 2;
        let delta = s.points - v.points;
        // Settlement is engine-owned, including the EXACT kitty multiplier and level rules.
        if (s.hands.every((h) => !h.length)) {
          s = tractor.apply(s, -1, { type: 'continue' });
          nodes++;
          delta = s.points - v.points;
        }
        const crossed80 = v.points < 80 && s.points >= 80;
        const band = Math.floor(s.points / 40) - Math.floor(v.points / 40);
        const ownTrumps = s.hands[v.seat!].filter((x) => effective(x, v.level, v.trump) === 'J');
        const control = ownTrumps.filter((x) => x.suit === 'J' || x.rank === v.level).length;
        const pot = score(s.trick.flatMap((p) => p.cards));
        // Defenders gain by denying attackers the public pot; the same goal applies to both teams.
        values.push(
          sign * delta +
            (sign === -1 && ours ? pot * 0.72 : 0) +
            sign * (crossed80 ? 30 : band * 5) +
            (ours ? 4 : 0) +
            control * 1.5,
        );
      }
      const mean = values.length ? values.reduce((n, x) => n + x, 0) / values.length : 0;
      const spread = values.length ? Math.max(...values) - Math.min(...values) : 0;
      return { ...c, heuristic: c.value, value: c.value + mean * 0.65, mean, spread };
    })
    .sort((a, b) => b.value - a.value);
  return {
    ranked,
    samples: belief.worlds.length,
    nodes,
    invalid,
    fallback: belief.fallback,
    uncertainty: '4 approximate constrained worlds; one-trick policy rollout, not certainty',
  };
}
