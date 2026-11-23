import { createDeck, type Card, type Suit } from '../../core/cards';
import {
  basicRecommend,
  bestPairs,
  components,
  declarationChoices,
  currentTrickWinner,
  effective,
  followError,
  pairs,
  power,
  score,
  shape,
  type TractorAction,
  type TractorView,
} from './index';
import { runs } from './patterns';
import { evaluateCandidates, type Candidate } from './adaptive';
export interface DecisionReport {
  version: 'adaptive-v2';
  reason: string;
  samples: number;
  nodes: number;
  invalid: number;
  uncertainty: string;
  candidates: { cards: number[]; score: number; spread?: number }[];
}
function choose(v: TractorView, candidates: Candidate[], report?: (r: DecisionReport) => void) {
  const critical =
    !v.trick.length ||
    (v.trick.length < 3 &&
      (score(v.trick.flatMap((p) => p.cards)) >= 10 || v.points >= 60 || v.hand.length <= 6));
  const result = critical ? evaluateCandidates(v, candidates) : null;
  const ranked = result?.ranked.length
    ? result.ranked
    : [...candidates].sort((a, b) => b.value - a.value);
  report?.({
    version: 'adaptive-v2',
    reason: critical
      ? 'round goal + public-belief trick/control evaluation'
      : 'legal economy, secure feeding and round threshold',
    samples: result?.samples ?? 0,
    nodes: result?.nodes ?? 0,
    invalid: result?.invalid ?? 0,
    uncertainty:
      result?.fallback ||
      result?.uncertainty ||
      'deterministic public heuristic; no sampled certainty',
    candidates: ranked.slice(0, 6).map((x) => ({
      cards: x.cs.map((c) => c.id),
      score: x.value,
      ...('spread' in x ? { spread: x.spread as number } : {}),
    })),
  });
  return { type: 'play' as const, cards: ranked[0].cs.map((c) => c.id) };
}

const suits: Suit[] = ['S', 'H', 'C', 'D', 'J'];
const key = (c: Card) => `${c.suit}:${c.rank}`;
function suitQuality(v: TractorView, suit: Suit) {
  const trumps = v.hand.filter((c) => effective(c, v.level, suit) === 'J');
  return (
    trumps.length +
    pairs(trumps).length * 1.5 +
    trumps.filter((c) => c.suit === 'J' || c.rank === v.level || c.rank === 14).length * 0.5
  );
}
function declare(v: TractorView): TractorAction {
  const choices = declarationChoices(v)
    .filter((c) => c.cards.length)
    .sort((a, b) => suitQuality(v, b.suit) - suitQuality(v, a.suit));
  const best = choices[0];
  if (!best || v.hand.length < 5) return { type: 'pass' };
  const quality = suitQuality(v, best.suit);
  if (quality < Math.max(4, v.hand.length * 0.36)) return { type: 'pass' };
  if (v.bid && v.bid.seat % 2 === v.seat! % 2 && quality < suitQuality(v, v.trump) + 3.5)
    return { type: 'pass' };
  if (v.bid && v.bid.seat % 2 !== v.seat! % 2 && quality < suitQuality(v, v.trump) + 1)
    return { type: 'pass' };
  return { type: 'reveal', cards: best.cards };
}
function bury(v: TractorView): TractorAction {
  const trumps = v.hand.filter((c) => effective(c, v.level, v.trump) === 'J');
  const declaring = v.seat! % 2 === v.dealer % 2;
  // Declaring-side kitty points are doubled for attackers at the last trick, so they are worse.
  const base = declaring ? 2.4 : 1.6;
  const risk =
    trumps.length >= 10 && trumps.filter((c) => c.suit === 'J').length >= 2 ? base * 0.3 : base;
  const evaluate = (buried: Card[]) => {
    const ids = new Set(buried.map((c) => c.id));
    const kept = v.hand.filter((c) => !ids.has(c.id));
    let value = -score(buried) * risk;
    for (const suit of suits) {
      const g = kept.filter((c) => effective(c, v.level, v.trump) === suit);
      if (suit !== 'J') value += !g.length ? 8 : g.length === 1 ? -3 : 0;
      for (const c of g)
        value +=
          suit === 'J'
            ? 5 + power(c, v.level, v.trump) * 0.5
            : c.rank === 14
              ? 5
              : power(c, v.level, v.trump) * 0.12;
      const ps = pairs(g);
      value += ps.length * 7;
      const values = new Set(ps.map((p) => power(p[0], v.level, v.trump)));
      for (const n of values) if (values.has(n + 1)) value += 6;
    }
    return value;
  };
  let best: Card[] = [],
    bestValue = -Infinity;
  // Sixteen side-suit void plans; no combinatorial 33-choose-8 search.
  for (let mask = 0; mask < 16; mask++) {
    const chosen = v.hand.filter((c) =>
      suits.slice(0, 4).some((s, i) => !!(mask & (1 << i)) && effective(c, v.level, v.trump) === s),
    );
    if (chosen.length > 8) continue;
    while (chosen.length < 8) {
      const rest = v.hand.filter((c) => !chosen.some((x) => x.id === c.id));
      let card = rest[0],
        value = -Infinity;
      for (const c of rest) {
        const n = evaluate([...chosen, c]);
        if (n > value) {
          value = n;
          card = c;
        }
      }
      chosen.push(card);
    }
    const value = evaluate(chosen);
    if (value > bestValue) {
      bestValue = value;
      best = chosen;
    }
  }
  return { type: 'bury', cards: best.map((c) => c.id) };
}

/** No persistent bot cache: late join and reconnect derive identical public knowledge. */
export function publicKnowledge(v: TractorView) {
  const voids = Array.from({ length: 4 }, () => new Set<Suit>());
  /** Suits a seat has demonstrated void in, with the observation count. */
  const voidSeen = Array.from({ length: 4 }, () => new Map<Suit, number>());
  const history = [...(v.playedHistory ?? []), v.trick];
  for (const trick of history) {
    if (!trick.length) continue;
    const suit = effective(trick[0].cards[0], v.level, v.trump);
    for (const p of trick.slice(1))
      if (p.cards.some((c) => effective(c, v.level, v.trump) !== suit)) {
        voids[p.seat].add(suit);
        voidSeen[p.seat].set(suit, (voidSeen[p.seat].get(suit) ?? 0) + 1);
      }
  }
  // Current trick can already be in history during trickOver. Deduplicate physical IDs.
  const seen = new Map<number, Card>();
  for (const c of [...v.hand, ...v.kitty, ...history.flat(2).flatMap((p) => p.cards)])
    seen.set(c.id, c);
  const counts = new Map<string, number>();
  for (const c of seen.values()) counts.set(key(c), (counts.get(key(c)) ?? 0) + 1);
  const unseen = createDeck(2).filter((c) => {
    const n = counts.get(key(c)) ?? 0;
    if (!n) return true;
    counts.set(key(c), n - 1);
    return false;
  });
  return { voids, voidSeen, unseen };
}
function leadChoice(v: TractorView, report?: (r: DecisionReport) => void): TractorAction {
  const { voidSeen, unseen } = publicKnowledge(v);
  const seat = v.seat!,
    partner = (seat + 2) % 4;
  const enemy = [(seat + 1) % 4, (seat + 3) % 4];
  const unseenTrumps = unseen.filter((c) => effective(c, v.level, v.trump) === 'J').length;
  // Public estimate that a seat with no observed void still holds at least one card of a suit.
  // Level cards are trumps; a follow in another suit proves the TRUMP void, not the nominal suit.
  const holds = (s: number, suit: Suit) =>
    voidSeen[s].has(suit)
      ? 0
      : Math.min(
          1,
          1 -
            (1 -
              unseen.filter((c) => effective(c, v.level, v.trump) === suit).length /
                Math.max(1, unseen.length)) **
              Math.max(0, v.handCounts[s]),
        );
  const candidates: Card[][] = v.hand.map((c) => [c]);
  for (const suit of suits) {
    const ps = pairs(v.hand.filter((c) => effective(c, v.level, v.trump) === suit));
    candidates.push(...ps);
    for (let n = 2; n <= ps.length; n++)
      candidates.push(...runs(ps, n, (c) => power(c, v.level, v.trump)));
  }
  const value = (cs: Card[]) => {
    const suit = effective(cs[0], v.level, v.trump);
    const high = Math.max(...cs.map((c) => power(c, v.level, v.trump)));
    const higher = unseen.filter(
      (c) => effective(c, v.level, v.trump) === suit && power(c, v.level, v.trump) > high,
    ).length;
    // Only public facts: a shown void is a proof; otherwise estimate remaining suit cards.
    // A lead is only a template for suit strength. The public recorded play still matches
    // the seat's effective lead suit; partial following proves only the remained suit void.
    const enemyVoid =
      suit !== 'J' && enemy.some((e) => voidSeen[e].has(suit) && !voidSeen[e].has('J'));
    const enemyHolds = suit === 'J' ? 1 : Math.max(...enemy.map((e) => holds(e, suit)));
    const partnerVoid = suit !== 'J' && voidSeen[partner].has(suit) && !voidSeen[partner].has('J');
    const target =
      partnerVoid && !enemyVoid && cs.length === 1 && v.handCounts[partner] > 0 && unseenTrumps > 0;
    const risk = (1 - enemyHolds) * (suit === 'J' ? 0 : 1);
    return (
      (higher === 0 ? 14 : -higher * 1.1) +
      (cs.length - 1) * 3 +
      (target ? 12 * enemyHolds - score(cs) * 0.6 : 0) -
      risk * (30 + score(cs) + (suit !== 'J' ? 6 : 0)) -
      score(cs) * (higher ? 0.6 : -0.3) -
      (suit === 'J' ? 5 : 0)
    );
  };
  return choose(
    v,
    candidates.map((cs) => ({ cs, value: value(cs) })),
    report,
  );
}

/** Rank only legal actions; never manufacture a second trick comparison. */
export function strategicPlay(v: TractorView, report?: (r: DecisionReport) => void): TractorAction {
  if (v.phase === 'dealing' || v.phase === 'reveal') return declare(v);
  if (v.phase === 'bury') return bury(v);
  const fallback = basicRecommend(v);
  if (v.phase !== 'play' || v.seat === null) return fallback;
  if (!v.trick.length) return leadChoice(v, report);
  const lead = v.trick[0].cards;
  const candidates: Card[][] = [];
  if ('cards' in fallback) candidates.push(v.hand.filter((c) => fallback.cards.includes(c.id)));
  const groups = ['S', 'H', 'C', 'D', 'J'].map((s) =>
    v.hand.filter((c) => effective(c, v.level, v.trump) === s),
  );
  for (const g of groups) {
    if (lead.length === 1) candidates.push(...g.map((c) => [c]));
    else if (lead.length === 2) candidates.push(...pairs(g));
    else if (lead.length % 2 === 0)
      candidates.push(...runs(pairs(g), lead.length / 2, (c) => power(c, v.level, v.trump)));
  }
  const own = v.hand.filter(
    (c) => effective(c, v.level, v.trump) === effective(lead[0], v.level, v.trump),
  );
  const parts = components(lead, v.level, v.trump);
  const n = parts.reduce((n, p) => n + Math.floor(p.length / 2), 0);
  const demands = parts.filter((p) => p.length > 2).map((p) => p.length / 2);
  // A fixed number of objective orderings covers shortages and mixed throws legally.
  for (const points of [-3, 0, 3])
    for (const strength of [-1, 1]) {
      const ordered = [...v.hand].sort(
        (a, b) =>
          points * (score([a]) - score([b])) +
            strength * (power(a, v.level, v.trump) - power(b, v.level, v.trump)) || a.id - b.id,
      );
      const following = ordered.filter((c) => own.some((x) => x.id === c.id));
      const cs = n ? bestPairs(following, n, v.level, v.trump, demands).flat() : [];
      for (const group of groups) {
        if (group.length < lead.length) continue;
        const suited = ordered.filter((c) => group.some((x) => x.id === c.id));
        const cover = n ? bestPairs(suited, n, v.level, v.trump, demands).flat() : [];
        for (const c of suited)
          if (cover.length < lead.length && !cover.some((x) => x.id === c.id)) cover.push(c);
        candidates.push(cover);
      }
      for (const c of [...following, ...ordered])
        if (cs.length < lead.length && !cs.some((x) => x.id === c.id)) cs.push(c);
      candidates.push(cs);
    }
  const { unseen, voids } = publicKnowledge(v);
  const remaining = Array.from(
    { length: 3 - v.trick.length },
    (_, i) => (v.seat! + i + 1) % 4,
  ).filter((s) => s % 2 !== v.seat! % 2);
  const uncertainty = (cs: Card[]) => {
    const trick = [...v.trick, { seat: v.seat!, cards: cs }];
    const winner = currentTrickWinner(trick, v.level, v.trump)!;
    const suit = effective(lead[0], v.level, v.trump);
    let survival = 1;
    for (const enemy of remaining) {
      let risk = 0;
      for (const g of suits.map((s) =>
        unseen.filter((c) => effective(c, v.level, v.trump) === s),
      )) {
        if (!g.length) continue;
        const gs = effective(g[0], v.level, v.trump);
        if ((gs !== suit && gs !== 'J') || voids[enemy].has(gs)) continue;
        const possible =
          lead.length === 1
            ? g.map((c) => [c])
            : shape(lead, v.level, v.trump) === 'pair'
              ? pairs(g)
              : shape(lead, v.level, v.trump) === 'tractor'
                ? runs(pairs(g), lead.length / 2, (c) => power(c, v.level, v.trump))
                : [];
        if (!possible.length && !shape(lead, v.level, v.trump)) {
          risk = Math.max(risk, 0.5);
          continue;
        }
        const threats = possible.filter(
          (p) =>
            currentTrickWinner([...trick, { seat: enemy, cards: p }], v.level, v.trump) === enemy,
        ).length;
        if (!threats) continue;
        const fraction = Math.min(1, v.handCounts[enemy] / Math.max(1, unseen.length));
        let chance = Math.min(0.95, threats * fraction ** Math.min(lead.length, 4));
        if (gs === 'J' && suit !== 'J')
          chance *= voids[enemy].has(suit)
            ? 1
            : (1 -
                unseen.filter((c) => effective(c, v.level, v.trump) === suit).length /
                  Math.max(1, unseen.length)) **
              v.handCounts[enemy];
        risk = Math.min(0.98, risk + chance);
      }
      survival *= 1 - risk;
    }
    return { winner, survival };
  };
  // Points only score for the attacking side; feeding our own defenders is a blunder.
  const sign = v.seat! % 2 !== v.dealer % 2 ? 1 : -1;
  const pot = score(v.trick.flatMap((p) => p.cards));
  // Final trick decides the kitty at x2/x4/x^(N+1); average kitty value x multiplier.
  const lastTrick =
    v.hand.length === lead.length && v.handCounts.every((n, i) => i === v.seat || n === 0);
  const swing = lastTrick
    ? (() => {
        const largest = Math.max(...components(lead, v.level, v.trump).map((p) => p.length));
        return 14.8 * 2 ** (largest === 1 ? 1 : largest / 2 + 1);
      })()
    : 0;
  const value = (cs: Card[]) => {
    const { winner, survival } = uncertainty(cs);
    const ours = winner % 2 === v.seat! % 2;
    const winProb = ours ? survival : 1 - survival;
    const ending = v.hand.length <= lead.length * 2;
    const cost = cs.reduce(
      (n, c) =>
        n +
        power(c, v.level, v.trump) * 0.1 +
        (effective(c, v.level, v.trump) === 'J' ? (ending ? 1 : 4) : 0) +
        (!ending &&
        c.suit === 'J' &&
        c.rank === 17 &&
        v.hand.filter((x) => effective(x, v.level, v.trump) === 'J').length === 1
          ? 18
          : 0),
      0,
    );
    const split = pairs(v.hand).filter(
      (p) => cs.filter((c) => key(c) === key(p[0])).length === 1,
    ).length;
    // Secured points help attackers directly; defenders deny them the same cards.
    const weight = sign === 1 ? 1 : 0.72;
    const contested = pot + score(cs);
    return (
      (2 * winProb - 1) * weight * contested +
      winProb *
        (v.points < 80 && v.points + contested >= 80
          ? 30
          : Math.floor((v.points + contested) / 40) > Math.floor(v.points / 40)
            ? 5
            : 0) +
      winProb * ((ending ? 12 : 3) + swing) -
      cost -
      split * (ending ? 1 : 4)
    );
  };
  const legal = candidates.filter(
    (cs) =>
      !followError(v.hand, cs, lead, v.level, v.trump) &&
      (v.throwFailure?.challenger !== v.seat ||
        currentTrickWinner(
          [
            { seat: -1, cards: v.throwFailure.forced },
            { seat: v.seat!, cards: cs },
          ],
          v.level,
          v.trump,
        ) === v.seat),
  );
  const ranked = legal.map((cs) => ({ cs, value: value(cs) })).sort((a, b) => b.value - a.value);
  return ranked.length ? choose(v, ranked, report) : fallback;
}
