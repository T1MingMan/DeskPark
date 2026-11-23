import { createDeck, type Card, type Suit } from '../../core/cards';
import { clone } from '../../core/clone';
import { Rng } from '../../core/rng';
import type { GameDefinition } from '../../core/types';
import { decompose, runs, obligation, coverPower, compareVector } from './patterns';
import { strategicPlay } from './strategy';
export interface TractorOptions {
  rounds: number;
}
export type TractorAction =
  | { type: 'pass' }
  | { type: 'deal' }
  | { type: 'closeReveal' }
  | { type: 'continue' }
  | { type: 'reveal' | 'bury' | 'play'; cards: number[] };
export interface Play {
  seat: number;
  cards: Card[];
}
export interface TractorState {
  options: TractorOptions;
  rng: number;
  round: number;
  phase: 'dealing' | 'reveal' | 'bury' | 'play' | 'trickOver' | 'roundOver' | 'matchOver';
  drawPile: Card[];
  dealt: number;
  throwFailure: {
    seat: number;
    challenger: number;
    attempted: Card[];
    forced: Card[];
    penalty: number;
  } | null;
  hands: Card[][];
  kitty: Card[];
  turn: number;
  dealer: number;
  levels: number[];
  level: number;
  trump: Suit;
  bid: { seat: number; strength: number; cards: Card[] } | null;
  /** Accepted public announcements only, retained across overcalls for reconnects. */
  declarationHistory?: Play[];
  /** Already accepted public reveals, retained for inference after the artwork clears. */
  publicReveals?: Play[];
  /** Completed public tricks only; per-round and optional for old saved games. */
  playedHistory?: Play[][];
  passes: number;
  trick: Play[];
  lastTrick: Play[];
  winner: number;
  points: number;
  result: string;
  ready: number[];
  /** Private per-round acknowledgements, never broadcast. Optional for older saves. */
  declarationAcknowledged?: string[][];
}
export type TractorView = Omit<
  TractorState,
  'hands' | 'rng' | 'kitty' | 'drawPile' | 'declarationAcknowledged'
> & {
  hand: Card[];
  declarations: DeclarationChoice[];
  awaitingDeclaration: boolean;
  handCounts: number[];
  kitty: Card[];
  seat: number | null;
};
export function effective(c: Card, level: number, trump: Suit): Suit {
  return c.suit === 'J' || c.rank === level || c.suit === trump ? 'J' : c.suit;
}
export function power(c: Card, level: number, trump: Suit): number {
  if (c.suit === 'J') return (trump === 'J' ? 13 : 14) + (c.rank === 17 ? 1 : 0);
  if (c.rank === level) return c.suit === trump ? 13 : 12;
  return c.rank - 2 - (c.rank > level ? 1 : 0);
}
const key = (c: Card) => `${c.suit}${c.rank}`;
export function pairs(cards: Card[]): Card[][] {
  const m = new Map<string, Card[]>();
  for (const c of cards) m.set(key(c), [...(m.get(key(c)) ?? []), c]);
  return [...m.values()].filter((x) => x.length === 2);
}
export function shape(
  cards: Card[],
  level: number,
  trump: Suit,
): 'single' | 'pair' | 'tractor' | null {
  if (
    !cards.length ||
    cards.some((c) => effective(c, level, trump) !== effective(cards[0], level, trump))
  )
    return null;
  if (cards.length === 1) return 'single';
  const ps = pairs(cards);
  if (ps.length * 2 !== cards.length) return null;
  if (ps.length === 1) return 'pair';
  const values = ps.map((p) => power(p[0], level, trump)).sort((a, b) => a - b);
  return values.every((v, i) => i === 0 || v === values[i - 1] + 1) ? 'tractor' : null;
}
export function components(cards: Card[], level: number, trump: Suit): Card[][] {
  return decompose(cards, (c) => power(c, level, trump));
}
function failedThrow(
  s: TractorState,
  seat: number,
  cards: Card[],
): { seat: number; cards: Card[] } | null {
  const parts = components(cards, s.level, s.trump).sort(
    (a, b) =>
      a.length - b.length ||
      power(a[0], s.level, s.trump) - power(b[0], s.level, s.trump) ||
      a[0].id - b[0].id,
  );
  const suit = effective(cards[0], s.level, s.trump);
  for (const part of parts)
    for (let i = 1; i < 4; i++) {
      const other = (seat + i) % 4;
      const own = s.hands[other].filter((c) => effective(c, s.level, s.trump) === suit);
      const candidates =
        part.length === 1
          ? own.map((c) => [c])
          : part.length === 2
            ? pairs(own)
            : runs(pairs(own), part.length / 2, (c) => power(c, s.level, s.trump));
      if (candidates.some((x) => beats(x, part, part, s.level, s.trump)))
        return { seat: other, cards: part };
    }
  return null;
}
function bidStrength(cards: Card[], level: number): number {
  if (!cards.length || cards.length > 2 || cards.some((c) => key(c) !== key(cards[0]))) return 0;
  if (cards[0].suit === 'J') return cards.length === 2 ? (cards[0].rank === 17 ? 4 : 3) : 0;
  return cards[0].rank === level ? cards.length : 0;
}
export interface DeclarationChoice {
  suit: Suit;
  cards: number[];
  label: string;
  token: string;
}
/** Candidates only from this viewer's already-received cards; no opponent information. */
export function declarationChoices(
  v: Pick<TractorView, 'hand' | 'phase' | 'level' | 'bid'>,
): DeclarationChoice[] {
  const candidates = ['dealing', 'reveal'].includes(v.phase)
    ? [...pairs(v.hand), ...v.hand.map((c) => [c])].filter(
        (cs) => bidStrength(cs, v.level) > (v.bid?.strength ?? 0),
      )
    : [];
  return (['S', 'H', 'C', 'D', 'J'] as const).map((suit) => {
    const best = candidates
      .filter((cs) => cs[0].suit === suit)
      .sort((a, b) => bidStrength(b, v.level) - bidStrength(a, v.level))[0];
    return {
      suit,
      cards: best?.map((c) => c.id) ?? [],
      token: best ? `${suit}:${best[0].rank}:${best.length}` : '',
      label: !best
        ? '暂不可亮'
        : suit === 'J'
          ? best[0].rank === 17
            ? '大王对'
            : '小王对'
          : best.length === 2
            ? '级牌对'
            : '单级牌',
    };
  });
}
function awaitingDeclaration(s: TractorState, seat: number): boolean {
  return declarationChoices({ ...s, hand: s.hands[seat] }).some(
    (o) => o.token && !s.declarationAcknowledged?.[seat]?.includes(o.token),
  );
}
function deal(s: TractorState) {
  const rng = new Rng(s.rng);
  const deck = rng.shuffle(createDeck(2));
  s.rng = rng.state;
  s.hands = Array.from({ length: 4 }, () => []);
  s.drawPile = deck.slice(0, 100);
  s.dealt = 0;
  s.kitty = deck.slice(100);
  s.level = s.levels[s.dealer % 2];
  s.trump = 'S';
  s.turn = s.dealer;
  s.phase = 'dealing';
  s.bid = null;
  s.declarationHistory = [];
  s.publicReveals = [];
  s.playedHistory = [];
  s.declarationAcknowledged = [[], [], [], []];
  s.passes = 0;
  s.points = 0;
  s.trick = [];
  s.lastTrick = [];
  s.ready = [];
  s.throwFailure = null;
}
export const tractor: GameDefinition<TractorState, TractorAction, TractorView, TractorOptions> = {
  meta: {
    id: 'tractor',
    category: 'poker',
    name: '拖拉机',
    nameEn: 'Tractor',
    tagline: '双升 · 边发边亮 · 同门甩牌 · 不限局',
    minPlayers: 4,
    maxPlayers: 4,
    defaultPlayers: 4,
    botDelayMs: [450, 850],
    rules: [
      '四人两副牌，隔座为队友，每人25张、底牌8张。本桌采用下列明示家规：支持同门混合甩牌，不反底、不炒底。',
      '每450毫秒每人收到一张；真人遇新合法亮主机会时暂停发牌与电脑，亮主或暂不亮后继续，边发边看，任何座位均可立即亮已收到的级牌或王对；发完另留2.4秒反主。单张级牌 < 一对级牌 < 对小王无主 < 对大王无主；同强度不能反，允许自保升级亮牌。无人亮默认黑桃。首局首位亮主者坐庄，之后按得分轮转。',
      '大小王、全部级牌、主花色均为主牌；大王 > 小王 > 主级牌 > 副级牌 > 主A到2（跳过级牌）。副级牌同大但不同花色不成对；相同强度先出为大。无主时所有级牌同大。',
      '庄家拿底扣8张，庄家首领，逆时针跟牌。同一有效花色可甩任意组合；按最长拖拉机、对子、单张拆分，同长取低者。若其他任一座位（含对家）同门能压任一组，甩牌失败，自动只领最少张数、同张数最弱的可压牌组，其余退手；每退一张向对方转10分。最近可压牌者须跟出能压过该组的牌，但不公开其余手牌。主杀不导致甩牌失败。',
      '有门必须跟足，不足门全部跟出后垫牌。按领牌中拖拉机从长到短优先满足，不能满足则跟最长部分，再尽量跟足领牌所含对子数；单张甩不强迫跟对。完全缺门才可整手主杀，须能拆出同样的拖拉机、对子和单张；多家主杀只比较最大牌组（最长拖拉机，其次对子，否则单张）的最大点数，同大先出胜。',
      '5计5分，10和K各10分，闲家赢墩收分。末墩闲家获胜扣底：以领牌最大组计算，单张×2、对子×4、N连对×2^(N+1)，混合甩牌不按总张数加倍。罚分可令闲家分为负。',
      '闲家≤0分庄升3级，1–39庄升2级，40–79庄升1级；保庄对家接庄。80–119闲家上台不升级，120起每40分闲家升1级，由原庄下家接庄。默认不限局，过A后按升级数循环到2；无必打级。可选有限局则封顶A，到局数结束。详细来源和差异见 docs/tractor-rules.md。',
    ],
  },
  defaultOptions: { rounds: 0 },
  optionFields: [
    {
      key: 'rounds',
      label: '连续局数',
      type: 'select',
      choices: [
        { value: 0, label: '不限局 · 持续升级' },
        { value: 1, label: '1局体验' },
        { value: 3, label: '3局升级' },
        { value: 5, label: '5局升级' },
      ],
    },
  ],
  setup({ players, options, seed }) {
    if (players.length !== 4) throw new Error('拖拉机需要4人');
    const s: TractorState = {
      options: {
        rounds: Number.isInteger(options.rounds) && options.rounds >= 0 ? options.rounds : 0,
      },
      rng: seed,
      round: 1,
      phase: 'dealing',
      drawPile: [],
      dealt: 0,
      throwFailure: null,
      hands: [],
      kitty: [],
      turn: 0,
      dealer: 0,
      levels: [2, 2],
      level: 2,
      trump: 'S',
      bid: null,
      passes: 0,
      trick: [],
      lastTrick: [],
      winner: 0,
      points: 0,
      result: '',
      ready: [],
    };
    deal(s);
    return s;
  },
  activeSeats(s) {
    return ['dealing', 'reveal'].includes(s.phase)
      ? [0, 1, 2, 3].filter(
          (i) =>
            !s.ready.includes(i) ||
            declarationChoices({ ...s, hand: s.hands[i] }).some((o) => o.cards.length),
        )
      : s.phase === 'roundOver'
        ? [0, 1, 2, 3].filter((i) => !s.ready.includes(i))
        : ['reveal', 'bury', 'play'].includes(s.phase)
          ? [s.turn]
          : [];
  },
  validate(s, seat, a) {
    if (a.type === 'deal' || a.type === 'closeReveal')
      return seat === -1 && s.phase === (a.type === 'deal' ? 'dealing' : 'reveal')
        ? null
        : '仅系统可推进发牌';
    if (a.type === 'continue')
      return (s.phase === 'trickOver' && seat === -1) ||
        (s.phase === 'roundOver' && seat >= 0 && seat < 4 && !s.ready.includes(seat))
        ? null
        : '请等待';
    if (
      !(a.type === 'reveal' && ['dealing', 'reveal'].includes(s.phase) && seat >= 0 && seat < 4) &&
      !tractor.activeSeats(s).includes(seat)
    )
      return '还没轮到你';
    if (a.type === 'pass') return ['dealing', 'reveal'].includes(s.phase) ? null : '不能不出';
    if (a.type !== 'reveal' && a.type !== 'bury' && a.type !== 'play') return '未知操作';
    if (!Array.isArray(a.cards) || a.cards.some((id) => !Number.isInteger(id))) return '请选择手牌';
    const cards = s.hands[seat].filter((c) => a.cards.includes(c.id));
    if (cards.length !== a.cards.length || new Set(a.cards).size !== a.cards.length)
      return '请选择自己的手牌';
    if (a.type === 'reveal')
      return ['dealing', 'reveal'].includes(s.phase) &&
        bidStrength(cards, s.level) > (s.bid?.strength ?? 0)
        ? null
        : '需要更强的级牌或王对才能亮主';
    if (a.type === 'bury') return s.phase === 'bury' && cards.length === 8 ? null : '请扣8张底牌';
    if (a.type === 'play' && s.phase === 'play')
      return (
        followError(s.hands[seat], cards, s.trick[0]?.cards ?? [], s.level, s.trump) ??
        (s.throwFailure?.challenger === seat &&
        !beats(cards, s.throwFailure.forced, s.throwFailure.forced, s.level, s.trump)
          ? '甩牌失败的压牌者必须压过强制领出的牌组'
          : null)
      );
    return '当前阶段不能这样操作';
  },
  apply(prev, seat, a) {
    const s = clone(prev);
    if (a.type === 'deal') {
      for (let i = 0; i < 4; i++) s.hands[(s.turn + i) % 4].push(s.drawPile.shift()!);
      s.dealt++;
      s.ready = [];
      if (s.dealt === 25) s.phase = 'reveal';
      return s;
    }
    if (a.type === 'closeReveal') {
      s.phase = 'bury';
      s.declarationHistory = [];
      s.turn = s.dealer;
      s.ready = [];
      s.hands[s.dealer].push(...s.kitty);
      s.kitty = [];
      return s;
    }
    if (a.type === 'continue') {
      if (s.phase === 'roundOver') {
        s.ready.push(seat);
        if (s.ready.length === 4) {
          s.round++;
          deal(s);
        }
        return s;
      }
      s.trick = [];
      s.throwFailure = null;
      if (s.hands.every((h) => h.length === 0)) {
        const lead = s.lastTrick[0].cards;
        const largest = Math.max(...components(lead, s.level, s.trump).map((x) => x.length));
        const mult = 2 ** (largest === 1 ? 1 : largest / 2 + 1);
        if (s.winner % 2 !== s.dealer % 2) s.points += score(s.kitty) * mult;
        const attack = s.points >= 80;
        const team = attack ? 1 - (s.dealer % 2) : s.dealer % 2;
        const up = attack
          ? Math.floor((s.points - 80) / 40)
          : s.points <= 0
            ? 3
            : s.points < 40
              ? 2
              : 1;
        s.levels[team] =
          s.options.rounds === 0
            ? 2 + ((s.levels[team] - 2 + up) % 13)
            : Math.min(14, s.levels[team] + up);
        s.result = `闲家 ${s.points} 分 · ${attack ? '闲家上台' : '庄家保庄'} · ${up ? `升${up}级` : '不升级'}${s.winner % 2 !== s.dealer % 2 ? ` · 扣底×${mult}` : ''}`;
        s.dealer = (s.dealer + (attack ? 1 : 2)) % 4;
        s.phase = s.options.rounds > 0 && s.round >= s.options.rounds ? 'matchOver' : 'roundOver';
      } else {
        s.phase = 'play';
        s.turn = s.winner;
      }
      return s;
    }
    if (a.type === 'pass' || a.type === 'reveal') {
      s.declarationAcknowledged ??= [[], [], [], []];
      s.declarationAcknowledged[seat] = [
        ...new Set([
          ...s.declarationAcknowledged[seat],
          ...declarationChoices(tractor.view(prev, seat))
            .map((o) => o.token)
            .filter(Boolean),
        ]),
      ];
      if (a.type === 'reveal') {
        const cards = s.hands[seat].filter((c) => a.cards.includes(c.id));
        s.bid = { seat, strength: bidStrength(cards, s.level), cards };
        s.declarationHistory = [...(s.declarationHistory ?? []), { seat, cards }];
        s.publicReveals = [...(s.publicReveals ?? []), { seat, cards }];
        s.trump = cards[0].suit === 'J' ? 'J' : cards[0].suit;
        s.passes = 0;
        s.ready = []; // Reconsider a changed public contract once, not forever after passing.
        if (s.round === 1 && !prev.bid) s.dealer = seat;
      } else if (!s.ready.includes(seat)) s.ready.push(seat);
      return s;
    }
    let cards = s.hands[seat].filter((c) => a.cards.includes(c.id));
    if (a.type === 'play' && !s.trick.length && !shape(cards, s.level, s.trump)) {
      const failed = failedThrow(s, seat, cards);
      if (failed) {
        s.throwFailure = {
          seat,
          challenger: failed.seat,
          attempted: cards,
          forced: failed.cards,
          penalty: (cards.length - failed.cards.length) * 10,
        };
        s.points += s.throwFailure.penalty * (seat % 2 === s.dealer % 2 ? 1 : -1);
        cards = failed.cards;
      }
    }
    s.hands[seat] = s.hands[seat].filter((c) => !cards.some((x) => x.id === c.id));
    if (a.type === 'bury') {
      s.kitty = cards;
      s.phase = 'play';
      s.turn = s.dealer;
      return s;
    }
    s.trick.push({ seat, cards });
    s.turn = (seat + 1) % 4;
    if (s.trick.length === 4) {
      s.playedHistory = [...(s.playedHistory ?? []), clone(s.trick)];
      s.winner = currentTrickWinner(s.trick, s.level, s.trump)!;
      if (s.winner % 2 !== s.dealer % 2) s.points += score(s.trick.flatMap((p) => p.cards));
      s.lastTrick = s.trick;
      s.phase = 'trickOver';
    }
    return s;
  },
  view(s, seat) {
    const {
      hands,
      rng: _rng,
      drawPile: _drawPile,
      declarationAcknowledged: _ack,
      kitty,
      ...pub
    } = s;
    return {
      ...clone(pub),
      declarationHistory: ['dealing', 'reveal'].includes(s.phase)
        ? clone(s.declarationHistory ?? (s.bid ? [{ seat: s.bid.seat, cards: s.bid.cards }] : []))
        : [],
      seat,
      declarations: declarationChoices({ ...s, hand: seat === null ? [] : hands[seat] }),
      awaitingDeclaration: seat !== null && awaitingDeclaration(s, seat),
      hand: seat === null ? [] : clone(hands[seat]),
      handCounts: hands.map((h) => h.length),
      kitty:
        s.phase === 'roundOver' ||
        s.phase === 'matchOver' ||
        (seat === s.dealer && !['dealing', 'reveal'].includes(s.phase))
          ? clone(kitty)
          : [],
    };
  },
  humanTimeoutEnabled: (s) => !['dealing', 'reveal'].includes(s.phase),
  automatedActionEnabled: (s, seat) =>
    !['dealing', 'reveal'].includes(s.phase) || !s.ready.includes(seat),
  automationBlocked: (s, humans) => humans.some((seat) => awaitingDeclaration(s, seat)),
  isOver: (s) => s.phase === 'matchOver',
  autoAdvance: (s) =>
    s.phase === 'dealing'
      ? { delayMs: 450, action: { type: 'deal' } }
      : s.phase === 'reveal'
        ? { delayMs: 2400, action: { type: 'closeReveal' } }
        : s.phase === 'trickOver'
          ? { delayMs: 1400, action: { type: 'continue' } }
          : null,
  bot(v) {
    return recommend(v);
  },
};
export const score = (cards: Card[]) =>
  cards.reduce((n, c) => n + (c.rank === 5 ? 5 : c.rank === 10 || c.rank === 13 ? 10 : 0), 0);
// Follow-selection and shape comparison are shared by server validation and view-only bots.
const compare = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
};
export function bestPairs(
  cards: Card[],
  n: number,
  level: number,
  trump: Suit,
  demands: number[] = [n],
): Card[][] {
  const ps = pairs(cards);
  const take = Math.min(n, ps.length);
  if (!demands.length || take === ps.length) return ps.slice(0, take);
  const ceiling = obligation(ps, demands, (c) => power(c, level, trump));
  let best: Card[][] = [];
  let sig: number[] = [];
  let done = false;
  function visit(i: number, picked: Card[][]) {
    if (done) return;
    if (picked.length === take) {
      const x = obligation(picked, demands, (c) => power(c, level, trump));
      if (!best.length || compare(x, sig) > 0) {
        best = [...picked];
        sig = x;
        done = compare(x, ceiling) === 0;
      }
      return;
    }
    if (ps.length - i < take - picked.length) return;
    for (let j = i; j < ps.length; j++) visit(j + 1, [...picked, ps[j]]);
  }
  visit(0, []);
  return best;
}
export function followError(
  hand: Card[],
  cards: Card[],
  lead: Card[],
  level: number,
  trump: Suit,
): string | null {
  if (!lead.length)
    return cards.length &&
      cards.every((c) => effective(c, level, trump) === effective(cards[0], level, trump))
      ? null
      : '领牌或甩牌须全部同门（主牌视为一门）';
  if (cards.length !== lead.length) return `本墩须出${lead.length}张`;
  const suit = effective(lead[0], level, trump);
  const own = hand.filter((c) => effective(c, level, trump) === suit);
  const chosen = cards.filter((c) => effective(c, level, trump) === suit);
  if (chosen.length !== Math.min(own.length, lead.length))
    return '必须先跟足领出花色（级牌和王属于主牌）';
  const parts = components(lead, level, trump);
  const pairCount = parts.reduce((n, p) => n + Math.floor(p.length / 2), 0);
  const demands = parts.filter((p) => p.length > 2).map((p) => p.length / 2);
  if (pairCount > 0) {
    const count = Math.min(pairs(own).length, pairCount);
    if (pairs(chosen).length < count) return '有对必须尽量跟对';
    if (
      demands.length &&
      compareVector(
        obligation(pairs(chosen), demands, (c) => power(c, level, trump)),
        obligation(bestPairs(own, pairCount, level, trump, demands), demands, (c) =>
          power(c, level, trump),
        ),
      ) < 0
    )
      return '必须优先跟最长拖拉机，再跟对子';
  }
  return null;
}
function beats(cards: Card[], best: Card[], lead: Card[], level: number, trump: Suit) {
  if (
    cards.length !== lead.length ||
    !cards.length ||
    cards.some((c) => effective(c, level, trump) !== effective(cards[0], level, trump))
  )
    return false;
  const parts = components(lead, level, trump);
  const cp = coverPower(cards, parts, (c) => power(c, level, trump));
  if (cp === null) return false;
  const suit = effective(cards[0], level, trump),
    bs = effective(best[0], level, trump),
    ls = effective(lead[0], level, trump);
  if (suit !== ls && suit !== 'J') return false;
  if (bs === 'J' && suit !== 'J') return false;
  if (suit === 'J' && bs !== 'J') return true;
  const bp = coverPower(best, parts, (c) => power(c, level, trump));
  return bp === null || cp > bp;
}
/** Public-only provisional winner. The exact same comparison settles completed tricks. */
export function currentTrickWinner(
  trick: readonly Play[],
  level: number,
  trump: Suit,
): number | null {
  if (!trick.length) return null;
  let best = trick[0];
  for (const p of trick.slice(1))
    if (beats(p.cards, best.cards, trick[0].cards, level, trump)) best = p;
  return best.seat;
}
export function recommend(v: TractorView): TractorAction {
  return strategicPlay(v);
}
/** Deterministic legal fallback, also used to seed bounded strategic candidates. */
export function basicRecommend(v: TractorView): TractorAction {
  if (v.phase === 'roundOver') return { type: 'continue' };
  const hand = [...v.hand].sort(
    (a, b) =>
      score([a]) - score([b]) ||
      power(a, v.level, v.trump) - power(b, v.level, v.trump) ||
      a.id - b.id,
  );
  if (v.phase === 'reveal' || v.phase === 'dealing') {
    const candidates = [...pairs(hand), ...hand.map((c) => [c])].filter(
      (c) => bidStrength(c, v.level) > (v.bid?.strength ?? 0),
    );
    return candidates.length
      ? { type: 'reveal', cards: candidates[0].map((c) => c.id) }
      : { type: 'pass' };
  }
  if (v.phase === 'bury') return { type: 'bury', cards: hand.slice(0, 8).map((c) => c.id) };
  const lead = v.trick[0]?.cards;
  if (!lead) {
    const ps = pairs(hand);
    for (const p of ps)
      for (const q of ps)
        if (shape([...p, ...q], v.level, v.trump) === 'tractor')
          return { type: 'play', cards: [...p, ...q].map((c) => c.id) };
    return { type: 'play', cards: (ps[0] ?? [hand[0]]).map((c) => c.id) };
  }
  const own = hand.filter(
    (c) => effective(c, v.level, v.trump) === effective(lead[0], v.level, v.trump),
  );
  if (v.throwFailure?.challenger === v.seat) {
    const forced = v.throwFailure.forced;
    const candidates =
      forced.length === 1
        ? own.map((c) => [c])
        : forced.length === 2
          ? pairs(own)
          : runs(pairs(own), forced.length / 2, (c) => power(c, v.level, v.trump));
    const beating = candidates.find((x) => beats(x, forced, forced, v.level, v.trump));
    if (beating) return { type: 'play', cards: beating.map((c) => c.id) };
  }
  if (v.trick.length === 3 && currentTrickWinner(v.trick, v.level, v.trump)! % 2 === v.seat! % 2) {
    const feed = [...own].sort((a, b) => score([b]) - score([a]));
    if (lead.length === 1 && feed.length) return { type: 'play', cards: [feed[0].id] };
  }
  const parts = components(lead, v.level, v.trump);
  const n = parts.reduce((sum, p) => sum + Math.floor(p.length / 2), 0);
  const selected = n
    ? bestPairs(
        own,
        n,
        v.level,
        v.trump,
        parts.filter((p) => p.length > 2).map((p) => p.length / 2),
      ).flat()
    : [];
  for (const c of [...own, ...hand])
    if (selected.length < lead.length && !selected.some((x) => x.id === c.id)) selected.push(c);
  return { type: 'play', cards: selected.map((c) => c.id) };
}
export {
  thinkTractor,
  sampleSmartBeliefs,
  isPubliclySafeThrow,
  type ThinkOptions,
  type ThinkDiagnostics,
} from './think';
