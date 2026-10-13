/**
 * Objective layout quality metrics.
 *
 * Used by tests (regression guards), by the benchmark script (to compare
 * algorithm variants), and shown in the UI status bar. All edges are
 * treated as polylines of axis-aligned or arbitrary segments.
 */
import type { LayoutEdge, LayoutMetrics, LayoutNode, Point, Rect, SchemaBounds } from './types';

export interface Segment {
  a: Point;
  b: Point;
}

export function segmentsOf(points: Point[]): Segment[] {
  const out: Segment[] = [];
  for (let i = 0; i + 1 < points.length; i++) out.push({ a: points[i], b: points[i + 1] });
  return out;
}

function orient(p: Point, q: Point, r: Point): number {
  return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
}

/** Proper intersection (crossing), ignoring touching endpoints and collinear overlaps. */
export function segmentsCross(s: Segment, t: Segment): boolean {
  const o1 = orient(s.a, s.b, t.a);
  const o2 = orient(s.a, s.b, t.b);
  const o3 = orient(t.a, t.b, s.a);
  const o4 = orient(t.a, t.b, s.b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

/** Does the segment pass through the interior of the rect (shrunk by `inset`)? */
export function segmentHitsRect(s: Segment, r: Rect, inset = 2): boolean {
  const x0 = r.x + inset;
  const y0 = r.y + inset;
  const x1 = r.x + r.width - inset;
  const y1 = r.y + r.height - inset;
  if (x1 <= x0 || y1 <= y0) return false;
  // Liang–Barsky clipping.
  let t0 = 0;
  let t1 = 1;
  const dx = s.b.x - s.a.x;
  const dy = s.b.y - s.a.y;
  const clip = (p: number, q: number) => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  if (!clip(-dx, s.a.x - x0)) return false;
  if (!clip(dx, x1 - s.a.x)) return false;
  if (!clip(-dy, s.a.y - y0)) return false;
  if (!clip(dy, y1 - s.a.y)) return false;
  return t1 - t0 > 1e-6;
}

export function rectsOverlap(a: Rect, b: Rect, margin = 0): boolean {
  return a.x < b.x + b.width + margin && b.x < a.x + a.width + margin && a.y < b.y + b.height + margin && b.y < a.y + a.height + margin;
}

function length(points: Point[]): number {
  let l = 0;
  for (let i = 0; i + 1 < points.length; i++) l += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
  return l;
}

/** Uniform grid over the plane to avoid O(n²) pair tests on large diagrams. */
class SpatialGrid<T> {
  private cells = new Map<string, T[]>();
  constructor(private readonly cell: number) {}
  private keys(r: Rect): string[] {
    const out: string[] = [];
    const x0 = Math.floor(r.x / this.cell);
    const x1 = Math.floor((r.x + r.width) / this.cell);
    const y0 = Math.floor(r.y / this.cell);
    const y1 = Math.floor((r.y + r.height) / this.cell);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(`${x},${y}`);
    return out;
  }
  insert(r: Rect, item: T) {
    for (const k of this.keys(r)) {
      const list = this.cells.get(k);
      if (list) list.push(item);
      else this.cells.set(k, [item]);
    }
  }
  query(r: Rect): Set<T> {
    const out = new Set<T>();
    for (const k of this.keys(r)) for (const item of this.cells.get(k) ?? []) out.add(item);
    return out;
  }
}

export function segmentBox(s: Segment): Rect {
  return { x: Math.min(s.a.x, s.b.x), y: Math.min(s.a.y, s.b.y), width: Math.abs(s.b.x - s.a.x), height: Math.abs(s.b.y - s.a.y) };
}

export function computeMetrics(nodes: LayoutNode[], edges: LayoutEdge[], schemas: SchemaBounds[]): LayoutMetrics {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of [...nodes, ...schemas]) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  if (!Number.isFinite(minX)) {
    minX = minY = 0;
    maxX = maxY = 0;
  }
  const width = maxX - minX;
  const height = maxY - minY;

  const nodeGrid = new SpatialGrid<LayoutNode>(400);
  for (const n of nodes) nodeGrid.insert(n, n);

  let nodeOverlaps = 0;
  for (const n of nodes) {
    for (const m of nodeGrid.query(n)) if (m.id < n.id && rectsOverlap(n, m)) nodeOverlaps++;
  }

  let schemaOverlaps = 0;
  for (let i = 0; i < schemas.length; i++) {
    for (let j = i + 1; j < schemas.length; j++) if (rectsOverlap(schemas[i], schemas[j])) schemaOverlaps++;
  }

  const nodeSchema = new Map(nodes.map((n) => [n.id, n.schema]));
  const segGrid = new SpatialGrid<{ edge: number; seg: Segment }>(400);
  let edgeNodeOverlaps = 0;
  let edgeSchemaIntrusions = 0;
  let bends = 0;
  let total = 0;

  edges.forEach((e, ei) => {
    const segs = segmentsOf(e.points);
    bends += Math.max(0, e.points.length - 2);
    total += length(e.points);
    const endSchemas = new Set([nodeSchema.get(e.source), nodeSchema.get(e.target)]);
    for (const seg of segs) {
      const box = segmentBox(seg);
      segGrid.insert(box, { edge: ei, seg });
      for (const n of nodeGrid.query(box)) {
        if (n.id === e.source || n.id === e.target) continue;
        if (segmentHitsRect(seg, n)) edgeNodeOverlaps++;
      }
      for (const s of schemas) {
        if (endSchemas.has(s.schema)) continue;
        if (segmentHitsRect(seg, s, 6)) edgeSchemaIntrusions++;
      }
    }
  });

  let edgeCrossings = 0;
  edges.forEach((e, ei) => {
    for (const seg of segmentsOf(e.points)) {
      for (const other of segGrid.query(segmentBox(seg))) {
        if (other.edge <= ei) continue;
        if (segmentsCross(seg, other.seg)) edgeCrossings++;
      }
    }
  });

  const cardArea = nodes.reduce((a, n) => a + n.width * n.height, 0);
  return {
    edgeCrossings,
    edgeNodeOverlaps,
    edgeSchemaIntrusions,
    nodeOverlaps,
    schemaOverlaps,
    totalEdgeLength: Math.round(total),
    meanEdgeLength: edges.length > 0 ? Math.round(total / edges.length) : 0,
    bends,
    width: Math.round(width),
    height: Math.round(height),
    areaUsage: width * height > 0 ? Number((cardArea / (width * height)).toFixed(3)) : 0,
  };
}
