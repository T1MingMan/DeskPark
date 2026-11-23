import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlayingCard } from '../legacy-tractor/PlayingCard';

describe('isolated Tractor joker artwork', () => {
  it('renders red big and black small as SVG artwork, not visible words, while retaining accessible names', () => {
    for (const rank of [16, 17]) {
      const html = renderToStaticMarkup(
        createElement(PlayingCard, { card: { id: rank, suit: 'J', rank } }),
      );
      expect(html).toContain('role="img"');
      expect(html).toContain(`aria-label="${rank === 17 ? '大王' : '小王'}"`);
      expect(html).toContain(rank === 17 ? 'is-big' : 'is-small');
      expect(html).toContain('<svg');
      expect(html.replace(/<[^>]*>/g, '')).toBe('');
    }
  });
});
