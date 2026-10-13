/**
 * Model + options → the abstract graph every layout engine lays out.
 *
 * This is where view decisions become graph structure: collapsed schemas
 * become single nodes (with their edges merged), column modes decide card
 * height, and each relationship is pinned to the exact column rows it
 * connects. Engines only see nodes with sizes and edges with anchor rows.
 */
import type { DatabaseModel, TableId } from '../domain/model';
import { COLLAPSED_SCHEMA, measureCard, rowCenterY } from './sizing';
import type { CardColumns, LayoutOptions } from './types';

export interface PreparedNode {
  id: string;
  kind: 'table' | 'collapsed-schema';
  schema: string;
  width: number;
  height: number;
  columns: string[];
  hiddenColumns: number;
  cardColumns: CardColumns;
  /** Index in model declaration order: used as a stable tie-breaker. */
  order: number;
}

export interface PreparedEdge {
  id: string;
  relationshipIds: string[];
  /** Child (FK owner). */
  source: string;
  /** Parent (referenced). */
  target: string;
  sourceColumn?: string;
  targetColumn?: string;
  /** Anchor Y offsets from the top of each card. */
  sourceY: number;
  targetY: number;
  selfLoop: boolean;
  crossSchema: boolean;
}

export interface PreparedSchema {
  name: string;
  nodeIds: string[];
  collapsed: boolean;
  tableCount: number;
}

export interface PreparedGraph {
  nodes: PreparedNode[];
  edges: PreparedEdge[];
  schemas: PreparedSchema[];
}

export const collapsedSchemaId = (schema: string) => `schema:${schema}`;

export function prepareGraph(model: DatabaseModel, options: LayoutOptions): PreparedGraph {
  const collapsedSchemas = new Set(options.collapsedSchemas);
  const collapsedTables = new Set(options.collapsedTables);

  // Columns referenced by any FK stay visible in "keys" mode so the edge has a row to land on.
  const referenced = new Map<TableId, Set<string>>();
  for (const r of model.relationships) {
    const set = referenced.get(r.targetTable) ?? new Set<string>();
    r.targetColumns.forEach((c) => set.add(c));
    referenced.set(r.targetTable, set);
  }

  const nodes: PreparedNode[] = [];
  const nodeOf = new Map<TableId, string>();
  const rowIndex = new Map<string, Map<string, number>>();

  model.tables.forEach((t, order) => {
    if (collapsedSchemas.has(t.schema)) {
      nodeOf.set(t.id, collapsedSchemaId(t.schema));
      return;
    }
    const mode = collapsedTables.has(t.id) ? (options.columnMode === 'none' ? 'none' : 'keys') : options.columnMode;
    const size = measureCard(t, mode, referenced.get(t.id) ?? new Set());
    nodes.push({
      id: t.id,
      kind: 'table',
      schema: t.schema,
      width: size.width,
      height: size.height,
      columns: size.columns.map((c) => c.name),
      hiddenColumns: size.hiddenColumns,
      cardColumns: size.cardColumns,
      order,
    });
    nodeOf.set(t.id, t.id);
    rowIndex.set(t.id, new Map(size.columns.map((c, i) => [c.name, i])));
  });

  const schemas: PreparedSchema[] = model.schemas.map((s) => ({
    name: s.name,
    nodeIds: collapsedSchemas.has(s.name) ? [collapsedSchemaId(s.name)] : s.tableIds.filter((id) => nodeOf.get(id) === id),
    collapsed: collapsedSchemas.has(s.name),
    tableCount: s.tableIds.length,
  }));
  for (const s of schemas) {
    if (!s.collapsed) continue;
    nodes.push({
      id: collapsedSchemaId(s.name),
      kind: 'collapsed-schema',
      schema: s.name,
      width: COLLAPSED_SCHEMA.width,
      height: COLLAPSED_SCHEMA.height,
      columns: [],
      hiddenColumns: 0,
      cardColumns: { name: 0, type: 0, default: 0 },
      order: model.tables.findIndex((t) => t.schema === s.name),
    });
  }

  const anchor = (nodeId: string, column?: string) => {
    if (!column) return rowCenterY(-1);
    const idx = rowIndex.get(nodeId)?.get(column);
    return rowCenterY(idx ?? -1);
  };

  const edges: PreparedEdge[] = [];
  const merged = new Map<string, PreparedEdge>();
  for (const r of model.relationships) {
    const source = nodeOf.get(r.sourceTable);
    const target = nodeOf.get(r.targetTable);
    if (!source || !target) continue;
    const isAggregated = source !== r.sourceTable || target !== r.targetTable;
    if (isAggregated) {
      if (source === target) continue; // internal to a collapsed schema
      const key = `${source}->${target}`;
      const existing = merged.get(key);
      if (existing) {
        existing.relationshipIds.push(r.id);
        continue;
      }
      const sourceColumn = source === r.sourceTable ? r.sourceColumns[0] : undefined;
      const targetColumn = target === r.targetTable ? r.targetColumns[0] : undefined;
      const e: PreparedEdge = {
        id: `agg:${key}`,
        relationshipIds: [r.id],
        source,
        target,
        sourceColumn,
        targetColumn,
        sourceY: source === r.sourceTable ? anchor(source, sourceColumn) : COLLAPSED_SCHEMA.height / 2,
        targetY: target === r.targetTable ? anchor(target, targetColumn) : COLLAPSED_SCHEMA.height / 2,
        selfLoop: false,
        crossSchema: true,
      };
      merged.set(key, e);
      edges.push(e);
      continue;
    }
    const sourceColumn = rowIndex.get(source)?.has(r.sourceColumns[0]) ? r.sourceColumns[0] : undefined;
    const targetColumn = rowIndex.get(target)?.has(r.targetColumns[0]) ? r.targetColumns[0] : undefined;
    edges.push({
      id: r.id,
      relationshipIds: [r.id],
      source,
      target,
      sourceColumn,
      targetColumn,
      sourceY: anchor(source, sourceColumn),
      targetY: anchor(target, targetColumn),
      selfLoop: r.selfReference,
      crossSchema: r.crossSchema,
    });
  }

  return { nodes, edges, schemas: schemas.filter((s) => s.nodeIds.length > 0) };
}
