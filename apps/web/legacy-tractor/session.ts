import {
  tractor,
  pairs,
  type TractorAction,
  type TractorView,
} from '../../../packages/engine/src/games/tractor';
import { parseCheckpoint } from './checkpoint';
import { Rng } from '../../../packages/engine/src/core/rng';

/** Local host only: bots receive the same redacted views as online players. */
export class LegacyTractorSession {
  private rng: Rng;
  private state;
  private version = 0;
  constructor(seed: number) {
    this.rng = new Rng(seed);
    this.state = tractor.setup({
      seed,
      options: tractor.defaultOptions,
      players: ['我', '松', '竹', '梅'].map((name, seat) => ({ name, isBot: seat !== 0 })),
    });
  }
  /** Versioned, private local-host checkpoint; never a public replay or network payload. */
  serialize() {
    return JSON.stringify({
      format: 'deskpark-legacy-tractor',
      version: 1,
      state: this.state,
      rng: this.rng.state,
      acknowledged: [...this.acknowledged],
      acknowledgedRound: this.acknowledgedRound,
      publicReveals: this.publicReveals,
    });
  }
  static restore(text: string) {
    const saved = parseCheckpoint(text);
    const game = new LegacyTractorSession(0);
    game.state = saved.state;
    game.rng = new Rng(saved.rng);
    game.acknowledged = new Set(saved.acknowledged);
    game.acknowledgedRound = saved.acknowledgedRound;
    game.publicReveals = saved.publicReveals;
    return game;
  }
  get view() {
    return tractor.view(this.state, 0);
  }
  get isHumanActive() {
    return tractor.activeSeats(this.state).includes(0);
  }
  private acknowledged = new Set<string>();
  private acknowledgedRound = 1;
  /** Fixed panel, derived only from human cards; legality belongs to the shared engine. */
  get declarations() {
    const hand = this.view.hand;
    const candidates = [...pairs(hand), ...hand.map((c) => [c])];
    return (['S', 'H', 'C', 'D', 'J'] as const).map((suit) => {
      const legal = candidates.filter(
        (cards) =>
          cards[0].suit === suit &&
          !tractor.validate(this.state, 0, { type: 'reveal', cards: cards.map((c) => c.id) }),
      );
      legal.sort((a, b) => b.length - a.length || b[0].rank - a[0].rank);
      const best = legal[0];
      return {
        suit,
        cards: best?.map((c) => c.id) ?? [],
        label: !best
          ? '暂不可亮'
          : suit === 'J'
            ? best[0].rank === 17
              ? '大王对'
              : '小王对'
            : best.length === 2
              ? '级牌对'
              : '单级牌',
        token: best ? `${suit}:${best[0].rank}:${best.length}` : '',
      };
    });
  }
  get awaitingDeclaration() {
    if (this.acknowledgedRound !== this.state.round) {
      this.acknowledged.clear();
      this.acknowledgedRound = this.state.round;
    }
    return this.declarations.some((o) => o.token && !this.acknowledged.has(o.token));
  }
  skipDeclaration() {
    for (const o of this.declarations) if (o.token) this.acknowledged.add(o.token);
  }
  act(action: TractorAction): string | null {
    const error = tractor.validate(this.state, 0, action);
    if (error) return error;
    if (action.type === 'reveal' || action.type === 'pass') this.skipDeclaration();
    return this.apply(0, action);
  }
  get delayMs() {
    return this.state.phase === 'dealing'
      ? 450
      : (tractor.autoAdvance?.(this.state)?.delayMs ?? 650);
  }
  private publicReveals: NonNullable<TractorView['bid']>[] = [];
  get revealedDeclarations() {
    return this.publicReveals;
  }
  private apply(seat: number, action: TractorAction): string | null {
    const error = tractor.validate(this.state, seat, action);
    if (error) return error;
    const round = this.state.round;
    this.state = tractor.apply(this.state, seat, action);
    this.version++;
    if (round !== this.state.round) {
      this.acknowledged.clear();
      this.acknowledgedRound = this.state.round;
    }
    // Capture only accepted PUBLIC announcements; never look at another hand.
    if (round !== this.state.round || !['dealing', 'reveal'].includes(this.state.phase)) {
      this.publicReveals = [];
    } else if (action.type === 'reveal') {
      const bid = this.view.bid;
      if (bid)
        this.publicReveals = [
          ...this.publicReveals.filter((b) => b.seat !== bid.seat),
          { ...bid, cards: bid.cards.map((c) => ({ ...c })) },
        ];
    }
    return null;
  }
  step(): boolean {
    // This guard is before EVERY automated action, including computer overcalls.
    if (this.awaitingDeclaration) return false;
    if (this.state.phase === 'dealing' || this.state.phase === 'reveal') {
      for (const seat of [1, 2, 3]) {
        const action = tractor.bot(tractor.view(this.state, seat), seat, this.rng);
        if (action.type === 'reveal') {
          const error = this.apply(seat, action);
          if (error) throw new Error(error);
        }
      }
    }
    const auto = tractor.autoAdvance?.(this.state);
    if (auto) {
      const error = this.apply(-1, auto.action);
      if (error) throw new Error(error);
      return true;
    }
    const seat = tractor.activeSeats(this.state).find((s) => s !== 0);
    if (seat === undefined) return false;
    const action = tractor.bot(tractor.view(this.state, seat), seat, this.rng);
    const error = this.apply(seat, action);
    if (error) throw new Error(error);
    return true;
  }
  /** Inspect whether the next step is a computer bury/play suitable for async Mac mini search. */
  peekPendingBot(): { seat: number; view: TractorView; version: number } | null {
    if (this.awaitingDeclaration) return null;
    if (this.state.phase !== 'bury' && this.state.phase !== 'play') return null;
    if (tractor.autoAdvance?.(this.state)) return null;
    const seat = tractor.activeSeats(this.state).find((s) => s !== 0);
    if (seat === undefined) return null;
    return { seat, view: tractor.view(this.state, seat), version: this.version };
  }
  /** Apply an async bot decision if still current & legal, otherwise fall back safely to local bot. */
  applyBotDecision(seat: number, expectedVersion: number, candidate: unknown): boolean {
    if (this.awaitingDeclaration) return false;
    if (this.version !== expectedVersion) return false;
    if (seat === 0 || !tractor.activeSeats(this.state).includes(seat)) return false;
    const isStructured =
      !!candidate &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate) &&
      typeof (candidate as { type?: unknown }).type === 'string';
    if (isStructured && !tractor.validate(this.state, seat, candidate as TractorAction)) {
      return this.apply(seat, candidate as TractorAction) === null;
    }
    const fallback = tractor.bot(tractor.view(this.state, seat), seat, this.rng);
    const error = this.apply(seat, fallback);
    if (error) throw new Error(error);
    return true;
  }
}
