import {
  PlayingCard as SharedPlayingCard,
  type PlayingCardProps,
} from '../src/components/PlayingCard';
import { JesterIcon } from '../src/components/Suit';

/** Old Tractor artwork only; shared cards and other clients remain byte-identical. */
export function PlayingCard(props: PlayingCardProps) {
  const { card, className = '', selected, dim, highlight, faceDown, ...rest } = props;
  if (!card || faceDown || card.suit !== 'J') return <SharedPlayingCard {...props} />;
  const big = card.rank === 17;
  return (
    <div
      {...rest}
      className={`pcard pcard--joker ${big ? 'is-big' : 'is-small'} ${selected ? 'is-selected' : ''} ${dim ? 'is-dim' : ''} ${highlight ? 'is-highlight' : ''} ${className}`}
      data-suit="J"
      role="img"
      aria-label={big ? '大王' : '小王'}
    >
      <JesterIcon className="joker-art" />
    </div>
  );
}
