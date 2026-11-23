import { parentPort } from 'node:worker_threads';
import { tr } from '@park/engine';

export interface WorkerRequest {
  id: number;
  gameId: string;
  view: unknown;
  budgetMs: number;
}

export interface WorkerResponse {
  id: number;
  ok: boolean;
  action?: unknown;
  elapsedMs?: number;
  worlds?: number;
  nodes?: number;
  error?: string;
}

parentPort?.on('message', (msg: WorkerRequest) => {
  const start = performance.now();
  try {
    if (msg.gameId === 'tractor') {
      let worlds = 0;
      let nodes = 0;
      const action = tr.thinkTractor(
        msg.view as tr.TractorView,
        { budgetMs: msg.budgetMs },
        (diag) => {
          worlds = diag.worlds;
          nodes = diag.nodes;
        },
      );
      const reply: WorkerResponse = {
        id: msg.id,
        ok: true,
        action,
        elapsedMs: performance.now() - start,
        worlds,
        nodes,
      };
      parentPort?.postMessage(reply);
      return;
    }
    parentPort?.postMessage({
      id: msg.id,
      ok: false,
      error: `unsupported gameId: ${msg.gameId}`,
    } satisfies WorkerResponse);
  } catch (err) {
    parentPort?.postMessage({
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } satisfies WorkerResponse);
  }
});
