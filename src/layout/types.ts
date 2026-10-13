/**
 * Layout engine contract.
 *
 * An engine receives the normalized model plus view options and returns pure
 * geometry. It knows nothing about React, SVG or the DOM, so engines can be
 * benchmarked in Node, run in a Web Worker, and swapped without touching the
 * renderer.
 */
import type { DatabaseModel, RelationshipId, TableId } from '../domain/model';

export type ColumnMode = 'all' | 'keys' | 'none';

export interface LayoutOptions {
  /** Which columns contribute to card height. */
  columnMode: ColumnMode;
  /** Schemas drawn as a single compact node. */
  collapsedSchemas: string[];
  /** Tables drawn with keys only, regardless of columnMode. */
  collapsedTables: TableId[];
  /** Spacing preset. */
  density: 'compact' | 'comfortable';
}

export const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = {
  columnMode: 'all',
  collapsedSchemas: [],
  collapsedTables: [],
  density: 'comfortable',
};

export interface LayoutInput {
  model: DatabaseModel;
  options: LayoutOptions;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Column widths inside a card, in px. The renderer uses these verbatim. */
export interface CardColumns {
  name: number;
  type: number;
  default: number;
}

export interface LayoutNode extends Rect {
  /** Table id, or `schema:<name>` for a collapsed schema. */
  id: string;
  kind: 'table' | 'collapsed-schema';
  schema: string;
  /** Columns drawn on the card, in order. */
  columns: string[];
  hiddenColumns: number;
  cardColumns: CardColumns;
}

/** A gap drawn where this edge crosses over another edge. */
export interface Bridge {
  x: number;
  y: number;
  /** Orientation of the segment that carries the bridge. */
  axis: 'h' | 'v';
}

export interface LayoutEdge {
  id: string;
  relationshipIds: RelationshipId[];
  /** Child node (owner of the FK). */
  source: string;
  /** Parent node (referenced). */
  target: string;
  sourceColumn?: string;
  targetColumn?: string;
  /** Polyline from the child end to the parent end. */
  points: Point[];
  bridges: Bridge[];
  selfLoop: boolean;
  crossSchema: boolean;
}

export interface SchemaBounds extends Rect {
  schema: string;
  collapsed: boolean;
  tableCount: number;
}

export interface LayoutMetrics {
  edgeCrossings: number;
  /** Edge segments passing through a table they don't belong to. */
  edgeNodeOverlaps: number;
  /** Edge segments passing through a schema box neither endpoint belongs to. */
  edgeSchemaIntrusions: number;
  nodeOverlaps: number;
  schemaOverlaps: number;
  totalEdgeLength: number;
  meanEdgeLength: number;
  bends: number;
  width: number;
  height: number;
  /** Sum of card areas / bounding box area. */
  areaUsage: number;
}

export interface LayoutResult {
  engine: string;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  schemas: SchemaBounds[];
  width: number;
  height: number;
  metrics: LayoutMetrics;
  durationMs: number;
  /** Optional phase timings for diagnostics. */
  timings?: Record<string, number>;
}

export interface LayoutEngine {
  readonly name: string;
  layout(input: LayoutInput): Promise<LayoutResult>;
}
