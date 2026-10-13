/**
 * Application state.
 *
 * Kept deliberately in separate slices — source (SQL), model (parse result),
 * geometry (layout + manual positions), interaction (selection, hover,
 * filters) and view (theme, panels) — so a hover never touches layout data
 * and components subscribe to exactly the slice they draw.
 */
import { create } from 'zustand';
import type { TableId } from '../../domain/model';
import { parseProject, serializeProject } from '../../export/project';
import { DEFAULT_LAYOUT_OPTIONS, type LayoutOptions, type LayoutResult } from '../../layout/types';
import type { ParseResult } from '../../parser/types';
import { buildGraphIndex, NO_FILTERS, relatedWithin, type Filters, type GraphIndex } from '../../view/graphQueries';
import { createPipeline, type Pipeline } from '../../workers/pipelineClient';
import type { PipelinePhase } from '../../workers/protocol';

export type Theme = 'light' | 'dark';
type Pos = { x: number; y: number };

export interface AppState {
  // source
  sql: string;
  docName: string;
  dirty: boolean;
  // pipeline
  status: 'idle' | 'working' | 'ready' | 'error';
  phase?: PipelinePhase;
  error?: string;
  parse: ParseResult | null;
  index: GraphIndex | null;
  // geometry
  layout: LayoutResult | null;
  layoutOptions: LayoutOptions;
  positions: Record<string, Pos>;
  locked: Record<string, true>;
  // interaction
  selected: TableId | null;
  /** Column highlighted on the selected card (search hit). */
  selectedColumn: string | null;
  related: Set<TableId> | null;
  hovered: TableId | null;
  hoveredEdge: string | null;
  filters: Filters;
  // requests consumed by the diagram (nonce-based so repeats fire)
  focusRequest: { id: string; nonce: number } | null;
  fitRequest: number;
  editorJump: { offset: number; nonce: number } | null;
  // view
  theme: Theme;
  mobileTab: 'sql' | 'diagram';
  inspectorOpen: boolean;

  setSql(sql: string): void;
  generate(): void;
  loadSql(sql: string, name: string): void;
  setLayoutOptions(patch: Partial<LayoutOptions>): void;
  toggleSchemaCollapsed(schema: string): void;
  autoLayout(): void;
  moveNode(id: string, pos: Pos): void;
  toggleLock(id: string): void;
  select(id: TableId | null, center?: boolean, column?: string): void;
  hover(id: TableId | null): void;
  hoverEdge(id: string | null): void;
  setFilters(patch: Partial<Filters>): void;
  clearFilters(): void;
  requestFit(): void;
  focusOn(id: string): void;
  jumpToSource(offset: number): void;
  setTheme(theme: Theme): void;
  setMobileTab(tab: 'sql' | 'diagram'): void;
  setInspectorOpen(open: boolean): void;
  exportProject(): string;
  importProject(text: string): void;
}

const initialTheme = (): Theme => {
  try {
    const saved = localStorage.getItem('dbviz:theme') ?? localStorage.getItem('pgviz:theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* storage unavailable */
  }
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

let pipeline: Pipeline | undefined;
/** Positions to apply after the next layout (project import). */
let pendingPositions: { positions: Record<string, Pos>; locked: string[] } | undefined;

export const useApp = create<AppState>((set, get) => {
  const getPipeline = () =>
    (pipeline ??= createPipeline({
      onPhase: (phase) => set({ phase, status: 'working' }),
      onParsed: (parse) => {
        const index = buildGraphIndex(parse.model);
        const s = get();
        const stillThere = s.selected && index.neighbors.has(s.selected) ? s.selected : null;
        set({ parse, index, selected: stillThere, related: stillThere ? relatedWithin(index, stillThere, 1) : null });
      },
      onLayout: (layout) => {
        const s = get();
        let positions: Record<string, Pos>;
        let locked = s.locked;
        if (pendingPositions) {
          positions = pendingPositions.positions;
          locked = Object.fromEntries(pendingPositions.locked.map((id) => [id, true as const]));
          pendingPositions = undefined;
        } else {
          // A fresh layout keeps only pinned (locked) tables where the user put them.
          positions = Object.fromEntries(Object.entries(s.positions).filter(([id]) => s.locked[id]));
        }
        const firstLayout = !s.layout;
        set({ layout, positions, locked, status: 'ready', phase: undefined, error: undefined });
        if (firstLayout || s.dirty) set({ fitRequest: s.fitRequest + 1, dirty: false });
      },
      onError: (error) => set({ status: 'error', error, phase: undefined }),
    }));

  return {
    sql: '',
    docName: 'schema.sql',
    dirty: false,
    status: 'idle',
    parse: null,
    index: null,
    layout: null,
    layoutOptions: DEFAULT_LAYOUT_OPTIONS,
    positions: {},
    locked: {},
    selected: null,
    selectedColumn: null,
    related: null,
    hovered: null,
    hoveredEdge: null,
    filters: NO_FILTERS,
    focusRequest: null,
    fitRequest: 0,
    editorJump: null,
    theme: initialTheme(),
    mobileTab: 'sql',
    inspectorOpen: true,

    setSql: (sql) => set({ sql }),
    generate: () => {
      const { sql, layoutOptions } = get();
      // Collapsed schemas that no longer exist are dropped by prepare(); fine to keep.
      set({ status: 'working', dirty: true, mobileTab: 'diagram' });
      getPipeline().process(sql, layoutOptions);
    },
    loadSql: (sql, name) => {
      set({ sql, docName: name, positions: {}, locked: {}, selected: null, related: null, filters: NO_FILTERS, layout: null });
      get().generate();
    },
    setLayoutOptions: (patch) => {
      const layoutOptions = { ...get().layoutOptions, ...patch };
      set({ layoutOptions, status: 'working' });
      if (get().parse) getPipeline().relayout(layoutOptions);
    },
    toggleSchemaCollapsed: (schema) => {
      const cur = get().layoutOptions.collapsedSchemas;
      get().setLayoutOptions({ collapsedSchemas: cur.includes(schema) ? cur.filter((s) => s !== schema) : [...cur, schema] });
    },
    autoLayout: () => {
      set({ positions: {}, locked: {}, dirty: true });
      if (get().parse) {
        set({ status: 'working' });
        getPipeline().relayout(get().layoutOptions);
      }
    },
    moveNode: (id, pos) => set((s) => ({ positions: { ...s.positions, [id]: pos } })),
    toggleLock: (id) =>
      set((s) => {
        const locked = { ...s.locked };
        if (locked[id]) delete locked[id];
        else locked[id] = true;
        return { locked };
      }),
    select: (id, center, column) => {
      const index = get().index;
      set({ selected: id, selectedColumn: column ?? null, related: id && index ? relatedWithin(index, id, 1) : null, inspectorOpen: id ? true : get().inspectorOpen });
      if (id && center) get().focusOn(id);
    },
    hover: (id) => {
      if (get().hovered !== id) set({ hovered: id });
    },
    hoverEdge: (id) => {
      if (get().hoveredEdge !== id) set({ hoveredEdge: id });
    },
    setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch }, fitRequest: s.fitRequest + 1 })),
    clearFilters: () => set((s) => ({ filters: NO_FILTERS, fitRequest: s.fitRequest + 1 })),
    requestFit: () => set((s) => ({ fitRequest: s.fitRequest + 1 })),
    focusOn: (id) => set((s) => ({ focusRequest: { id, nonce: (s.focusRequest?.nonce ?? 0) + 1 }, mobileTab: 'diagram' })),
    jumpToSource: (offset) => set((s) => ({ editorJump: { offset, nonce: (s.editorJump?.nonce ?? 0) + 1 }, mobileTab: 'sql' })),
    setTheme: (theme) => {
      try {
        localStorage.setItem('dbviz:theme', theme);
      } catch {
        /* ignore */
      }
      set({ theme });
    },
    // The canvas was display:none while hidden, so re-fit when it appears.
    setMobileTab: (mobileTab) => set((s) => ({ mobileTab, fitRequest: mobileTab === 'diagram' && s.mobileTab !== 'diagram' ? s.fitRequest + 1 : s.fitRequest })),
    setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),

    exportProject: () => {
      const s = get();
      return serializeProject({
        name: s.docName.replace(/\.sql$/i, ''),
        sql: s.sql,
        layoutOptions: s.layoutOptions,
        positions: s.positions,
        locked: Object.keys(s.locked),
        filters: s.filters,
      });
    },
    importProject: (text) => {
      const p = parseProject(text);
      pendingPositions = { positions: p.positions, locked: p.locked };
      set({ sql: p.sql, docName: `${p.name}.sql`, layoutOptions: p.layoutOptions, filters: p.filters, selected: null, related: null, layout: null });
      get().generate();
    },
  };
});

/** Current top-left of a node: manual override or layout position. */
export function nodePosition(state: Pick<AppState, 'positions'>, node: { id: string; x: number; y: number }): Pos {
  return state.positions[node.id] ?? { x: node.x, y: node.y };
}
