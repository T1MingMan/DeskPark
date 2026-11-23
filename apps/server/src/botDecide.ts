import type { AnyGame, DelegateContext, Seat, Table } from '@park/engine';
import { tr } from '@park/engine';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { WorkerRequest, WorkerResponse } from './botWorkerEntry';
import { clientIp } from './net';

declare const __BOT_WORKER_CODE__: string | undefined;

const DECIDE_PATH = '/api/bot/decide';
const MAX_BODY_BYTES = 128 * 1024;
const DEFAULT_BUDGET_MS = 360;
const MIN_BUDGET_MS = 50;
const MAX_BUDGET_MS = 600;
const HARD_TIMEOUT_MS = 1000;
const RATE_LIMIT_PER_MIN = 600;

export function isBotDecidePath(url: string | undefined): boolean {
  if (!url) return false;
  const q = url.indexOf('?');
  const path = q >= 0 ? url.slice(0, q) : url;
  return path === DECIDE_PATH;
}

/** Redact any unexpected private fields if a malformed client payload ever includes them. */
function sanitizeTractorView(raw: unknown): tr.TractorView | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  if (typeof src.phase !== 'string' || !Array.isArray(src.hand) || !Array.isArray(src.handCounts)) {
    return null;
  }
  const copy: Record<string, unknown> = { ...src };
  delete copy.hands;
  delete copy.rng;
  delete copy.drawPile;
  delete copy.declarationAcknowledged;
  return copy as unknown as tr.TractorView;
}

/** Verify action structure & view-level legality before returning to caller. */
function isValidTractorDecision(v: tr.TractorView, action: unknown): action is tr.TractorAction {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return false;
  const a = action as { type?: unknown; cards?: unknown };
  if (typeof a.type !== 'string') return false;
  if (a.type === 'pass') return v.phase === 'dealing' || v.phase === 'reveal';
  if (a.type === 'continue') return v.phase === 'roundOver';
  if (a.type !== 'reveal' && a.type !== 'bury' && a.type !== 'play') return false;
  if (!Array.isArray(a.cards) || a.cards.some((id) => !Number.isInteger(id))) return false;
  const ids = a.cards as number[];
  if (new Set(ids).size !== ids.length) return false;
  const cards = v.hand.filter((c) => ids.includes(c.id));
  if (cards.length !== ids.length) return false;
  if (a.type === 'reveal') {
    if (v.phase !== 'dealing' && v.phase !== 'reveal') return false;
    return tr
      .declarationChoices(v)
      .some((ch) => ch.cards.length === ids.length && ch.cards.every((cid) => ids.includes(cid)));
  }
  if (a.type === 'bury') return v.phase === 'bury' && cards.length === 8;
  if (a.type === 'play') {
    if (v.phase !== 'play') return false;
    const lead = v.trick?.[0]?.cards ?? [];
    if (tr.followError(v.hand, cards, lead, v.level, v.trump)) return false;
    if (
      v.throwFailure?.challenger === v.seat &&
      v.seat !== null &&
      tr.currentTrickWinner(
        [
          { seat: -1, cards: v.throwFailure.forced },
          { seat: v.seat, cards },
        ],
        v.level,
        v.trump,
      ) !== v.seat
    ) {
      return false;
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Worker Pool (supports bundled __BOT_WORKER_CODE__ and dev/test fallback)
// ---------------------------------------------------------------------------

interface PendingJob {
  id: number;
  req: WorkerRequest;
  resolve: (res: WorkerResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  cancelled: boolean;
}

interface WorkerSlot {
  worker: Worker;
  busy: PendingJob | null;
}

let cachedDevWorkerCode: Promise<string | null> | null = null;

async function getWorkerEvalCode(): Promise<string | null> {
  if (typeof __BOT_WORKER_CODE__ === 'string' && __BOT_WORKER_CODE__.length > 0) {
    return __BOT_WORKER_CODE__;
  }
  if (!cachedDevWorkerCode) {
    cachedDevWorkerCode = (async () => {
      try {
        const esbuildMod = 'esbuild';
        const { build } = (await import(esbuildMod)) as typeof import('esbuild');
        const entry = fileURLToPath(new URL('./botWorkerEntry.ts', import.meta.url));
        const out = await build({
          entryPoints: [entry],
          bundle: true,
          platform: 'node',
          format: 'cjs',
          target: 'node20',
          write: false,
          logLevel: 'silent',
        });
        return out.outputFiles[0]?.text ?? null;
      } catch {
        return null;
      }
    })();
  }
  return cachedDevWorkerCode;
}

class BotWorkerPool {
  private slots: WorkerSlot[] = [];
  private queue: PendingJob[] = [];
  private seq = 0;
  private disposed = false;
  private initPromise: Promise<boolean> | null = null;
  private readonly size = Math.max(
    1,
    Math.min(2, availableParallelism?.() ? availableParallelism() - 1 : 2),
  );

  private ensureInit(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (!this.initPromise) {
      this.initPromise = getWorkerEvalCode().then((code) => {
        if (!code || this.disposed) return false;
        for (let i = 0; i < this.size; i++) {
          this.spawnSlot(code);
        }
        return this.slots.length > 0;
      });
    }
    return this.initPromise;
  }

  private spawnSlot(code: string): void {
    if (this.disposed) return;
    try {
      const worker = new Worker(code, { eval: true });
      worker.unref();
      const slot: WorkerSlot = { worker, busy: null };
      worker.on('message', (msg: WorkerResponse) => {
        const job = slot.busy;
        if (job && job.id === msg.id) {
          slot.busy = null;
          clearTimeout(job.timer);
          if (!job.cancelled) job.resolve(msg);
        }
        this.pump();
      });
      worker.on('error', (err) => {
        const job = slot.busy;
        slot.busy = null;
        this.removeSlot(slot);
        if (job) {
          clearTimeout(job.timer);
          if (!job.cancelled) job.reject(err instanceof Error ? err : new Error(String(err)));
        }
        if (!this.disposed) this.spawnSlot(code);
        this.pump();
      });
      this.slots.push(slot);
    } catch {
      // Fallback to in-process execution if worker creation is restricted
    }
  }

  private removeSlot(slot: WorkerSlot): void {
    const idx = this.slots.indexOf(slot);
    if (idx >= 0) this.slots.splice(idx, 1);
    slot.worker.terminate().catch(() => {});
  }

  private pump(): void {
    if (this.disposed) return;
    while (this.queue.length > 0) {
      const free = this.slots.find((s) => s.busy === null);
      if (!free) break;
      const next = this.queue.shift()!;
      if (next.cancelled) continue;
      free.busy = next;
      free.worker.postMessage(next.req);
    }
  }

  async run(
    gameId: string,
    view: tr.TractorView,
    budgetMs: number,
    onCancel?: (fn: () => void) => void,
  ): Promise<WorkerResponse> {
    if (this.disposed) throw new Error('bot pool disposed');
    const hasWorkers = await this.ensureInit();
    if (!hasWorkers) {
      // Graceful non-worker fallback with strict budget
      const t0 = performance.now();
      let worlds = 0;
      let nodes = 0;
      const action = tr.thinkTractor(view, { budgetMs }, (d) => {
        worlds = d.worlds;
        nodes = d.nodes;
      });
      return {
        id: 0,
        ok: true,
        action,
        elapsedMs: performance.now() - t0,
        worlds,
        nodes,
      };
    }

    return new Promise<WorkerResponse>((resolve, reject) => {
      const id = ++this.seq;
      const job: PendingJob = {
        id,
        req: { id, gameId, view, budgetMs },
        resolve,
        reject,
        cancelled: false,
        timer: setTimeout(
          () => {
            job.cancelled = true;
            const stuckSlot = this.slots.find((s) => s.busy?.id === id);
            if (stuckSlot) {
              stuckSlot.busy = null;
              getWorkerEvalCode().then((code) => {
                this.removeSlot(stuckSlot);
                if (code && !this.disposed) this.spawnSlot(code);
                this.pump();
              });
            }
            reject(new Error('bot worker timeout'));
          },
          Math.max(HARD_TIMEOUT_MS, budgetMs + 450),
        ),
      };

      onCancel?.(() => {
        if (job.cancelled) return;
        job.cancelled = true;
        clearTimeout(job.timer);
        const qIdx = this.queue.indexOf(job);
        if (qIdx >= 0) this.queue.splice(qIdx, 1);
        reject(new Error('cancelled'));
      });

      this.queue.push(job);
      this.pump();
    });
  }

  async close(): Promise<void> {
    this.disposed = true;
    for (const job of this.queue.splice(0)) {
      clearTimeout(job.timer);
      job.reject(new Error('server closing'));
    }
    const current = this.slots.splice(0);
    for (const s of current) {
      if (s.busy) {
        clearTimeout(s.busy.timer);
        s.busy.reject(new Error('server closing'));
      }
    }
    await Promise.allSettled(current.map((s) => s.worker.terminate()));
  }
}

export function createBotService() {
  const pool = new BotWorkerPool();
  const hits = new Map<string, { start: number; count: number }>();

  function rateLimited(ip: string): boolean {
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || now - h.start > 60_000) {
      hits.set(ip, { start: now, count: 1 });
      if (hits.size > 2000) {
        for (const [k, v] of hits) if (now - v.start > 60_000) hits.delete(k);
      }
      return false;
    }
    return ++h.count > RATE_LIMIT_PER_MIN;
  }

  /** Delegate hook for server-hosted multiplayer Rooms (`Table`). */
  function decideForTable(
    def: AnyGame,
    table: Table,
    seat: Seat,
    ctx: DelegateContext,
  ): Promise<unknown> | null {
    if (def.meta.id !== 'tractor') return null;
    const rawView = table.view(seat) as tr.TractorView;
    // Fast phases (dealing/reveal/roundOver) resolve in <1ms without worker queue overhead
    if (
      rawView.phase === 'dealing' ||
      rawView.phase === 'reveal' ||
      rawView.phase === 'roundOver'
    ) {
      const syncAction = tr.thinkTractor(rawView, { budgetMs: 30 });
      return isValidTractorDecision(rawView, syncAction) ? Promise.resolve(syncAction) : null;
    }
    const budgetMs = DEFAULT_BUDGET_MS;
    return pool
      .run('tractor', rawView, budgetMs, (fn) => ctx.onCancel(fn))
      .then((res) => {
        if (res.ok && isValidTractorDecision(rawView, res.action)) {
          return res.action;
        }
        return tr.recommend(rawView);
      });
  }

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sendJson = (status: number, payload: unknown) => {
      if (res.headersSent) return;
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(JSON.stringify(payload));
    };

    if (req.method !== 'POST') {
      sendJson(405, { ok: false, error: 'Method Not Allowed' });
      return;
    }

    // Enforce same-origin when browser sends Origin / Sec-Fetch-Site headers
    const secSite = req.headers['sec-fetch-site'];
    if (typeof secSite === 'string' && secSite !== 'same-origin' && secSite !== 'none') {
      sendJson(403, { ok: false, error: 'Cross-site requests forbidden' });
      return;
    }
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (typeof origin === 'string' && origin !== 'null' && typeof host === 'string') {
      try {
        if (new URL(origin).host !== host) {
          sendJson(403, { ok: false, error: 'Origin mismatch' });
          return;
        }
      } catch {
        sendJson(403, { ok: false, error: 'Invalid Origin' });
        return;
      }
    }

    const ip = clientIp(req);
    if (rateLimited(ip)) {
      sendJson(429, { ok: false, error: 'Too Many Requests' });
      return;
    }

    let rawBody: string;
    try {
      rawBody = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        req.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_BODY_BYTES) {
            reject(new Error('payload too large'));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
      });
    } catch {
      sendJson(413, { ok: false, error: 'Payload Too Large' });
      return;
    }

    let body: { gameId?: unknown; view?: unknown; budgetMs?: unknown; version?: unknown };
    try {
      body = JSON.parse(rawBody);
    } catch {
      sendJson(400, { ok: false, error: 'Invalid JSON' });
      return;
    }

    if (!body || typeof body !== 'object' || body.gameId !== 'tractor') {
      sendJson(400, { ok: false, error: 'Unsupported gameId' });
      return;
    }

    const view = sanitizeTractorView(body.view);
    if (!view) {
      sendJson(400, { ok: false, error: 'Invalid redacted view' });
      return;
    }

    const reqBudget = Number(body.budgetMs);
    const budgetMs = Number.isFinite(reqBudget)
      ? Math.max(MIN_BUDGET_MS, Math.min(MAX_BUDGET_MS, Math.floor(reqBudget)))
      : DEFAULT_BUDGET_MS;

    let abortFn: (() => void) | null = null;
    res.on('close', () => {
      if (!res.writableEnded) abortFn?.();
    });

    try {
      // Fast sync path for sub-millisecond phases
      if (view.phase === 'dealing' || view.phase === 'reveal' || view.phase === 'roundOver') {
        const action = tr.thinkTractor(view, { budgetMs: 30 });
        const valid = isValidTractorDecision(view, action) ? action : tr.recommend(view);
        sendJson(200, {
          ok: true,
          action: valid,
          version: body.version ?? null,
          fallback: !isValidTractorDecision(view, action),
          elapsedMs: 0,
        });
        return;
      }

      const out = await pool.run('tractor', view, budgetMs, (fn) => {
        abortFn = fn;
      });
      if (out.ok && isValidTractorDecision(view, out.action)) {
        sendJson(200, {
          ok: true,
          action: out.action,
          version: body.version ?? null,
          fallback: false,
          elapsedMs: Math.round((out.elapsedMs ?? 0) * 100) / 100,
          worlds: out.worlds ?? 0,
        });
        return;
      }
      const safeFallback = tr.recommend(view);
      sendJson(200, {
        ok: true,
        action: safeFallback,
        version: body.version ?? null,
        fallback: true,
        elapsedMs: 0,
      });
    } catch {
      if (res.writableEnded || res.destroyed) return;
      try {
        const safeFallback = tr.recommend(view);
        sendJson(200, {
          ok: true,
          action: safeFallback,
          version: body.version ?? null,
          fallback: true,
          elapsedMs: 0,
        });
      } catch {
        sendJson(500, { ok: false, error: 'Decision fallback failed' });
      }
    }
  }

  return {
    decideForTable,
    handleHttp,
    close: () => pool.close(),
  };
}
