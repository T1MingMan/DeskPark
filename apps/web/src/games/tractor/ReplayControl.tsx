import { useEffect, useRef, useState } from 'react';
import type { TractorView } from '../../../../../packages/engine/src/games/tractor';
import { downloadReplay, SafeTractorReplay } from './replay';
export function useTractorReplay(view: TractorView | null | undefined) {
  const recorder = useRef<SafeTractorReplay | null>(null);
  if (!recorder.current) recorder.current = new SafeTractorReplay();
  useEffect(() => {
    if (view) recorder.current!.observe(view);
  }, [view]);
  return recorder.current;
}
export function TractorReplayControl({
  recorder,
  enabled,
}: {
  recorder: SafeTractorReplay;
  enabled: boolean;
}) {
  const [text, setText] = useState('');
  return (
    <section aria-label="复盘导出">
      <button
        type="button"
        className="quiet"
        disabled={!enabled}
        style={{
          minHeight: 44,
          color: '#183c32',
          background: '#e7d18e',
          border: '1px solid #68785f',
        }}
        onClick={() => {
          setText(recorder.json());
          try {
            downloadReplay(recorder);
          } catch {
            /* Selectable fallback remains available. */
          }
        }}
      >
        保存复盘
      </button>
      <p>
        仅保存本机已看到的过程和自己的手牌，不含对手暗牌。可随时保存问题步骤；后台或重连记录可能不完整。
      </p>
      {text && (
        <details>
          <summary>无法下载？展开复制 JSON</summary>
          <textarea
            aria-label="复盘 JSON"
            readOnly
            value={text}
            onFocus={(e) => e.currentTarget.select()}
            style={{ width: '100%', height: 160, fontSize: 14 }}
          />
        </details>
      )}
    </section>
  );
}
