/**
 * Pure read-side queries over the model, used by the UI for selection,
 * filters and search. No React, no layout — unit-testable in isolation.
 */
import type { DatabaseModel, TableId } from '../domain/model';

export interface GraphIndex {
  neighbors: Map<TableId, Set<TableId>>;
  degree: Map<TableId, number>;
  /** Relationship ids touching each table. */
  incident: Map<TableId, string[]>;
}

export function buildGraphIndex(model: DatabaseModel): GraphIndex {
  const neighbors = new Map<TableId, Set<TableId>>();
  const degree = new Map<TableId, number>();
  const incident = new Map<TableId, string[]>();
  for (const t of model.tables) {
    neighbors.set(t.id, new Set());
    degree.set(t.id, 0);
    incident.set(t.id, []);
  }
  for (const r of model.relationships) {
    for (const [a, b] of [
      [r.sourceTable, r.targetTable],
      [r.targetTable, r.sourceTable],
    ]) {
      neighbors.get(a)?.add(b);
      incident.get(a)?.push(r.id);
    }
    degree.set(r.sourceTable, (degree.get(r.sourceTable) ?? 0) + 1);
    if (r.targetTable !== r.sourceTable) degree.set(r.targetTable, (degree.get(r.targetTable) ?? 0) + 1);
  }
  return { neighbors, degree, incident };
}

/** Tables within `depth` FK hops of `start` (including it). */
export function relatedWithin(index: GraphIndex, start: TableId, depth: number): Set<TableId> {
  const seen = new Set([start]);
  let frontier = [start];
  for (let d = 0; d < depth; d++) {
    const next: TableId[] = [];
    for (const id of frontier) {
      for (const n of index.neighbors.get(id) ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          next.push(n);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

/** Degree threshold for "highly connected": top ~10%, at least 4 links. */
export function hubThreshold(index: GraphIndex): number {
  const degrees = [...index.degree.values()].sort((a, b) => b - a);
  if (degrees.length === 0) return Infinity;
  return Math.max(4, degrees[Math.floor(degrees.length * 0.1)] ?? 4);
}

export interface Filters {
  hiddenSchemas: string[];
  /** Show only this schema (and nothing else). */
  focusSchema?: string;
  /** Show only tables near this one. */
  relatedTo?: { table: TableId; depth: number };
  orphansOnly: boolean;
  hubsOnly: boolean;
}

export const NO_FILTERS: Filters = { hiddenSchemas: [], orphansOnly: false, hubsOnly: false };

export function isFiltering(f: Filters): boolean {
  return f.hiddenSchemas.length > 0 || !!f.focusSchema || !!f.relatedTo || f.orphansOnly || f.hubsOnly;
}

/** null = everything visible. */
export function visibleTables(model: DatabaseModel, index: GraphIndex, f: Filters): Set<TableId> | null {
  if (!isFiltering(f)) return null;
  const hidden = new Set(f.hiddenSchemas);
  const related = f.relatedTo ? relatedWithin(index, f.relatedTo.table, f.relatedTo.depth) : undefined;
  const hub = f.hubsOnly ? hubThreshold(index) : 0;
  const result = new Set<TableId>();
  for (const t of model.tables) {
    if (hidden.has(t.schema)) continue;
    if (f.focusSchema && t.schema !== f.focusSchema) continue;
    if (related && !related.has(t.id)) continue;
    const deg = index.degree.get(t.id) ?? 0;
    if (f.orphansOnly && deg > 0) continue;
    if (f.hubsOnly && deg < hub) continue;
    result.add(t.id);
  }
  return result;
}

export interface SearchHit {
  kind: 'table' | 'column';
  table: TableId;
  column?: string;
  label: string;
  detail: string;
  score: number;
}

/** Case-insensitive search over table and column names; best matches first. */
export function search(model: DatabaseModel, query: string, limit = 30): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const score = (name: string) => {
    const n = name.toLowerCase();
    if (n === q) return 0;
    if (n.startsWith(q)) return 1;
    if (n.includes(q)) return 2;
    return -1;
  };
  const hits: SearchHit[] = [];
  for (const t of model.tables) {
    const st = Math.min(...[score(t.name), score(t.id)].filter((s) => s >= 0), 99);
    if (st < 99) hits.push({ kind: 'table', table: t.id, label: t.name, detail: t.schema, score: st });
    for (const c of t.columns) {
      const sc = score(c.name);
      if (sc >= 0) hits.push({ kind: 'column', table: t.id, column: c.name, label: c.name, detail: `${t.id} · ${c.type}`, score: sc + 0.5 });
    }
  }
  return hits.sort((a, b) => a.score - b.score || a.label.length - b.label.length || a.detail.localeCompare(b.detail)).slice(0, limit);
}

/** Distinct, calm hues for schema tints; stable by schema order. */
const SCHEMA_HUES = [214, 28, 152, 280, 350, 190, 48, 110, 250, 5, 320, 170];
export const schemaHue = (index: number) => SCHEMA_HUES[index % SCHEMA_HUES.length];
