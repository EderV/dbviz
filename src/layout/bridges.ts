/**
 * Line jumps: where a horizontal segment crosses a vertical segment of a
 * different relationship, the horizontal one gets a small bridge so the
 * reader can tell "crosses" from "joins".
 */
import { segmentBox, segmentsOf } from './metrics';
import type { Bridge, LayoutEdge } from './types';

const CELL = 300;

export function computeBridges(edges: LayoutEdge[], radius = 5): void {
  type V = { edge: number; x: number; y0: number; y1: number };
  const grid = new Map<string, V[]>();
  edges.forEach((e, ei) => {
    for (const s of segmentsOf(e.points)) {
      if (Math.abs(s.a.x - s.b.x) > 0.01) continue;
      const v: V = { edge: ei, x: s.a.x, y0: Math.min(s.a.y, s.b.y), y1: Math.max(s.a.y, s.b.y) };
      const box = segmentBox(s);
      for (let gx = Math.floor(box.x / CELL); gx <= Math.floor((box.x + box.width) / CELL); gx++) {
        for (let gy = Math.floor(box.y / CELL); gy <= Math.floor((box.y + box.height) / CELL); gy++) {
          const key = `${gx},${gy}`;
          const list = grid.get(key);
          if (list) list.push(v);
          else grid.set(key, [v]);
        }
      }
    }
  });

  edges.forEach((e, ei) => {
    const bridges: Bridge[] = [];
    const seen = new Set<string>();
    const shares = new Set(e.relationshipIds);
    for (const s of segmentsOf(e.points)) {
      if (Math.abs(s.a.y - s.b.y) > 0.01) continue;
      const y = s.a.y;
      const x0 = Math.min(s.a.x, s.b.x);
      const x1 = Math.max(s.a.x, s.b.x);
      const gy = Math.floor(y / CELL);
      for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++) {
        for (const v of grid.get(`${gx},${gy}`) ?? []) {
          if (v.edge === ei) continue;
          if (edges[v.edge].relationshipIds.some((r) => shares.has(r))) continue;
          // Strict interior on both segments, with room for the arc.
          if (v.x <= x0 + radius + 1 || v.x >= x1 - radius - 1) continue;
          if (y <= v.y0 + 0.5 || y >= v.y1 - 0.5) continue;
          const key = `${Math.round(v.x)},${Math.round(y)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          bridges.push({ x: v.x, y, axis: 'h' });
        }
      }
    }
    e.bridges = bridges;
  });
}
