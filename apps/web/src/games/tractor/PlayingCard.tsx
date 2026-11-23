import type { Card } from '@park/engine';
import type { CSSProperties } from 'react';
import {
  PlayingCard as SharedPlayingCard,
  type PlayingCardProps,
} from '../../components/PlayingCard';
import { JesterIcon } from '../../components/Suit';

/** Tractor-local artwork; never change shared cards or other games. */
export function PlayingCard(props: PlayingCardProps) {
  const {
    card,
    className = '',
    selected,
    dim,
    highlight,
    faceDown,
    w = 'var(--cw)',
    style,
    ...rest
  } = props;
  if (!card || faceDown || card.suit !== 'J') return <SharedPlayingCard {...props} />;
  const big = card.rank === 17;
  return (
    <div
      {...rest}
      style={{ '--w': w, ...style } as CSSProperties}
      className={`pcard pcard--joker ${big ? 'is-big' : 'is-small'} ${selected ? 'is-selected' : ''} ${dim ? 'is-dim' : ''} ${highlight ? 'is-highlight' : ''} ${className}`}
      data-suit="J"
      role="img"
      aria-label={big ? '大王' : '小王'}
    >
      <JesterIcon className="tractor-joker-art" />
    </div>
  );
}
export function CardRow({ cards, w = 'var(--cw)' }: { cards: Card[]; w?: string }) {
  return (
    <div className="cardrow">
      {cards.map((c) => (
        <PlayingCard key={c.id} card={c} w={w} />
      ))}
    </div>
  );
}
