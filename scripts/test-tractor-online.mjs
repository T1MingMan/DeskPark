import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { writeFile } from 'node:fs/promises';
import { engine } from './tractor-browser-helpers.mjs';
const base = process.env.DESKPARK_URL || 'http://127.0.0.1:8788';
const clients = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  for (let i = 0; i < 2000; i++) {
    if (fn()) return;
    await sleep(10);
  }
  throw Error('Timeout');
}
const send = (c, m) => c.ws.send(JSON.stringify(m));
try {
  for (let i = 0; i < 5; i++) {
    const c = { ws: new WebSocket(base.replace('http', 'ws') + '/ws'), messages: [], frames: [] };
    clients.push(c);
    c.ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      c.messages.push(m);
      if (m.t === 'game') {
        c.game = m;
        c.frames.push({ at: Date.now(), ...m });
      }
      if (m.t === 'room') c.room = m;
    });
    await until(() => c.ws.readyState === 1);
    send(c, {
      t: 'hello',
      token: 'tractor-rework-' + i + '-' + Date.now(),
      name: '测试' + i,
      v: 1,
    });
    await until(() => c.messages.some((m) => m.t === 'welcome'));
  }
  const host = clients[0];
  send(host, { t: 'create', gameId: 'tractor', options: { rounds: 0 }, seats: 4 });
  await until(() => host.room);
  const code = host.room.room.code;
  for (let i = 1; i < 5; i++) {
    send(clients[i], { t: 'join', code });
    await until(() => clients[i].room);
    if (i < 4) {
      send(clients[i], { t: 'sit', seat: i });
      await until(() => clients[i].room.you.seat === i);
    }
  }
  send(host, { t: 'start' });
  await until(() => clients.every((c) => c.game));
  assert.equal(clients[4].game.seat, null);
  assert.equal(host.game.view.phase, 'dealing');
  assert.equal(host.game.view.hand.length, 0);
  // Attempt an undealt card immediately: server must reject, not reveal its identity or take it from the future pile.
  send(host, { t: 'act', action: { type: 'reveal', cards: [107] } });
  await until(() => host.messages.some((m) => m.t === 'error'));
  const rejected = host.messages.filter((m) => m.t === 'error').pop();
  assert.match(rejected.message, /自己|手牌/);
  let actions = 0,
    tricks = 0,
    revealsDuringDeal = 0,
    overcalls = 0,
    sawBury = false,
    throwAttempts = 0,
    failedThrows = 0;
  while (host.game.view.phase !== 'roundOver' && actions < 600) {
    const version = host.game.version;
    await until(
      () => clients.every((c) => c.game.version === version) || host.game.version !== version,
    );
    if (host.game.version !== version) continue;
    const v = host.game.view;
    for (const c of clients) {
      const x = c.game.view;
      for (const hidden of ['hands', 'rng', 'drawPile']) assert.equal(hidden in x, false);
      if (c.game.seat === null) assert.equal(x.hand.length, 0);
      if (c.game.seat !== x.dealer && !['matchOver', 'roundOver'].includes(x.phase))
        assert.equal(x.kitty.length, 0);
    }
    const all = clients.slice(0, 4).flatMap((c) => c.game.view.hand.map((c) => c.id));
    assert.equal(new Set(all).size, all.length);
    if (v.phase === 'dealing' || v.phase === 'reveal') {
      let acted = false;
      for (let seat = 0; seat < 4; seat++) {
        const c = clients[seat];
        let a = engine.recommend(c.game.view);
        if (!v.bid) {
          const single = c.game.view.hand.find((x) => x.rank === v.level && x.suit !== 'J');
          a = single ? { type: 'reveal', cards: [single.id] } : { type: 'pass' };
        }
        if (a.type === 'reveal' || c.game.view.awaitingDeclaration) {
          const before = v.bid?.strength ?? 0;
          send(c, { t: 'act', action: a });
          await until(() => host.game.version > version);
          if (a.type === 'reveal' && v.phase === 'dealing') revealsDuringDeal++;
          if (a.type === 'reveal' && before > 0) overcalls++;
          actions++;
          acted = true;
          break;
        }
      }
      if (!acted) await until(() => host.game.version > version);
      continue;
    }
    if (v.phase === 'trickOver') {
      tricks++;
      await until(() => host.game.version > version);
      continue;
    }
    const seat = v.turn,
      c = clients[seat];
    let a = engine.recommend(c.game.view);
    if (v.phase === 'play' && !v.trick.length && throwAttempts < 4) {
      const hand = c.game.view.hand;
      const same = hand.filter(
        (x) =>
          engine.effective(x, v.level, v.trump) === engine.effective(hand[0], v.level, v.trump),
      );
      if (!engine.shape(same, v.level, v.trump)) {
        a = { type: 'play', cards: same.map((x) => x.id) };
        throwAttempts++;
      }
    }
    sawBury ||= a.type === 'bury';
    send(c, { t: 'act', action: a });
    await until(() => host.game.version > version);
    actions++;
    if (a.type === 'play' && !v.trick.length && host.game.view.throwFailure) {
      const f = host.game.view.throwFailure;
      failedThrows++;
      assert.equal(f.penalty, (a.cards.length - f.forced.length) * 10);
      assert.equal(
        host.game.view.points,
        v.points + f.penalty * (seat % 2 === v.dealer % 2 ? 1 : -1),
      );
      assert.equal(host.game.view.handCounts[seat], v.handCounts[seat] - f.forced.length);
    }
  }
  assert.equal(host.game.view.phase, 'roundOver');
  assert.equal(host.game.over, false);
  assert(sawBury);
  assert(revealsDuringDeal > 0);
  assert(throwAttempts > 0);
  assert(failedThrows > 0);
  const dealFrames = host.frames.filter((f) => f.view.phase === 'dealing');
  const counts = [...new Set(dealFrames.map((f) => f.view.hand.length))];
  assert.deepEqual(
    counts,
    Array.from({ length: 25 }, (_, i) => i),
  );
  const firstByCount = counts.map((n) => dealFrames.find((f) => f.view.hand.length === n).at);
  const deltas = firstByCount.slice(1).map((at, i) => at - firstByCount[i]);
  assert(
    deltas.every((n) => n >= 250),
    'actual server timed increments, not cosmetic client animation',
  );
  assert.equal(
    host.game.view.handCounts.reduce((a, b) => a + b, 0),
    0,
  );
  assert.equal(host.game.view.kitty.length, 8);
  const result = host.game.view.result;
  for (const c of clients.slice(0, 4)) send(c, { t: 'act', action: { type: 'continue' } });
  await until(() => clients.every((c) => c.game.view.round === 2));
  assert.equal(host.game.view.phase, 'dealing');
  const report = {
    base,
    actions,
    tricks,
    revealsDuringDeal,
    overcalls,
    sawBury,
    throwAttempts,
    failedThrows,
    progressiveCounts: counts,
    minimumTickMs: Math.min(...deltas),
    maximumTickMs: Math.max(...deltas),
    rejectedUndealt: rejected.message,
    hiddenViewsVerified: true,
    clients: 5,
    result,
    nextRound: host.game.view.round,
  };
  console.log(JSON.stringify(report, null, 2));
  await writeFile(
    'apps/web/tractor-evidence/rework-online-report.json',
    JSON.stringify(report, null, 2),
  );
} finally {
  for (const c of clients) {
    if (c.ws.readyState === 1) send(c, { t: 'leave' });
    c.ws.close();
  }
}
