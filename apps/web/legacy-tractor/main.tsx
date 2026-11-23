import 'core-js/stable';
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { rankText } from '../src/components/PlayingCard';
import { PlayingCard } from './PlayingCard';
import {
  tractor,
  effective,
  power,
  currentTrickWinner,
  type TractorAction,
} from '../../../packages/engine/src/games/tractor';
import { LegacyTractorSession } from './session';
import { loadLocalGame, saveLocalGame } from './storage';
import { useTractorReplay, TractorReplayControl } from '../src/games/tractor/ReplayControl';

declare global {
  interface Window {
    DeskParkLegacy?: { stage(text: string): void; fail(error: unknown): void; ready(): void };
  }
}
const names = ['我', '松 · 下家', '竹 · 对家', '梅 · 上家'];
let remoteDecideUnavailable = false;
let remoteUnavailableTimer = 0;

function requestMacMiniBot(
  view: unknown,
  version: number,
  onDone: (action: unknown) => void,
): () => void {
  if (remoteDecideUnavailable || typeof XMLHttpRequest === 'undefined') {
    onDone(null);
    return () => {};
  }
  let settled = false;
  const xhr = new XMLHttpRequest();
  const finish = (action: unknown) => {
    if (settled) return;
    settled = true;
    window.clearTimeout(hardTimer);
    onDone(action);
  };
  const hardTimer = window.setTimeout(() => {
    try {
      xhr.abort();
    } catch {
      // Ignore abort errors on legacy WebKit
    }
    finish(null);
  }, 1200);
  try {
    xhr.open('POST', '/api/bot/decide', true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.timeout = 1200;
    xhr.onreadystatechange = () => {
      if (xhr.readyState !== 4 || settled) return;
      if (xhr.status === 404) {
        remoteDecideUnavailable = true;
        if (remoteUnavailableTimer) window.clearTimeout(remoteUnavailableTimer);
        remoteUnavailableTimer = window.setTimeout(() => {
          remoteDecideUnavailable = false;
          remoteUnavailableTimer = 0;
        }, 30000);
        finish(null);
        return;
      }
      if (xhr.status === 200) {
        try {
          const parsed = JSON.parse(xhr.responseText) as { ok?: boolean; action?: unknown };
          finish(parsed && parsed.ok ? parsed.action : null);
          return;
        } catch {
          finish(null);
          return;
        }
      }
      finish(null);
    };
    xhr.onerror = () => finish(null);
    xhr.ontimeout = () => finish(null);
    xhr.send(
      JSON.stringify({
        gameId: 'tractor',
        view,
        budgetMs: 360,
        version,
      }),
    );
  } catch {
    finish(null);
  }
  return () => {
    if (settled) return;
    settled = true;
    window.clearTimeout(hardTimer);
    try {
      xhr.abort();
    } catch {
      // Ignore abort errors on legacy WebKit
    }
  };
}
const suits = { S: '♠ 黑桃', H: '♥ 红桃', C: '♣ 梅花', D: '♦ 方块', J: '无主' };
const phases = {
  dealing: '边发边亮',
  reveal: '亮主 / 反主',
  bury: '庄家扣底',
  play: '跟牌争分',
  trickOver: '本墩结算',
  roundOver: '本局结算',
  matchOver: '本场结束',
};
function App() {
  const [saved, setSaved] = useState(() => loadLocalGame());
  const [saveFailed, setSaveFailed] = useState(false);
  const [game, setGame] = useState<LegacyTractorSession | null>(null);
  const [revision, update] = useState(0);
  const [selected, select] = useState<number[]>([]);
  const [message, notify] = useState('');
  const [rules, showRules] = useState(false);
  useEffect(() => {
    window.DeskParkLegacy?.ready();
  }, []);
  function startNew() {
    const current = loadLocalGame();
    if (
      (game || saved.text !== null || current.text !== null) &&
      !window.confirm('开始新游戏将覆盖上次牌局，无法恢复。确定开始？')
    )
      return;
    const next = new LegacyTractorSession(Date.now());
    setSaveFailed(!saveLocalGame(next));
    setGame(next);
    select([]);
    notify('');
  }
  function continueSaved() {
    const current = loadLocalGame();
    setSaved(current);
    if (!current.text || current.issue) return;
    setGame(LegacyTractorSession.restore(current.text));
    select([]);
    notify('');
  }
  useEffect(() => {
    if (!game) return;
    const flush = () => {
      setSaveFailed(!saveLocalGame(game));
    };
    const hidden = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [game]);
  const v = game?.view;
  const replay = useTractorReplay(v);
  useEffect(() => {
    if (!game) return;
    let cancelled = false;
    let cancelRemote: (() => void) | null = null;
    const pendingPreview = !remoteDecideUnavailable ? game.peekPendingBot() : null;
    const waitMs = pendingPreview ? 380 : game.delayMs;
    const timer = window.setTimeout(() => {
      try {
        const pending = game.peekPendingBot();
        if (pending) {
          cancelRemote = requestMacMiniBot(pending.view, pending.version, (remoteAction) => {
            if (cancelled) return;
            try {
              if (game.applyBotDecision(pending.seat, pending.version, remoteAction)) {
                setSaveFailed(!saveLocalGame(game));
                update((n) => n + 1);
              }
            } catch (e) {
              window.DeskParkLegacy?.fail(e);
            }
          });
          return;
        }
        if (game.step()) {
          setSaveFailed(!saveLocalGame(game));
          update((n) => n + 1);
        }
      } catch (e) {
        window.DeskParkLegacy?.fail(e);
      }
    }, waitMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (cancelRemote) cancelRemote();
    };
  }, [game, revision]);
  function act(a: TractorAction) {
    if (!game) return;
    const error = game.act(a);
    notify(error || '');
    if (!error) {
      setSaveFailed(!saveLocalGame(game));
      select([]);
      update((n) => n + 1);
    }
  }
  const bidding = v && (v.phase === 'dealing' || v.phase === 'reveal');
  const active = !!v && (!!bidding || !!game?.isHumanActive);
  const ended = v && (v.phase === 'roundOver' || v.phase === 'matchOver');
  const cards = v
    ? [...v.hand].sort(
        (a, b) =>
          'JSHCD'.indexOf(effective(a, v.level, v.trump)) -
            'JSHCD'.indexOf(effective(b, v.level, v.trump)) ||
          power(b, v.level, v.trump) - power(a, v.level, v.trump) ||
          a.suit.localeCompare(b.suit) ||
          a.id - b.id,
      )
    : [];
  const plays = v ? (v.phase === 'trickOver' ? v.lastTrick : v.trick) : [];
  const largest = v ? currentTrickWinner(plays, v.level, v.trump) : null;
  const paused = !!game?.awaitingDeclaration;
  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-seal">亭</span>
          <div>
            <h1>
              闲亭 <span>拖拉机</span>
            </h1>
          </div>
        </div>
        <nav>
          <button className="quiet" onClick={() => showRules(true)}>
            玩法说明
          </button>
          <a
            className="lobby-link"
            href="/classic/"
            onClick={(event) => {
              if (!game) return;
              const ok = saveLocalGame(game);
              setSaveFailed(!ok);
              if (
                !window.confirm(
                  ok
                    ? '牌局已保存在当前浏览器。返回大厅后，可点「继续上次牌局」恢复。确定返回？'
                    : '保存失败！返回大厅会丢失当前进度（上次成功存档可能仍保留）。确定离开？',
                )
              )
                event.preventDefault();
            }}
          >
            返回大厅
          </a>
        </nav>
      </header>
      {(saveFailed || (!game && saved.issue)) && (
        <p className="save-warning" role="alert">
          {!game && saved.issue === 'invalid'
            ? '上次存档损坏或版本不支持，无法继续。开始新游戏前会确认覆盖。'
            : '当前浏览器无法保存进度；可继续玩，但离开可能丢失进度。请勿清理浏览器数据。'}
        </p>
      )}
      {!v ? (
        <section className="table welcome">
          <p className="eyebrow">双升 / 升级 · 同门甩牌</p>
          <div aria-hidden="true">
            {[0, 1].map((id) => (
              <PlayingCard card={{ id, suit: 'H', rank: 14 }} key={id} />
            ))}
            <PlayingCard card={{ id: 2, suit: 'S', rank: 2 }} />
          </div>
          <h2>拖拉机</h2>
          <p>我和对家一队，先从 2 打起。</p>
          {saved.text !== null && !saved.issue && (
            <button className="primary start" onClick={continueSaved}>
              继续上次牌局
            </button>
          )}
          <button className="primary start" onClick={startNew}>
            {saved.text !== null ? '开始新游戏' : '开始游戏'}
          </button>
          <p>自动保存在当前浏览器，不跨设备；清理浏览器数据会丢失存档。</p>
        </section>
      ) : (
        <section
          className="table"
          data-phase={v.phase}
          data-round={v.round}
          data-turn={v.turn}
          data-level={v.level}
          data-trump={v.trump}
          data-dealer={v.dealer}
          data-paused={paused}
          data-dealt={v.dealt}
          data-bid-seat={v.bid?.seat ?? -1}
          data-bid-strength={v.bid?.strength ?? 0}
          data-bid-cards={JSON.stringify(v.bid?.cards.map((c) => c.id) ?? [])}
        >
          <div className="table-info">
            <div className="trump-banner" aria-label="当前主牌">
              {v.trump === 'J' ? (
                <strong>无主</strong>
              ) : (
                <PlayingCard
                  card={{ id: -1, suit: v.trump, rank: v.level }}
                  aria-label={`${suits[v.trump]} ${rankText(v.level)}级主牌`}
                />
              )}
            </div>
            <div className="summary">
              <span>
                闲家 <b className="score">{v.points}</b> 分
              </span>
            </div>
          </div>
          {ended ? (
            <div className="result" data-result="true">
              <h2>{phases[v.phase]}</h2>
              <p>{v.result}</p>
              <p>
                我和竹 {rankText(v.levels[0])} 级 · 松和梅 {rankText(v.levels[1])} 级
              </p>
              <div className="kitty">
                {v.kitty.map((c) => (
                  <PlayingCard key={c.id} card={c} />
                ))}
              </div>
              {v.phase === 'roundOver' ? (
                <button
                  className="primary"
                  disabled={v.ready.includes(0)}
                  onClick={() => act({ type: 'continue' })}
                >
                  {v.ready.includes(0) ? '等待电脑准备' : '准备下一局'}
                </button>
              ) : (
                <button className="primary" onClick={startNew}>
                  再来一场
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="arena compass">
                {[2, 3, 1, 0].map((s) => {
                  const p = plays.find((x) => x.seat === s);
                  const announcement = bidding
                    ? game!.revealedDeclarations.find((x) => x.seat === s)
                    : undefined;
                  const shown = announcement?.cards ?? p?.cards;
                  const turn = !bidding && v.phase !== 'trickOver' && v.turn === s;
                  const winning = largest === s;
                  return (
                    <div
                      className={`play compass-${s} ${turn ? 'turn' : ''} ${winning ? 'winning' : ''}`}
                      key={s}
                      data-seat={s}
                      data-order={plays.findIndex((x) => x.seat === s)}
                      data-winning={winning}
                    >
                      <div className="player-label">
                        <strong>{names[s]}</strong>
                        <span>
                          余 {v.handCounts[s]} 张 ·{' '}
                          {v.dealer === s ? '庄家' : s % 2 === v.dealer % 2 ? '庄家队' : '闲家队'}
                        </span>
                      </div>
                      <small>
                        {p
                          ? winning
                            ? v.phase === 'trickOver'
                              ? '✓ 本墩赢牌'
                              : '▲ 本轮暂时最大'
                            : '已出牌'
                          : bidding
                            ? paused
                              ? ''
                              : ''
                            : turn
                              ? s === 0
                                ? ''
                                : '▶ 轮到他'
                              : ''}
                      </small>
                      <div
                        className="play-cards"
                        data-revealed={!!announcement}
                        aria-label={announcement ? `${names[s]}亮主牌` : `${names[s]}出牌`}
                      >
                        {shown ? (
                          shown.map((c) => (
                            <PlayingCard
                              card={c}
                              key={c.id}
                              data-cid={c.id}
                              data-suit={c.suit}
                              data-rank={c.rank}
                            />
                          ))
                        ) : (
                          <span className="empty-play">—</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {!!v.lastTrick.length && v.phase !== 'trickOver' && (
                <details className="previous-trick">
                  <summary>上一墩 · {names[v.winner]} 赢墩（点开回看）</summary>
                  <div>
                    {v.lastTrick.map((p) => (
                      <div key={p.seat}>
                        <b>
                          {names[p.seat]}
                          {p.seat === v.winner ? ' ✓ 赢墩' : ''}
                        </b>
                        {p.cards.map((c) => (
                          <PlayingCard key={c.id} card={c} />
                        ))}
                      </div>
                    ))}
                  </div>
                </details>
              )}
              <div className="status" role="status" aria-live="polite">
                <strong>
                  {v.phase === 'trickOver'
                    ? `${names[v.winner]} 赢得本墩`
                    : paused
                      ? '请亮主，或继续发牌'
                      : bidding
                        ? v.phase === 'dealing'
                          ? '发牌中'
                          : '亮主中'
                        : active
                          ? `轮到你 · ${phases[v.phase]}`
                          : `请稍候 · ${names[v.turn]}`}
                </strong>
                <span>
                  {v.throwFailure
                    ? `甩牌失败 · 罚${v.throwFailure.penalty}分 · 领${v.throwFailure.forced.length}张`
                    : message}
                </span>
              </div>
              <div className="actions">
                {bidding ? (
                  <div className="declaration-panel" aria-label="亮主花色">
                    {game!.declarations.map((o) => (
                      <button
                        key={o.suit}
                        data-declare={o.suit}
                        className={o.cards.length ? 'declaration legal' : 'declaration'}
                        disabled={!o.cards.length}
                        onClick={() => act({ type: 'reveal', cards: o.cards })}
                      >
                        <strong>{suits[o.suit]}</strong>
                      </button>
                    ))}
                    <button
                      className="quiet resume"
                      disabled={!paused}
                      onClick={() => {
                        game!.skipDeclaration();
                        setSaveFailed(!saveLocalGame(game!));
                        notify('');
                        update((n) => n + 1);
                      }}
                    >
                      暂不亮 / 继续发牌
                    </button>
                  </div>
                ) : (
                  <button
                    className="primary"
                    disabled={
                      !active || (v.phase === 'bury' ? selected.length !== 8 : !selected.length)
                    }
                    onClick={() =>
                      act({ type: v.phase === 'bury' ? 'bury' : 'play', cards: selected })
                    }
                  >
                    {v.phase === 'bury' ? '扣下8张' : '出牌'}
                  </button>
                )}
                <button
                  className="quiet"
                  disabled={!selected.length}
                  onClick={() => {
                    select([]);
                    notify('');
                  }}
                >
                  清空
                </button>
              </div>
              <div className="self">
                <span>
                  <b>我</b> · {v.dealer === 0 ? '庄家' : v.dealer % 2 === 0 ? '庄家队' : '闲家队'} ·
                  余 {v.hand.length} 张 · 已选 <b>{selected.length}</b>
                </span>
                <span>
                  我和竹 {rankText(v.levels[0])}级 / 对方 {rankText(v.levels[1])}级
                </span>
              </div>
              <div className="hand" aria-label="我的手牌">
                {cards.map((c) => (
                  <button
                    key={c.id}
                    data-cid={c.id}
                    data-suit={c.suit}
                    data-rank={c.rank}
                    aria-label={`手牌 ${suits[c.suit]} ${c.suit === 'J' ? (c.rank === 17 ? '大王' : '小王') : rankText(c.rank)}`}
                    aria-pressed={selected.includes(c.id)}
                    disabled={!active || !!bidding || v.phase === 'trickOver'}
                    onClick={() =>
                      select(
                        selected.includes(c.id)
                          ? selected.filter((id) => id !== c.id)
                          : [...selected, c.id],
                      )
                    }
                  >
                    <PlayingCard card={c} selected={selected.includes(c.id)} />
                  </button>
                ))}
              </div>
              {v.kitty.length > 0 && (
                <details className="kitty">
                  <summary>查看我扣下的8张底牌</summary>
                  {v.kitty.map((c) => (
                    <PlayingCard key={c.id} card={c} />
                  ))}
                </details>
              )}
            </>
          )}
        </section>
      )}
      {rules && (
        <div className="rules-shade">
          <section className="rules-panel" role="dialog" aria-modal="true" aria-label="玩法说明">
            <h2>拖拉机 · 同门甩牌</h2>
            <p>我和竹同队，松和梅同队。点牌选择，再点金色按钮确认。默认不限局，过A循环至2。</p>
            {tractor.meta.rules.map((r) => (
              <p key={r}>
                {r.replace(
                  '每320毫秒每人收到一张',
                  '本入口每450毫秒每人收到一张；出现新的合法亮主选项时，发牌与电脑亮主一起暂停，必须自己亮主或点「暂不亮 / 继续发牌」继续',
                )}
              </p>
            ))}
            <TractorReplayControl recorder={replay} enabled={!!v} />
            <button className="primary" onClick={() => showRules(false)}>
              知道了，回到牌桌
            </button>
          </section>
        </div>
      )}
    </main>
  );
}
createRoot(document.getElementById('app')!, {
  onUncaughtError: (error) => window.DeskParkLegacy?.fail(error),
}).render(<App />);
