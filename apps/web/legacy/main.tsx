import 'core-js/stable';
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { PlayingCard } from '../src/components/PlayingCard';
import { doudizhu, resolvePlay } from '../../../packages/engine/src/games/doudizhu';
import { LegacySession } from './session';

declare global {
  interface Window {
    DeskParkLegacy?: { stage(text: string): void; fail(error: unknown): void; ready(): void };
  }
}

function App() {
  useEffect(() => {
    window.DeskParkLegacy?.ready();
  }, []);
  const [game, setGame] = useState<LegacySession | null>(null);
  const [version, update] = useState(0);
  const [selected, select] = useState<number[]>([]);
  const [message, notify] = useState('');
  const [rules, showRules] = useState(false);
  const v = game?.view;
  useEffect(() => {
    if (!game) return;
    const timer = window.setTimeout(() => {
      try {
        if (game.stepBot()) update((n) => n + 1);
      } catch (error) {
        notify(String(error));
        window.DeskParkLegacy?.fail(error);
      }
    }, 700);
    return () => window.clearTimeout(timer);
  }, [game, version]);
  function act(action: Parameters<LegacySession['act']>[0]) {
    if (!game) return;
    const error = game.act(action);
    notify(error || '');
    if (!error) {
      select([]);
      update((n) => n + 1);
    }
  }
  const myTurn = v?.turn === 0;
  const target = v?.lastPlay && v.lastPlay.seat !== 0 ? v.lastPlay.pattern : null;
  const valid =
    v &&
    selected.length > 0 &&
    resolvePlay(
      v.hand.filter((c) => selected.includes(c.id)),
      target,
    );
  const role = (s: number) =>
    !v || v.landlord === null ? '待叫分' : v.landlord === s ? '地主' : '农民';
  const status = !v
    ? '一桌好牌，慢慢来。'
    : v.result
      ? '本局结束 · 休息一下，再来一局'
      : v.phase === 'bidding'
        ? myTurn
          ? '轮到你叫分'
          : '电脑正在叫分…'
        : myTurn
          ? '轮到你出牌'
          : '请稍候，电脑正在出牌…';
  return (
    <main className="legacy-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-seal" aria-hidden="true">
            亭
          </span>
          <div>
            <h1>
              闲亭 <span>斗地主</span>
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
              if (v && !window.confirm('返回大厅将离开当前牌局，进度不会保存。确定返回？'))
                event.preventDefault();
            }}
          >
            返回大厅
          </a>
        </nav>
      </header>
      {!v ? (
        <section className="welcome table-surface">
          <div className="welcome-cards" aria-hidden="true">
            {[
              { id: 0, suit: 'S' as const, rank: 14 },
              { id: 1, suit: 'H' as const, rank: 13 },
              { id: 2, suit: 'J' as const, rank: 17 },
            ].map((c) => (
              <PlayingCard card={c} key={c.id} />
            ))}
          </div>
          <p className="eyebrow">一人 · 两位电脑</p>
          <h2>斗地主</h2>
          <p className="welcome-copy">选好牌，点「出牌」。</p>
          <button className="primary start" onClick={() => setGame(new LegacySession(Date.now()))}>
            开始游戏
          </button>
        </section>
      ) : (
        <section className="game-board table-surface" data-phase={v.phase} data-round={v.round}>
          <div className="round-strip">
            <span>
              第 <b>{v.round}</b> 局 ·{' '}
              {v.phase === 'bidding' ? '叫分' : v.result ? '已结束' : '对局中'}
            </span>
            <span>
              本局倍数 <b>×{v.multiplier}</b>
            </span>
          </div>
          <div className="bottom">
            <span className="small-label">本局底牌</span>
            <div>
              {v.bottom
                ? v.bottom.map((c) => <PlayingCard card={c} key={c.id} />)
                : [0, 1, 2].map((n) => <PlayingCard faceDown key={n} />)}
            </div>
          </div>
          <div className="opponents">
            {[2, 1].map((s) => (
              <div
                key={s}
                className={`opponent seat-${s} ${v.turn === s && !v.result ? 'active' : ''}`}
              >
                <div className="seat-head">
                  <span className="seat-avatar" aria-hidden="true">
                    {s === 2 ? '竹' : '松'}
                  </span>
                  <div>
                    <h2>电脑{s === 1 ? '一' : '二'}</h2>
                    <span className={`role-tag ${v.landlord === s ? 'landlord' : ''}`}>
                      {role(s)}
                    </span>
                  </div>
                </div>
                <p className="remaining">
                  余牌 <strong>{v.handCounts[s]}</strong> 张
                </p>
                <p className="seat-score">
                  积分 {v.scores[s]}
                  {v.bids[s] !== null ? ` · ${v.bids[s] ? `叫 ${v.bids[s]} 分` : '不叫'}` : ''}
                </p>
                <span className="turn-label">
                  {v.turn === s && !v.result ? '正在思考' : '静候出牌'}
                </span>
              </div>
            ))}
          </div>
          <div className="table-center">
            <div className="table-watermark" aria-hidden="true">
              闲亭
            </div>
            {v.phase === 'bidding' ? (
              <div className="bidding-note">
                <span>叫分决定地主</span>
              </div>
            ) : (
              <div className="trick">
                <span className="small-label">
                  {v.lastPlay
                    ? `${v.lastPlay.seat === 0 ? '我' : v.lastPlay.seat === 1 ? '电脑一' : '电脑二'}出的牌`
                    : ''}
                </span>
                <div className="played">
                  {v.lastPlay ? (
                    v.lastPlay.cards.map((c) => <PlayingCard card={c} key={c.id} />)
                  ) : (
                    <p>地主先出牌</p>
                  )}
                </div>
                <div className="move-notes">
                  {[2, 0, 1]
                    .filter((s) => v.lastMoves[s]?.type === 'pass')
                    .map((s) => (
                      <span key={s}>{s === 0 ? '我' : s === 1 ? '电脑一' : '电脑二'} · 不出</span>
                    ))}
                </div>
              </div>
            )}
          </div>
          <div className="player-area">
            <div className="status-line" role="status" aria-live="polite">
              <strong>{status}</strong>
              <span>{message}</span>
            </div>
            {v.result ? (
              <div className="result-panel" data-result="true">
                <h2>{v.result.landlordWin === (v.landlord === 0) ? '你赢了' : '这局再接再厉'}</h2>
                <p>
                  本局积分 {v.result.deltas[0] > 0 ? '+' : ''}
                  {v.result.deltas[0]} · 电脑一 {v.result.deltas[1]} · 电脑二 {v.result.deltas[2]}
                </p>
                <button
                  className="primary"
                  disabled={v.ready[0]}
                  onClick={() => act({ type: 'ready' })}
                >
                  继续下一局
                </button>
              </div>
            ) : (
              <div className="actions">
                {v.phase === 'bidding' ? (
                  ([0, 1, 2, 3] as const).map((n) => (
                    <button
                      className={n === 3 ? 'primary' : ''}
                      key={n}
                      disabled={!myTurn || (n > 0 && n <= v.currentBid)}
                      onClick={() => act({ type: 'bid', score: n })}
                    >
                      {n ? `${n} 分` : '不叫'}
                    </button>
                  ))
                ) : (
                  <>
                    <button disabled={!myTurn || !target} onClick={() => act({ type: 'pass' })}>
                      不出
                    </button>
                    <button
                      disabled={!myTurn}
                      onClick={() => {
                        const a = game!.hint();
                        select(a.type === 'play' ? a.cards : []);
                        notify(
                          a.type === 'pass' ? '建议不出，请点“不出”' : '已帮你选好，点“出牌”即可',
                        );
                      }}
                    >
                      提示
                    </button>
                    <button
                      className="primary"
                      disabled={!myTurn || !valid}
                      onClick={() => act({ type: 'play', cards: selected })}
                    >
                      出牌
                    </button>
                    <button
                      className="quiet clear"
                      onClick={() => {
                        select([]);
                        notify('');
                      }}
                    >
                      清空选择
                    </button>
                  </>
                )}
              </div>
            )}
            <div className="self-line">
              <div>
                <span className="seat-avatar self-avatar" aria-hidden="true">
                  我
                </span>
                <strong>我</strong>
                <span className={`role-tag ${v.landlord === 0 ? 'landlord' : ''}`}>{role(0)}</span>
                <span>余 {v.hand.length} 张</span>
              </div>
              <span>
                积分 {v.scores[0]}{' '}
                <span className="selection-count">· 已选 {selected.length} 张</span>
              </span>
            </div>
            <div className="legacy-hand" aria-label="我的手牌">
              {v.hand.map((c) => (
                <button
                  key={c.id}
                  aria-label={`手牌 ${c.suit} ${c.rank}`}
                  aria-pressed={selected.includes(c.id)}
                  disabled={!myTurn || v.phase !== 'playing' || !!v.result}
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
          </div>
        </section>
      )}
      {rules && (
        <div className="rules-shade">
          <section className="rules-panel" role="dialog" aria-modal="true" aria-label="玩法说明">
            <h2>斗地主 · 怎么玩</h2>
            <p>先叫分决定地主；地主一人，农民两人合作。先出完手牌的一方获胜。</p>
            <p>点一下选牌，再点一下取消。「提示」只帮你选择，不会自动出牌；选好后请点「出牌」。</p>
            {doudizhu.meta.rules.map((r) => (
              <p key={r}>{r}</p>
            ))}
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
