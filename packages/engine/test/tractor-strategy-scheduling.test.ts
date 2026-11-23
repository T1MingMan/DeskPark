import { afterEach, it, expect, vi } from 'vitest';
import { Table } from '../src/core/table';
import { tractor } from '../src/games/tractor';
let table: Table | undefined;
afterEach(() => {
  table?.dispose();
  vi.useRealTimers();
});
it('strategic passes cannot livelock the final reveal timer while legal manual reveals remain enabled', async () => {
  vi.useFakeTimers();
  const t = new Table(
    tractor,
    Array.from({ length: 4 }, () => ({ name: 'bot', isBot: true, connected: true })),
    { rounds: 0 },
    { seed: 24 },
  );
  table = t;
  t.state = tractor.apply(tractor.apply(t.state, -1, { type: 'deal' }), -1, { type: 'deal' });
  t.state.phase = 'reveal';
  t.start();
  await vi.advanceTimersByTimeAsync(6000);
  expect(t.state.phase).not.toBe('reveal');
});
