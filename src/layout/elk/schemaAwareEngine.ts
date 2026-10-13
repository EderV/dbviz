/**
 * The production layout engine.
 *
 *   1. Lay out every schema on its own (ELK layered) to learn its size.
 *   2. Place schema boxes with stress majorization weighted by FK counts,
 *      then remove overlaps (keeping routing gutters) and compact.
 *   3. Decide, for every cross-schema bundle, which side of each box faces
 *      the partner, and lay out every schema again with external ports on
 *      those sides — tables with outside links move to the right edge.
 *   4. Re-settle the boxes (sizes changed slightly) without reshuffling them.
 *   5. Route between boxes with the orthogonal A* router, nudge parallel
 *      routes onto separate tracks, and stitch inner + outer segments into
 *      one polyline per relationship.
 *
 * Cross-schema FKs are bundled per (referenced column, referencing schema):
 * twenty tables in `billing` pointing at `identity.users.id` leave
 * `identity` as one line and fan out only once they reach `billing`.
 */
import ELK from 'elkjs/lib/elk.bundled.js';
import { computeBridges } from '../bridges';
import { computeMetrics } from '../metrics';
import { placeBoxes, type Weights } from '../placement';
import { prepareGraph, type PreparedEdge, type PreparedNode } from '../prepare';
import { DEFAULT_GRID_ROUTER_OPTIONS, routeGrid, type GridRouteRequest } from '../gridRouter';
import type { LayoutEdge, LayoutEngine, LayoutInput, LayoutNode, LayoutResult, Point, Rect, SchemaBounds } from '../types';
import { externalKey, layoutSchema, type ExternalPort, type InnerResult, type PortSide, type SpacingPreset } from './innerLayout';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const SPACING: Record<'compact' | 'comfortable', SpacingPreset & { gutter: number }> = {
  comfortable: { nodeNode: 34, betweenLayers: 76, edgeNode: 18, edgeEdge: 10, padding: { top: 58, side: 28, bottom: 28 }, gutter: 70 },
  compact: { nodeNode: 22, betweenLayers: 56, edgeNode: 14, edgeEdge: 8, padding: { top: 50, side: 20, bottom: 20 }, gutter: 56 },
};

interface Bundle {
  id: string;
  parentSchema: string;
  childSchema: string;
  parent: string;
  parentY: number;
  edges: PreparedEdge[];
  parentSide: PortSide;
  childSide: PortSide;
}

interface ElkLike {
  layout(graph: object): Promise<any>;
}

export class SchemaAwareEngine implements LayoutEngine {
  readonly name = 'schema-aware';
  private readonly elk: ElkLike;

  constructor(elk?: ElkLike) {
    this.elk = elk ?? new ELK();
  }

  async layout(input: LayoutInput): Promise<LayoutResult> {
    const t0 = now();
    const g = prepareGraph(input.model, input.options);
    const spacing = SPACING[input.options.density];
    const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
    const schemaOfNode = (id: string) => nodeById.get(id)!.schema;
    // Large diagrams trade a little optimality for interactive speed.
    const big = g.edges.length > 400;
    const effort = { elk: big ? 3 : 7, heuristic: big ? 2.2 : 1.4 };
    const collapsed = new Set(g.schemas.filter((s) => s.collapsed).map((s) => s.name));

    // ---- classify edges ---------------------------------------------------
    const intra = new Map<string, PreparedEdge[]>();
    const bundles = new Map<string, Bundle>();
    const weights: Weights = new Map();
    const addWeight = (a: string, b: string) => {
      for (const [x, y] of [[a, b], [b, a]]) {
        const m = weights.get(x) ?? new Map<string, number>();
        m.set(y, (m.get(y) ?? 0) + 1);
        weights.set(x, m);
      }
    };
    for (const e of g.edges) {
      const cs = schemaOfNode(e.source);
      const ps = schemaOfNode(e.target);
      if (cs === ps) {
        intra.set(cs, [...(intra.get(cs) ?? []), e]);
        continue;
      }
      addWeight(cs, ps);
      const key = `${e.target}|${e.targetY}|${cs}`;
      const b = bundles.get(key);
      if (b) b.edges.push(e);
      else bundles.set(key, { id: `b${bundles.size}`, parentSchema: ps, childSchema: cs, parent: e.target, parentY: e.targetY, edges: [e], parentSide: 'E', childSide: 'W' });
    }

    const nodesOf = new Map<string, PreparedNode[]>();
    for (const s of g.schemas) nodesOf.set(s.name, s.nodeIds.map((id) => nodeById.get(id)!));

    // ---- phase 1: sizes without external ports ----------------------------
    const firstPass = new Map<string, InnerResult>();
    await Promise.all(
      g.schemas.map(async (s) => firstPass.set(s.name, await this.inner(s.name, nodesOf.get(s.name)!, intra.get(s.name) ?? [], [], spacing, collapsed.has(s.name), 2))),
    );

    // Routes need room: widen gutters a little when there is a lot of cross traffic.
    const gutter = spacing.gutter + Math.min(110, Math.sqrt(bundles.size) * 5);

    const tElk1 = now() - t0;
    // ---- phase 2: place schemas -------------------------------------------
    const boxes = g.schemas.map((s) => ({ id: s.name, width: firstPass.get(s.name)!.width, height: firstPass.get(s.name)!.height }));
    const placed1 = placeBoxes(boxes, weights, { gutter });

    // ---- phase 3: sides + external ports ----------------------------------
    const allRects = [...placed1.values()];
    const diagramCentreX = allRects.reduce((a, r) => a + r.x + r.width / 2, 0) / Math.max(1, allRects.length);
    const portsOf = new Map<string, (ExternalPort & { key: number })[]>();
    const pushPort = (schema: string, port: ExternalPort & { key: number }) => portsOf.set(schema, [...(portsOf.get(schema) ?? []), port]);
    for (const b of bundles.values()) {
      const pr = placed1.get(b.parentSchema)!;
      const cr = placed1.get(b.childSchema)!;
      b.parentSide = sideToward(pr, cr, diagramCentreX);
      b.childSide = sideToward(cr, pr, diagramCentreX);
      pushPort(b.parentSchema, { id: `${b.id}:p`, side: b.parentSide, connections: [{ nodeId: b.parent, y: b.parentY }], key: cr.y + cr.height / 2 });
      pushPort(b.childSchema, { id: `${b.id}:c`, side: b.childSide, connections: b.edges.map((e) => ({ nodeId: e.source, y: e.sourceY })), key: pr.y + pr.height / 2 });
    }
    // FIXED_ORDER is clockwise: east side top→bottom, west side bottom→top.
    for (const list of portsOf.values()) {
      list.sort((a, b) => (a.side !== b.side ? (a.side === 'E' ? -1 : 1) : a.side === 'E' ? a.key - b.key : b.key - a.key));
    }

    const inner = new Map<string, InnerResult>();
    await Promise.all(
      g.schemas.map(async (s) =>
        inner.set(s.name, await this.inner(s.name, nodesOf.get(s.name)!, intra.get(s.name) ?? [], portsOf.get(s.name) ?? [], spacing, collapsed.has(s.name), effort.elk)),
      ),
    );

    const tElk2 = now() - t0 - tElk1;
    // ---- phase 4: re-settle boxes ------------------------------------------
    const initial = new Map([...placed1].map(([id, r]) => [id, { x: r.x + r.width / 2, y: r.y + r.height / 2 }]));
    const placed = placeBoxes(
      g.schemas.map((s) => ({ id: s.name, width: inner.get(s.name)!.width, height: inner.get(s.name)!.height })),
      weights,
      { gutter, initial, refineOnly: true },
    );

    // ---- phase 5: absolute geometry ---------------------------------------
    const nodes: LayoutNode[] = [];
    const schemas: SchemaBounds[] = [];
    const offset = (schema: string, p: Point): Point => {
      const r = placed.get(schema)!;
      return { x: r.x + p.x, y: r.y + p.y };
    };
    for (const s of g.schemas) {
      const r = placed.get(s.name)!;
      schemas.push({ schema: s.name, ...r, collapsed: s.collapsed, tableCount: s.tableCount });
      const res = inner.get(s.name)!;
      for (const n of nodesOf.get(s.name)!) {
        const p = offset(s.name, res.nodes.get(n.id) ?? { x: 0, y: 0 });
        nodes.push({ id: n.id, kind: n.kind, schema: n.schema, x: p.x, y: p.y, width: n.width, height: n.height, columns: n.columns, hiddenColumns: n.hiddenColumns, cardColumns: n.cardColumns });
      }
    }

    // ---- global orthogonal routing ----------------------------------------
    const rectOf = new Map(nodes.map((n) => [n.id, n]));
    const regionIndex = new Map(schemas.map((s, i) => [s.schema, i]));
    const requests: GridRouteRequest[] = [];
    for (const e of g.edges) {
      const c = rectOf.get(e.source)!;
      const p = rectOf.get(e.target)!;
      let cs: PortSide;
      let ps: PortSide;
      if (e.selfLoop) [cs, ps] = ['E', 'E'];
      else if (c.x >= p.x + p.width) [cs, ps] = ['W', 'E'];
      else if (c.x + c.width <= p.x) [cs, ps] = ['E', 'W'];
      else {
        // Stacked cards: loop through the channel on the side with more room.
        const box = placed.get(c.schema)!;
        const side: PortSide = c.x + c.width / 2 - box.x > box.width / 2 ? 'E' : 'W';
        const pBox = placed.get(p.schema)!;
        const pSide: PortSide = c.schema === p.schema ? side : p.x + p.width / 2 - pBox.x > pBox.width / 2 ? 'E' : 'W';
        [cs, ps] = [side, pSide];
      }
      requests.push({
        id: e.id,
        start: { x: cs === 'W' ? c.x : c.x + c.width, y: c.y + e.sourceY },
        startSide: cs,
        end: { x: ps === 'W' ? p.x : p.x + p.width, y: p.y + e.targetY },
        endSide: ps,
        regions: [regionIndex.get(c.schema)!, regionIndex.get(p.schema)!],
      });
    }
    const tRoute = now();
    const routes = routeGrid(requests, nodes, schemas, { ...DEFAULT_GRID_ROUTER_OPTIONS, heuristicWeight: effort.heuristic });
    const routeMs = now() - tRoute;
    const edges: LayoutEdge[] = g.edges.map((e) => toLayoutEdge(e, routes.get(e.id) ?? []));

    computeBridges(edges);
    const metrics = computeMetrics(nodes, edges, schemas);
    return { engine: this.name, nodes, edges, schemas, width: metrics.width, height: metrics.height, metrics, durationMs: now() - t0, timings: { elkPass1Ms: tElk1, elkPass2Ms: tElk2, routeMs } };
  }

  private async inner(
    schema: string,
    nodes: PreparedNode[],
    edges: PreparedEdge[],
    externals: ExternalPort[],
    spacing: SpacingPreset,
    isCollapsed: boolean,
    thoroughness = 7,
  ): Promise<InnerResult> {
    if (!isCollapsed) return layoutSchema(this.elk, { schema, nodes, edges, externals, spacing, thoroughness });
    // A collapsed schema is just its summary node; ports sit on its border.
    const n = nodes[0];
    const res: InnerResult = { width: n.width, height: n.height, nodes: new Map([[n.id, { x: 0, y: 0 }]]), edges: new Map(), external: new Map(), ports: new Map() };
    for (const side of ['W', 'E'] as const) {
      const onSide = externals.filter((p) => p.side === side);
      onSide.forEach((p, i) => {
        const y = (n.height * (i + 1)) / (onSide.length + 1);
        const pt = { x: side === 'W' ? 0 : n.width, y };
        res.ports.set(p.id, pt);
        for (const c of p.connections) res.external.set(externalKey(p.id, c.nodeId, c.y), [pt]);
      });
    }
    return res;
  }
}

function toLayoutEdge(e: PreparedEdge, points: Point[]): LayoutEdge {
  return {
    id: e.id,
    relationshipIds: e.relationshipIds,
    source: e.source,
    target: e.target,
    sourceColumn: e.sourceColumn,
    targetColumn: e.targetColumn,
    points,
    bridges: [],
    selfLoop: e.selfLoop,
    crossSchema: e.crossSchema,
  };
}

/** Which side of `a` faces `b`? Vertically stacked boxes both use the side facing the diagram centre. */
function sideToward(a: Rect, b: Rect, diagramCentreX: number): PortSide {
  const ax0 = a.x;
  const ax1 = a.x + a.width;
  const bx0 = b.x;
  const bx1 = b.x + b.width;
  if (bx0 >= ax1 - 1) return 'E';
  if (bx1 <= ax0 + 1) return 'W';
  const centre = (Math.min(ax0, bx0) + Math.max(ax1, bx1)) / 2;
  return centre <= diagramCentreX ? 'E' : 'W';
}
