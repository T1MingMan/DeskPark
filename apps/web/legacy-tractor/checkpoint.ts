import { createDeck, type Card } from '../../../packages/engine/src/core/cards';
import type { TractorState, TractorView } from '../../../packages/engine/src/games/tractor';

export interface Checkpoint {
  format: string;
  version: number;
  state: TractorState;
  rng: number;
  acknowledged: string[];
  acknowledgedRound: number;
  publicReveals: NonNullable<TractorView['bid']>[];
}
const integer = (n: number, min: number, max: number) =>
  Number.isInteger(n) && n >= min && n <= max;
const seat = (n: number) => integer(n, 0, 3);
const uint = (n: number) => integer(n, 0, 0xffffffff);
const token = (s: string) => typeof s === 'string' && /^[SHCDJ]:(?:[2-9]|1[0-7]):[12]$/.test(s);
const deck = createDeck(2);
const cards = (cs: Card[]) =>
  Array.isArray(cs) &&
  cs.length <= 108 &&
  cs.every(
    (c) => c && integer(c.id, 0, 107) && deck[c.id].suit === c.suit && deck[c.id].rank === c.rank,
  ) &&
  new Set(cs.map((c) => c.id)).size === cs.length;
const plays = (ps: TractorState['trick']) =>
  Array.isArray(ps) &&
  ps.length <= 4 &&
  ps.every((p) => p && seat(p.seat) && cards(p.cards) && p.cards.length > 0);

/** Reject incompatible/corrupt local data before it can reach engine automation. */
export function parseCheckpoint(text: string): Checkpoint {
  if (text.length > 500000) throw new Error('存档过大');
  const c: Checkpoint = JSON.parse(text);
  const s = c?.state;
  if (
    !c ||
    c.format !== 'deskpark-legacy-tractor' ||
    c.version !== 1 ||
    !s ||
    !uint(c.rng) ||
    !uint(s.rng) ||
    !integer(s.round, 1, Number.MAX_SAFE_INTEGER) ||
    !integer(c.acknowledgedRound, 1, s.round) ||
    !Array.isArray(c.acknowledged) ||
    !c.acknowledged.every(token) ||
    !['dealing', 'reveal', 'bury', 'play', 'trickOver', 'roundOver', 'matchOver'].includes(
      s.phase,
    ) ||
    !s.options ||
    s.options.rounds !== 0 ||
    !seat(s.turn) ||
    !seat(s.dealer) ||
    !seat(s.winner) ||
    !Array.isArray(s.levels) ||
    s.levels.length !== 2 ||
    !s.levels.every((n) => integer(n, 2, 14)) ||
    !integer(s.level, 2, 14) ||
    !['S', 'H', 'C', 'D', 'J'].includes(s.trump) ||
    !integer(s.dealt, 0, 25) ||
    !Number.isFinite(s.points) ||
    !integer(s.passes, 0, 4) ||
    typeof s.result !== 'string' ||
    !Array.isArray(s.ready) ||
    !s.ready.every(seat) ||
    new Set(s.ready).size !== s.ready.length ||
    !Array.isArray(s.hands) ||
    s.hands.length !== 4 ||
    !s.hands.every(cards) ||
    !cards(s.drawPile) ||
    !cards(s.kitty) ||
    !plays(s.trick) ||
    !plays(s.lastTrick) ||
    !Array.isArray(s.playedHistory) ||
    !s.playedHistory.every(plays) ||
    !Array.isArray(s.declarationHistory) ||
    !s.declarationHistory.every((p) => plays([p])) ||
    !Array.isArray(s.publicReveals) ||
    !s.publicReveals.every((p) => plays([p])) ||
    !Array.isArray(s.declarationAcknowledged) ||
    s.declarationAcknowledged.length !== 4 ||
    !s.declarationAcknowledged.every((a) => Array.isArray(a) && a.every(token)) ||
    !Array.isArray(c.publicReveals) ||
    !c.publicReveals.every((b) => plays([b]) && integer(b.strength, 1, 4)) ||
    (s.bid !== null && (!s.bid || !plays([s.bid]) || !integer(s.bid.strength, 1, 4))) ||
    (s.throwFailure !== null &&
      (!s.throwFailure ||
        !seat(s.throwFailure.seat) ||
        !seat(s.throwFailure.challenger) ||
        !cards(s.throwFailure.attempted) ||
        !cards(s.throwFailure.forced) ||
        !Number.isFinite(s.throwFailure.penalty)))
  )
    throw new Error('存档损坏或版本不支持');
  // A completed current trick is already in playedHistory; all physical cards occur exactly once.
  const owned = [
    ...s.drawPile,
    ...s.kitty,
    ...s.hands.flat(),
    ...s.playedHistory.flatMap((t) => t.flatMap((p) => p.cards)),
    ...(s.phase === 'play' ? s.trick.flatMap((p) => p.cards) : []),
  ];
  if (owned.length !== 108 || new Set(owned.map((card) => card.id)).size !== 108)
    throw new Error('存档牌张不完整');
  return c;
}
