import type { DelegateContext, Table } from '@park/engine';

const BUDGET_MS = 360;
const HARD_TIMEOUT_MS = 1200;

let endpointUnavailable = false;
let unavailableResetTimer: ReturnType<typeof setTimeout> | null = null;

function markUnavailableTemporarily(): void {
  endpointUnavailable = true;
  if (unavailableResetTimer) clearTimeout(unavailableResetTimer);
  unavailableResetTimer = setTimeout(() => {
    endpointUnavailable = false;
    unavailableResetTimer = null;
  }, 30_000);
}

/**
 * Same-origin Mac mini bot decision delegate for modern single-player Table.
 * Sends ONLY the seat's redacted `view`; falls back silently to local rule bot
 * on timeout, offline, or missing endpoint without blocking UI or raising errors.
 */
export function serverBotTurn(
  table: Table,
  seat: number,
  ctx: DelegateContext,
): Promise<unknown> | null {
  if (table.def.meta.id !== 'tractor') return null;
  if (endpointUnavailable || typeof fetch !== 'function') return null;

  const view = table.view(seat) as { phase?: string };
  if (!view || (view.phase !== 'bury' && view.phase !== 'play')) {
    return null;
  }

  const ctrl = new AbortController();
  let cancelledByTable = false;
  ctx.onCancel(() => {
    cancelledByTable = true;
    ctrl.abort();
  });

  const timer = setTimeout(() => ctrl.abort(), HARD_TIMEOUT_MS);

  return fetch('/api/bot/decide', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      gameId: 'tractor',
      view,
      budgetMs: BUDGET_MS,
      version: table.version,
    }),
    signal: ctrl.signal,
  })
    .then(async (res) => {
      clearTimeout(timer);
      if (res.status === 404) {
        markUnavailableTemporarily();
        return table.botAction(seat);
      }
      if (!res.ok) return table.botAction(seat);
      const data = (await res.json()) as { ok?: boolean; action?: unknown };
      return data?.ok && data.action ? data.action : table.botAction(seat);
    })
    .catch((err) => {
      clearTimeout(timer);
      if (cancelledByTable) throw err;
      return table.botAction(seat);
    });
}
