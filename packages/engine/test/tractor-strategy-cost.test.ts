import { it, expect } from 'vitest';
import { createDeck } from '../src/core/cards';
import { effective, bestPairs } from '../src/games/tractor';
it('bounds 33-card matching search without enumerating 16 choose 8 equivalent subsets', () => {
  const hand = createDeck(2)
    .filter((c) => effective(c, 2, 'S') === 'J')
    .slice(0, 33);
  const t = performance.now();
  for (let i = 0; i < 100; i++) bestPairs(hand, 8, 2, 'S', []);
  expect(performance.now() - t).toBeLessThan(20);
});
