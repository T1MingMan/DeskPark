import { tr } from '@park/engine';
import { PROTOCOL_VERSION } from '@park/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startServer } from '../src/server';

let server: ReturnType<typeof startServer>;
let baseUrl = '';
let wsUrl = '';

beforeAll(async () => {
  server = startServer({
    port: 0,
    host: '127.0.0.1',
    staticDir: null,
    config: { turnTimeoutMs: 5000 },
  });
  const port = await server.ready;
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});

afterAll(async () => {
  await server.close();
});

describe('Mac mini /api/bot/decide endpoint & Worker pool', () => {
  it('computes legal play and bury decisions in worker pool from redacted view only', async () => {
    const players = Array.from({ length: 4 }, () => ({ name: 'bot', isBot: true }));
    let s = tr.tractor.setup({ players, options: { rounds: 1 }, seed: 29 });
    while (s.phase === 'dealing') s = tr.tractor.apply(s, -1, { type: 'deal' });
    s = tr.tractor.apply(s, -1, { type: 'closeReveal' });

    // 1. Bury decision via HTTP
    const burySeat = s.turn;
    const buryView = tr.tractor.view(s, burySeat);
    const buryRes = await fetch(`${baseUrl}/api/bot/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        gameId: 'tractor',
        view: { ...buryView, hands: 'SHOULD_BE_STRIPPED', rng: 12345 },
        budgetMs: 120,
        version: 7,
      }),
    });
    expect(buryRes.status).toBe(200);
    const buryJson = (await buryRes.json()) as {
      ok: boolean;
      action: tr.TractorAction;
      version: number;
      fallback: boolean;
    };
    expect(buryJson.ok).toBe(true);
    expect(buryJson.version).toBe(7);
    expect(buryJson.fallback).toBe(false);
    expect(tr.tractor.validate(s, burySeat, buryJson.action)).toBeNull();

    // 2. Play decision via HTTP
    s = tr.tractor.apply(s, burySeat, buryJson.action);
    const playSeat = s.turn;
    const playView = tr.tractor.view(s, playSeat);
    const playRes = await fetch(`${baseUrl}/api/bot/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        gameId: 'tractor',
        view: playView,
        budgetMs: 150,
        version: 8,
      }),
    });
    expect(playRes.status).toBe(200);
    const playJson = (await playRes.json()) as {
      ok: boolean;
      action: tr.TractorAction;
      fallback: boolean;
    };
    expect(playJson.ok).toBe(true);
    expect(playJson.fallback).toBe(false);
    expect(tr.tractor.validate(s, playSeat, playJson.action)).toBeNull();
  });

  it('rejects cross-site origins, wrong HTTP methods, and unsupported games', async () => {
    const getRes = await fetch(`${baseUrl}/api/bot/decide`);
    expect(getRes.status).toBe(405);

    const crossOrigin = await fetch(`${baseUrl}/api/bot/decide`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example.com',
      },
      body: JSON.stringify({ gameId: 'tractor', view: {} }),
    });
    expect(crossOrigin.status).toBe(403);

    const badGame = await fetch(`${baseUrl}/api/bot/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gameId: 'unknown', view: {} }),
    });
    expect(badGame.status).toBe(400);
  });

  it('drives online tractor room bots via worker delegate while respecting human pause', async () => {
    const ws = new WebSocket(wsUrl);
    const messages: Record<string, unknown>[] = [];
    await new Promise<void>((r) => ws.once('open', () => r()));
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));

    ws.send(
      JSON.stringify({
        t: 'hello',
        token: 'token-tractor-worker-test',
        name: '真人玩家',
        v: PROTOCOL_VERSION,
      }),
    );
    await new Promise((r) => setTimeout(r, 60));
    ws.send(JSON.stringify({ t: 'create', gameId: 'tractor', options: { rounds: 1 } }));
    await new Promise((r) => setTimeout(r, 60));
    ws.send(JSON.stringify({ t: 'start' }));

    // Wait briefly to verify dealing advances or pauses cleanly on human declaration without error
    await new Promise((r) => setTimeout(r, 1200));
    const gameMsgs = messages.filter((m) => m.t === 'game');
    expect(gameMsgs.length).toBeGreaterThanOrEqual(2);
    const errorMsgs = messages.filter((m) => m.t === 'error');
    expect(errorMsgs).toEqual([]);
    ws.close();
  });
});
