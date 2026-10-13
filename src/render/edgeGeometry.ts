/**
 * Edge geometry shared by the live diagram and the SVG exporter, so both
 * draw byte-for-byte the same lines.
 */
import type { Bridge, LayoutEdge, LayoutNode, Point } from '../layout/types';

type Pos = { x: number; y: number };

const moved = (n: LayoutNode, p: Pos | undefined) => !!p && (Math.abs(p.x - n.x) > 0.5 || Math.abs(p.y - n.y) > 0.5);

export interface ResolvedEdge {
  points: Point[];
  bridges: Bridge[];
  /** True when the routed layout geometry is used (not a fallback). */
  routed: boolean;
}

/**
 * Points for an edge given current (possibly manually moved) node positions.
 * Untouched edges use the router's result. If an endpoint was dragged, a
 * simple orthogonal connector is drawn from the same column rows.
 */
export function resolveEdge(edge: LayoutEdge, source: LayoutNode, target: LayoutNode, sourcePos?: Pos, targetPos?: Pos): ResolvedEdge {
  const sMoved = moved(source, sourcePos);
  const tMoved = moved(target, targetPos);
  if (!sMoved && !tMoved) return { points: edge.points, bridges: edge.bridges, routed: true };
  const first = edge.points[0];
  const last = edge.points[edge.points.length - 1];
  const sy = (first?.y ?? source.y + 17) - source.y;
  const ty = (last?.y ?? target.y + 17) - target.y;
  const s = { x: sourcePos?.x ?? source.x, y: (sourcePos?.y ?? source.y) + sy, w: source.width };
  const t = { x: targetPos?.x ?? target.x, y: (targetPos?.y ?? target.y) + ty, w: target.width };
  return { points: orthogonalConnector(s, t, edge.selfLoop), bridges: [], routed: false };
}

function orthogonalConnector(s: { x: number; y: number; w: number }, t: { x: number; y: number; w: number }, selfLoop: boolean): Point[] {
  const stub = 22;
  if (selfLoop) {
    const x = s.x + s.w;
    return [
      { x, y: s.y },
      { x: x + stub, y: s.y },
      { x: x + stub, y: t.y },
      { x, y: t.y },
    ];
  }
  if (s.x >= t.x + t.w + stub) {
    const mid = (s.x + t.x + t.w) / 2;
    return [
      { x: s.x, y: s.y },
      { x: mid, y: s.y },
      { x: mid, y: t.y },
      { x: t.x + t.w, y: t.y },
    ];
  }
  if (s.x + s.w + stub <= t.x) {
    const mid = (s.x + s.w + t.x) / 2;
    return [
      { x: s.x + s.w, y: s.y },
      { x: mid, y: s.y },
      { x: mid, y: t.y },
      { x: t.x, y: t.y },
    ];
  }
  // Overlapping horizontally: loop around the right side.
  const x = Math.max(s.x + s.w, t.x + t.w) + stub;
  return [
    { x: s.x + s.w, y: s.y },
    { x, y: s.y },
    { x, y: t.y },
    { x: t.x + t.w, y: t.y },
  ];
}

/**
 * SVG path for an orthogonal polyline with rounded corners and small hops
 * ("bridges") where this edge passes over another one.
 */
export function edgePathD(points: Point[], bridges: Bridge[], corner = 6, hop = 5): string {
  if (points.length < 2) return '';
  const parts: string[] = [`M${f(points[0].x)},${f(points[0].y)}`];
  // Precompute where each segment's drawable span starts/ends after corner rounding.
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    const rIn = i > 0 ? Math.min(corner, len / 2, segLen(points[i - 1], a) / 2) : 0;
    const rOut = i + 2 < points.length ? Math.min(corner, len / 2, segLen(b, points[i + 2]) / 2) : 0;
    const dir = { x: Math.sign(b.x - a.x), y: Math.sign(b.y - a.y) };
    const from = { x: a.x + dir.x * rIn, y: a.y + dir.y * rIn };
    const to = { x: b.x - dir.x * rOut, y: b.y - dir.y * rOut };
    if (dir.y === 0 && bridges.length > 0) {
      const hops = bridges
        .filter((br) => br.axis === 'h' && Math.abs(br.y - a.y) < 0.5 && between(br.x, from.x, to.x, hop + 1))
        .sort((p, q) => (q.x - p.x) * -dir.x);
      for (const h of hops) {
        parts.push(`L${f(h.x - dir.x * hop)},${f(a.y)}`);
        parts.push(`A${hop},${hop} 0 0 ${dir.x > 0 ? 1 : 0} ${f(h.x + dir.x * hop)},${f(a.y)}`);
      }
    }
    parts.push(`L${f(to.x)},${f(to.y)}`);
    if (rOut > 0) {
      const c = points[i + 2];
      const d2 = { x: Math.sign(c.x - b.x), y: Math.sign(c.y - b.y) };
      parts.push(`Q${f(b.x)},${f(b.y)} ${f(b.x + d2.x * rOut)},${f(b.y + d2.y * rOut)}`);
    }
  }
  return parts.join(' ');
}

const segLen = (a: Point, b: Point) => Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
const between = (v: number, a: number, b: number, pad: number) => v > Math.min(a, b) + pad && v < Math.max(a, b) - pad;
const f = (v: number) => (Math.round(v * 10) / 10).toString();

export interface EndMarkers {
  /** Crow's foot / bar / circle at the child (FK owner) end. */
  child: string;
  /** Bar(s) at the parent (referenced) end. */
  parent: string;
}

/**
 * Crow's-foot notation drawn as plain path data so it works identically in
 * the DOM and in exported SVG (no <marker> quirks).
 */
export function endMarkers(points: Point[], cardinality: 'one-to-one' | 'many-to-one', optional: boolean): EndMarkers {
  if (points.length < 2) return { child: '', parent: '' };
  const c0 = points[0];
  const c1 = points[1];
  const p0 = points[points.length - 1];
  const p1 = points[points.length - 2];
  // Unit direction pointing *into* the card.
  const cin = { x: Math.sign(c0.x - c1.x) || 1, y: Math.sign(c0.y - c1.y) };
  const pin = { x: Math.sign(p0.x - p1.x) || 1, y: Math.sign(p0.y - p1.y) };
  const child: string[] = [];
  const parent: string[] = [];
  const perp = (d: Pos) => ({ x: -d.y, y: d.x });
  const at = (o: Point, d: Pos, back: number) => ({ x: o.x - d.x * back, y: o.y - d.y * back });

  if (cardinality === 'many-to-one') {
    // Crow's foot: three prongs meeting 12px out from the card edge.
    const tip = at(c0, cin, 12);
    const n = perp(cin);
    child.push(`M${f(tip.x)},${f(tip.y)} L${f(c0.x + n.x * 6)},${f(c0.y + n.y * 6)}`);
    child.push(`M${f(tip.x)},${f(tip.y)} L${f(c0.x - n.x * 6)},${f(c0.y - n.y * 6)}`);
  } else {
    child.push(bar(at(c0, cin, 8), cin));
  }
  if (optional) {
    const o = at(c0, cin, 18);
    child.push(circle(o, 3.2));
  } else {
    child.push(bar(at(c0, cin, 16), cin));
  }
  parent.push(bar(at(p0, pin, 7), pin));
  parent.push(bar(at(p0, pin, 12), pin));
  return { child: child.join(' '), parent: parent.join(' ') };
}

function bar(o: Point, d: Pos, half = 5): string {
  const n = { x: -d.y, y: d.x };
  return `M${f(o.x + n.x * half)},${f(o.y + n.y * half)} L${f(o.x - n.x * half)},${f(o.y - n.y * half)}`;
}

function circle(o: Point, r: number): string {
  return `M${f(o.x - r)},${f(o.y)} a${r},${r} 0 1 0 ${f(r * 2)},0 a${r},${r} 0 1 0 ${f(-r * 2)},0`;
}

/** Bounds of a set of tables (used to redraw schema backgrounds after drags). */
export function boundsOf(rects: { x: number; y: number; width: number; height: number }[], pad: { top: number; side: number; bottom: number }) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  }
  return { x: x0 - pad.side, y: y0 - pad.top, width: x1 - x0 + pad.side * 2, height: y1 - y0 + pad.top + pad.bottom };
}
