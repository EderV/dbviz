/**
 * Placement of schema boxes on the plane.
 *
 * Schemas are few (typically < 30) but large and of very different sizes,
 * and the quality goal is "coupled domains sit next to each other, the
 * overall picture is compact, and there are clean gutters between boxes for
 * cross-schema routes". A layered algorithm turns this into a long strip, so
 * instead:
 *
 *   1. stress majorization (SMACOF) on the schema super-graph, with ideal
 *      distances derived from box sizes and FK counts,
 *   2. overlap removal that keeps a routing gutter between boxes,
 *   3. gravity compaction to close leftover gaps,
 *   4. shelf packing of disconnected groups.
 *
 * Everything is deterministic: the same input always yields the same picture.
 */
import type { Rect } from './types';

export interface PlacementBox {
  id: string;
  width: number;
  height: number;
}

export interface PlacementOptions {
  gutter: number;
  /** Previous centres, used as the starting point to keep the picture stable. */
  initial?: Map<string, { x: number; y: number }>;
  /** Skip stress and only separate/compact from `initial`. */
  refineOnly?: boolean;
}

/** weights.get(a)?.get(b) = number of relationships between schemas a and b. */
export type Weights = Map<string, Map<string, number>>;

export function placeBoxes(boxes: PlacementBox[], weights: Weights, options: PlacementOptions): Map<string, Rect> {
  const result = new Map<string, Rect>();
  if (boxes.length === 0) return result;

  const components = connectedComponents(boxes, weights);
  const placedGroups: { rects: Map<string, Rect>; bounds: Rect }[] = [];
  for (const comp of components) {
    const centres = options.refineOnly && options.initial ? initialFrom(comp, options.initial) : stress(comp, weights, options.initial);
    separate(comp, centres, options.gutter);
    compact(comp, centres, options.gutter, weights);
    const rects = new Map<string, Rect>();
    for (const b of comp) {
      const c = centres.get(b.id)!;
      rects.set(b.id, { x: c.x - b.width / 2, y: c.y - b.height / 2, width: b.width, height: b.height });
    }
    placedGroups.push({ rects, bounds: boundsOf([...rects.values()]) });
  }

  if (options.refineOnly && placedGroups.length > 1 && options.initial) {
    // Keep groups where they were; just resolve overlaps between them.
    const all = placedGroups.flatMap((g) => [...g.rects.entries()]);
    const allBoxes = all.map(([id, r]) => ({ id, width: r.width, height: r.height }));
    const centres = new Map(all.map(([id, r]) => [id, { x: r.x + r.width / 2, y: r.y + r.height / 2 }]));
    separate(allBoxes, centres, options.gutter);
    for (const b of allBoxes) {
      const c = centres.get(b.id)!;
      result.set(b.id, { x: c.x - b.width / 2, y: c.y - b.height / 2, width: b.width, height: b.height });
    }
    return normalize(result);
  }

  // Pack groups: the biggest connected group first, then the rest in shelves.
  const packed = shelfPack(
    placedGroups.map((g, i) => ({ id: String(i), width: g.bounds.width, height: g.bounds.height })),
    options.gutter,
  );
  placedGroups.forEach((g, i) => {
    const target = packed.get(String(i))!;
    const dx = target.x - g.bounds.x;
    const dy = target.y - g.bounds.y;
    for (const [id, r] of g.rects) result.set(id, { ...r, x: r.x + dx, y: r.y + dy });
  });
  return normalize(result);
}

function initialFrom(boxes: PlacementBox[], initial: Map<string, { x: number; y: number }>) {
  const out = new Map<string, { x: number; y: number }>();
  boxes.forEach((b, i) => out.set(b.id, initial.get(b.id) ?? { x: i * 50, y: 0 }));
  return out;
}

// ---------------------------------------------------------------------------
// Stress majorization
// ---------------------------------------------------------------------------

function stress(boxes: PlacementBox[], weights: Weights, initial?: Map<string, { x: number; y: number }>) {
  const n = boxes.length;
  const pos = new Map<string, { x: number; y: number }>();
  if (n === 1) {
    pos.set(boxes[0].id, { x: 0, y: 0 });
    return pos;
  }
  const radius = boxes.map((b) => Math.hypot(b.width, b.height) / 2);
  const INF = 1e12;
  const d: number[][] = Array.from({ length: n }, () => new Array(n).fill(INF));
  for (let i = 0; i < n; i++) {
    d[i][i] = 0;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const w = weights.get(boxes[i].id)?.get(boxes[j].id) ?? 0;
      if (w > 0) {
        // Strongly coupled schemas want to touch (modulo the gutter); weak ties may sit further away.
        const pull = 1 / (1 + Math.log1p(w));
        d[i][j] = (radius[i] + radius[j]) * (0.78 + 0.5 * pull);
      }
    }
  }
  // Floyd–Warshall: n is small.
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (d[i][k] + d[k][j] < d[i][j]) d[i][j] = d[i][k] + d[k][j];

  // Deterministic initialization: previous positions, else hub-centred spiral.
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const degree = boxes.map((b) => [...(weights.get(b.id)?.values() ?? [])].reduce((a, v) => a + v, 0));
  const orderByDegree = boxes.map((_, i) => i).sort((a, b) => degree[b] - degree[a] || a - b);
  const meanR = radius.reduce((a, r) => a + r, 0) / n;
  orderByDegree.forEach((i, rank) => {
    const prev = initial?.get(boxes[i].id);
    if (prev) {
      x[i] = prev.x;
      y[i] = prev.y;
      return;
    }
    const angle = rank * 2.399963; // golden angle
    const r = rank === 0 ? 0 : meanR * 1.6 * Math.sqrt(rank);
    x[i] = Math.cos(angle) * r;
    y[i] = Math.sin(angle) * r * 0.75;
  });

  // SMACOF with weights w_ij = d_ij^-2.
  for (let iter = 0; iter < 400; iter++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      let sx = 0;
      let sy = 0;
      let sw = 0;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const dij = d[i][j];
        const wij = 1 / (dij * dij);
        const dx = x[i] - x[j];
        const dy = y[i] - y[j];
        // Slightly anisotropic distance: diagrams read better wider than tall.
        const dist = Math.hypot(dx, dy * 1.25) || 1e-6;
        sx += wij * (x[j] + (dij * dx) / dist);
        sy += wij * (y[j] + (dij * dy) / (dist * 1.25));
        sw += wij;
      }
      const nx = sx / sw;
      const ny = sy / sw;
      moved += Math.abs(nx - x[i]) + Math.abs(ny - y[i]);
      x[i] = nx;
      y[i] = ny;
    }
    if (moved < 0.5) break;
  }
  boxes.forEach((b, i) => pos.set(b.id, { x: x[i], y: y[i] }));
  return pos;
}

// ---------------------------------------------------------------------------
// Overlap removal and compaction
// ---------------------------------------------------------------------------

function separate(boxes: PlacementBox[], c: Map<string, { x: number; y: number }>, gutter: number) {
  for (let iter = 0; iter < 2000; iter++) {
    let any = false;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const pa = c.get(a.id)!;
        const pb = c.get(b.id)!;
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const ox = (a.width + b.width) / 2 + gutter - Math.abs(dx);
        const oy = (a.height + b.height) / 2 + gutter - Math.abs(dy);
        if (ox <= 0.01 || oy <= 0.01) continue;
        any = true;
        // Push along the axis of least penetration, split by relative size.
        const ra = (a.width * a.height) / (a.width * a.height + b.width * b.height);
        if (ox < oy) {
          const s = dx === 0 ? (i < j ? 1 : -1) : Math.sign(dx);
          pa.x -= s * ox * (1 - ra) + s * 0.01;
          pb.x += s * ox * ra;
        } else {
          const s = dy === 0 ? 1 : Math.sign(dy);
          pa.y -= s * oy * (1 - ra) + s * 0.01;
          pb.y += s * oy * ra;
        }
      }
    }
    if (!any) return;
  }
}

/**
 * Moves each box toward the weighted centre of its partners (or the global
 * centre if it has none) as far as it can go without breaking the gutter.
 */
function compact(boxes: PlacementBox[], c: Map<string, { x: number; y: number }>, gutter: number, weights: Weights) {
  if (boxes.length < 2) return;
  const byId = new Map(boxes.map((b) => [b.id, b]));
  for (let round = 0; round < 6; round++) {
    const centre = { x: 0, y: 0 };
    for (const b of boxes) {
      centre.x += c.get(b.id)!.x / boxes.length;
      centre.y += c.get(b.id)!.y / boxes.length;
    }
    for (const axis of ['x', 'y'] as const) {
      const order = [...boxes].sort((a, b) => Math.abs(c.get(a.id)![axis] - centre[axis]) - Math.abs(c.get(b.id)![axis] - centre[axis]));
      for (const b of order) {
        const p = c.get(b.id)!;
        let tx = 0;
        let tw = 0;
        for (const [other, w] of weights.get(b.id) ?? []) {
          const q = c.get(other);
          if (!q || !byId.has(other)) continue;
          tx += q[axis] * w;
          tw += w;
        }
        const goal = tw > 0 ? 0.5 * (tx / tw) + 0.5 * centre[axis] : centre[axis];
        const want = goal - p[axis];
        if (Math.abs(want) < 1) continue;
        const dir = Math.sign(want);
        let allowed = Math.abs(want);
        for (const o of boxes) {
          if (o.id === b.id) continue;
          const q = c.get(o.id)!;
          const cross = axis === 'x' ? 'y' : 'x';
          const sizeCross = cross === 'x' ? 'width' : 'height';
          const size = axis === 'x' ? 'width' : 'height';
          // Only boxes that overlap on the other axis can block this move.
          if (Math.abs(q[cross] - p[cross]) >= (b[sizeCross] + o[sizeCross]) / 2 + gutter) continue;
          const gap = (q[axis] - p[axis]) * dir - (b[size] + o[size]) / 2 - gutter;
          if (gap >= -0.01 && gap < allowed) allowed = Math.max(0, gap);
        }
        p[axis] += dir * allowed;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function connectedComponents(boxes: PlacementBox[], weights: Weights): PlacementBox[][] {
  const seen = new Set<string>();
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const out: PlacementBox[][] = [];
  for (const b of boxes) {
    if (seen.has(b.id)) continue;
    const comp: PlacementBox[] = [];
    const stack = [b.id];
    seen.add(b.id);
    while (stack.length) {
      const id = stack.pop()!;
      comp.push(byId.get(id)!);
      for (const [other, w] of weights.get(id) ?? []) {
        if (w > 0 && byId.has(other) && !seen.has(other)) {
          seen.add(other);
          stack.push(other);
        }
      }
    }
    comp.sort((a, z) => boxes.indexOf(a) - boxes.indexOf(z));
    out.push(comp);
  }
  // Largest group first: it anchors the picture.
  return out.sort((a, z) => area(z) - area(a));
}

function area(boxes: PlacementBox[]) {
  return boxes.reduce((s, b) => s + b.width * b.height, 0);
}

export function boundsOf(rects: Rect[]): Rect {
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
  if (!Number.isFinite(x0)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Shelf packing: first item sets the stage, the rest flow in rows whose
 * width targets a ~16:10 overall aspect ratio.
 */
export function shelfPack(items: PlacementBox[], gap: number): Map<string, Rect> {
  const out = new Map<string, Rect>();
  if (items.length === 0) return out;
  const totalArea = items.reduce((a, b) => a + (b.width + gap) * (b.height + gap), 0);
  const targetWidth = Math.max(items[0].width, Math.sqrt(totalArea * 1.6));
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const it of items) {
    if (x > 0 && x + it.width > targetWidth) {
      x = 0;
      y += rowH + gap;
      rowH = 0;
    }
    out.set(it.id, { x, y, width: it.width, height: it.height });
    x += it.width + gap;
    rowH = Math.max(rowH, it.height);
  }
  return out;
}

function normalize(rects: Map<string, Rect>): Map<string, Rect> {
  const b = boundsOf([...rects.values()]);
  for (const [id, r] of rects) rects.set(id, { ...r, x: Math.round(r.x - b.x), y: Math.round(r.y - b.y) });
  return rects;
}
