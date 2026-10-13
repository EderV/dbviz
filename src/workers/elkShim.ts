/**
 * elk.bundled.js decides at load time whether it *is* a web worker
 * (`typeof document === 'undefined'`), and if so turns itself into a
 * message server instead of exporting its in-process engine. We want the
 * in-process engine inside our own worker, so a dummy `document` is
 * present while ELK loads. Must be the worker's first import; removed again
 * once the engine is constructed (ELK requires its engine lazily).
 */
const g = globalThis as { document?: unknown };
if (typeof g.document === 'undefined') g.document = { __dbvizElkShim: true };
export {};
