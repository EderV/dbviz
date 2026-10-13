/// <reference lib="webworker" />
/**
 * Off-main-thread pipeline: SQL → model (libpg-query, WASM) → layout (ELK +
 * router). The UI thread never blocks on parsing or layout, and the last
 * model is cached so view changes only re-run the layout stage.
 */
import './elkShim';
import wasmUrl from 'libpg-query/wasm/libpg-query.wasm?url';
import { SchemaAwareEngine } from '../layout/elk/schemaAwareEngine';
import type { LayoutEngine } from '../layout/types';
import { createLibpgQueryParser, type PgParserPort } from '../parser/pgParser';
import { parseSql } from '../parser/parseSql';
import type { DatabaseModel } from '../domain/model';
import type { PipelineRequest, PipelineResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;


// The emscripten loader fetches `<worker dir>/libpg-query.wasm`; in a bundled
// app the asset lives elsewhere, so redirect that one request to Vite's URL.
// Must be installed before libpg-query is imported (it instantiates on import).
const nativeFetch = self.fetch.bind(self);
self.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return nativeFetch(url.endsWith('libpg-query.wasm') ? wasmUrl : input, init);
}) as typeof fetch;

let parserPromise: Promise<PgParserPort> | undefined;
// ELK resolves its in-process engine on construction; only then drop the shim.
const engine: LayoutEngine = new SchemaAwareEngine();
if ((globalThis as { document?: { __dbvizElkShim?: boolean } }).document?.__dbvizElkShim) delete (globalThis as { document?: unknown }).document;
let lastModel: DatabaseModel | undefined;
// Layouts are queued so a stale request never overwrites a newer result.
let latest = 0;

const post = (msg: PipelineResponse) => self.postMessage(msg);

self.onmessage = async (event: MessageEvent<PipelineRequest>) => {
  const req = event.data;
  latest = req.id;
  try {
    if (req.kind === 'process') {
      if (!parserPromise) {
        post({ kind: 'progress', id: req.id, phase: 'loading-parser' });
        parserPromise = createLibpgQueryParser();
      }
      const parser = await parserPromise;
      if (req.id !== latest) return;
      post({ kind: 'progress', id: req.id, phase: 'parsing' });
      const parse = parseSql(req.sql, parser);
      lastModel = parse.model;
      post({ kind: 'parsed', id: req.id, parse });
    }
    if (!lastModel) throw new Error('Nothing parsed yet.');
    if (req.id !== latest) return;
    post({ kind: 'progress', id: req.id, phase: 'layout' });
    const layout = await engine.layout({ model: lastModel, options: req.options });
    if (req.id !== latest) return;
    post({ kind: 'laidOut', id: req.id, layout });
  } catch (err) {
    post({ kind: 'failed', id: req.id, error: err instanceof Error ? err.message : String(err) });
  }
};
