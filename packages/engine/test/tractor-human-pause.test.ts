import { afterEach, expect, it, vi } from 'vitest';
import { Table } from '../src/core/table';
import { tractor } from '../src/games/tractor';

const tables: Table[] = [];
afterEach(() => {
  tables.forEach((t) => t.dispose());
  tables.length = 0;
  vi.useRealTimers();
});
function fixture(humans = [0]) {
  const t = new Table(
    tractor,
    Array.from({ length: 4 }, (_, i) => ({
      name: `P${i}`,
      isBot: !humans.includes(i),
      connected: true,
    })),
    { rounds: 0 },
    { seed: 24, humanTimeoutMs: 500 },
  );
  tables.push(t);
  t.state = tractor.apply(t.state, -1, { type: 'deal' });
  t.state = tractor.apply(t.state, -1, { type: 'deal' });
  return t;
}
it('freezes all bots and system timers until the active human explicitly skips', async () => {
  vi.useFakeTimers();
  const t = fixture();
  t.start();
  const before = JSON.stringify(t.state);
  await vi.advanceTimersByTimeAsync(8000);
  expect(JSON.stringify(t.state)).toBe(before);
  expect(t.act(-1, { type: 'deal' })).toMatch(/等待/);
  expect(t.act(0, { type: 'pass' })).toBeNull();
  await vi.advanceTimersByTimeAsync(1200);
  expect(t.version).toBeGreaterThan(1);
});
it('requires each human to confirm independently, and freezes the final reveal window', async () => {
  vi.useFakeTimers();
  const t = fixture([0, 1, 2]);
  t.start();
  expect(t.act(0, { type: 'pass' })).toBeNull();
  expect(t.act(1, { type: 'pass' })).toBeNull();
  const version = t.version;
  await vi.advanceTimersByTimeAsync(6000);
  expect(t.version).toBe(version);
  expect(t.view(2).awaitingDeclaration).toBe(true);
  expect(t.act(2, { type: 'pass' })).toBeNull();
  await vi.advanceTimersByTimeAsync(450);
  expect(t.state.dealt).toBe(3);
  t.stop();
  t.state = fixture([0, 1, 2]).state;
  t.state.phase = 'reveal';
  t.state.declarationAcknowledged = [[], [], [], []];
  t.start();
  const final = t.version;
  await vi.advanceTimersByTimeAsync(6000);
  expect(t.version).toBe(final);
});
it.each(['disconnect', 'autoplay'] as const)(
  '%s releases only that human and reconnect restores pending choice without stealing it',
  async (mode) => {
    vi.useFakeTimers();
    const t = fixture([0, 1]);
    t.start();
    if (mode === 'disconnect') t.setConnected(0, false);
    else t.setAuto(0, true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(t.version).toBe(0); // seat1 is still an active human with its own choice
    t.setConnected(0, true);
    t.setAuto(0, false);
    expect(t.view(0).awaitingDeclaration).toBe(true);
    t.act(1, { type: 'pass' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(t.state.dealt).toBe(2); // active human0 is never silently timed out
    if (mode === 'disconnect') t.setConnected(0, false);
    else t.setAuto(0, true);
    await vi.advanceTimersByTimeAsync(1200);
    expect(t.version).toBeGreaterThan(1);
  },
);
it('successful human reveal beats simultaneous bot offers, and acknowledges the existing opportunities', async () => {
  vi.useFakeTimers();
  const t = fixture();
  t.start();
  const o = t.view(0).declarations.find((o) => o.cards.length)!;
  expect(t.act(0, { type: 'reveal', cards: o.cards })).toBeNull();
  expect(t.state.bid?.seat).toBe(0);
  expect(t.view(0).awaitingDeclaration).toBe(false);
  await vi.advanceTimersByTimeAsync(3000);
  expect(t.state.dealt).toBeGreaterThan(2);
});
it('skipped tokens do not repause but a new suit or stronger pair pauses again', () => {
  const t = fixture();
  t.act(0, { type: 'pass' });
  expect(t.view(0).awaitingDeclaration).toBe(false);
  t.state.hands[0].push({ id: 200, suit: 'S', rank: 2 });
  expect(t.view(0).awaitingDeclaration).toBe(true);
  t.act(0, { type: 'pass' });
  expect(t.view(0).awaitingDeclaration).toBe(false);
  t.state.hands[0].push({ id: 201, suit: 'S', rank: 2 });
  expect(t.view(0).awaitingDeclaration).toBe(true);
  expect(t.view(0).declarations.find((o) => o.suit === 'S')?.cards).toHaveLength(2);
});
it('acknowledgements and opponents candidates are never leaked, including to spectators', () => {
  const t = fixture();
  for (const seat of [0, 1, 2, 3, null]) {
    const v = t.view(seat);
    for (const key of ['hands', 'rng', 'drawPile', 'declarationAcknowledged'])
      expect(key in v).toBe(false);
    expect(v.declarations.map((o) => o.suit)).toEqual(['S', 'H', 'C', 'D', 'J']);
    for (const o of v.declarations)
      for (const id of o.cards) expect(v.hand.some((c) => c.id === id)).toBe(true);
    if (seat === null) {
      expect(v.awaitingDeclaration).toBe(false);
      expect(v.declarations.every((o) => !o.cards.length)).toBe(true);
    }
  }
  const own = t.view(0);
  t.state.hands[1] = t.state.hands[1].map((c) => ({ ...c, rank: 17, suit: 'J' }));
  expect(t.view(0)).toEqual(own);
});
it('skip is not a permanent withdrawal: still-visible legal declarations remain actionable', () => {
  const t = fixture();
  t.act(0, { type: 'pass' });
  const offer = t.view(0).declarations.find((o) => o.cards.length)!;
  expect(t.act(0, { type: 'reveal', cards: offer.cards })).toBeNull();
});
it.each(['disconnect', 'autoplay'] as const)(
  'last pending human %s resumes actual dealing, not only a bot action',
  async (mode) => {
    vi.useFakeTimers();
    const t = fixture();
    t.start();
    if (mode === 'disconnect') t.setConnected(0, false);
    else t.setAuto(0, true);
    await vi.advanceTimersByTimeAsync(6000);
    expect(t.state.dealt).toBeGreaterThan(2);
  },
);
it('all five choices expose only validated actions over a progressive deal', () => {
  for (const seed of [10, 24, 79, 200]) {
    let s = tractor.setup({
      seed,
      options: { rounds: 0 },
      players: Array.from({ length: 4 }, () => ({ name: 'P', isBot: false })),
    });
    for (let i = 0; i <= 25; i++) {
      for (let seat = 0; seat < 4; seat++)
        for (const o of tractor.view(s, seat).declarations) {
          if (o.cards.length)
            expect(tractor.validate(s, seat, { type: 'reveal', cards: o.cards })).toBeNull();
        }
      if (i < 25) s = tractor.apply(s, -1, { type: 'deal' });
    }
  }
});
it('the shared deal cadence is deliberate, not cosmetic animation', () => {
  const t = fixture();
  expect(tractor.autoAdvance!(t.state)?.delayMs).toBe(450);
});
it('a pending asynchronous bot decision is cancelled when a new human opportunity arrives', async () => {
  vi.useFakeTimers();
  let cancelled = false;
  let resolve!: (a: unknown) => void;
  const state = fixture().state;
  const fresh = tractor.setup({
    seed: 24,
    options: { rounds: 0 },
    players: Array.from({ length: 4 }, (_, i) => ({ name: `P${i}`, isBot: i !== 0 })),
  });
  // Isolate delegate cancellation from the now-faster progressive deal timer.
  fresh.phase = 'reveal';
  const t = new Table(
    tractor,
    Array.from({ length: 4 }, (_, i) => ({ name: `P${i}`, isBot: i !== 0 })),
    { rounds: 0 },
    {
      initialState: fresh,
      delegate: (_, ctx) => {
        ctx.onCancel(() => {
          cancelled = true;
        });
        return new Promise((r) => {
          resolve = r;
        });
      },
    },
  );
  tables.push(t);
  t.start();
  await vi.advanceTimersByTimeAsync(900);
  expect(t.thinking.length).toBeGreaterThan(0);
  t.state = state;
  t.setConnected(0, true); // reschedule using the runtime's real connection boundary
  expect(cancelled).toBe(true);
  expect(t.thinking).toEqual([]);
  resolve({ type: 'pass' });
  await vi.advanceTimersByTimeAsync(4000);
  expect(t.version).toBe(0);
});
