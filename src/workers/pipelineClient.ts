/**
 * UI-side port to the pipeline worker. The rest of the app only sees this
 * interface, never `postMessage`.
 */
import type { LayoutOptions, LayoutResult } from '../layout/types';
import type { ParseResult } from '../parser/types';
import type { PipelinePhase, PipelineRequest, PipelineResponse } from './protocol';

export interface PipelineCallbacks {
  onPhase(phase: PipelinePhase): void;
  onParsed(parse: ParseResult): void;
  onLayout(layout: LayoutResult): void;
  onError(error: string): void;
}

export interface Pipeline {
  process(sql: string, options: LayoutOptions): void;
  relayout(options: LayoutOptions): void;
}

export function createPipeline(callbacks: PipelineCallbacks): Pipeline {
  const worker = new Worker(new URL('./pipeline.worker.ts', import.meta.url), { type: 'module' });
  let seq = 0;
  worker.onmessage = (e: MessageEvent<PipelineResponse>) => {
    const msg = e.data;
    if (msg.id !== seq) return; // superseded
    if (msg.kind === 'progress') callbacks.onPhase(msg.phase);
    else if (msg.kind === 'parsed') callbacks.onParsed(msg.parse);
    else if (msg.kind === 'laidOut') callbacks.onLayout(msg.layout);
    else callbacks.onError(msg.error);
  };
  worker.onerror = (e) => callbacks.onError(e.message || 'Worker crashed');
  type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;
  const send = (req: WithoutId<PipelineRequest>) => worker.postMessage({ ...req, id: ++seq } as PipelineRequest);
  return {
    process: (sql, options) => send({ kind: 'process', sql, options }),
    relayout: (options) => send({ kind: 'relayout', options }),
  };
}
