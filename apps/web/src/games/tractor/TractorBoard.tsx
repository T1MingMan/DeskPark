import { rankLabel, SUIT_SYMBOL, tr } from '@park/engine';
import { CardRow, PlayingCard } from './PlayingCard';
import { Button, Sheet, toast } from '../../components/ui';
import type { GameController } from '../../lib/controller';
import { useSelection, useTurnCue } from '../shared/trick';
import './tractor.css';
export default function TractorBoard({
  ctl,
}: {
  ctl: GameController<tr.TractorView, tr.TractorAction>;
}) {
  const v = ctl.view!;
  const me = ctl.seat ?? 0;
  const bidding = v.phase === 'dealing' || v.phase === 'reveal';
  const active =
    ctl.seat !== null &&
    !ctl.auto &&
    (bidding || (v.turn === me && ['bury', 'play'].includes(v.phase)));
  const [sel, setSel] = useSelection(v.hand, `${v.round}-${v.phase}-${v.trick.length}`);
  useTurnCue(active && !bidding);
  const send = (a: tr.TractorAction) => {
    const error = ctl.act(a);
    if (error) toast(error, 'error');
    else setSel(new Set());
  };
  const hand = [...v.hand].sort(
    (a, b) =>
      'JSHCD'.indexOf(tr.effective(a, v.level, v.trump)) -
        'JSHCD'.indexOf(tr.effective(b, v.level, v.trump)) ||
      tr.power(b, v.level, v.trump) - tr.power(a, v.level, v.trump) ||
      a.suit.localeCompare(b.suit) ||
      a.id - b.id,
  );
  const phase = {
    dealing: `边发边亮 ${v.dealt}/25`,
    reveal: '最后亮主 / 反主',
    bury: '庄家扣底',
    play: '跟牌争分',
    trickOver: '本墩结算',
    roundOver: '本局结算',
    matchOver: '本场结束',
  }[v.phase];
  const plays = v.phase === 'trickOver' ? v.lastTrick : v.trick;
  const largest = tr.currentTrickWinner(plays, v.level, v.trump);
  const choices = v.declarations ?? tr.declarationChoices(v);
  const ended = v.phase === 'roundOver' || v.phase === 'matchOver';
  const hint = bidding
    ? '随时选已到手级牌或王对亮主 / 反主'
    : v.phase === 'bury'
      ? '选择8张扣底；主牌和分牌都可扣'
      : v.trick.length
        ? `跟 ${v.trick[0].cards.length} 张 · 有门跟门，先拖拉机再对子`
        : '可领单张、对子、拖拉机或同门甩牌';
  return (
    <div
      className="tractor"
      data-phase={v.phase}
      data-round={v.round}
      data-turn={v.turn}
      data-level={v.level}
      data-trump={v.trump}
      data-dealer={v.dealer}
      data-paused={!!v.awaitingDeclaration && !ctl.auto}
    >
      <header className="tractor__info" />
      <div className="tractor__score">
        <section
          className="tractor__trump"
          aria-label={`当前主牌 ${v.trump === 'J' ? '无主' : SUIT_SYMBOL[v.trump]} ${rankLabel(v.level)}级`}
        >
          {v.trump === 'J' ? (
            <strong>无主 · {rankLabel(v.level)}</strong>
          ) : (
            <PlayingCard card={{ id: -1, suit: v.trump, rank: v.level }} w="36px" />
          )}
          {bidding && !v.bid && <small>待亮</small>}
        </section>
        <span>
          庄家 <b>{ctl.players[v.dealer].name}</b> · {v.dealer % 2 === 0 ? '①③' : '②④'}队
        </span>
        <span className="tractor__meter">
          <b>{v.points}</b> 闲家分 / 80上台
        </span>
        <span>
          ①③ {rankLabel(v.levels[0])} · ②④ {rankLabel(v.levels[1])}
        </span>
      </div>

      <main className="tractor__arena">
        <div className="tractor__compass">
          {[2, 3, 1, 0].map((rel) => {
            const seat = (me + rel) % 4;
            const p = plays.find((x) => x.seat === seat);
            const declared = bidding
              ? [
                  ...new Map(
                    (v.declarationHistory ?? (v.bid ? [v.bid] : []))
                      .filter((x) => x.seat === seat)
                      .flatMap((x) => x.cards)
                      .map((c) => [c.id, c]),
                  ).values(),
                ]
              : [];
            const shown = bidding ? declared : (p?.cards ?? []);
            const position = (
              { 0: 'bottom', 1: 'right', 2: 'top', 3: 'left' } as Record<number, string>
            )[rel];
            const winning = largest === seat;
            return (
              <section
                key={seat}
                data-position={position}
                data-seat={seat}
                data-order={plays.findIndex((x) => x.seat === seat)}
                data-winning={winning}
                className={`tractor__cards tractor__seat ${['bury', 'play'].includes(v.phase) && v.turn === seat ? 'is-active' : ''} ${winning ? 'is-winner' : ''}`}
              >
                <div className="tractor__seat-title">
                  <strong>{seat === ctl.seat ? '我' : ctl.players[seat].name}</strong>
                  <span>
                    {rel === 2 ? '对家' : rel === 1 ? '下家' : rel === 3 ? '上家' : '自己'} ·{' '}
                    {seat === v.dealer ? '庄 · ' : ''}
                    {v.handCounts[seat]}张
                  </span>
                </div>
                <small>
                  {winning
                    ? v.phase === 'trickOver'
                      ? '本墩赢家'
                      : '暂时最大'
                    : p
                      ? '已出牌'
                      : !bidding && v.turn === seat
                        ? v.phase === 'bury'
                          ? '正在扣底'
                          : '轮到出牌'
                        : bidding
                          ? declared.length
                            ? '已亮牌'
                            : '发牌 / 等待确认'
                          : '等待出牌'}
                </small>
                <div className="tractor__played-cards">
                  {shown.length ? (
                    shown.map((c) => (
                      <PlayingCard
                        card={c}
                        key={c.id}
                        data-cid={c.id}
                        data-suit={c.suit}
                        data-rank={c.rank}
                        w="50px"
                      />
                    ))
                  ) : (
                    <span className="tractor__waiting">—</span>
                  )}
                </div>
              </section>
            );
          })}
          <div className="tractor__center">
            <b>{bidding ? `${v.dealt}/25` : `${v.points} 分`}</b>
            <span>
              {bidding ? '边发边亮' : v.phase === 'trickOver' ? '本墩已结算' : '闲家争分'}
            </span>
          </div>
        </div>
      </main>
      <div className="tractor__dock">
        {v.lastTrick.length > 0 && (
          <details className="tractor__history">
            <summary>
              上一墩 · {ctl.players[tr.currentTrickWinner(v.lastTrick, v.level, v.trump)!].name}{' '}
              赢墩
            </summary>
            <div>
              {v.lastTrick.map((p) => (
                <section key={p.seat}>
                  <b>{ctl.players[p.seat].name}</b>
                  <CardRow cards={p.cards} w="30px" />
                </section>
              ))}
            </div>
          </details>
        )}
        {bidding && (
          <section className="tractor__bidding" aria-label="亮主选择">
            <div className="tractor__pause" role="status">
              {ctl.auto
                ? '正在托管，可取消托管亲自决定'
                : v.awaitingDeclaration
                  ? '你有新的亮主机会 · 发牌和所有电脑已暂停'
                  : '新亮主机会会暂停发牌和电脑，等你确认'}
              <small>
                联机需每位有机会的在线真人分别确认；不自动超时抢亮。断线或主动托管由电脑接手。
              </small>
            </div>
            <div className="tractor__declarations">
              {choices.map((o) => (
                <button
                  key={o.suit}
                  data-suit={o.suit}
                  className={o.suit === 'H' || o.suit === 'D' ? 'is-red' : ''}
                  disabled={!active || !o.cards.length}
                  onClick={() => send({ type: 'reveal', cards: o.cards })}
                >
                  <strong>{o.suit === 'J' ? '无主' : SUIT_SYMBOL[o.suit]}</strong>
                  <span>{o.label}</span>
                </button>
              ))}
            </div>
            {v.awaitingDeclaration && active && (
              <Button variant="felt-primary" onClick={() => send({ type: 'pass' })}>
                暂不亮 / 继续发牌
              </Button>
            )}
            {ctl.auto && <Button onClick={() => ctl.setAuto(false)}>取消托管 · 我来决定</Button>}
          </section>
        )}
        {v.throwFailure && (
          <div className="tractor__failure" role="status">
            {ctl.players[v.throwFailure.seat].name} 甩牌失败 · 收回{' '}
            {v.throwFailure.attempted.length - v.throwFailure.forced.length} 张 · 罚{' '}
            {v.throwFailure.penalty} 分 · 强制领 {v.throwFailure.forced.length} 张
          </div>
        )}
        <div className="action-bar">
          <span className="action-hint">
            {active
              ? `${hint} · 已选 ${sel.size}`
              : v.phase === 'trickOver'
                ? `${ctl.players[v.winner].name} 赢墩`
                : `等待 ${ctl.players[v.turn].name} · ${phase}`}
          </span>
          {active && !bidding && (
            <>
              <Button
                variant="felt-primary"
                disabled={v.phase === 'bury' ? sel.size !== 8 : sel.size === 0}
                onClick={() =>
                  send({
                    type: bidding ? 'reveal' : v.phase === 'bury' ? 'bury' : 'play',
                    cards: [...sel],
                  })
                }
              >
                {bidding ? '亮主 / 反主' : v.phase === 'bury' ? '扣下8张' : '出牌'}
              </Button>
              <Button disabled={!sel.size} onClick={() => setSel(new Set())}>
                清空
              </Button>
            </>
          )}
        </div>
        <div className="tractor__self">
          我 · {v.hand.length} 张 ·{' '}
          {me === v.dealer ? '庄家' : me % 2 === v.dealer % 2 ? '庄家队' : '闲家队'}
          <span>{bidding ? '直接点亮主花色，或暂不亮继续' : '点牌选择，再点按钮确认'}</span>
        </div>
        <div className="tractor__hand" aria-label="我的手牌">
          {hand.map((c) => (
            <button
              key={c.id}
              data-cid={c.id}
              data-suit={c.suit}
              data-rank={c.rank}
              aria-label={`手牌 ${c.suit} ${rankLabel(c.rank)}`}
              aria-pressed={sel.has(c.id)}
              disabled={!active}
              onClick={() => {
                const next = new Set(sel);
                if (next.has(c.id)) next.delete(c.id);
                else next.add(c.id);
                setSel(next);
              }}
            >
              <PlayingCard card={c} selected={sel.has(c.id)} w="var(--tractor-cw)" />
            </button>
          ))}
        </div>
        {v.kitty.length > 0 && !ended && (
          <details className="tractor__kitty">
            <summary>查看我的8张底牌</summary>
            <CardRow cards={v.kitty} w="36px" />
          </details>
        )}
      </div>
      {ended && (
        <Sheet
          open
          dismissible={false}
          footer={
            <>
              <Button onClick={() => ctl.leave()}>返回大厅</Button>
              <Button onClick={() => window.dispatchEvent(new Event('deskpark-tractor-rules'))}>
                规则 / 复盘
              </Button>
              {v.phase === 'roundOver' ? (
                <Button
                  variant="primary"
                  disabled={ctl.seat === null || v.ready.includes(me)}
                  onClick={() => send({ type: 'continue' })}
                >
                  {v.ready.includes(me) ? '等待其他玩家' : '准备下一局'}
                </Button>
              ) : (
                ctl.canRestart && (
                  <Button variant="primary" onClick={() => ctl.restart()}>
                    再来一场
                  </Button>
                )
              )}
            </>
          }
        >
          <div className="result tractor__result">
            <h2>{phase}</h2>
            <p>{v.result}</p>
            <p>
              ①③ {rankLabel(v.levels[0])} 级 · ②④ {rankLabel(v.levels[1])} 级
            </p>
            <p>底牌（{tr.score(v.kitty)} 分）</p>
            <CardRow cards={v.kitty} />
          </div>
        </Sheet>
      )}
    </div>
  );
}
