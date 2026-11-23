import { describe, it, expect } from 'vitest';
import { LegacyTractorSession } from '../legacy-tractor/session';
import { loadLocalGame, saveLocalGame, SAVE_KEY } from '../legacy-tractor/storage';

describe('old Tractor isolated storage', () => {
  it('writes only its independent key and reloads the exact private checkpoint', () => {
    const data = new Map([['deskpark:modern', 'untouched']]);
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => {
        data.set(k, v);
      },
    };
    const game = new LegacyTractorSession(79);
    expect(saveLocalGame(game, () => storage)).toBe(true);
    expect(loadLocalGame(() => storage)).toEqual({ text: game.serialize(), issue: '' });
    expect(data.get('deskpark:modern')).toBe('untouched');
    expect(data.size).toBe(2);
    expect(SAVE_KEY).toContain('legacy-tractor');
  });
  it('does not delete malformed or future saves and handles inaccessible/read/quota/silent write failures', () => {
    for (const text of ['{', '{"version":900}']) {
      const storage = {
        getItem: () => text,
        setItem: () => {
          throw Error('must not write');
        },
      };
      expect(loadLocalGame(() => storage)).toEqual({ text, issue: 'invalid' });
    }
    const blocked = () => {
      throw Error('SecurityError');
    };
    expect(loadLocalGame(blocked).issue).toBe('unavailable');
    expect(saveLocalGame(new LegacyTractorSession(1), blocked)).toBe(false);
    expect(
      saveLocalGame(new LegacyTractorSession(1), () => ({
        getItem: () => null,
        setItem: () => {},
      })),
    ).toBe(false);
  });
});
