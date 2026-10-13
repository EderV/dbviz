/**
 * Orthogonal router: used between schema boxes (obstacles = schema boxes)
 * and inside each schema (obstacles = table cards, bounded by the box).
 *
 * Routes are found with A* on a sparse orthogonal grid whose lines are the
 * obstacle boundaries (offset by a margin), gutter centre lines, and the
 * route's own endpoints. Cost = length + a penalty per bend, so routes are
 * short and calm. Afterwards, `nudge` spreads segments that share a gutter
 * over separate tracks so parallel routes never collapse into one line.
 */
import type { Point, Rect } from './types';

export type Side = 'W' | 'E';

export interface RouteRequest {
  id: string;
  start: Point;
  startSide: Side;
  end: Point;
  endSide: Side;
}

export interface RouterOptions {
  margin: number;
  bendPenalty: number;
  /** Spacing between parallel tracks in a shared gutter. */
  trackSpacing: number;
}

export const DEFAULT_ROUTER_OPTIONS: RouterOptions = { margin: 16, bendPenalty: 60, trackSpacing: 9 };

interface Obstacle {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const out = (side: Side) => (side === 'W' ? -1 : 1);

export function routeAll(requests: RouteRequest[], rects: Rect[], options: RouterOptions = DEFAULT_ROUTER_OPTIONS, bounds?: Rect): Map<string, Point[]> {
  const m = options.margin;
  const inX = (v: number) => !bounds || (v >= bounds.x && v <= bounds.x + bounds.width);
  const inY = (v: number) => !bounds || (v >= bounds.y && v <= bounds.y + bounds.height);
  // Test rects are shrunk slightly so grid lines on the margin boundary are walkable.
  const obstacles: Obstacle[] = rects.map((r) => ({ x0: r.x - m + 0.5, y0: r.y - m + 0.5, x1: r.x + r.width + m - 0.5, y1: r.y + r.height + m - 0.5 }));
  const baseXs = withMidlines(rects.flatMap((r) => [r.x - m, r.x + r.width + m]).filter(inX));
  const baseYs = withMidlines(rects.flatMap((r) => [r.y - m, r.y + r.height + m]).filter(inY));

  const routes = new Map<string, Point[]>();
  for (const req of requests) {
    const s: Point = { x: Math.round(req.start.x + out(req.startSide) * (m + 4)), y: Math.round(req.start.y) };
    const e: Point = { x: Math.round(req.end.x + out(req.endSide) * (m + 4)), y: Math.round(req.end.y) };
    const path = astar(s, e, mergeSorted(baseXs, [s.x, e.x]), mergeSorted(baseYs, [s.y, e.y]), obstacles, options.bendPenalty);
    routes.set(req.id, simplify([req.start, ...(path ?? [s, { x: s.x, y: e.y }, e]), req.end]));
  }
  nudge(routes, rects, options);
  for (const [id, pts] of routes) routes.set(id, simplify(pts));
  return routes;
}

function withMidlines(values: number[]): number[] {
  const sorted = [...new Set(values.map((v) => Math.round(v)))].sort((a, b) => a - b);
  const result = [...sorted];
  for (let i = 0; i + 1 < sorted.length; i++) {
    if (sorted[i + 1] - sorted[i] > 30) result.push(Math.round((sorted[i] + sorted[i + 1]) / 2));
  }
  return result.sort((a, b) => a - b);
}

function mergeSorted(base: number[], extra: number[]): number[] {
  const set = new Set(base);
  for (const v of extra) set.add(v);
  return [...set].sort((a, b) => a - b);
}

function pointBlocked(x: number, y: number, obs: Obstacle[]): boolean {
  for (const o of obs) if (x > o.x0 && x < o.x1 && y > o.y0 && y < o.y1) return true;
  return false;
}

function segmentBlocked(ax: number, ay: number, bx: number, by: number, obs: Obstacle[]): boolean {
  const x0 = Math.min(ax, bx);
  const x1 = Math.max(ax, bx);
  const y0 = Math.min(ay, by);
  const y1 = Math.max(ay, by);
  for (const o of obs) {
    if (ay === by) {
      if (ay > o.y0 && ay < o.y1 && x1 > o.x0 && x0 < o.x1) return true;
    } else if (ax > o.x0 && ax < o.x1 && y1 > o.y0 && y0 < o.y1) return true;
  }
  return false;
}

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size() {
    return this.keys.length;
  }
  push(k: number, v: number) {
    const keys = this.keys;
    const vals = this.vals;
    let i = keys.length;
    keys.push(k);
    vals.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= k) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = k;
    vals[i] = v;
  }
  pop(): number {
    const keys = this.keys;
    const vals = this.vals;
    const top = vals[0];
    const lk = keys.pop()!;
    const lv = vals.pop()!;
    if (keys.length > 0) {
      let i = 0;
      const n = keys.length;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && keys[r] < keys[l] ? r : l;
        if (keys[c] >= lk) break;
        keys[i] = keys[c];
        vals[i] = vals[c];
        i = c;
      }
      keys[i] = lk;
      vals[i] = lv;
    }
    return top;
  }
}

/** A* over grid states (xi, yi, axis); axis 0 = horizontal, 1 = vertical. */
function astar(s: Point, e: Point, xs: number[], ys: number[], obs: Obstacle[], bend: number): Point[] | null {
  const nx = xs.length;
  const ny = ys.length;
  const sx = xs.indexOf(s.x);
  const sy = ys.indexOf(s.y);
  const ex = xs.indexOf(e.x);
  const ey = ys.indexOf(e.y);
  const total = nx * ny * 2;
  const g = new Float64Array(total).fill(Infinity);
  const from = new Int32Array(total).fill(-1);
  const heap = new MinHeap();
  const idx = (xi: number, yi: number, axis: number) => ((yi * nx + xi) << 1) | axis;
  const h = (xi: number, yi: number) => Math.abs(xs[xi] - e.x) + Math.abs(ys[yi] - e.y);

  const start = idx(sx, sy, 0); // leaving the port horizontally
  g[start] = 0;
  heap.push(h(sx, sy), start);
  let goal = -1;
  let expansions = 0;
  while (heap.size > 0) {
    const cur = heap.pop();
    const axis = cur & 1;
    const cell = cur >> 1;
    const xi = cell % nx;
    const yi = (cell - xi) / nx;
    if (xi === ex && yi === ey) {
      goal = cur;
      break;
    }
    if (++expansions > 200000) break;
    const gc = g[cur];
    const dirs = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 1],
      [0, -1, 1],
    ];
    for (const [dx, dy, na] of dirs) {
      const tx = xi + dx;
      const ty = yi + dy;
      if (tx < 0 || ty < 0 || tx >= nx || ty >= ny) continue;
      const px = xs[tx];
      const py = ys[ty];
      if (pointBlocked(px, py, obs)) continue;
      if (segmentBlocked(xs[xi], ys[yi], px, py, obs)) continue;
      let cost = gc + Math.abs(px - xs[xi]) + Math.abs(py - ys[yi]);
      if (na !== axis) cost += bend;
      // Arriving at the end vertically means one more bend into the horizontal stub.
      if (tx === ex && ty === ey && na === 1) cost += bend;
      const ni = idx(tx, ty, na);
      if (cost < g[ni]) {
        g[ni] = cost;
        from[ni] = cur;
        heap.push(cost + h(tx, ty), ni);
      }
    }
  }
  if (goal < 0) return null;
  const pts: Point[] = [];
  for (let c = goal; c >= 0; c = from[c]) {
    const cell = c >> 1;
    const xi = cell % nx;
    pts.push({ x: xs[xi], y: ys[(cell - xi) / nx] });
  }
  return pts.reverse();
}

export function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2];
      const b = out[out.length - 1];
      const collinear = (Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - p.x) < 0.01) || (Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - p.y) < 0.01);
      if (collinear) {
        out[out.length - 1] = p;
        continue;
      }
    }
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Nudging
// ---------------------------------------------------------------------------

interface SegRef {
  route: string;
  k: number;
  /** Fixed coordinate (x for vertical segments, y for horizontal). */
  at: number;
  lo: number;
  hi: number;
  channelLo: number;
  channelHi: number;
  key: number;
}

/**
 * Spreads parallel segments that share a gutter ("channel") across evenly
 * spaced tracks. A channel is the free interval between the nearest
 * obstacles on either side of a segment.
 */
function nudge(routes: Map<string, Point[]>, rects: Rect[], options: RouterOptions) {
  for (const axis of ['v', 'h'] as const) {
    const segs: SegRef[] = [];
    for (const [route, pts] of routes) {
      for (let k = 1; k + 2 < pts.length; k++) {
        const a = pts[k];
        const b = pts[k + 1];
        const vertical = Math.abs(a.x - b.x) < 0.01;
        if ((axis === 'v') !== vertical) continue;
        const at = vertical ? a.x : a.y;
        const lo = vertical ? Math.min(a.y, b.y) : Math.min(a.x, b.x);
        const hi = vertical ? Math.max(a.y, b.y) : Math.max(a.x, b.x);
        let channelLo = at - 400;
        let channelHi = at + 400;
        for (const r of rects) {
          const r0 = vertical ? r.x : r.y;
          const r1 = vertical ? r.x + r.width : r.y + r.height;
          const s0 = vertical ? r.y : r.x;
          const s1 = vertical ? r.y + r.height : r.x + r.width;
          if (s1 <= lo || s0 >= hi) continue;
          if (r1 <= at + 0.5) channelLo = Math.max(channelLo, r1);
          if (r0 >= at - 0.5) channelHi = Math.min(channelHi, r0);
        }
        // Ordering key: where the route comes from and goes to on the other axis.
        const prev = pts[k - 1];
        const next = pts[k + 2];
        const key = vertical ? (prev.x + next.x) / 2 : (prev.y + next.y) / 2;
        segs.push({ route, k, at, lo, hi, channelLo, channelHi, key });
      }
    }
    // Cluster: same channel and overlapping extent.
    const byChannel = new Map<string, SegRef[]>();
    for (const s of segs) {
      const id = `${Math.round(s.channelLo)}|${Math.round(s.channelHi)}`;
      const list = byChannel.get(id);
      if (list) list.push(s);
      else byChannel.set(id, [s]);
    }
    for (const list of byChannel.values()) {
      list.sort((a, b) => a.lo - b.lo);
      let cluster: SegRef[] = [];
      let reach = -Infinity;
      const flush = () => {
        if (cluster.length > 0) assignTracks(cluster, routes, axis, options);
        cluster = [];
      };
      for (const s of list) {
        if (s.lo > reach + 1) flush();
        cluster.push(s);
        reach = Math.max(reach, s.hi);
      }
      flush();
    }
  }
}

function assignTracks(cluster: SegRef[], routes: Map<string, Point[]>, axis: 'v' | 'h', options: RouterOptions) {
  const lo = Math.max(...cluster.map((s) => s.channelLo));
  const hi = Math.min(...cluster.map((s) => s.channelHi));
  const width = hi - lo;
  if (width <= 4) return;
  // Segments of the same route never need separate tracks from themselves.
  const ordered = [...cluster].sort((a, b) => a.key - b.key || a.lo - b.lo);
  const n = ordered.length;
  const spacing = Math.min(options.trackSpacing, (width - 2 * options.margin * 0.6) / Math.max(1, n));
  const centre = (lo + hi) / 2;
  ordered.forEach((s, i) => {
    const target = centre + (i - (n - 1) / 2) * Math.max(2, spacing);
    const pts = routes.get(s.route)!;
    const a = pts[s.k];
    const b = pts[s.k + 1];
    if (axis === 'v') {
      // Never pull the first/last vertical leg back behind its port.
      if (s.k === 1 && !legal(pts[0].x, pts[1].x, target)) return;
      if (s.k + 2 === pts.length - 1 && !legal(pts[pts.length - 1].x, pts[pts.length - 2].x, target)) return;
      a.x = target;
      b.x = target;
    } else {
      a.y = target;
      b.y = target;
    }
  });
}

/** The leg must stay on the outward side of its port by at least 8px. */
function legal(portX: number, originalX: number, target: number): boolean {
  const dir = Math.sign(originalX - portX);
  return (target - portX) * dir >= 8;
}
