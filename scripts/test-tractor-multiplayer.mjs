import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import WebSocket from 'ws';
import { writeFile } from 'node:fs/promises';
import { engine, choose, layout } from './tractor-browser-helpers.mjs';
const base = process.env.DESKPARK_URL || 'http://127.0.0.1:8788';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  for (let i = 0; i < 2000; i++) {
    if (fn()) return;
    await sleep(10);
  }
  throw Error('Timeout');
}
const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
let room, game;
const errors = [];
const frames = [];
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.t === 'room') room = m;
  if (m.t === 'game') {
    game = m;
    frames.push(m);
  }
  if (m.t === 'error') errors.push(m.message);
});
const send = (m) => ws.send(JSON.stringify(m));
const browser = await chromium.launch();
try {
  await until(() => ws.readyState === 1);
  send({ t: 'hello', token: 'tractor-rework-host-' + Date.now(), name: '房主', v: 1 });
  send({ t: 'create', gameId: 'tractor', options: { rounds: 0 }, seats: 4 });
  await until(() => room);
  send({ t: 'bot', seat: 2, add: true });
  send({ t: 'bot', seat: 3, add: true });
  await until(() => room.room.seats[3].kind === 'bot');
  const pages = [],
    views = [],
    initialViews = [],
    contexts = [];
  for (let i = 0; i < 2; i++) {
    const context = await browser.newContext({
      viewport: i ? { width: 1024, height: 660 } : { width: 844, height: 390 },
    });
    contexts.push(context);
    const page = await context.newPage();
    pages.push(page);
    await page.addInitScript(() => {
      const Native = window.WebSocket;
      window.testSockets = [];
      window.WebSocket = class extends Native {
        constructor(...args) {
          super(...args);
          window.testSockets.push(this);
        }
      };
    });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('websocket', (socket) =>
      socket.on('framereceived', (frame) => {
        try {
          const m = JSON.parse(frame.payload);
          if (m.t === 'game') {
            initialViews[i] ??= m;
            views[i] = m;
          }
        } catch {
          /* ignore non-JSON control frames */
        }
      }),
    );
    await page.goto(base + '/#/room/' + room.room.code);
    await page.locator('.room__title').waitFor();
    if (i === 0) await until(() => room.room.seats[1].kind === 'human');
  }
  send({ t: 'start' });
  await until(() => game && views[0] && views[1]);
  assert.equal(views[0].seat, 1);
  assert.equal(views[1].seat, null);
  await pages[0].locator('.tractor').waitFor();
  assert.deepEqual(
    await pages[0]
      .locator('.tractor__compass [data-position]')
      .evaluateAll((es) =>
        Object.fromEntries(es.map((e) => [e.dataset.position, Number(e.dataset.seat)])),
      ),
    { top: 3, left: 0, right: 2, bottom: 1 },
  );
  const initial = initialViews[0].view.hand.length;
  assert.equal(initial, 0);
  let acted = 0,
    sawIntermediate = false,
    completedTricks = 0;
  while (game.view.round < 2) {
    const version = game.version;
    await until(() => views.every((v) => v.version === version) || game.version !== version);
    if (game.version !== version) continue;
    const v = game.view;
    for (const x of views) {
      assert(!('hands' in x.view));
      assert(!('drawPile' in x.view));
      assert(!('rng' in x.view));
      if (x.seat !== x.view.dealer && !['roundOver', 'matchOver'].includes(x.view.phase))
        assert.equal(x.view.kitty.length, 0);
    }
    assert.equal(views[1].view.hand.length, 0);
    assert(!views[0].view.hand.some((c) => game.view.hand.some((d) => c.id === d.id)));
    if (v.phase === 'trickOver') {
      completedTricks++;
      await until(() => game.version > version);
      continue;
    }
    if (v.phase === 'roundOver') {
      if (!v.ready.includes(0)) {
        send({ t: 'act', action: { type: 'continue' } });
        await until(() => game.version > version);
        continue;
      }
      if (!v.ready.includes(1)) {
        await pages[0].getByRole('button', { name: '准备下一局', exact: true }).click();
        acted++;
      }
      await until(() => game.version > version);
      continue;
    }
    if (['dealing', 'reveal'].includes(v.phase)) {
      if (views[0].view.hand.length > 0 && views[0].view.hand.length < 25) sawIntermediate = true;
      let done = false;
      for (const [seat, x] of [
        [0, game],
        [1, views[0]],
      ]) {
        const a = engine.recommend(x.view);
        if (a.type !== 'reveal' && !x.view.awaitingDeclaration) continue;
        if (seat === 0) send({ t: 'act', action: a.type === 'reveal' ? a : { type: 'pass' } });
        else if (a.type === 'reveal') {
          const card = x.view.hand.find((c) => c.id === a.cards[0]);
          await pages[0].locator(`.tractor__declarations button[data-suit="${card.suit}"]`).click();
          acted++;
        } else {
          const skip = pages[0].getByRole('button', { name: '暂不亮 / 继续发牌', exact: true });
          if (await skip.count()) await skip.click();
        }
        done = true;
        await until(() => game.version > version);
        break;
      }
      if (!done) await until(() => game.version > version);
      continue;
    }
    if (v.turn === 0) {
      send({ t: 'act', action: engine.recommend(v) });
      await until(() => game.version > version);
    } else if (v.turn === 1) {
      const a = engine.recommend(views[0].view);
      await choose(pages[0], a.cards);
      await pages[0]
        .getByRole('button', { name: v.phase === 'bury' ? '扣下8张' : '出牌', exact: true })
        .click();
      acted++;
      await until(() => game.version > version);
    } else await until(() => game.version > version);
  }
  assert(sawIntermediate);
  assert(completedTricks > 0);
  assert.equal(game.view.round, 2);
  assert(acted > 0);
  assert.deepEqual(errors, []);
  await layout(pages[0]);
  await layout(pages[1]);
  await pages[0].screenshot({ path: 'apps/web/tractor-evidence/rework-multiplayer-seat1.png' });
  await pages[1].screenshot({ path: 'apps/web/tractor-evidence/rework-multiplayer-spectator.png' });
  const report = {
    base,
    browserContexts: 2,
    seat: views[0].seat,
    spectatorHand: views[1].view.hand.length,
    sawIntermediate,
    acted,
    trickWinner: game.view.winner,
    completedTricks,
    nextRound: game.view.round,
    errors,
  };
  console.log(JSON.stringify(report, null, 2));
  await writeFile(
    'apps/web/tractor-evidence/rework-multiplayer-report.json',
    JSON.stringify(report, null, 2),
  );
  for (const page of pages)
    await page.evaluate(() => {
      for (const s of window.testSockets)
        if (s.readyState === 1) s.send(JSON.stringify({ t: 'leave' }));
    });
} finally {
  await browser.close();
  if (ws.readyState === 1) send({ t: 'leave' });
  ws.close();
}
