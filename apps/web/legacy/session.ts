import { doudizhu, type DdzAction } from '../../../packages/engine/src/games/doudizhu';
import { Rng } from '../../../packages/engine/src/core/rng';

/** Local-only adapter: all legality, scoring and bot choices belong to the shared engine. */
export class LegacySession {
  private rng: Rng;
  private state;
  constructor(seed: number) {
    this.rng = new Rng(seed);
    this.state = doudizhu.setup({
      seed,
      options: doudizhu.defaultOptions,
      players: [
        { name: '我', isBot: false },
        { name: '电脑一', isBot: true },
        { name: '电脑二', isBot: true },
      ],
    });
  }
  get view() {
    return doudizhu.view(this.state, 0);
  }
  act(action: DdzAction): string | null {
    return this.apply(0, action);
  }
  private apply(seat: number, action: DdzAction): string | null {
    if (!doudizhu.activeSeats(this.state).includes(seat)) return '还没有轮到你';
    const error = doudizhu.validate(this.state, seat, action);
    if (error) return error;
    this.state = doudizhu.apply(this.state, seat, action);
    return null;
  }
  hint(): DdzAction {
    return doudizhu.bot(this.view, 0, this.rng);
  }
  stepBot(): boolean {
    const seat = doudizhu.activeSeats(this.state).find((s) => s !== 0);
    if (seat === undefined) return false;
    const error = this.apply(seat, doudizhu.bot(doudizhu.view(this.state, seat), seat, this.rng));
    if (error) throw new Error(error);
    return true;
  }
}
