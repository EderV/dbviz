# dbviz

Paste or open a PostgreSQL `.sql` file (hand-written DDL or a raw `pg_dump --schema-only`) and get a readable ER diagram. Everything runs in the browser tab: no backend, no upload, your SQL never leaves the machine.

The focus is **automatic layout quality**: schemas as visual groups, orthogonal relationship lines attached to the exact FK column rows, no lines through tables, bridges at crossings, and sane handling of hubs, chains, self-references, parallel FKs and cross-schema references.

## Run it

```bash
npm install
npm run dev              # http://localhost:5173
```

```bash
npm test                 # parser, graph and layout tests (vitest)
npm run typecheck
npm run build            # production build → dist/
npm run preview          # serve dist/
npm run fixtures         # regenerate synthetic fixtures
npm run bench:layout                     # layout quality metrics on 20 → 300 table stress cases
npm run bench:layout -- --svg out        # … plus debug SVG snapshots per case
npm run bench:layout -- --case xl-300    # one case
```

Requires Node 20+. Tested in Chromium; the parser uses WebAssembly and module workers (all evergreen browsers).

## Using it

- **Generate**: button or `Ctrl/⌘ + Enter` in the editor. Open/drop a `.sql` file (or a `.dbviz.json` project). *Examples* loads the fixtures.
- **Navigate**: wheel to zoom, drag to pan, `F` to fit, `/` to search tables and columns (Enter centres and highlights), double-click a table to centre it, `Esc` to clear selection.
- **Select** a table to highlight its relationships, dim the rest and open the inspector (all columns, full defaults, enums, indexes, checks, FK constraint names, jump to source).
- **Hover** a line for constraint name, columns, cardinality and `ON DELETE`.
- **Schemas panel**: collapse a schema into one box (re-layout), hide it, or focus on it. **Filters**: related to the selection (1–3 hops), highly connected tables, orphans.
- **Cards**: *All cols / Keys / Names* changes what cards show; *Airy / Dense* changes spacing. Zoomed out, cards switch to name-only.
- **Manual layout**: drag tables; *Lock* in the inspector pins one. *Auto layout* re-runs the engine and discards unlocked moves.
- **Errors**: syntax errors are reported with line/column and an excerpt, underlined in the editor, click to jump. Every other statement is still drawn; FKs to tables that are missing become dashed *external* tables.
- **Export**: PNG, SVG (fonts embedded, renders the same outside the browser) and project JSON (SQL + options + manual positions + filters).

## Architecture

```
SQL text ──► Parser ──► DatabaseModel ──► Layout engine ──► LayoutResult ──► Renderer / Exporters
             (worker)    (plain data)       (worker)          (geometry)       (React Flow + SVG)
                                                                 ▲
                                    UI state (zustand) ──────────┘  selection, filters, positions, theme
```

Each stage only knows the output of the previous one: the renderer never sees SQL, the layout engine never sees React. All data crossing a boundary is plain structured-clone data.

| Layer | Where | Responsibility |
|---|---|---|
| Domain | `src/domain/model.ts` | `DatabaseModel`: schemas, tables, columns, PK/FK/unique/check, indexes, enums, comments, source positions. |
| Parser | `src/parser/` | `splitter` cuts the script into statements (comments, quotes, `E''`, dollar quotes, `BEGIN ATOMIC`, psql meta-commands, `COPY … FROM stdin` data). Each statement is parsed by **libpg-query** (PostgreSQL's real grammar compiled to WASM) behind the `PgParserPort` interface. `ModelBuilder` folds the ASTs into the model (inline + `ALTER TABLE` constraints, `search_path`, comments, renames…) and resolves FKs at the end. |
| Layout | `src/layout/` | `prepare` turns model + view options into sized nodes and anchored edges (card sizes are exact arithmetic, see below). `LayoutEngine` is the replaceable port; `SchemaAwareEngine` is the production engine; `ElkCompoundEngine` is kept as a baseline for the benchmark. |
| View queries | `src/view/graphQueries.ts` | Neighbourhoods, hubs, filters, search: pure functions, unit-tested. |
| Render | `src/render/` | Edge geometry (routed path with rounded corners and bridges, crow's-foot markers, fallback connector for moved tables) and design tokens, shared by the live view and the exporters, so both draw identical output. |
| Worker | `src/workers/` | Parse + layout run off the main thread; the last model is cached so view changes only re-run layout; stale requests are dropped. The UI talks to it through `pipelineClient.ts`. |
| UI | `src/ui/` | React + React Flow (viewport, zoom, pan, drag, culling). Tables are React Flow nodes; lines and schema backgrounds are one SVG layer under the cards. State is split into slices, and every component subscribes to the smallest selector it needs (a hover re-renders one card and its lines, not the diagram). |
| Export | `src/export/` | SVG from model + layout + positions + theme (not from the DOM), PNG via canvas, project JSON. |

### Why these choices

- **libpg-query, not a JS SQL parser.** It is the actual PostgreSQL parser, so anything `pg_dump` emits parses (GRANT, functions, `COPY`, partitions, generated columns…) and error positions match what PostgreSQL itself reports. Pure-JS parsers I evaluated failed on ordinary dump statements. Statements are parsed one by one, so one error costs one statement, not the diagram.
- **Exact card sizes without the DOM.** Cards use JetBrains Mono, whose advance width is exactly 0.6em, so widths and row positions are computed in the worker. Layout runs before anything is rendered, and every line lands exactly on its column row.
- **React Flow only for the viewport.** It gives smooth zoom/pan/drag and culling, but its edge/handle system is bypassed: the router already knows exact anchors, and one SVG layer with memoised paths is far cheaper for 1000 lines.

## The layout engine (`SchemaAwareEngine`)

A single hierarchical ELK run was the starting point. Measured on the stress cases, it produced long strips of schemas and routed cross-schema lines around the whole diagram (15,075 crossings on 300 tables, 19 s). The current engine splits the problem:

1. **Inside each schema**, ELK *layered* (Sugiyama: cycle breaking, layering, crossing minimisation, network-simplex or Brandes–Köpf placement) positions the tables, parents to the left of children. Relationships leaving the schema are dummy nodes pinned to the first/last layer on the side facing the partner schema, which pulls those tables toward the right border. Orphan tables are shelf-packed into one block. Chains longer than ~9 layers wrap into rows.
2. **Schema boxes** are placed by stress majorisation (SMACOF) on the schema graph, weighted by FK counts, so heavily linked schemas end up adjacent. Overlaps are then removed while keeping routing gutters, the result is compacted, and disconnected groups are shelf-packed.
3. Sides are chosen from that placement, schemas are laid out again with their ports, and the boxes are re-settled without reshuffling.
4. **Global orthogonal routing** (`gridRouter.ts`): every relationship is routed by A* on one sparse orthogonal grid built from all card boundaries (plus margin), gutter midlines and the exact anchor rows. The cost combines four terms:
   - length;
   - a bend penalty;
   - a penalty for crossing previously routed lines;
   - a penalty for passing through a schema neither end belongs to.

   Short edges are routed first. Blocked cells and segments are precomputed and search arrays are reused, and large diagrams use weighted A*.
5. **Nudging** spreads parallel segments sharing a channel onto separate tracks, so parallel FKs (e.g. six FKs between `handoffs` and `people`) never collapse into one line. **Bridges** are drawn where lines cross.

Self-references loop on the card's right side. Collapsed schemas become single nodes with merged edges. The result is deterministic.

### Benchmark (`npm run bench:layout`, Node, one core)

| case | tables / FKs | time | crossings | lines through tables | schema overlaps |
|---|---|---|---|---|---|
| small-20 | 21 / 30 | 0.8 s | 42 | 0 | 0 |
| medium-50 | 53 / 100 | 1.2 s | ~400 | 0 | 0 |
| large-100 | 106 / 200 | 1.3 s | ~680 | 0 | 0 |
| huge-200 | 210 / 500 | ~6 s | ~6,400 | 0 | 0 |
| xl-300 | 312 / 1000 | ~12 s | ~21,000 | 0 | 0 |

For comparison, the single-pass ELK baseline on xl-300 took 19 s with 15,075 crossings. The synthetic cases are deliberately denser than typical real schemas: the 300-table case averages 6.4 FKs per table with heavy cross-schema traffic. The fixtures are much calmer, e.g. the realistic pg_dump (20 tables) lays out in ~0.2 s with 45 crossings.

The layout tests (`tests/layout.test.ts`) enforce the invariants that make diagrams readable:
- no table or schema overlaps;
- every table inside its schema box;
- orthogonal lines starting and ending on the card border at the exact FK column row;
- no line through a table;
- parallel FKs kept distinct;
- long chains wrapped;
- determinism.

## Fixtures (`fixtures/`)

| file | content |
|---|---|
| `01-simple.sql` | 3 tables, 2 FKs (inline + named table constraint) |
| `02-multi-schema.sql` | 5 schemas, ~30 tables, ~50 FKs |
| `03-complex.sql` | 10 schemas, 116 tables, 220 FKs, pg_dump-style `ALTER TABLE` constraints |
| `04-pathological.sql` | 40-way star, 25-long chain, six parallel FKs, self references, 2- and 3-cycles, a six-way junction, a table with 12 FKs, a 92-column table with very long names |
| `05-pg-dump-realistic.sql` | real dump shape: `SET`, `set_config`, extensions, enums, `$$`/`$_$` functions, sequences, identity and generated columns, partitioned table, quoted mixed-case identifiers, comments, views, `COPY` data, `ALTER TABLE ONLY` PK/unique/FK, composite FKs, partial/GIN/BRIN indexes, triggers, grants |
| `06-with-errors.sql` | two syntax errors and a dangling FK: partial render + diagnostics |

`02`–`04` are generated deterministically by `scripts/generate-fixtures.ts` (`src/testing/synthetic.ts`); the layout benchmark uses the same generator.

## Project layout

```
src/
  domain/      model types
  parser/      splitter, libpg-query port, AST → model
  layout/      prepare, sizing, metrics, placement, routers, elk/ engines
  render/      shared edge geometry, theme tokens
  view/        graph queries (filters, search, neighbourhoods)
  export/      SVG / PNG / project file
  workers/     pipeline worker + client
  ui/          React app, components, store, styles
tests/         vitest suites
fixtures/      sample schemas
scripts/       fixture generator, layout benchmark
```

## Known limitations / next steps

- **Dense diagrams.** On 200–300-table diagrams with dense cross-schema traffic, crossings are still high and whitespace is generous. Planned improvements:
  - bundle cross-schema lines that share a parent column;
  - better side choice for stacked tables;
  - tighter schema packing.
- **Layout time.** It grows to ~10 s at 300 tables / 1000 FKs. It runs in a worker with a progress state, so the UI stays responsive, but it is not yet incremental.
- **Dragging.** A dragged table's lines use a simple orthogonal connector rather than a full re-route.
- **Not drawn:** views, materialised views and triggers. They are parsed and counted, but appear only as statements, not diagram objects.
- The project file is designed to be shareable (versioned, plain JSON), but there is no URL sharing yet.
