import { createDeck, type Card, type Suit } from '../../core/cards';
import {
  basicRecommend,
  bestPairs,
  components,
  currentTrickWinner,
  declarationChoices,
  effective,
  followError,
  pairs,
  power,
  recommend,
  score,
  shape,
  type Play,
  type TractorAction,
  type TractorView,
} from './index';
import { coverPower, runs } from './patterns';

export interface ThinkOptions {
  /** Time budget in milliseconds for iterative world rollouts (default: 360ms). */
  budgetMs?: number;
  /** Maximum belief worlds to evaluate per move (default: 32). */
  maxWorlds?: number;
  /** Maximum root candidates to evaluate via rollouts (default: 10). */
  maxCandidates?: number;
  /** Optional monotonic clock override for deterministic tests. */
  clock?: () => number;
}

export interface ThinkDiagnostics {
  version: 'tractor-think-v3';
  phase: TractorView['phase'];
  worlds: number;
  rollouts: number;
  nodes: number;
  elapsedMs: number;
  shortCircuited: boolean;
  fallback: string;
  candidates: { cards: number[]; score: number; prior: number; meanUtility: number }[];
}

const SUITS: readonly Suit[] = ['S', 'H', 'C', 'D', 'J'];
const SUIT_BIT: Record<Suit, number> = { S: 1, H: 2, C: 4, D: 8, J: 16 };
const defaultClock = () =>
  (globalThis as { performance?: { now(): number } }).performance?.now() ?? Date.now();
const cardKey = (c: Card) => `${c.suit}:${c.rank}`;

function suitMask(s: Suit): number {
  return SUIT_BIT[s];
}

function coverBeats(
  cards: Card[],
  best: Card[],
  lead: Card[],
  parts: Card[][],
  level: number,
  trump: Suit,
): boolean {
  if (
    cards.length !== lead.length ||
    !cards.length ||
    cards.some((c) => effective(c, level, trump) !== effective(cards[0], level, trump))
  )
    return false;
  const cp = coverPower(cards, parts, (c) => power(c, level, trump));
  if (cp === null) return false;
  const suit = effective(cards[0], level, trump);
  const bs = effective(best[0], level, trump);
  const ls = effective(lead[0], level, trump);
  if (suit !== ls && suit !== 'J') return false;
  if (bs === 'J' && suit !== 'J') return false;
  if (suit === 'J' && bs !== 'J') return true;
  const bp = coverPower(best, parts, (c) => power(c, level, trump));
  return bp === null || cp > bp;
}

/** Check whether a multi-card lead is 100% immune to failed-throw penalty under public unseen cards. */
export function isPubliclySafeThrow(
  cards: Card[],
  unseen: Card[],
  level: number,
  trump: Suit,
): boolean {
  if (cards.length <= 1) return true;
  const suit = effective(cards[0], level, trump);
  if (cards.some((c) => effective(c, level, trump) !== suit)) return false;
  if (shape(cards, level, trump) !== null) return true;
  const unseenSuit = unseen.filter((c) => effective(c, level, trump) === suit);
  if (!unseenSuit.length) return true;
  const parts = components(cards, level, trump);
  for (const part of parts) {
    const singleParts = [part];
    const challengers =
      part.length === 1
        ? unseenSuit.map((c) => [c])
        : part.length === 2
          ? pairs(unseenSuit)
          : runs(pairs(unseenSuit), part.length / 2, (c) => power(c, level, trump));
    if (challengers.some((x) => coverBeats(x, part, part, singleParts, level, trump))) {
      return false;
    }
  }
  return true;
}

interface SmartBeliefResult {
  worlds: { hands: Card[][]; kitty: Card[] }[];
  voidMask: number[];
  seenIds: Uint8Array;
  unseen: Card[];
  fallback: string;
}

/**
 * Sample constrained worlds strictly from redacted TractorView.
 * Incorporates hard constraints (counts, proven voids, public declarations)
 * plus soft inference (dealer kitty bury tendencies & historical underplays).
 */
export function sampleSmartBeliefs(v: TractorView, requested = 24): SmartBeliefResult {
  const voidMask = [0, 0, 0, 0];
  const seenIds = new Uint8Array(108);
  const seenCards = new Map<number, Card>();
  const history = [...(v.playedHistory ?? []), v.trick];
  // Track max power an actor failed to beat when following a point-bearing single trick
  const softCap: Record<Suit, number>[] = Array.from({ length: 4 }, () => ({
    S: 99,
    H: 99,
    C: 99,
    D: 99,
    J: 99,
  }));

  for (const trick of history) {
    if (!trick.length) continue;
    const leadSuit = effective(trick[0].cards[0], v.level, v.trump);
    const isSingle = trick[0].cards.length === 1;
    let runningBestSeat = trick[0].seat;
    let runningBestCard = trick[0].cards[0];
    let runningPot = score(trick[0].cards);

    for (let idx = 0; idx < trick.length; idx++) {
      const p = trick[idx];
      for (const c of p.cards) {
        if (c.id >= 0 && c.id < 108) seenIds[c.id] = 1;
        seenCards.set(c.id, c);
      }
      if (idx > 0) {
        const mismatch = p.cards.some((c) => effective(c, v.level, v.trump) !== leadSuit);
        if (mismatch) {
          voidMask[p.seat] |= suitMask(leadSuit);
        } else if (
          isSingle &&
          idx === 3 &&
          runningBestSeat % 2 !== p.seat % 2 &&
          runningPot >= 10 &&
          effective(runningBestCard, v.level, v.trump) === leadSuit
        ) {
          const playedPow = power(p.cards[0], v.level, v.trump);
          const targetPow = power(runningBestCard, v.level, v.trump);
          if (playedPow < targetPow) {
            // In 4th seat with >=10 pts at stake and enemy winning in leadSuit, actor didn't overtake
            softCap[p.seat][leadSuit] = Math.min(softCap[p.seat][leadSuit], targetPow);
          }
        }
        const winnerSoFar = currentTrickWinner(trick.slice(0, idx + 1), v.level, v.trump)!;
        const winPlay = trick.find((x) => x.seat === winnerSoFar)!;
        runningBestSeat = winnerSoFar;
        runningBestCard = winPlay.cards[0];
        runningPot += score(p.cards);
      }
    }
  }

  for (const c of v.hand) if (c.id >= 0 && c.id < 108) seenIds[c.id] = 1;
  for (const c of v.kitty) if (c.id >= 0 && c.id < 108) seenIds[c.id] = 1;

  const deck = createDeck(2);
  const unseen = deck.filter((c) => !seenIds[c.id]);
  const worlds: { hands: Card[][]; kitty: Card[] }[] = [];
  const fail = (fallback: string): SmartBeliefResult => ({
    worlds,
    voidMask,
    seenIds,
    unseen,
    fallback,
  });

  if (v.phase !== 'play' || v.seat === null) return fail('not a playing-seat observation');
  if (
    !v.options ||
    !Array.isArray(v.levels) ||
    (v.bid && (!Array.isArray(v.bid.cards) || !Number.isInteger(v.bid.seat)))
  )
    return fail('partial observation lacks public engine metadata');

  const announcements = [...(v.publicReveals ?? []), ...(v.bid ? [v.bid] : [])];
  const dealerShown = new Set(
    announcements.filter((p) => p.seat === v.dealer).flatMap((p) => p.cards.map((c) => c.id)),
  );
  const known = [
    ...seenCards.values(),
    ...v.hand,
    ...v.kitty,
    ...announcements.flatMap((p) => p.cards),
  ];
  if (known.some((c) => !deck[c.id] || deck[c.id].rank !== c.rank || deck[c.id].suit !== c.suit))
    return fail('incomplete/noncanonical public cards');

  const kittyUnknown = 8 - v.kitty.length;
  if (
    v.handCounts[v.seat] !== v.hand.length ||
    v.handCounts.reduce((n, x) => n + x, 0) + 8 + seenCards.size !== 108
  )
    return fail('inconsistent public counts/history');

  // Observation-only deterministic PRNG (no hidden state or external seed)
  let rng = 2166136261;
  const sigText = JSON.stringify([
    v.hand.map((c) => c.id),
    [...seenCards.keys()],
    v.handCounts,
    announcements,
    v.trump,
    v.level,
    v.points,
  ]);
  for (let i = 0; i < sigText.length; i++) {
    rng = Math.imul(rng ^ sigText.charCodeAt(i), 16777619) >>> 0;
  }
  const random = () => {
    rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
    return rng / 4294967296;
  };

  const targetCount = Math.min(48, Math.max(0, requested));
  const maxAttempts = Math.max(96, targetCount * 5);

  // Precompute base pinned cards
  const basePinned = new Set<number>();
  const pinnedBySeat: Card[][] = [[], [], [], []];
  for (const announcement of announcements) {
    if (announcement.seat !== v.dealer && announcement.seat !== v.seat) {
      for (const c of announcement.cards) {
        if (!seenIds[c.id] && !basePinned.has(c.id)) {
          pinnedBySeat[announcement.seat].push(c);
          basePinned.add(c.id);
        }
      }
    }
  }
  const freeUnseen = unseen.filter((c) => !basePinned.has(c.id));

  for (let attempt = 0; attempt < maxAttempts && worlds.length < targetCount; attempt++) {
    const hands: Card[][] = [
      [...pinnedBySeat[0]],
      [...pinnedBySeat[1]],
      [...pinnedBySeat[2]],
      [...pinnedBySeat[3]],
    ];
    hands[v.seat] = [...v.hand];
    const kitty = [...v.kitty];
    const capacities = [
      v.seat === 0 ? 0 : v.handCounts[0] - hands[0].length,
      v.seat === 1 ? 0 : v.handCounts[1] - hands[1].length,
      v.seat === 2 ? 0 : v.handCounts[2] - hands[2].length,
      v.seat === 3 ? 0 : v.handCounts[3] - hands[3].length,
      kittyUnknown,
    ];
    if (capacities.some((n) => n < 0)) break;

    const slotAllowed = (c: Card, slot: number): boolean => {
      if (capacities[slot] <= 0) return false;
      if (slot === 4) return true;
      if (slot === v.seat) return false;
      if (dealerShown.has(c.id) && slot !== v.dealer) return false;
      const eff = effective(c, v.level, v.trump);
      return (voidMask[slot] & suitMask(eff)) === 0;
    };

    const slotWeight = (c: Card, slot: number): number => {
      const cap = capacities[slot];
      if (cap <= 0) return 0;
      const eff = effective(c, v.level, v.trump);
      const pow = power(c, v.level, v.trump);
      if (slot === 4) {
        // Dealer rarely buries jokers, level trumps or side aces
        if (c.suit === 'J' || c.rank === v.level) return cap * 0.06;
        if (eff === 'J') return cap * 0.25;
        if (c.rank === 14) return cap * 0.18;
        if (score([c]) > 0) return cap * 0.75;
        return cap * 1.35;
      }
      let w = cap;
      if (pow > softCap[slot][eff]) w *= 0.28;
      if (slot === v.dealer && (c.suit === 'J' || c.rank === v.level || c.rank === 14)) {
        w *= 1.22; // Dealer filtered 33 cards and kept stronger controls
      }
      return w;
    };

    const ordered = freeUnseen
      .map((c) => {
        let deg = 0;
        for (let s = 0; s < 5; s++) if (slotAllowed(c, s)) deg++;
        return { c, deg, jitter: random() };
      })
      .sort((a, b) => a.deg - b.deg || a.jitter - b.jitter);

    let ok = true;
    for (const { c } of ordered) {
      let totalW = 0;
      const weights = [0, 0, 0, 0, 0];
      for (let s = 0; s < 5; s++) {
        if (slotAllowed(c, s)) {
          weights[s] = slotWeight(c, s);
          totalW += weights[s];
        }
      }
      if (totalW <= 0) {
        ok = false;
        break;
      }
      let ticket = random() * totalW;
      let chosen = 4;
      for (let s = 0; s < 5; s++) {
        if (weights[s] <= 0) continue;
        chosen = s;
        ticket -= weights[s];
        if (ticket <= 0) break;
      }
      capacities[chosen]--;
      if (chosen === 4) kitty.push(c);
      else hands[chosen].push(c);
    }

    if (ok && capacities.every((n) => n === 0)) {
      worlds.push({ hands, kitty });
    }
  }

  return {
    worlds,
    voidMask,
    seenIds,
    unseen,
    fallback: worlds.length ? '' : 'no feasible allocation within attempts',
  };
}

// ---------------------------------------------------------------------------
// Fast, non-cheating, zero-history-clone simulation engine & tactical rollout
// ---------------------------------------------------------------------------

interface SimState {
  hands: Card[][];
  kitty: Card[];
  dealer: number;
  level: number;
  trump: Suit;
  turn: number;
  points: number;
  trick: Play[];
  lastTrick: Play[];
  winner: number;
  throwFailure: {
    seat: number;
    challenger: number;
    forced: Card[];
    penalty: number;
  } | null;
  voidMask: number[];
  seenIds: Uint8Array;
  done: boolean;
}

function simFailedThrow(
  sim: SimState,
  seat: number,
  cards: Card[],
): { seat: number; cards: Card[] } | null {
  const parts = components(cards, sim.level, sim.trump).sort(
    (a, b) =>
      a.length - b.length ||
      power(a[0], sim.level, sim.trump) - power(b[0], sim.level, sim.trump) ||
      a[0].id - b[0].id,
  );
  const suit = effective(cards[0], sim.level, sim.trump);
  for (const part of parts) {
    const singlePart = [part];
    for (let i = 1; i < 4; i++) {
      const other = (seat + i) % 4;
      const own = sim.hands[other].filter((c) => effective(c, sim.level, sim.trump) === suit);
      if (own.length < part.length) continue;
      const candidates =
        part.length === 1
          ? own.map((c) => [c])
          : part.length === 2
            ? pairs(own)
            : runs(pairs(own), part.length / 2, (c) => power(c, sim.level, sim.trump));
      if (candidates.some((x) => coverBeats(x, part, part, singlePart, sim.level, sim.trump))) {
        return { seat: other, cards: part };
      }
    }
  }
  return null;
}

function stepSimPlay(sim: SimState, seat: number, chosenCards: Card[]): void {
  let cards = chosenCards;
  if (sim.trick.length === 0 && cards.length > 1 && !shape(cards, sim.level, sim.trump)) {
    const failed = simFailedThrow(sim, seat, cards);
    if (failed) {
      const penalty = (cards.length - failed.cards.length) * 10;
      sim.throwFailure = {
        seat,
        challenger: failed.seat,
        forced: failed.cards,
        penalty,
      };
      sim.points += penalty * (seat % 2 === sim.dealer % 2 ? 1 : -1);
      cards = failed.cards;
    }
  }

  // Remove played cards from seat's hand & update public observations
  const hand = sim.hands[seat];
  if (cards.length === 1) {
    const idx = hand.findIndex((c) => c.id === cards[0].id);
    if (idx >= 0) hand.splice(idx, 1);
  } else {
    const drop = new Set(cards.map((c) => c.id));
    sim.hands[seat] = hand.filter((c) => !drop.has(c.id));
  }

  for (const c of cards) {
    if (c.id >= 0 && c.id < 108) sim.seenIds[c.id] = 1;
  }
  if (sim.trick.length > 0) {
    const leadSuit = effective(sim.trick[0].cards[0], sim.level, sim.trump);
    if (cards.some((c) => effective(c, sim.level, sim.trump) !== leadSuit)) {
      sim.voidMask[seat] |= suitMask(leadSuit);
    }
  }

  sim.trick.push({ seat, cards });
  sim.turn = (seat + 1) % 4;

  if (sim.trick.length === 4) {
    const winner = currentTrickWinner(sim.trick, sim.level, sim.trump)!;
    sim.winner = winner;
    if (winner % 2 !== sim.dealer % 2) {
      sim.points += score(sim.trick.flatMap((p) => p.cards));
    }
    sim.lastTrick = sim.trick;
    sim.trick = [];
    sim.throwFailure = null;
    if (sim.hands.every((h) => h.length === 0)) {
      const lead = sim.lastTrick[0].cards;
      const largest = Math.max(...components(lead, sim.level, sim.trump).map((x) => x.length));
      const mult = 2 ** (largest === 1 ? 1 : largest / 2 + 1);
      if (winner % 2 !== sim.dealer % 2) {
        sim.points += score(sim.kitty) * mult;
      }
      sim.done = true;
    } else {
      sim.turn = winner;
    }
  }
}

/**
 * Fast tactical rollout policy.
 * STRICT INFORMATION ISOLATION: reads ONLY `sim.hands[seat]` and public `sim` fields
 * (`trick`, `level`, `trump`, `dealer`, `points`, `throwFailure`, `voidMask`, `seenIds`).
 * NEVER inspects `sim.hands[other]` or `sim.kitty`!
 */
function fastRolloutChoose(sim: SimState, seat: number, fullDeck: Card[]): Card[] {
  const hand = sim.hands[seat];
  const { level, trump, dealer, voidMask, seenIds } = sim;
  if (hand.length === 1) return [hand[0]];

  const partner = (seat + 2) % 4;
  const enemy1 = (seat + 1) % 4;
  const enemy2 = (seat + 3) % 4;
  const isDefender = seat % 2 === dealer % 2;

  const isHighestUnseenSingle = (c: Card, eff: Suit): boolean => {
    const p = power(c, level, trump);
    for (let i = 0; i < 108; i++) {
      if (seenIds[i]) continue;
      const dc = fullDeck[i];
      if (hand.some((hc) => hc.id === i)) continue;
      if (effective(dc, level, trump) === eff && power(dc, level, trump) > p) return false;
    }
    return true;
  };

  // --- LEAD ---
  if (sim.trick.length === 0) {
    const bySuit: Record<Suit, Card[]> = { S: [], H: [], C: [], D: [], J: [] };
    for (const c of hand) bySuit[effective(c, level, trump)].push(c);
    const e1HasTrump = (voidMask[enemy1] & SUIT_BIT.J) === 0;
    const e2HasTrump = (voidMask[enemy2] & SUIT_BIT.J) === 0;
    const enemyHasTrump = e1HasTrump || e2HasTrump;
    const bothEnemiesHaveTrump = e1HasTrump && e2HasTrump;

    // 1. Defender trump-drawing: draw with boss trumps / strong trump pairs, never gift lead 2-for-1
    if (
      isDefender &&
      enemyHasTrump &&
      bySuit.J.length >= Math.max(5, Math.ceil(hand.length * (bothEnemiesHaveTrump ? 0.42 : 0.52)))
    ) {
      const tPairs = pairs(bySuit.J);
      if (tPairs.length >= 2) {
        const tRuns = runs(tPairs, 2, (c) => power(c, level, trump));
        if (tRuns.length) return tRuns[tRuns.length - 1];
      }
      if (tPairs.length) {
        tPairs.sort((a, b) => power(b[0], level, trump) - power(a[0], level, trump));
        if (power(tPairs[0][0], level, trump) >= 12) return tPairs[0];
      }
      const sortedT = [...bySuit.J].sort((a, b) => power(b, level, trump) - power(a, level, trump));
      if (isHighestUnseenSingle(sortedT[0], 'J')) return [sortedT[0]];
      // Only probe with a small 0-pt trump when BOTH enemies still hold trumps AND we hold a boss trump to regain control
      if (bothEnemiesHaveTrump && sortedT.length >= 6 && power(sortedT[0], level, trump) >= 13) {
        const lowNoPt = [...bySuit.J]
          .filter((c) => score([c]) === 0)
          .sort((a, b) => power(a, level, trump) - power(b, level, trump));
        if (lowNoPt.length) return [lowNoPt[0]];
      }
    }

    // 2. Cash safe side-suit pairs/tractors/top winners where enemies haven't shown void
    for (const s of ['S', 'H', 'C', 'D'] as const) {
      const g = bySuit[s];
      if (!g.length) continue;
      const bit = SUIT_BIT[s];
      const enemyRuffs =
        ((voidMask[enemy1] & bit) !== 0 && (voidMask[enemy1] & SUIT_BIT.J) === 0) ||
        ((voidMask[enemy2] & bit) !== 0 && (voidMask[enemy2] & SUIT_BIT.J) === 0);
      if (enemyRuffs) continue;

      const ps = pairs(g);
      if (ps.length >= 2) {
        const rs = runs(ps, 2, (c) => power(c, level, trump));
        if (rs.length) return rs[rs.length - 1];
      }
      if (ps.length) {
        ps.sort((a, b) => power(b[0], level, trump) - power(a[0], level, trump));
        if (cRankTopPair(ps[0][0], level) || !enemyHasTrump) return ps[0];
      }
      const topCard = [...g].sort((a, b) => power(b, level, trump) - power(a, level, trump))[0];
      if (isHighestUnseenSingle(topCard, s)) return [topCard];
    }

    // 3. Feed partner's proven side-suit void with a cheap 0-point single
    if ((voidMask[partner] & SUIT_BIT.J) === 0) {
      for (const s of ['S', 'H', 'C', 'D'] as const) {
        const g = bySuit[s];
        if (!g.length) continue;
        const bit = SUIT_BIT[s];
        const partnerVoid = (voidMask[partner] & bit) !== 0;
        const enemyVoid = (voidMask[enemy1] & bit) !== 0 || (voidMask[enemy2] & bit) !== 0;
        if (partnerVoid && !enemyVoid) {
          const cheap = [...g].sort(
            (a, b) => score([a]) - score([b]) || power(a, level, trump) - power(b, level, trump),
          )[0];
          if (score([cheap]) === 0) return [cheap];
        }
      }
    }

    // 4. Default economical non-point lead avoiding enemy voids & preserving pairs
    const pairKeys = new Set(pairs(hand).map((p) => cardKey(p[0])));
    const candidates = [...hand].sort((a, b) => {
      const sa = effective(a, level, trump);
      const sb = effective(b, level, trump);
      const eVoidA =
        sa !== 'J' &&
        (((voidMask[enemy1] & SUIT_BIT[sa]) !== 0 && (voidMask[enemy1] & SUIT_BIT.J) === 0) ||
          ((voidMask[enemy2] & SUIT_BIT[sa]) !== 0 && (voidMask[enemy2] & SUIT_BIT.J) === 0))
          ? 1
          : 0;
      const eVoidB =
        sb !== 'J' &&
        (((voidMask[enemy1] & SUIT_BIT[sb]) !== 0 && (voidMask[enemy1] & SUIT_BIT.J) === 0) ||
          ((voidMask[enemy2] & SUIT_BIT[sb]) !== 0 && (voidMask[enemy2] & SUIT_BIT.J) === 0))
          ? 1
          : 0;
      if (eVoidA !== eVoidB) return eVoidA - eVoidB;
      const pa = pairKeys.has(cardKey(a)) ? 1 : 0;
      const pb = pairKeys.has(cardKey(b)) ? 1 : 0;
      if (pa !== pb) return pa - pb;
      if (score([a]) !== score([b])) return score([a]) - score([b]);
      const ta = sa === 'J' ? 1 : 0;
      const tb = sb === 'J' ? 1 : 0;
      if (ta !== tb) return ta - tb;
      return power(a, level, trump) - power(b, level, trump);
    });
    return [candidates[0]];
  }

  // --- FOLLOW ---
  const lead = sim.trick[0].cards;
  const leadSuit = effective(lead[0], level, trump);
  const own = hand.filter((c) => effective(c, level, trump) === leadSuit);

  // Forced challenger beat after failed throw
  if (sim.throwFailure?.challenger === seat) {
    const forced = sim.throwFailure.forced;
    const fParts = components(forced, level, trump);
    const pool =
      forced.length === 1
        ? own.map((c) => [c])
        : forced.length === 2
          ? pairs(own)
          : runs(pairs(own), forced.length / 2, (c) => power(c, level, trump));
    const beating = pool
      .filter((x) => coverBeats(x, forced, forced, fParts, level, trump))
      .sort((a, b) => power(a[0], level, trump) - power(b[0], level, trump));
    if (beating.length) return beating[0];
  }

  const curWinner = currentTrickWinner(sim.trick, level, trump)!;
  const partnerWinning = curWinner % 2 === seat % 2;
  const lastToAct = sim.trick.length === 3;
  const pot = score(sim.trick.flatMap((p) => p.cards));
  const isFinalTrick = hand.length === lead.length;

  // Fast path for single-card tricks (majority of all tricks)
  if (lead.length === 1) {
    if (own.length === 1) return [own[0]];
    const pairKeys = new Set(pairs(hand).map((p) => cardKey(p[0])));

    if (own.length > 1) {
      const bestPlay = sim.trick.find((p) => p.seat === curWinner)!.cards;
      const bestSuit = effective(bestPlay[0], level, trump);
      const canBeatInSuit = bestSuit === leadSuit;
      const bestPow = power(bestPlay[0], level, trump);

      if (lastToAct) {
        if (partnerWinning) {
          // Partner already won trick! Feed highest points (or cheapest non-pair 0-pt card)
          const pts = own.filter((c) => score([c]) > 0);
          if (pts.length) {
            pts.sort(
              (a, b) => score([b]) - score([a]) || power(a, level, trump) - power(b, level, trump),
            );
            return [pts[0]];
          }
        } else if (canBeatInSuit) {
          const winners = own
            .filter((c) => power(c, level, trump) > bestPow)
            .sort((a, b) => {
              const splitA = pairKeys.has(cardKey(a)) ? 1 : 0;
              const splitB = pairKeys.has(cardKey(b)) ? 1 : 0;
              // Prefer capturing points or final trick; avoid splitting trump pair on 0-pt trick
              return (
                power(a, level, trump) - power(b, level, trump) ||
                score([b]) - score([a]) ||
                splitA - splitB
              );
            });
          if (winners.length) {
            const w = winners[0];
            const worthTaking =
              pot + score([w]) >= 5 ||
              isFinalTrick ||
              (!pairKeys.has(cardKey(w)) && (leadSuit !== 'J' || power(w, level, trump) <= 12));
            if (worthTaking) return [w];
          }
        }
      } else {
        // 2nd or 3rd seat
        const partnerUnbeatable =
          partnerWinning &&
          ((bestSuit === 'J' && bestPow >= 15) ||
            (bestSuit === leadSuit &&
              isHighestUnseenSingle(bestPlay[0], leadSuit) &&
              (leadSuit === 'J' || (voidMask[enemy1] & SUIT_BIT[leadSuit]) === 0)));
        if (partnerUnbeatable) {
          const pts = own.filter((c) => score([c]) > 0);
          if (pts.length) {
            pts.sort((a, b) => score([b]) - score([a]));
            return [pts[0]];
          }
        }
        if (!partnerWinning && canBeatInSuit) {
          const winners = own
            .filter((c) => power(c, level, trump) > bestPow)
            .sort((a, b) => power(b, level, trump) - power(a, level, trump));
          if (winners.length) {
            // Play top winner if it's boss, or third-hand high on contested trick
            if (
              isHighestUnseenSingle(winners[0], leadSuit) ||
              pot >= 10 ||
              sim.trick.length === 2
            ) {
              const cheapWin = winners[winners.length - 1];
              return [isHighestUnseenSingle(winners[0], leadSuit) ? winners[0] : cheapWin];
            }
          }
        }
      }

      // Otherwise slough lowest 0-pt non-pair card in suit
      const dump = [...own].sort((a, b) => {
        if (score([a]) !== score([b])) return score([a]) - score([b]);
        const pa = pairKeys.has(cardKey(a)) ? 1 : 0;
        const pb = pairKeys.has(cardKey(b)) ? 1 : 0;
        if (pa !== pb) return pa - pb;
        return power(a, level, trump) - power(b, level, trump);
      });
      return [dump[0]];
    }

    // Void in single-card leadSuit! Decide between ruffing, feeding partner, or discarding trash
    const partnerSafe =
      partnerWinning &&
      (lastToAct ||
        (effective(sim.trick.find((p) => p.seat === curWinner)!.cards[0], level, trump) ===
          leadSuit &&
          isHighestUnseenSingle(sim.trick.find((p) => p.seat === curWinner)!.cards[0], leadSuit) &&
          (voidMask[enemy1] & SUIT_BIT[leadSuit]) === 0));

    if (partnerSafe) {
      const sidePts = hand
        .filter((c) => effective(c, level, trump) !== 'J' && score([c]) > 0)
        .sort((a, b) => score([b]) - score([a]) || power(a, level, trump) - power(b, level, trump));
      if (sidePts.length) return [sidePts[0]];
    }

    if (!partnerWinning && leadSuit !== 'J') {
      const trumps = hand.filter((c) => effective(c, level, trump) === 'J');
      if (trumps.length) {
        const bestPlay = sim.trick.find((p) => p.seat === curWinner)!.cards;
        const needPow =
          effective(bestPlay[0], level, trump) === 'J' ? power(bestPlay[0], level, trump) : -1;
        const ruffs = trumps
          .filter((c) => power(c, level, trump) > needPow)
          .sort(
            (a, b) => score([b]) - score([a]) || power(a, level, trump) - power(b, level, trump),
          );
        if (ruffs.length) {
          const r = ruffs.find((c) => !pairKeys.has(cardKey(c))) ?? ruffs[0];
          const soleBigJoker = trumps.length === 1 && r.suit === 'J' && r.rank === 17;
          if (
            isFinalTrick ||
            pot + score([r]) >= 10 ||
            (!soleBigJoker && (pot >= 5 || hand.length <= 6 || power(r, level, trump) <= 11))
          ) {
            return [r];
          }
        }
      }
    }

    // Discard 0-pt card from shortest side suit without breaking pairs
    const suitCounts: Record<Suit, number> = { S: 0, H: 0, C: 0, D: 0, J: 99 };
    for (const c of hand) {
      const eff = effective(c, level, trump);
      if (eff !== 'J') suitCounts[eff]++;
    }
    const discards = [...hand].sort((a, b) => {
      const ea = effective(a, level, trump);
      const eb = effective(b, level, trump);
      if (score([a]) !== score([b])) return score([a]) - score([b]);
      const ta = ea === 'J' ? 1 : 0;
      const tb = eb === 'J' ? 1 : 0;
      if (ta !== tb) return ta - tb;
      const pa = pairKeys.has(cardKey(a)) ? 1 : 0;
      const pb = pairKeys.has(cardKey(b)) ? 1 : 0;
      if (pa !== pb) return pa - pb;
      if (suitCounts[ea] !== suitCounts[eb]) return suitCounts[ea] - suitCounts[eb];
      return power(a, level, trump) - power(b, level, trump);
    });
    return [discards[0]];
  }

  // Multi-card follow (pairs, tractors, mixed throws)
  const parts = components(lead, level, trump);
  const pairCount = parts.reduce((sum, p) => sum + Math.floor(p.length / 2), 0);
  const demands = parts.filter((p) => p.length > 2).map((p) => p.length / 2);
  const bestPlay = sim.trick.find((p) => p.seat === curWinner)!.cards;

  // If completely void in non-trump leadSuit and enemy winning, check economical trump kill
  if (own.length === 0 && leadSuit !== 'J' && !partnerWinning) {
    const trumps = hand.filter((c) => effective(c, level, trump) === 'J');
    if (
      trumps.length >= lead.length &&
      (pot >= 10 || isFinalTrick || hand.length <= lead.length * 2)
    ) {
      const orderedT = [...trumps].sort(
        (a, b) => power(a, level, trump) - power(b, level, trump) || a.id - b.id,
      );
      const cover = pairCount ? bestPairs(orderedT, pairCount, level, trump, demands).flat() : [];
      for (const c of orderedT) {
        if (cover.length < lead.length && !cover.some((x) => x.id === c.id)) cover.push(c);
      }
      if (cover.length === lead.length && coverBeats(cover, bestPlay, lead, parts, level, trump)) {
        return cover;
      }
    }
  }

  // If following in suit and can beat enemy on valuable trick
  if (
    own.length >= lead.length &&
    !partnerWinning &&
    effective(bestPlay[0], level, trump) === leadSuit
  ) {
    if (lead.length === 2 && pairCount === 1) {
      const ps = pairs(own)
        .filter((p) => coverBeats(p, bestPlay, lead, parts, level, trump))
        .sort((a, b) => power(a[0], level, trump) - power(b[0], level, trump));
      if (ps.length && (pot + score(ps[0]) >= 10 || isFinalTrick || lastToAct)) return ps[0];
    } else if (demands.length === 1 && demands[0] * 2 === lead.length) {
      const rs = runs(pairs(own), demands[0], (c) => power(c, level, trump))
        .filter((r) => coverBeats(r, bestPlay, lead, parts, level, trump))
        .sort((a, b) => power(a[0], level, trump) - power(b[0], level, trump));
      if (rs.length) return rs[0];
    }
  }

  // Construct legal follow ordered by feeding (if partner safe) vs conserving
  const feedMode = lastToAct && partnerWinning;
  const orderedOwn = [...own].sort((a, b) =>
    feedMode
      ? score([b]) - score([a]) || power(a, level, trump) - power(b, level, trump)
      : score([a]) - score([b]) || power(a, level, trump) - power(b, level, trump),
  );
  const selected = pairCount ? bestPairs(orderedOwn, pairCount, level, trump, demands).flat() : [];
  const orderedRest = [...hand].sort((a, b) => {
    if (feedMode) {
      const ta = effective(a, level, trump) === 'J' ? 1 : 0;
      const tb = effective(b, level, trump) === 'J' ? 1 : 0;
      return score([b]) - score([a]) || ta - tb || power(a, level, trump) - power(b, level, trump);
    }
    const ta = effective(a, level, trump) === 'J' ? 1 : 0;
    const tb = effective(b, level, trump) === 'J' ? 1 : 0;
    return score([a]) - score([b]) || ta - tb || power(a, level, trump) - power(b, level, trump);
  });
  for (const c of [...orderedOwn, ...orderedRest]) {
    if (selected.length < lead.length && !selected.some((x) => x.id === c.id)) {
      selected.push(c);
    }
  }
  return selected;
}

function cRankTopPair(c: Card, level: number): boolean {
  return c.rank === 14 || (level === 14 && c.rank === 13);
}

// ---------------------------------------------------------------------------
// Utility function & Root Candidate Generators
// ---------------------------------------------------------------------------

/** Round outcome utility from the perspective of `seat` (exact threshold & level jumps + smooth score). */
function roundUtility(finalPoints: number, dealer: number, seat: number): number {
  const attackerWin = finalPoints >= 80;
  const levelJump = attackerWin
    ? Math.floor((finalPoints - 80) / 40)
    : finalPoints <= 0
      ? -3
      : finalPoints < 40
        ? -2
        : -1;
  // Dealer turnover + level jump + smooth point incentive
  const attackerScore = (attackerWin ? 46 : -46) + levelJump * 22 + (finalPoints - 60) * 0.52;
  return seat % 2 !== dealer % 2 ? attackerScore : -attackerScore;
}

interface RootCandidate {
  cs: Card[];
  sig: string;
  prior: number;
}

function dedupeEquivalentCandidates(
  raw: { cs: Card[]; prior: number }[],
  level: number,
  trump: Suit,
): RootCandidate[] {
  // Two plays consisting of identical suit+rank multisets are Strategically Isomorphic!
  const byIso = new Map<string, RootCandidate>();
  for (const item of raw) {
    const iso = item.cs
      .map((c) => `${c.suit}${c.rank}:${effective(c, level, trump)}`)
      .sort()
      .join('|');
    const prev = byIso.get(iso);
    if (!prev || item.prior > prev.prior) {
      const sig = item.cs
        .map((c) => c.id)
        .sort((a, b) => a - b)
        .join(',');
      byIso.set(iso, { cs: item.cs, sig, prior: item.prior });
    }
  }
  return [...byIso.values()].sort((a, b) => b.prior - a.prior);
}

function generateLeadCandidates(
  v: TractorView,
  unseen: Card[],
  voidMask: number[],
): RootCandidate[] {
  const seat = v.seat!;
  const partner = (seat + 2) % 4;
  const enemy1 = (seat + 1) % 4;
  const enemy2 = (seat + 3) % 4;
  const isDefender = seat % 2 === v.dealer % 2;
  const raw: { cs: Card[]; prior: number }[] = [];

  const myTrumps = v.hand.filter((c) => effective(c, v.level, v.trump) === 'J');
  const unseenTrumps = unseen.filter((c) => effective(c, v.level, v.trump) === 'J').length;
  const enemyHasTrump =
    unseenTrumps > 0 &&
    ((voidMask[enemy1] & SUIT_BIT.J) === 0 || (voidMask[enemy2] & SUIT_BIT.J) === 0);

  const pairSet = new Set(pairs(v.hand).map((p) => cardKey(p[0])));

  const scoreLeadPrior = (cs: Card[]): number => {
    const suit = effective(cs[0], v.level, v.trump);
    const high = Math.max(...cs.map((c) => power(c, v.level, v.trump)));
    const higher = unseen.filter(
      (c) => effective(c, v.level, v.trump) === suit && power(c, v.level, v.trump) > high,
    ).length;
    const bit = SUIT_BIT[suit];
    const enemyVoid =
      suit !== 'J' &&
      (((voidMask[enemy1] & bit) !== 0 && (voidMask[enemy1] & SUIT_BIT.J) === 0) ||
        ((voidMask[enemy2] & bit) !== 0 && (voidMask[enemy2] & SUIT_BIT.J) === 0));
    const partnerVoid =
      suit !== 'J' &&
      (voidMask[partner] & bit) !== 0 &&
      (voidMask[partner] & SUIT_BIT.J) === 0 &&
      v.handCounts[partner] > 0 &&
      unseenTrumps > 0;

    let val =
      (partnerVoid && !enemyVoid && cs.length === 1
        ? 16 - power(cs[0], v.level, v.trump) * 0.3
        : higher === 0
          ? 15
          : -higher * 1.15) +
      (cs.length - 1) * 4.5;
    if (enemyVoid) val -= 34 + score(cs) * 1.5;
    if (partnerVoid && !enemyVoid && cs.length === 1) val -= score(cs) * 0.8;
    if (cs.length === 1 && pairSet.has(cardKey(cs[0]))) val -= 4.5;

    if (suit === 'J') {
      // Defenders with strong trumps WANT to draw enemy trumps; attackers avoid wasting trumps
      if (isDefender && enemyHasTrump && myTrumps.length >= Math.max(4, v.hand.length * 0.38)) {
        val += 6;
      } else {
        val -= 5;
      }
    } else if (higher > 0) {
      val -= score(cs) * 0.7;
    } else if (!enemyVoid) {
      val += score(cs) * 0.35;
    }
    return val;
  };

  // Singles
  for (const c of v.hand) raw.push({ cs: [c], prior: scoreLeadPrior([c]) });

  // Pairs, Tractors & 100% Publicly Safe Top Throws
  for (const suit of SUITS) {
    const g = v.hand.filter((c) => effective(c, v.level, v.trump) === suit);
    if (g.length < 2) continue;
    const ps = pairs(g);
    for (const p of ps) raw.push({ cs: p, prior: scoreLeadPrior(p) });
    for (let n = 2; n <= ps.length; n++) {
      for (const r of runs(ps, n, (c) => power(c, v.level, v.trump))) {
        raw.push({ cs: r, prior: scoreLeadPrior(r) + 3 });
      }
    }

    // Generate guaranteed-safe mixed throws (e.g., AA+K, AA+10, Tractor+TopSingle, Two Top Pairs)
    const topOrdered = [...g].sort(
      (a, b) => power(b, v.level, v.trump) - power(a, v.level, v.trump),
    );
    const topUnits: Card[][] = [];
    const usedIds = new Set<number>();
    if (ps.length >= 2) {
      const trs = runs(ps, 2, (c) => power(c, v.level, v.trump)).sort(
        (a, b) => power(b[0], v.level, v.trump) - power(a[0], v.level, v.trump),
      );
      if (trs.length && isPubliclySafeThrow(trs[0], unseen, v.level, v.trump)) {
        topUnits.push(trs[0]);
        for (const c of trs[0]) usedIds.add(c.id);
      }
    }
    for (const p of [...ps].sort(
      (a, b) => power(b[0], v.level, v.trump) - power(a[0], v.level, v.trump),
    )) {
      if (p.some((c) => usedIds.has(c.id))) continue;
      if (isPubliclySafeThrow(p, unseen, v.level, v.trump)) {
        topUnits.push(p);
        for (const c of p) usedIds.add(c.id);
      }
    }
    for (const c of topOrdered) {
      if (usedIds.has(c.id)) continue;
      if (
        !unseen.some(
          (u) =>
            effective(u, v.level, v.trump) === suit &&
            power(u, v.level, v.trump) > power(c, v.level, v.trump),
        )
      ) {
        topUnits.push([c]);
        usedIds.add(c.id);
      }
    }
    if (topUnits.length >= 2) {
      const combined: Card[] = [...topUnits[0]];
      for (let i = 1; i < topUnits.length; i++) {
        const nextCombo = [...combined, ...topUnits[i]];
        if (isPubliclySafeThrow(nextCombo, unseen, v.level, v.trump)) {
          combined.push(...topUnits[i]);
          raw.push({ cs: [...combined], prior: scoreLeadPrior(combined) + 6 });
        }
      }
    }
  }

  // Also include adaptive-v2's own recommended play to ensure strict superset of v2 intuition
  const v2Rec = recommend(v);
  if (v2Rec.type === 'play') {
    const v2Cards = v.hand.filter((c) => v2Rec.cards.includes(c.id));
    if (v2Cards.length) raw.push({ cs: v2Cards, prior: scoreLeadPrior(v2Cards) + 4 });
  }

  return dedupeEquivalentCandidates(raw, v.level, v.trump);
}

function generateFollowCandidates(v: TractorView): RootCandidate[] {
  const lead = v.trick[0].cards;
  const leadSuit = effective(lead[0], v.level, v.trump);
  const rawPool: Card[][] = [];

  const fb = basicRecommend(v);
  if ('cards' in fb) rawPool.push(v.hand.filter((c) => fb.cards.includes(c.id)));
  const v2Rec = recommend(v);
  if ('cards' in v2Rec) rawPool.push(v.hand.filter((c) => v2Rec.cards.includes(c.id)));

  const groups = SUITS.map((s) => v.hand.filter((c) => effective(c, v.level, v.trump) === s));
  if (lead.length === 1) {
    for (const c of v.hand) rawPool.push([c]);
  } else {
    for (const g of groups) {
      if (lead.length === 2) rawPool.push(...pairs(g));
      else if (lead.length % 2 === 0) {
        rawPool.push(...runs(pairs(g), lead.length / 2, (c) => power(c, v.level, v.trump)));
      }
    }

    const own = v.hand.filter((c) => effective(c, v.level, v.trump) === leadSuit);
    const parts = components(lead, v.level, v.trump);
    const pairCount = parts.reduce((n, p) => n + Math.floor(p.length / 2), 0);
    const demands = parts.filter((p) => p.length > 2).map((p) => p.length / 2);
    const suitLen: Record<Suit, number> = { S: 0, H: 0, C: 0, D: 0, J: 99 };
    for (const c of v.hand) {
      const eff = effective(c, v.level, v.trump);
      if (eff !== 'J') suitLen[eff]++;
    }
    const pairKeys = new Set(pairs(v.hand).map((p) => cardKey(p[0])));

    // Richer objective orderings: point-feed, zero-point void-creation, pair-preservation, cheap/high ruff
    const sorters: ((a: Card, b: Card) => number)[] = [
      // 1. Economical zero-point shortest-side-suit slough preserving pairs
      (a, b) =>
        score([a]) - score([b]) ||
        (effective(a, v.level, v.trump) === 'J' ? 1 : 0) -
          (effective(b, v.level, v.trump) === 'J' ? 1 : 0) ||
        (pairKeys.has(cardKey(a)) ? 1 : 0) - (pairKeys.has(cardKey(b)) ? 1 : 0) ||
        suitLen[effective(a, v.level, v.trump)] - suitLen[effective(b, v.level, v.trump)] ||
        power(a, v.level, v.trump) - power(b, v.level, v.trump),
      // 2. Maximum non-trump point feeding
      (a, b) =>
        score([b]) - score([a]) ||
        (effective(a, v.level, v.trump) === 'J' ? 1 : 0) -
          (effective(b, v.level, v.trump) === 'J' ? 1 : 0) ||
        suitLen[effective(a, v.level, v.trump)] - suitLen[effective(b, v.level, v.trump)] ||
        power(a, v.level, v.trump) - power(b, v.level, v.trump),
      // 3. Highest power contest
      (a, b) => power(b, v.level, v.trump) - power(a, v.level, v.trump) || score([b]) - score([a]),
      // 4. Cheapest power contest with points
      (a, b) => power(a, v.level, v.trump) - power(b, v.level, v.trump) || score([b]) - score([a]),
      // 5. Pure lowest power
      (a, b) => power(a, v.level, v.trump) - power(b, v.level, v.trump) || a.id - b.id,
    ];

    for (const cmp of sorters) {
      const ordered = [...v.hand].sort(cmp);
      const following = ordered.filter((c) => own.some((x) => x.id === c.id));
      const cs = pairCount ? bestPairs(following, pairCount, v.level, v.trump, demands).flat() : [];
      for (const c of [...following, ...ordered]) {
        if (cs.length < lead.length && !cs.some((x) => x.id === c.id)) cs.push(c);
      }
      rawPool.push(cs);

      // Trump cover candidates when completely void in side suit
      if (own.length === 0 && leadSuit !== 'J') {
        const trumps = ordered.filter((c) => effective(c, v.level, v.trump) === 'J');
        if (trumps.length >= lead.length) {
          const cover = pairCount
            ? bestPairs(trumps, pairCount, v.level, v.trump, demands).flat()
            : [];
          for (const c of trumps) {
            if (cover.length < lead.length && !cover.some((x) => x.id === c.id)) cover.push(c);
          }
          rawPool.push(cover);
        }
      }
    }
  }

  const legal = rawPool.filter(
    (cs) =>
      cs.length === lead.length &&
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

  const v2Ids = 'cards' in v2Rec ? new Set(v2Rec.cards) : new Set<number>();
  const curWin = currentTrickWinner(v.trick, v.level, v.trump)!;
  const partnerNow = curWin % 2 === v.seat! % 2;
  const last = v.trick.length === 3;
  const pot = score(v.trick.flatMap((p) => p.cards));

  const scoreFollowPrior = (cs: Card[]): number => {
    const afterWinner = currentTrickWinner(
      [...v.trick, { seat: v.seat!, cards: cs }],
      v.level,
      v.trump,
    )!;
    const oursAfter = afterWinner % 2 === v.seat! % 2;
    let p = 0;
    if (cs.length === v2Ids.size && cs.every((c) => v2Ids.has(c.id))) p += 5;
    if (last) {
      if (oursAfter) p += 16 + (pot + score(cs)) * 0.9;
      else p -= (pot + score(cs)) * 0.9;
    } else if (oursAfter && partnerNow) {
      // Keep point-feeding / point-unloading options in the shortlist when partner currently leads!
      p += 4 + score(cs) * 0.45;
    } else if (oursAfter && !partnerNow) {
      p += 6 + pot * 0.4;
    }
    // Penalize spending trumps unnecessarily early
    for (const c of cs) {
      if (effective(c, v.level, v.trump) === 'J' && leadSuit !== 'J' && v.hand.length > 8) {
        p -= 3.5 + power(c, v.level, v.trump) * 0.15;
      } else {
        p -= power(c, v.level, v.trump) * 0.08;
      }
    }
    return p;
  };

  return dedupeEquivalentCandidates(
    legal.map((cs) => ({ cs, prior: scoreFollowPrior(cs) })),
    v.level,
    v.trump,
  );
}

// ---------------------------------------------------------------------------
// Deep Declaration & Beam-Search + Rollout Bury
// ---------------------------------------------------------------------------

function suitDeclareStrength(v: TractorView, suit: Suit): number {
  const trumps = v.hand.filter((c) => effective(c, v.level, suit) === 'J');
  const sideVoids = (['S', 'H', 'C', 'D'] as const).filter(
    (s) => s !== suit && !v.hand.some((c) => effective(c, v.level, suit) === s),
  ).length;
  const sideAces = v.hand.filter(
    (c) => effective(c, v.level, suit) !== 'J' && c.rank === 14,
  ).length;
  const tPairs = pairs(trumps);
  const tTractors = tPairs.length >= 2 ? runs(tPairs, 2, (c) => power(c, v.level, suit)).length : 0;
  const highControls = trumps.filter(
    (c) => c.suit === 'J' || c.rank === v.level || c.rank === 14,
  ).length;
  return (
    trumps.length * 1.05 +
    tPairs.length * 1.65 +
    tTractors * 1.8 +
    highControls * 0.55 +
    (suit !== 'J' ? sideVoids * 0.75 : -0.6) +
    sideAces * 0.25
  );
}

function thinkDeclare(v: TractorView): TractorAction {
  const choices = declarationChoices(v)
    .filter((c) => c.cards.length > 0)
    .sort((a, b) => suitDeclareStrength(v, b.suit) - suitDeclareStrength(v, a.suit));
  const best = choices[0];
  if (!best || v.hand.length < 5) return { type: 'pass' };

  const quality = suitDeclareStrength(v, best.suit);
  const firstRoundGrabDealer = v.round === 1 && !v.bid;
  const ourTeamDealer = v.bid ? v.bid.seat % 2 === v.seat! % 2 : v.dealer % 2 === v.seat! % 2;

  // Base threshold scales with cards dealt so far; slightly more proactive when grabbing R1 dealer
  const minThreshold = firstRoundGrabDealer
    ? Math.max(3.8, v.hand.length * 0.34)
    : Math.max(4.2, v.hand.length * 0.37);
  if (quality < minThreshold) return { type: 'pass' };

  if (!v.bid) {
    // Round >= 2 unbid defaults to Spades ('S'). Avoid revealing a weak suit for enemy dealer if our Spades are already decent!
    if (v.round > 1 && !ourTeamDealer && best.suit !== 'S') {
      const spadeQ = suitDeclareStrength(v, 'S');
      if (quality < spadeQ + 1.2) return { type: 'pass' };
    }
    return { type: 'reveal', cards: best.cards };
  }

  const currentQ = suitDeclareStrength(v, v.trump);
  if (v.bid.seat % 2 === v.seat! % 2) {
    // Partner declared: only overcall if dramatically stronger or locking in no-trump control
    if (quality < currentQ + 3.6) return { type: 'pass' };
  } else {
    // Enemy declared: overcall aggressively when we are short in enemy's trump suit!
    const ourEnemyTrumps = v.hand.filter((c) => effective(c, v.level, v.trump) === 'J').length;
    const margin = ourEnemyTrumps <= Math.max(2, v.hand.length * 0.16) ? 0.4 : 1.1;
    if (quality < currentQ + margin) return { type: 'pass' };
  }
  return { type: 'reveal', cards: best.cards };
}

function evaluateKeptHand(kept: Card[], buried: Card[], level: number, trump: Suit): number {
  const trumps = kept.filter((c) => effective(c, level, trump) === 'J');
  const topTrumps = trumps.filter(
    (c) => c.suit === 'J' || (c.rank === level && c.suit === trump),
  ).length;
  const trumpPairs = pairs(trumps);
  // Kitty risk depends smoothly on whether dealer has fortress-level endgame protection
  const fortress =
    (trumps.length >= 11 && topTrumps >= 3) ||
    (trumps.length >= 10 && trumpPairs.length >= 2 && topTrumps >= 3);
  const midControl = trumps.length >= 9 && topTrumps >= 2;
  const pointRisk = fortress ? 0.85 : midControl ? 2.1 : 3.1;

  let val = -score(buried) * pointRisk;
  for (const suit of SUITS) {
    const g = kept.filter((c) => effective(c, level, trump) === suit);
    if (suit !== 'J') {
      if (g.length === 0)
        val += 10.5; // Void creation is huge for dealer
      else if (g.length === 1) val += g[0].rank === 14 ? 4 : -3.5;
      else if (g.length === 2 && pairs(g).length === 0) val -= 1.2;
      // Penalize exposed unprotected points left in side suits
      const hasAce = g.some((c) => c.rank === 14);
      for (const c of g) {
        if (score([c]) > 0 && !hasAce && g.length <= 3) val -= score([c]) * 0.45;
      }
    }
    for (const c of g) {
      val +=
        suit === 'J'
          ? 5.5 + power(c, level, trump) * 0.55
          : c.rank === 14
            ? 5.8
            : power(c, level, trump) * 0.12;
    }
    const ps = pairs(g);
    val += ps.length * 7.8;
    const pVals = new Set(ps.map((p) => power(p[0], level, trump)));
    for (const n of pVals) if (pVals.has(n + 1)) val += 7.5;
  }
  return val;
}

function thinkBury(v: TractorView, budgetMs: number, clock: () => number): TractorAction {
  const start = clock();
  if (v.hand.length !== 33) return recommend(v);

  const candidateSets = new Map<string, { buried: Card[]; score: number }>();
  const addCandidate = (buried: Card[]) => {
    if (buried.length !== 8) return;
    const ids = buried.map((c) => c.id).sort((a, b) => a - b);
    const sig = ids.join(',');
    if (candidateSets.has(sig)) return;
    const drop = new Set(ids);
    const kept = v.hand.filter((c) => !drop.has(c.id));
    candidateSets.set(sig, { buried, score: evaluateKeptHand(kept, buried, v.level, v.trump) });
  };

  // Include baseline v2 bury as candidate #0
  const baseAct = recommend(v);
  if (baseAct.type === 'bury') {
    addCandidate(v.hand.filter((c) => baseAct.cards.includes(c.id)));
  }

  // Beam search over 16 side-suit void target masks, stripping non-boss cards first
  const sideSuits: Suit[] = (['S', 'H', 'C', 'D'] as Suit[]).filter(
    (s) => s !== v.trump && v.hand.some((c) => effective(c, v.level, v.trump) === s),
  );
  const pairKeys = new Set(pairs(v.hand).map((p) => cardKey(p[0])));

  for (let mask = 0; mask < 1 << sideSuits.length; mask++) {
    // Collect non-pair, non-Ace cards from targeted void suits, or full targeted suits
    const targeted: Card[] = [];
    for (let i = 0; i < sideSuits.length; i++) {
      if (!(mask & (1 << i))) continue;
      const g = v.hand.filter((c) => effective(c, v.level, v.trump) === sideSuits[i]);
      targeted.push(...g);
    }

    for (const pointPref of [-1, 1]) {
      // pointPref = -1: avoid burying points (safe kitty); pointPref = +1: tuck loose side points if fortress
      const sortedTarget = [...targeted].sort(
        (a, b) =>
          pointPref * (score([b]) - score([a])) ||
          (pairKeys.has(cardKey(a)) ? 1 : 0) - (pairKeys.has(cardKey(b)) ? 1 : 0) ||
          power(a, v.level, v.trump) - power(b, v.level, v.trump),
      );
      const chosen = sortedTarget.slice(0, 8);
      while (chosen.length < 8) {
        const used = new Set(chosen.map((c) => c.id));
        const rest = v.hand.filter((c) => !used.has(c.id));
        // Intermediate step guides toward emptying short side suits without getting stuck at len=1!
        let bestCard = rest[0];
        let bestScore = -Infinity;
        for (const c of rest) {
          const nextChosen = [...chosen, c];
          const nextUsed = new Set(nextChosen.map((x) => x.id));
          const kept = v.hand.filter((x) => !nextUsed.has(x.id));
          let s = evaluateKeptHand(kept, nextChosen, v.level, v.trump);
          if (pointPref === -1) s -= score([c]) * 1.4;
          else if (effective(c, v.level, v.trump) !== 'J') s += score([c]) * 0.9;
          // Lookahead bonus for shrinking a side suit to <= remaining bury slots!
          const remSlots = 8 - nextChosen.length;
          for (const side of sideSuits) {
            const remInSuit = kept.filter((x) => effective(x, v.level, v.trump) === side).length;
            if (remInSuit > 0 && remInSuit <= remSlots) s += 5.5;
          }
          if (s > bestScore) {
            bestScore = s;
            bestCard = c;
          }
        }
        chosen.push(bestCard);
      }
      addCandidate(chosen);
    }
  }

  const finalists = [...candidateSets.values()].sort((a, b) => b.score - a.score).slice(0, 5);
  if (finalists.length <= 1 || budgetMs < 40) {
    return { type: 'bury', cards: finalists[0].buried.map((c) => c.id) };
  }

  // Simulate full rounds on common random opponent deals to test actual kitty safety & control!
  const fullDeck = createDeck(2);
  const myIds = new Set(v.hand.map((c) => c.id));
  const unseen = fullDeck.filter((c) => !myIds.has(c.id)); // 75 opponent cards
  let rng = (2166136261 ^ v.hand.reduce((h, c) => Math.imul(h ^ c.id, 16777619), 17)) >>> 0;
  const rand = () => {
    rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
    return rng / 4294967296;
  };

  const worldUtilities: number[][] = finalists.map(() => []);
  let worlds = 0;
  const maxBuryWorlds = 20;
  while (worlds < maxBuryWorlds && clock() - start < budgetMs * 0.85) {
    // Shuffle 75 unseen cards into the 3 other seats (25 each)
    const pool = [...unseen];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
    }
    const otherSeats = [0, 1, 2, 3].filter((s) => s !== v.seat);
    const dealHands: Card[][] = [[], [], [], []];
    dealHands[v.seat!] = [];
    dealHands[otherSeats[0]] = pool.slice(0, 25);
    dealHands[otherSeats[1]] = pool.slice(25, 50);
    dealHands[otherSeats[2]] = pool.slice(50, 75);

    for (let idx = 0; idx < finalists.length; idx++) {
      const cand = finalists[idx];
      const buriedIds = new Set(cand.buried.map((c) => c.id));
      const kept = v.hand.filter((c) => !buriedIds.has(c.id));
      const sim: SimState = {
        hands: dealHands.map((h, s) => (s === v.seat ? [...kept] : [...h])),
        kitty: [...cand.buried],
        dealer: v.dealer,
        level: v.level,
        trump: v.trump,
        turn: v.dealer,
        points: 0,
        trick: [],
        lastTrick: [],
        winner: v.dealer,
        throwFailure: null,
        voidMask: [0, 0, 0, 0],
        seenIds: new Uint8Array(108),
        done: false,
      };
      let guard = 0;
      while (!sim.done && guard++ < 120) {
        const actor = sim.turn;
        const playCards = fastRolloutChoose(sim, actor, fullDeck);
        stepSimPlay(sim, actor, playCards);
      }
      worldUtilities[idx].push(roundUtility(sim.points, v.dealer, v.seat!));
    }
    worlds++;
  }

  const evalBuryCandidate = (idx: number): number => {
    const samples = worldUtilities[idx];
    if (!samples.length) return finalists[idx].score;
    const sorted = [...samples].sort((a, b) => a - b);
    const mean = sorted.reduce((s, x) => s + x, 0) / sorted.length;
    const tailCount = Math.max(1, Math.floor(sorted.length * 0.25));
    const cvar25 = sorted.slice(0, tailCount).reduce((s, x) => s + x, 0) / tailCount;
    // Risk-averse dealer evaluation: penalize catastrophic kitty-multiplier blowups!
    return mean * 0.7 + cvar25 * 0.3 + finalists[idx].score * 0.22;
  };

  let bestIdx = 0;
  let bestBuryScore = evalBuryCandidate(0);
  for (let i = 1; i < finalists.length; i++) {
    const s = evalBuryCandidate(i);
    if (s > bestBuryScore) {
      bestBuryScore = s;
      bestIdx = i;
    }
  }
  return { type: 'bury', cards: finalists[bestIdx].buried.map((c) => c.id) };
}

// ---------------------------------------------------------------------------
// Main Entry: thinkTractor
// ---------------------------------------------------------------------------

/**
 * Budgeted deep-search bot decision for Tractor.
 * Designed to run inside Mac mini worker threads while keeping strict view-only isolation.
 */
export function thinkTractor(
  v: TractorView,
  opts: ThinkOptions = {},
  onReport?: (diag: ThinkDiagnostics) => void,
): TractorAction {
  const clock = opts.clock ?? defaultClock;
  const start = clock();
  const budgetMs = opts.budgetMs ?? 360;
  const maxWorlds = opts.maxWorlds ?? 32;
  const maxCandidates = opts.maxCandidates ?? 12;

  if (v.phase === 'roundOver') return { type: 'continue' };
  if (v.phase === 'dealing' || v.phase === 'reveal') {
    const act = thinkDeclare(v);
    onReport?.({
      version: 'tractor-think-v3',
      phase: v.phase,
      worlds: 0,
      rollouts: 0,
      nodes: 0,
      elapsedMs: clock() - start,
      shortCircuited: true,
      fallback: '',
      candidates: [],
    });
    return act;
  }
  if (v.phase === 'bury') {
    const act = thinkBury(v, budgetMs, clock);
    onReport?.({
      version: 'tractor-think-v3',
      phase: 'bury',
      worlds: 0,
      rollouts: 0,
      nodes: 0,
      elapsedMs: clock() - start,
      shortCircuited: false,
      fallback: '',
      candidates: [],
    });
    return act;
  }
  if (v.phase !== 'play' || v.seat === null || !v.hand.length) {
    return basicRecommend(v);
  }

  const belief = sampleSmartBeliefs(v, maxWorlds);
  const rootCandidates = (
    v.trick.length === 0
      ? generateLeadCandidates(v, belief.unseen, belief.voidMask)
      : generateFollowCandidates(v)
  ).slice(0, maxCandidates);

  if (!rootCandidates.length) {
    return basicRecommend(v);
  }

  // Instant short-circuit when only 1 distinct legal play exists!
  if (rootCandidates.length === 1 || !belief.worlds.length) {
    const chosen = rootCandidates[0];
    onReport?.({
      version: 'tractor-think-v3',
      phase: 'play',
      worlds: 0,
      rollouts: 0,
      nodes: 0,
      elapsedMs: clock() - start,
      shortCircuited: true,
      fallback: belief.fallback,
      candidates: [
        {
          cards: chosen.cs.map((c) => c.id),
          score: chosen.prior,
          prior: chosen.prior,
          meanUtility: 0,
        },
      ],
    });
    return { type: 'play', cards: chosen.cs.map((c) => c.id) };
  }

  const fullDeck = createDeck(2);
  const sums = new Float64Array(rootCandidates.length);
  let evaluatedWorlds = 0;
  let totalNodes = 0;
  let totalRollouts = 0;

  // Iterative deepening across common belief worlds: every candidate sees the EXACT same worlds!
  for (let wIdx = 0; wIdx < belief.worlds.length; wIdx++) {
    if (wIdx >= 2 && clock() - start >= budgetMs) break;
    const world = belief.worlds[wIdx];

    for (let cIdx = 0; cIdx < rootCandidates.length; cIdx++) {
      const cand = rootCandidates[cIdx];
      const sim: SimState = {
        hands: world.hands.map((h) => [...h]),
        kitty: [...world.kitty],
        dealer: v.dealer,
        level: v.level,
        trump: v.trump,
        turn: v.seat,
        points: v.points,
        trick: v.trick.map((p) => ({ seat: p.seat, cards: [...p.cards] })),
        lastTrick: v.lastTrick.map((p) => ({ seat: p.seat, cards: [...p.cards] })),
        winner: v.winner,
        throwFailure: v.throwFailure
          ? {
              seat: v.throwFailure.seat,
              challenger: v.throwFailure.challenger,
              forced: [...v.throwFailure.forced],
              penalty: v.throwFailure.penalty,
            }
          : null,
        voidMask: [...belief.voidMask],
        seenIds: new Uint8Array(belief.seenIds),
        done: false,
      };

      // Apply root candidate move
      stepSimPlay(sim, v.seat, cand.cs);
      totalNodes++;

      // Play out the rest of the round to exact engine settlement (including final kitty multiplier!)
      let guard = 0;
      while (!sim.done && guard++ < 120) {
        const actor = sim.turn;
        const move = fastRolloutChoose(sim, actor, fullDeck);
        stepSimPlay(sim, actor, move);
        totalNodes++;
      }
      sums[cIdx] += roundUtility(sim.points, v.dealer, v.seat);
      totalRollouts++;
    }
    evaluatedWorlds++;
  }

  // Bayesian blend: prior acts as gentle tie-breaker & small-sample stabilizer, rollout dominates
  const priorWeight = evaluatedWorlds >= 12 ? 0.14 : evaluatedWorlds >= 4 ? 0.25 : 0.6;
  const scored = rootCandidates
    .map((c, i) => {
      const meanUtility = evaluatedWorlds > 0 ? sums[i] / evaluatedWorlds : 0;
      const combined = meanUtility + c.prior * priorWeight;
      return {
        cs: c.cs,
        cards: c.cs.map((x) => x.id),
        score: combined,
        prior: c.prior,
        meanUtility,
      };
    })
    .sort((a, b) => b.score - a.score);

  onReport?.({
    version: 'tractor-think-v3',
    phase: 'play',
    worlds: evaluatedWorlds,
    rollouts: totalRollouts,
    nodes: totalNodes,
    elapsedMs: clock() - start,
    shortCircuited: false,
    fallback: belief.fallback,
    candidates: scored.map(({ cards, score: sc, prior, meanUtility }) => ({
      cards,
      score: sc,
      prior,
      meanUtility,
    })),
  });

  const bestAction: TractorAction = { type: 'play', cards: scored[0].cards };
  // Paranoid legality check against view-only followError before returning
  if (v.trick.length > 0 && followError(v.hand, scored[0].cs, v.trick[0].cards, v.level, v.trump)) {
    return basicRecommend(v);
  }
  return bestAction;
}
