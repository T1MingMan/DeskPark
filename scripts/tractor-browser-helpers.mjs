import assert from 'node:assert/strict';
import { build } from 'esbuild';
const compiled = await build({
  entryPoints: ['packages/engine/src/games/tractor/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
export const engine = await import(
  'data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64')
);
/** Read only cards and labels actually rendered, never React internals or private host state. */
export async function visibleView(page, legacy = false) {
  return page.evaluate((legacy) => {
    const table = document.querySelector(legacy ? '[data-phase]' : '.tractor');
    if (!table) return null;
    const card = (e) => ({
      id: Number(e.dataset.cid),
      rank: Number(e.dataset.rank),
      suit: e.dataset.suit,
    });
    const hand = [
      ...document.querySelectorAll(legacy ? '.hand button' : '.tractor__hand button'),
    ].map(card);
    const trick = [...document.querySelectorAll('[data-order]')]
      .filter((e) => Number(e.dataset.order) >= 0)
      .sort((a, b) => Number(a.dataset.order) - Number(b.dataset.order))
      .map((e) => ({
        seat: Number(e.dataset.seat),
        cards: [...e.querySelectorAll('[data-cid]')].map(card),
      }));
    return {
      phase: table.dataset.phase,
      paused: table.dataset.paused === 'true',
      markedWinner: legacy
        ? Number(document.querySelector('.compass [data-winning="true"]')?.dataset.seat ?? -1)
        : Number(
            document.querySelector('.tractor__compass [data-winning="true"]')?.dataset.seat ?? -1,
          ),
      round: Number(table.dataset.round),
      turn: Number(table.dataset.turn),
      level: Number(table.dataset.level),
      trump: table.dataset.trump,
      dealer: Number(table.dataset.dealer),
      hand,
      kitty: [],
      handCounts: [hand.length, hand.length, hand.length, hand.length],
      trick,
      bid: { strength: 4 },
      seat: 0,
      throwFailure: null,
    };
  }, legacy);
}
export async function choose(page, ids, legacy = false) {
  const selector = legacy ? '.hand button' : '.tractor__hand button';
  for (const e of await page.locator(selector + '[aria-pressed="true"]').all()) await e.click();
  for (const id of ids) await page.locator(selector + `[data-cid="${id}"]`).click();
}
export async function layout(page, legacy = false) {
  const report = await page.evaluate((legacy) => {
    const sels = legacy
      ? ['.table-info', '.arena', '.status', '.actions', '.self', '.hand']
      : ['.tractor__info', '.tractor__score', '.tractor__arena', '.tractor__dock'];
    const bounds = sels
      .map((s) => {
        const e = document.querySelector(s);
        if (!e || !e.getClientRects().length) return null;
        const r = e.getBoundingClientRect();
        return { s, top: r.top, bottom: r.bottom, left: r.left, right: r.right };
      })
      .filter(Boolean);
    const cards = [
      ...document.querySelectorAll(legacy ? '.hand button' : '.tractor__hand button'),
    ].map((e) => {
      const r = e.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        w: r.width,
        h: r.height,
      };
    });
    const collisions = [];
    for (let i = 1; i < bounds.length; i++)
      if (bounds[i].top < bounds[i - 1].bottom - 1) collisions.push([bounds[i - 1].s, bounds[i].s]);
    let cardCollisions = 0;
    for (let i = 0; i < cards.length; i++)
      for (let j = i + 1; j < cards.length; j++) {
        const a = cards[i],
          b = cards[j];
        if (
          Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
        )
          cardCollisions++;
      }
    const clips = cards.filter((c) => c.left < 0 || c.right > innerWidth + 1);
    const compass = [
      ...document.querySelectorAll('.compass .play, .tractor__compass .tractor__seat'),
    ].map((e) => e.getBoundingClientRect());
    const compassCollisions = [];
    for (let i = 0; i < compass.length; i++)
      for (let j = i + 1; j < compass.length; j++) {
        const a = compass[i],
          b = compass[j];
        if (
          Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
        )
          compassCollisions.push([i, j]);
      }
    const seatContentOverflow = [...document.querySelectorAll('.tractor__compass .tractor__seat')]
      .filter(
        (e) =>
          e.querySelector('.tractor__played-cards').getBoundingClientRect().bottom >
          e.getBoundingClientRect().bottom + 1,
      )
      .map((e) => e.dataset.seat);
    const legacyPlayGeometry = [...document.querySelectorAll('.compass .play')].map((e) => {
      const seat = e.getBoundingClientRect(),
        area = e.querySelector('.play-cards').getBoundingClientRect();
      return {
        seat: e.dataset.seat,
        contained:
          area.bottom <= seat.bottom + 1 && area.left >= seat.left && area.right <= seat.right + 1,
        areaHeight: area.height,
        cards: [...e.querySelectorAll('.pcard')].map((c) => {
          const r = c.getBoundingClientRect();
          return { width: r.width, height: r.height };
        }),
      };
    });
    const modernPlayGeometry = [...document.querySelectorAll('.tractor__seat')].map((e) => {
      const r = e.getBoundingClientRect(),
        a = e.querySelector('.tractor__played-cards').getBoundingClientRect();
      return {
        seat: e.dataset.seat,
        contained:
          a.top >= r.top && a.bottom <= r.bottom + 1 && a.left >= r.left && a.right <= r.right + 1,
        areaHeight: a.height,
        cards: [...e.querySelectorAll('.pcard')].map((c) => {
          const b = c.getBoundingClientRect();
          return { width: b.width, height: b.height };
        }),
      };
    });
    return {
      modernPlayGeometry,
      legacyPlayGeometry,
      minimumHandTarget: cards.length
        ? { width: Math.min(...cards.map((c) => c.w)), height: Math.min(...cards.map((c) => c.h)) }
        : null,
      seatContentOverflow,
      activeSeatCount: document.querySelectorAll('.tractor__compass .is-active').length,
      shouldHaveActiveSeat: ['bury', 'play'].includes(
        document.querySelector('.tractor')?.dataset.phase,
      ),
      compassCollisions,
      compass: compass.map((r) => ({ top: r.top, bottom: r.bottom, height: r.height })),
      handDocumentBottom: cards.length ? Math.max(...cards.map((c) => c.bottom)) + scrollY : 0,
      bounds,
      cards: cards.length,
      collisions,
      cardCollisions,
      clips,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      scrollHeight: document.documentElement.scrollHeight,
      viewport: innerHeight,
    };
  }, legacy);
  assert.deepEqual(report.collisions, [], 'nonoverlapping phase bands');
  if (!legacy) {
    assert(
      report.modernPlayGeometry.every(
        (s) =>
          s.contained &&
          s.areaHeight >= 72 &&
          s.cards.every((c) => c.width >= 50 && c.height >= 70),
      ),
      'large modern cards and area inside owner borders',
    );
    if (report.minimumHandTarget)
      assert(
        report.minimumHandTarget.width >= 44 && report.minimumHandTarget.height >= 44,
        'all hand targets at least44px',
      );
  }
  if (legacy) {
    assert(
      report.legacyPlayGeometry.every((s) => s.contained && s.areaHeight >= 70),
      'large play area contained in attributed seat',
    );
    assert(
      report.legacyPlayGeometry.every((s) => s.cards.every((c) => c.width >= 50 && c.height >= 70)),
      'all played/revealed cards at least 50x70',
    );
    if (report.minimumHandTarget)
      assert(
        report.minimumHandTarget.width >= 44 && report.minimumHandTarget.height >= 44,
        'hand targets at least 44px',
      );
  }
  assert.deepEqual(
    report.seatContentOverflow,
    [],
    'played-card area remains inside its attributed seat',
  );
  assert.equal(report.cardCollisions, 0, 'all hand cards independent touch targets');
  assert.deepEqual(report.clips, [], 'no horizontal card clipping');
  assert.deepEqual(
    report.compassCollisions,
    [],
    'compass player panels never collide: ' + JSON.stringify(report),
  );
  if (legacy && report.cards === 33 && page.viewportSize().width >= 768 && report.viewport >= 660)
    assert(report.handDocumentBottom <= report.viewport, 'all33cards fit iPad viewport');
  if (!legacy)
    assert.equal(
      report.activeSeatCount,
      report.shouldHaveActiveSeat ? 1 : 0,
      'only real bury/play turns are highlighted',
    );
  assert.equal(report.horizontalOverflow, false);
  if (
    !legacy &&
    report.cards === 33 &&
    page.viewportSize().width >= 768 &&
    report.viewport >= 660
  ) {
    const fit = await page
      .locator('.tractor')
      .evaluate((e) => ({ scroll: e.scrollHeight, client: e.clientHeight }));
    assert(
      fit.scroll <= fit.client + 1,
      'all33cards fit original tablet without vertical scrolling: ' + JSON.stringify(fit),
    );
  }
  return report;
}
export async function completeRound(
  page,
  { legacy = false, touch = false, shot, attemptThrow = true } = {},
) {
  let plays = 0,
    buries = 0,
    throwAttempts = 0;
  const phases = new Set();
  const checked = {};
  let historyChecked = false;
  let multiCardPlays = 0;
  let iterations = 0;
  for (; iterations < 1500; iterations++) {
    const v = await visibleView(page, legacy);
    if (!v) {
      await page.waitForTimeout(20);
      continue;
    }
    phases.add(v.phase);
    if (!legacy && !historyChecked && (await page.locator('.tractor__history').count())) {
      await page.locator('.tractor__history summary').click();
      assert.equal(await page.locator('.tractor__history section').count(), 4);
      assert(
        await page
          .locator('.tractor__history .pcard')
          .evaluateAll(
            (es) => es.length >= 4 && es.every((e) => Number(getComputedStyle(e).opacity) > 0.95),
          ),
        'history cards immediately readable',
      );
      await layout(page);
      if (shot) await page.screenshot({ path: shot('history'), fullPage: true });
      await page.locator('.tractor__history summary').click();
      historyChecked = true;
    }
    if (v.trick.length) {
      if (v.trick.some((p) => p.cards.length >= 2)) {
        multiCardPlays++;
        if (multiCardPlays === 1 && shot)
          await page.screenshot({ path: shot('multi-card'), fullPage: legacy });
      }
      const winner = engine.currentTrickWinner(v.trick, v.level, v.trump);
      assert.equal(v.markedWinner, winner, 'DOM winner agrees with shared settlement comparator');
    }
    if (!checked[v.phase] && v.phase !== 'roundOver') {
      checked[v.phase] = await layout(page, legacy);
      if (shot) await page.screenshot({ path: shot(v.phase), fullPage: legacy });
    }
    if (v.round >= 2) break;
    if (v.phase === 'roundOver') {
      if (shot) await page.screenshot({ path: shot('roundOver'), fullPage: legacy });
      const next = page.getByRole('button', { name: '准备下一局', exact: true });
      if (await next.count()) await next.click();
      else await page.waitForTimeout(30);
      continue;
    }
    if (iterations % 100 === 0)
      console.log('browser progress', legacy, v.phase, v.turn, v.hand.length, plays, buries);
    if (['dealing', 'reveal', 'trickOver'].includes(v.phase) || v.turn !== 0) {
      if (['dealing', 'reveal'].includes(v.phase)) {
        const skip = page.getByRole('button', { name: '暂不亮 / 继续发牌', exact: true });
        if (v.paused) await skip.click();
      }
      await page.waitForTimeout(30);
      continue;
    }
    let a = engine.recommend(v);
    if (attemptThrow && !throwAttempts && v.phase === 'play' && !v.trick.length) {
      const suit = engine.effective(v.hand[0], v.level, v.trump);
      const same = v.hand.filter((c) => engine.effective(c, v.level, v.trump) === suit);
      if (!engine.shape(same, v.level, v.trump)) {
        a = { type: 'play', cards: same.map((c) => c.id) };
        throwAttempts++;
      }
    }
    if (v.phase === 'bury') {
      const buttons = page.locator(legacy ? '.hand button' : '.tractor__hand button');
      assert.equal(await buttons.count(), 33);
      for (let i = 0; i < 33; i++) {
        const b = buttons.nth(i);
        await b.scrollIntoViewIfNeeded();
        if (legacy || touch) {
          const r = await b.boundingBox();
          await page.touchscreen.tap(r.x + r.width / 2, r.y + r.height / 2);
        } else await b.click();
        assert.equal(
          await b.getAttribute('aria-pressed'),
          'true',
          'each of 33 cards independently selectable',
        );
      }
      await page.getByRole('button', { name: '清空', exact: true }).click();
    }
    await choose(page, a.cards, legacy);
    if (v.phase === 'bury') {
      buries++;
      assert.equal(v.hand.length, 33);
      await layout(page, legacy);
      if (shot) await page.screenshot({ path: shot('bury-selected'), fullPage: legacy });
    }
    await page
      .getByRole('button', { name: v.phase === 'bury' ? '扣下8张' : '出牌', exact: true })
      .click();
    if (v.phase === 'play') plays++;
    await page.waitForTimeout(20);
    const notice = page.locator(legacy ? '.status' : '.tractor__failure');
    const failed = (await notice.count()) ? await notice.innerText() : '';
    // The challenger duty is selected from public information; reconstruct the forced group's winning candidate if human is challenger.
    if (failed.includes('压牌者')) throw Error('human challenger must be handled explicitly');
  }
  assert(iterations < 1500, 'full round must finish');
  assert(plays > 0);
  if (legacy) assert(multiCardPlays > 0, 'observed actual multi-card play');
  return {
    plays,
    buries,
    throwAttempts,
    multiCardPlays,
    historyChecked,
    phases: [...phases],
    checked,
    iterations,
  };
}
