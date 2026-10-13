/**
 * Global orthogonal edge router.
 *
 * All relationships are routed on ONE sparse orthogonal visibility grid built
 * from every table card (obstacles, inflated by a margin), gutter midlines
 * and the exact anchor rows of every edge. A* finds, per edge, the cheapest
 * path where
 *
 *   cost = length × region factor + bends × bendPenalty + crossings × crossPenalty
 *
 *  - region factor: passing through a schema box that is neither the
 *    source's nor the target's costs more, so cross-schema edges travel in
 *    the gutters and keep schema groups intact unless a detour is absurd;
 *  - crossings with already-routed edges are penalised, so later edges look
 *    for a crossing-free channel when one exists.
 *
 * Blocked cells and blocked grid segments are precomputed once, and A*
 * bookkeeping arrays are reused between edges with a generation stamp, so
 * routing 1000 edges over 300 tables stays in the low seconds.
 */
import { simplify, type Side } from './router';
import type { Point, Rect } from './types';

export interface GridRouteRequest {
  id: string;
  start: Point;
  startSide: Side;
  end: Point;
  endSide: Side;
  /** Schema regions this edge may cross for free (its own two schemas). */
  regions: number[];
}

export interface GridRouterOptions {
  margin: number;
  bendPenalty: number;
  crossPenalty: number;
  foreignRegionFactor: number;
  trackSpacing: number;
  maxExpansions: number;
  /** Weighted A*: >1 trades optimality for speed. */
  heuristicWeight: number;
}

export const DEFAULT_GRID_ROUTER_OPTIONS: GridRouterOptions = {
  margin: 14,
  bendPenalty: 40,
  crossPenalty: 30,
  foreignRegionFactor: 2.2,
  trackSpacing: 8,
  maxExpansions: 250_000,
  heuristicWeight: 1.4,
};

export const routerStats: { failures: number; expansions: number; unreachable?: number } = { failures: 0, expansions: 0 };

const out = (side: Side) => (side === 'W' ? -1 : 1);

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values.map((v) => Math.round(v)))].sort((a, b) => a - b);
}

function withMidlines(sorted: number[], minGap: number): number[] {
  const result = [...sorted];
  for (let i = 0; i + 1 < sorted.length; i++) {
    if (sorted[i + 1] - sorted[i] > minGap) result.push(Math.round((sorted[i] + sorted[i + 1]) / 2));
  }
  return uniqueSorted(result);
}

/** First index with arr[i] > v. */
function upper(arr: number[], v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] > v) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** First index with arr[i] >= v. */
function lower(arr: number[], v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] >= v) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size() {
    return this.keys.length;
  }
  clear() {
    this.keys.length = 0;
    this.vals.length = 0;
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

export function routeGrid(
  requests: GridRouteRequest[],
  obstacles: Rect[],
  regions: Rect[],
  options: GridRouterOptions = DEFAULT_GRID_ROUTER_OPTIONS,
): Map<string, Point[]> {
  const m = options.margin;
  const stub = m + 4;
  const stubs = requests.map((r) => ({
    s: { x: Math.round(r.start.x + out(r.startSide) * stub), y: Math.round(r.start.y) },
    e: { x: Math.round(r.end.x + out(r.endSide) * stub), y: Math.round(r.end.y) },
  }));

  const xs = withMidlines(
    uniqueSorted([...obstacles.flatMap((o) => [o.x - m, o.x + o.width + m]), ...regions.flatMap((r) => [r.x - m, r.x + r.width + m])]),
    40,
  );
  const ys = withMidlines(
    uniqueSorted([...obstacles.flatMap((o) => [o.y - m, o.y + o.height + m]), ...regions.flatMap((r) => [r.y - m, r.y + r.height + m])]),
    40,
  );
  const allX = uniqueSorted([...xs, ...stubs.flatMap((s) => [s.s.x, s.e.x])]);
  const allY = uniqueSorted([...ys, ...stubs.flatMap((s) => [s.s.y, s.e.y])]);
  const nx = allX.length;
  const ny = allY.length;
  const cells = nx * ny;

  // ---- precomputed blocking -------------------------------------------------
  const blocked = new Uint8Array(cells); // cell centre inside an obstacle
  const hBlocked = new Uint8Array(cells); // segment (xi,yi)→(xi+1,yi)
  const vBlocked = new Uint8Array(cells); // segment (xi,yi)→(xi,yi+1)
  for (const o of obstacles) {
    const x0 = o.x - m + 0.5;
    const x1 = o.x + o.width + m - 0.5;
    const y0 = o.y - m + 0.5;
    const y1 = o.y + o.height + m - 0.5;
    const xa = upper(allX, x0); // first strictly inside
    const xb = lower(allX, x1) - 1; // last strictly inside
    const ya = upper(allY, y0);
    const yb = lower(allY, y1) - 1;
    // Horizontal segments on rows strictly inside, overlapping (x0,x1).
    for (let yi = ya; yi <= yb; yi++) {
      for (let xi = Math.max(0, xa - 1); xi <= Math.min(nx - 2, xb); xi++) hBlocked[yi * nx + xi] = 1;
      for (let xi = xa; xi <= xb; xi++) blocked[yi * nx + xi] = 1;
    }
    for (let xi = xa; xi <= xb; xi++) {
      for (let yi = Math.max(0, ya - 1); yi <= Math.min(ny - 2, yb); yi++) vBlocked[yi * nx + xi] = 1;
    }
  }
  // Region (schema box) of each cell, -1 = gutter.
  const region = new Int16Array(cells).fill(-1);
  regions.forEach((r, ri) => {
    const xa = lower(allX, r.x);
    const xb = upper(allX, r.x + r.width) - 1;
    const ya = lower(allY, r.y);
    const yb = upper(allY, r.y + r.height) - 1;
    for (let yi = ya; yi <= yb; yi++) for (let xi = xa; xi <= xb; xi++) region[yi * nx + xi] = ri;
  });

  // Occupancy by routed edges, for the crossing penalty.
  const hUsed = new Uint16Array(cells);
  const vUsed = new Uint16Array(cells);

  const total = cells * 2;
  const g = new Float64Array(total);
  const from = new Int32Array(total);
  const stamp = new Uint32Array(total);
  let gen = 0;
  const heap = new MinHeap();

  const xIndex = new Map(allX.map((v, i) => [v, i]));
  const yIndex = new Map(allY.map((v, i) => [v, i]));

  const routes = new Map<string, Point[]>();
  // Short edges first: they have few alternatives; long ones can detour.
  const order = requests.map((_, i) => i).sort((a, b) => manhattan(stubs[a]) - manhattan(stubs[b]));

  routerStats.failures = 0;
  routerStats.expansions = 0;
  for (const ri of order) {
    const req = requests[ri];
    const { s, e } = stubs[ri];
    const sx = xIndex.get(s.x)!;
    const sy = yIndex.get(s.y)!;
    const ex = xIndex.get(e.x)!;
    const ey = yIndex.get(e.y)!;
    const free = new Set(req.regions);
    let goal = -1;
    let expansions = 0;
    for (const [hw, cap] of [[options.heuristicWeight, options.maxExpansions], [3, options.maxExpansions * 3]] as const) {
    gen++;
    heap.clear();
    const idx = (xi: number, yi: number, axis: number) => ((yi * nx + xi) << 1) | axis;
    const start = idx(sx, sy, 0);
    stamp[start] = gen;
    g[start] = 0;
    from[start] = -1;
    heap.push(Math.abs(s.x - e.x) + Math.abs(s.y - e.y), start);
    expansions = 0;
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
      if (++expansions > cap) break;
      const gc = g[cur];
      for (let d = 0; d < 4; d++) {
        let tx = xi;
        let ty = yi;
        let segBlocked: number;
        if (d === 0) {
          if (xi + 1 >= nx) continue;
          tx++;
          segBlocked = hBlocked[cell];
        } else if (d === 1) {
          if (xi === 0) continue;
          tx--;
          segBlocked = hBlocked[cell - 1];
        } else if (d === 2) {
          if (yi + 1 >= ny) continue;
          ty++;
          segBlocked = vBlocked[cell];
        } else {
          if (yi === 0) continue;
          ty--;
          segBlocked = vBlocked[cell - nx];
        }
        if (segBlocked) continue;
        const tcell = ty * nx + tx;
        if (blocked[tcell] && !(tx === ex && ty === ey)) continue;
        const na = d < 2 ? 0 : 1;
        const len = Math.abs(allX[tx] - allX[xi]) + Math.abs(allY[ty] - allY[yi]);
        const reg = region[tcell];
        const regFrom = region[cell];
        const foreign = (reg >= 0 && !free.has(reg)) || (regFrom >= 0 && !free.has(regFrom));
        let cost = gc + len * (foreign ? options.foreignRegionFactor : 1);
        if (na !== axis) cost += options.bendPenalty;
        // Crossing an existing route perpendicular to us at the target cell.
        if (na === 0 ? vUsed[tcell] : hUsed[tcell]) cost += options.crossPenalty;
        if (tx === ex && ty === ey && na === 1) cost += options.bendPenalty;
        const ni = (tcell << 1) | na;
        if (stamp[ni] !== gen || cost < g[ni]) {
          stamp[ni] = gen;
          g[ni] = cost;
          from[ni] = cur;
          heap.push(cost + hw * (Math.abs(allX[tx] - e.x) + Math.abs(allY[ty] - e.y)), ni);
        }
      }
    }
    routerStats.expansions += expansions;
    if (goal >= 0) break;
    }
    let path: Point[];
    if (goal >= 0) {
      const cellsOnPath: number[] = [];
      for (let c = goal; c >= 0; c = stamp[c] === gen ? from[c] : -1) cellsOnPath.push(c >> 1);
      cellsOnPath.reverse();
      path = cellsOnPath.map((c) => ({ x: allX[c % nx], y: allY[Math.floor(c / nx)] }));
      for (let k = 0; k + 1 < cellsOnPath.length; k++) {
        const a = cellsOnPath[k];
        const b = cellsOnPath[k + 1];
        const used = Math.abs(a - b) === 1 ? hUsed : vUsed;
        used[a]++;
        used[b]++;
      }
    } else {
      routerStats.failures++;
      if (expansions <= options.maxExpansions * 3) routerStats.unreachable = (routerStats.unreachable ?? 0) + 1;
      path = [s, { x: s.x, y: e.y }, e];
    }
    routes.set(req.id, simplify([req.start, ...path, req.end]));
  }

  nudge(routes, obstacles, options);
  for (const [id, pts] of routes) routes.set(id, simplify(pts));
  return routes;
}

function manhattan(s: { s: Point; e: Point }) {
  return Math.abs(s.s.x - s.e.x) + Math.abs(s.s.y - s.e.y);
}

// ---------------------------------------------------------------------------
// Nudging: spread parallel segments sharing a channel over separate tracks.
// ---------------------------------------------------------------------------

interface SegRef {
  route: string;
  k: number;
  at: number;
  lo: number;
  hi: number;
  channelLo: number;
  channelHi: number;
  key: number;
}

/** Bucketed obstacle index along one axis for fast channel queries. */
function nudge(routes: Map<string, Point[]>, rects: Rect[], options: GridRouterOptions) {
  const CELL = 400;
  for (const axis of ['v', 'h'] as const) {
    const vertical = axis === 'v';
    // Bucket rects by their extent along the segment direction.
    const buckets = new Map<number, Rect[]>();
    for (const r of rects) {
      const s0 = vertical ? r.y : r.x;
      const s1 = vertical ? r.y + r.height : r.x + r.width;
      for (let b = Math.floor(s0 / CELL); b <= Math.floor(s1 / CELL); b++) {
        const list = buckets.get(b);
        if (list) list.push(r);
        else buckets.set(b, [r]);
      }
    }
    const segs: SegRef[] = [];
    for (const [route, pts] of routes) {
      for (let k = 1; k + 2 < pts.length; k++) {
        const a = pts[k];
        const b = pts[k + 1];
        const isVertical = Math.abs(a.x - b.x) < 0.01;
        if (vertical !== isVertical) continue;
        const at = vertical ? a.x : a.y;
        const lo = vertical ? Math.min(a.y, b.y) : Math.min(a.x, b.x);
        const hi = vertical ? Math.max(a.y, b.y) : Math.max(a.x, b.x);
        let channelLo = at - 300;
        let channelHi = at + 300;
        const seen = new Set<Rect>();
        for (let bk = Math.floor(lo / CELL); bk <= Math.floor(hi / CELL); bk++) {
          for (const r of buckets.get(bk) ?? []) {
            if (seen.has(r)) continue;
            seen.add(r);
            const r0 = vertical ? r.x : r.y;
            const r1 = vertical ? r.x + r.width : r.y + r.height;
            const s0 = vertical ? r.y : r.x;
            const s1 = vertical ? r.y + r.height : r.x + r.width;
            if (s1 <= lo || s0 >= hi) continue;
            if (r1 <= at + 0.5) channelLo = Math.max(channelLo, r1);
            if (r0 >= at - 0.5) channelHi = Math.min(channelHi, r0);
          }
        }
        const prev = pts[k - 1];
        const next = pts[k + 2];
        const key = vertical ? (prev.x + next.x) / 2 : (prev.y + next.y) / 2;
        segs.push({ route, k, at, lo, hi, channelLo, channelHi, key });
      }
    }
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
        if (cluster.length > 1) assignTracks(cluster, routes, vertical, options);
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

function assignTracks(cluster: SegRef[], routes: Map<string, Point[]>, vertical: boolean, options: GridRouterOptions) {
  const lo = Math.max(...cluster.map((s) => s.channelLo));
  const hi = Math.min(...cluster.map((s) => s.channelHi));
  const width = hi - lo;
  if (width <= 6) return;
  const ordered = [...cluster].sort((a, b) => a.key - b.key || a.lo - b.lo);
  const n = ordered.length;
  const spacing = Math.max(2, Math.min(options.trackSpacing, (width - 12) / Math.max(1, n)));
  // Keep the group near where the router put it, clamped into the channel.
  const mean = ordered.reduce((a, s) => a + s.at, 0) / n;
  const half = ((n - 1) / 2) * spacing;
  const centre = Math.min(hi - 6 - half, Math.max(lo + 6 + half, mean));
  ordered.forEach((s, i) => {
    const target = centre + (i - (n - 1) / 2) * spacing;
    const pts = routes.get(s.route)!;
    const a = pts[s.k];
    const b = pts[s.k + 1];
    if (vertical) {
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

function legal(portX: number, originalX: number, target: number): boolean {
  const dir = Math.sign(originalX - portX);
  return (target - portX) * dir >= 8;
}
