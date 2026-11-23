import { describe, it, expect } from 'vitest';
import { tractor } from '../../../packages/engine/src/games/tractor';
import { SafeTractorReplay } from '../src/games/tractor/replay';
const players = Array.from({ length: 4 }, () => ({ name: 'bot', isBot: true }));
describe('safe partial replay', () => {
  it('whitelists own/public evidence, not state extras or bot-private rationale, and labels partial', () => {
    const s = tractor.setup({ players, options: { rounds: 1 }, seed: 7 });
    s.hands[0] = [{ id: 0, suit: 'S', rank: 2 }];
    const v = tractor.view(s, 0);
    const recorder = new SafeTractorReplay();
    recorder.observe(
      Object.assign(v, {
        hands: 'PRIVATE_HANDS',
        rng: 'SECRET_SEED',
        drawPile: 'SECRET_DECK',
        botReason: 'PRIVATE_REASON',
      }),
    );
    const text = recorder.json();
    const r = JSON.parse(text);
    expect(text).not.toMatch(/PRIVATE|SECRET|"hands"|"rng"|"drawPile"|botReason/);
    expect(r.schema).toBe('deskpark.tractor.public-replay.v2');
    expect(r.visibility).toContain('partial');
    expect(r.strategyVersion).toBe('adaptive-v2');
    expect(r.steps[0].ownHand).toEqual(v.hand);
    expect(r.steps[0].seat).toBe(0);
  });
  it('captures public completed actions and failed-throw evidence without foreign metadata', () => {
    const s = tractor.setup({ players, options: { rounds: 0 }, seed: 7 });
    const cs = [{ id: 4, suit: 'S' as const, rank: 6 }];
    s.playedHistory = [[{ seat: 1, cards: cs }]];
    s.throwFailure = { seat: 1, challenger: 2, attempted: cs, forced: cs, penalty: 10 };
    const recorder = new SafeTractorReplay();
    recorder.observe(tractor.view(s, 0));
    const data = JSON.parse(recorder.json());
    expect(data.publicActions).toEqual(s.playedHistory);
    expect(data.steps[0].throwFailure).toEqual(s.throwFailure);
  });
  it('resets when a new local game restarts at the same round and seat', () => {
    const s = tractor.setup({ players, options: { rounds: 0 }, seed: 7 });
    const recorder = new SafeTractorReplay();
    s.dealt = 10;
    recorder.observe(tractor.view(s, 0));
    s.dealt = 0;
    recorder.observe(tractor.view(s, 0));
    expect(JSON.parse(recorder.json()).steps).toHaveLength(1);
  });
  it('resets on round/seat change, deduplicates, caps bytes, snapshots without references', () => {
    const s = tractor.setup({ players, options: { rounds: 0 }, seed: 7 });
    const recorder = new SafeTractorReplay();
    const v = tractor.view(s, 0);
    recorder.observe(v);
    recorder.observe(v);
    expect(JSON.parse(recorder.json()).steps).toHaveLength(1);
    for (let i = 0; i < 900; i++) {
      v.points = i;
      recorder.observe(v);
    }
    expect(new TextEncoder().encode(recorder.json()).length).toBeLessThanOrEqual(524288);
    expect(JSON.parse(recorder.json()).truncated).toBe(true);
    v.round++;
    v.points = 0;
    recorder.observe(v);
    expect(JSON.parse(recorder.json()).steps).toHaveLength(1);
    v.round++;
    expect(JSON.parse(recorder.json()).round).toBe(v.round - 1);
    v.seat = 1;
    recorder.observe(v);
    expect(JSON.parse(recorder.json()).seat).toBe(1);
    expect(JSON.parse(recorder.json()).steps).toHaveLength(1);
  });
});
