import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { writeFile } from 'node:fs/promises';
const base = process.env.DESKPARK_URL || 'http://127.0.0.1:8788';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  for (let i = 0; i < 4000; i++) {
    if (fn()) return;
    await sleep(5);
  }
  throw Error('WS timeout');
}
const all = [];
const send = (c, m) => c.ws.send(JSON.stringify(m));
async function connect(token) {
  const c = { token, ws: new WebSocket(base.replace('http', 'ws') + '/ws') };
  all.push(c);
  c.ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.t === 'game') c.game = m;
    if (m.t === 'room') c.room = m;
    if (m.t === 'welcome') c.welcome = m;
  });
  await until(() => c.ws.readyState === 1);
  send(c, { t: 'hello', v: 1, token, name: '公开亮牌回归' });
  await until(() => c.welcome);
  return c;
}
const results = [];
try {
  for (let attempt = 0; attempt < 4; attempt++) {
    const token = 'public-' + Date.now();
    const host = await connect(token + '0');
    send(host, { t: 'create', gameId: 'tractor', options: { rounds: 0 }, seats: 4 });
    await until(() => host.room);
    const ps = [host];
    for (let i = 1; i < 4; i++) {
      const c = await connect(token + i);
      ps.push(c);
      send(c, { t: 'join', code: host.room.room.code });
      await until(() => c.room);
      send(c, { t: 'sit', seat: i });
      await until(() => c.room.you.seat === i);
    }
    send(host, { t: 'start' });
    await until(() => ps.every((c) => c.game));
    let history = [],
      late = null,
      reconnected = false;
    while (['dealing', 'reveal'].includes(host.game.view.phase)) {
      const version = host.game.version;
      await until(
        () => ps.every((c) => c.game.version === version) || host.game.version !== version,
      );
      if (host.game.version !== version) continue;
      const v = host.game.view;
      for (const c of ps) {
        for (const k of ['hands', 'rng', 'drawPile', 'declarationAcknowledged'])
          assert(!(k in c.game.view));
        assert.deepEqual(c.game.view.declarationHistory, history);
      }
      let acted = false;
      for (let seat = 0; seat < 4; seat++) {
        const c = ps[seat],
          x = c.game.view;
        const single = !v.bid && x.hand.find((c) => c.rank === v.level && c.suit !== 'J');
        const ids = single ? [single.id] : x.declarations.find((o) => o.cards.length)?.cards;
        if (ids) {
          const cards = x.hand.filter((c) => ids.includes(c.id));
          send(c, { t: 'act', action: { type: 'reveal', cards: ids } });
          await until(() => host.game.version > version);
          history.push({ seat, cards });
          assert.deepEqual(host.game.view.declarationHistory, history);
          acted = true;
          if (!late) {
            late = await connect(token + 'late');
            send(late, { t: 'join', code: host.room.room.code });
            await until(() => late.game);
            assert.deepEqual(late.game.view.declarationHistory, history);
            assert.deepEqual(late.game.view.hand, []);
            assert.deepEqual(late.game.view.kitty, []);
            late.ws.close();
            late = await connect(token + 'late');
            await until(() => late.game);
            assert.deepEqual(late.game.view.declarationHistory, history);
            reconnected = true;
          } else if (history.length > 1) {
            late.ws.close();
            late = await connect(token + 'late');
            await until(() => late.game);
            assert.deepEqual(
              late.game.view.declarationHistory,
              history,
              'reconnect retains all overcalls, not merely the final bid',
            );
          }
          break;
        }
      }
      if (!acted) {
        const c = ps.find((c) => c.game.view.awaitingDeclaration);
        if (c) {
          send(c, { t: 'act', action: { type: 'pass' } });
          await until(() => host.game.version > version);
        } else await until(() => host.game.version > version);
      }
    }
    await until(() => ps.every((c) => c.game.view.phase === 'bury'));
    for (const c of [...ps, late].filter(Boolean))
      assert.deepEqual(c.game.view.declarationHistory, []);
    results.push({
      attempt,
      announcements: history,
      overcalls: Math.max(0, history.length - 1),
      lateJoin: !!late,
      reconnected,
      clearedAtBury: true,
    });
    for (const c of [...ps, late].filter(Boolean)) {
      send(c, { t: 'leave' });
      c.ws.close();
    }
    if (history.length > 1) break;
  }
  assert(
    results.some((r) => r.overcalls > 0),
    'observe actual overcall',
  );
  await writeFile(
    'apps/web/tractor-evidence/refinements-modern/ws-public-history.json',
    JSON.stringify({ base, results }, null, 2),
  );
  console.log(JSON.stringify({ base, results }, null, 2));
} finally {
  for (const c of all)
    if (c.ws.readyState === 1) {
      send(c, { t: 'leave' });
      c.ws.close();
    }
}
