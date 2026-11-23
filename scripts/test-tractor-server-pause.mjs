import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { writeFile } from 'node:fs/promises';
const base = process.env.DESKPARK_URL || 'http://127.0.0.1:8788';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, limit = 12000) {
  const end = Date.now() + limit;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(10);
  }
  throw Error('WS condition timed out');
}
const all = [];
async function connect(token) {
  const c = { token, ws: new WebSocket(base.replace('http', 'ws') + '/ws'), errors: [] };
  all.push(c);
  c.ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.t === 'game') c.game = m;
    if (m.t === 'room') c.room = m;
    if (m.t === 'welcome') c.welcome = m;
    if (m.t === 'error') c.errors.push(m);
  });
  await until(() => c.ws.readyState === 1);
  send(c, { t: 'hello', v: 1, token, name: '暂停测试' });
  await until(() => c.welcome);
  return c;
}
function send(c, m) {
  c.ws.send(JSON.stringify(m));
}
const results = [];
try {
  for (const mode of ['autoplay', 'disconnect']) {
    const token = 'pause-' + Date.now() + '-' + mode;
    const host = await connect(token + '0');
    send(host, { t: 'create', gameId: 'tractor', options: { rounds: 0 }, seats: 4 });
    await until(() => host.room);
    const players = [host];
    for (let i = 1; i < 4; i++) {
      const c = await connect(token + i);
      players.push(c);
      send(c, { t: 'join', code: host.room.room.code });
      await until(() => c.room);
      send(c, { t: 'sit', seat: i });
      await until(() => c.room.you.seat === i);
    }
    const spectator = await connect(token + 'spectator');
    send(spectator, { t: 'join', code: host.room.room.code });
    await until(() => spectator.room);
    send(host, { t: 'start' });
    await until(() => players.every((c) => c.game) && spectator.game);
    await until(() => players.some((c) => c.game.view.awaitingDeclaration), 40000);
    const holder = players.find((c) => c.game.view.awaitingDeclaration);
    const observer = players.find((c) => c !== holder);
    // Convert two other seats to real rule bots using the ordinary leave-room transition.
    for (const c of players.filter((c) => c !== holder && c !== observer)) {
      send(c, { t: 'leave' });
      c.ws.close();
    }
    await until(() => observer.room.room.seats.filter((s) => s.kind === 'bot').length === 2);
    await sleep(100);
    const snapshot = JSON.stringify(observer.game);
    await sleep(3500);
    assert.equal(
      JSON.stringify(observer.game),
      snapshot,
      'server freezes ALL timers and bots, not merely browser animation',
    );
    for (const c of [holder, observer, spectator]) {
      const v = c.game.view;
      for (const key of ['hands', 'rng', 'drawPile', 'declarationAcknowledged'])
        assert(!(key in v));
      assert(v.declarations.every((o) => o.cards.every((id) => v.hand.some((c) => c.id === id))));
    }
    assert.equal(spectator.game.seat, null);
    assert.equal(spectator.game.view.awaitingDeclaration, false);
    assert.equal(spectator.game.view.hand.length, 0);
    if (observer.game.view.awaitingDeclaration) {
      const before = observer.game.version;
      send(observer, { t: 'act', action: { type: 'pass' } });
      await until(() => observer.game.version > before);
    }
    const version = observer.game.version;
    await sleep(1500);
    assert.equal(observer.game.version, version, 'one human cannot confirm another human');
    let rejoined = null;
    if (mode === 'autoplay') {
      send(holder, { t: 'auto', on: true });
      await until(() => observer.game.version > version);
      send(holder, { t: 'auto', on: false });
    } else {
      holder.ws.close();
      await until(() => observer.game.version > version);
      rejoined = await connect(holder.token);
      await until(() => rejoined.game && rejoined.room);
      if (rejoined.game.view.awaitingDeclaration) {
        const restored = observer.game.version;
        await sleep(3500);
        assert.equal(
          observer.game.version,
          restored,
          'reconnected active human retains their decision',
        );
      }
    }
    results.push({
      mode,
      holdMs: 3500,
      perSeatHoldMs: 1500,
      versionBefore: version,
      versionAfter: observer.game.version,
      botSystemFreeze: true,
      privacy: true,
      rejoined: !!rejoined,
    });
    for (const c of [holder, observer, spectator, rejoined].filter(Boolean))
      if (c.ws.readyState === 1) {
        send(c, { t: 'leave' });
        c.ws.close();
      }
    await sleep(200);
  }
  console.log(JSON.stringify({ base, results }, null, 2));
  await writeFile(
    'apps/web/tractor-evidence/polish-server-pause-report.json',
    JSON.stringify({ base, results }, null, 2),
  );
} finally {
  for (const c of all)
    if (c.ws.readyState === 1) {
      send(c, { t: 'leave' });
      c.ws.close();
    }
}
