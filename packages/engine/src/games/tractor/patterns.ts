import type { Card } from '../../core/cards';
// Pure combinatorics: no hidden state, clock, browser or Node dependency.
export type Ranking = (c: Card) => number;
const key = (c: Card) => `${c.suit}${c.rank}`;
export function identicalPairs(cards: Card[]): Card[][] {
  const groups = new Map<string, Card[]>();
  for (const c of cards) groups.set(key(c), [...(groups.get(key(c)) ?? []), c]);
  return [...groups.values()].filter((g) => g.length === 2);
}
export const compareVector = (a: number[], b: number[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
};
const without = (cards: Card[], used: Card[]) =>
  cards.filter((c) => !used.some((x) => x.id === c.id));
/** All exact adjacent-pair runs of a given length, including equal-rank alternatives. */
export function runs(ps: Card[][], n: number, rank: Ranking): Card[][] {
  const out: Card[][] = [];
  function visit(picked: Card[][]) {
    if (picked.length === n) {
      out.push(picked.flat());
      return;
    }
    const next = rank(picked[picked.length - 1][0]) + 1;
    for (const p of ps) if (rank(p[0]) === next) visit([...picked, p]);
  }
  for (const p of ps) visit([p]);
  return out;
}
/** Canonical decomposition: longest tractor first, weakest on ties, then pairs and singles. */
export function decompose(cards: Card[], rank: Ranking): Card[][] {
  let remaining = [...cards];
  const out: Card[][] = [];
  while (true) {
    const ps = identicalPairs(remaining);
    let found: Card[] | undefined;
    for (let n = ps.length; n >= 2; n--) {
      const candidates = runs(ps, n, rank).sort(
        (a, b) => rank(a[0]) - rank(b[0]) || key(a[0]).localeCompare(key(b[0])),
      );
      if (candidates.length) {
        found = candidates[0];
        break;
      }
    }
    if (!found) break;
    out.push(found);
    remaining = without(remaining, found);
  }
  for (const p of identicalPairs(remaining)) {
    out.push(p);
    remaining = without(remaining, p);
  }
  out.push(...remaining.map((c) => [c]));
  return out.sort((a, b) => b.length - a.length || rank(a[0]) - rank(b[0]) || a[0].id - b[0].id);
}
/** Exact structural obligation profile. Explore equal longest runs to avoid greedy tie errors. */
export function obligation(ps: Card[][], demands: number[], rank: Ranking): number[] {
  const memo = new Map<string, number[]>();
  function solve(available: Card[][], ds: number[]): number[] {
    if (!ds.length || !available.length) return [];
    const k =
      available
        .map((p) => p[0].id)
        .sort((a, b) => a - b)
        .join(',') +
      '|' +
      ds.join(',');
    const cached = memo.get(k);
    if (cached) return cached;
    const d = ds[0];
    let best: number[] = [];
    for (let n = Math.min(d, available.length); n >= 1; n--) {
      const candidates = n === 1 ? available : runs(available, n, rank);
      if (!candidates.length) continue;
      for (const run of candidates) {
        const rest = available.filter((p) => !run.some((c) => c.id === p[0].id));
        const tail = d - n > 0 ? [d - n, ...ds.slice(1)] : ds.slice(1);
        const profile = [n, ...solve(rest, tail)];
        if (compareVector(profile, best) > 0) best = profile;
      }
      break; // Shorter first chunk can never improve lexicographic obligation.
    }
    memo.set(k, best);
    return best;
  }
  return solve(ps, demands);
}
/** Returns the largest-component power of a complete matching cover, or null. */
export function coverPower(cards: Card[], parts: Card[][], rank: Ranking): number | null {
  const sizes = parts.map((p) => p.length).sort((a, b) => b - a);
  const memo = new Map<string, number | null>();
  function cover(remaining: Card[], i: number): number | null {
    const k =
      i +
      '|' +
      remaining
        .map((c) => c.id)
        .sort((a, b) => a - b)
        .join(',');
    if (memo.has(k)) return memo.get(k)!;
    if (i === sizes.length) return remaining.length === 0 ? -1 : null;
    const n = sizes[i];
    if (n === 1) return Math.max(...remaining.map(rank));
    const ps = identicalPairs(remaining);
    const candidates = n === 2 ? ps : runs(ps, n / 2, rank);
    let best: number | null = null;
    for (const x of candidates) {
      if (cover(without(remaining, x), i + 1) === null) continue;
      const value = Math.max(...x.map(rank));
      if (best === null || value > best) best = value;
    }
    memo.set(k, best);
    return best;
  }
  return cover(cards, 0);
}
