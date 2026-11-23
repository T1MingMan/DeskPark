import { LegacyTractorSession } from './session';

// Intentionally not the modern site's table/session keys. One slot, this browser/origin only.
export const SAVE_KEY = 'deskpark:legacy-tractor:local:v1';
type Store = Pick<Storage, 'getItem' | 'setItem'>;
const browserStore = () => window.localStorage;
export function loadLocalGame(store: () => Store = browserStore): {
  text: string | null;
  issue: '' | 'invalid' | 'unavailable';
} {
  let text: string | null;
  try {
    text = store().getItem(SAVE_KEY);
  } catch {
    return { text: null, issue: 'unavailable' };
  }
  if (text === null) return { text, issue: '' };
  try {
    LegacyTractorSession.restore(text);
    return { text, issue: '' };
  } catch {
    return { text, issue: 'invalid' };
  }
}
export function saveLocalGame(
  game: LegacyTractorSession,
  store: () => Store = browserStore,
): boolean {
  try {
    const text = game.serialize();
    const storage = store();
    storage.setItem(SAVE_KEY, text);
    return storage.getItem(SAVE_KEY) === text;
  } catch {
    return false;
  }
}
