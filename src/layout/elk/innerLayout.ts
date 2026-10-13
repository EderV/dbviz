/**
 * Layout of the tables inside one schema box.
 *
 * ELK's layered algorithm (Sugiyama-style: cycle breaking, layering, crossing
 * minimization, network-simplex placement, orthogonal routing) runs on the
 * schema's internal FK graph. Relationships that leave the schema are
 * represented by *external ports* on the side of the box that faces the
 * partner schema, so ELK pulls those tables toward the correct edge and
 * routes them to the boundary without crossing other tables.
 *
 * Tables with no relationships at all are packed into a tidy block instead
 * of being stacked into one tall layer.
 */
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api';
import type { PreparedEdge, PreparedNode } from '../prepare';
import { shelfPack } from '../placement';
import { DEFAULT_ROUTER_OPTIONS, routeAll, type RouteRequest } from '../router';
import type { Point, Rect } from '../types';

export type PortSide = 'W' | 'E';

export interface ExternalConnection {
  nodeId: string;
  /** Anchor offset from the card top. */
  y: number;
}

export interface ExternalPort {
  id: string;
  side: PortSide;
  connections: ExternalConnection[];
}

export interface SpacingPreset {
  nodeNode: number;
  betweenLayers: number;
  edgeNode: number;
  edgeEdge: number;
  padding: { top: number; side: number; bottom: number };
}

export interface InnerInput {
  schema: string;
  nodes: PreparedNode[];
  edges: PreparedEdge[];
  externals: ExternalPort[];
  spacing: SpacingPreset;
  /** Also route edges locally (standalone use). The schema-aware engine routes globally instead. */
  routeEdges?: boolean;
  /** ELK crossing-minimisation effort. */
  thoroughness?: number;
}

export interface InnerResult {
  width: number;
  height: number;
  nodes: Map<string, Point>;
  /** Intra-schema edges, child → parent, schema-local. */
  edges: Map<string, Point[]>;
  /** `${portId}|${nodeId}|${y}` → path from the card anchor to the boundary port. */
  external: Map<string, Point[]>;
  ports: Map<string, Point>;
}

export const externalKey = (portId: string, nodeId: string, y: number) => `${portId}|${nodeId}|${y}`;

const round = (v: number) => Math.round(v);

interface ElkLike {
  layout(graph: ElkNode): Promise<ElkNode>;
}

export async function layoutSchema(elk: ElkLike, input: InnerInput): Promise<InnerResult> {
  const { nodes, edges, externals, spacing } = input;
  const pad = spacing.padding;

  const connected = new Set<string>();
  for (const e of edges) {
    connected.add(e.source);
    connected.add(e.target);
  }
  for (const p of externals) for (const c of p.connections) connected.add(c.nodeId);
  const orphans = nodes.filter((n) => !connected.has(n.id));
  const linked = nodes.filter((n) => connected.has(n.id));

  // Pure orphan schemas (or a single table) need no graph layout at all.
  if (linked.length === 0) {
    const packed = shelfPack(orphans.map((n) => ({ id: n.id, width: n.width, height: n.height })), spacing.nodeNode);
    const result: InnerResult = { width: 0, height: 0, nodes: new Map(), edges: new Map(), external: new Map(), ports: new Map() };
    let w = 0;
    let h = 0;
    for (const [id, r] of packed) {
      result.nodes.set(id, { x: r.x + pad.side, y: r.y + pad.top });
      w = Math.max(w, r.x + r.width);
      h = Math.max(h, r.y + r.height);
    }
    result.width = w + pad.side * 2;
    result.height = h + pad.top + pad.bottom;
    return result;
  }

  // ELK only decides *placement*: edges are node-level so it is free to order
  // and layer tables. Routing happens afterwards with our own router, which
  // picks the card side that faces the partner for every relationship.
  const elkEdges: ElkExtendedEdge[] = [];
  for (const e of edges) {
    if (e.selfLoop) continue;
    // Parent on the left, child on the right.
    elkEdges.push({ id: e.id, sources: [e.target], targets: [e.source] });
  }
  externals.forEach((p) => {
    p.connections.forEach((c, i) => {
      const id = `x:${p.id}:${i}`;
      // Keep every edge "forward" for a RIGHT-directed layering.
      elkEdges.push(p.side === 'W' ? { id, sources: [p.id], targets: [c.nodeId] } : { id, sources: [c.nodeId], targets: [p.id] });
    });
  });

  let block: { id: string; width: number; height: number; items: Map<string, { x: number; y: number }> } | undefined;
  if (orphans.length > 0) {
    const packed = shelfPack(orphans.map((n) => ({ id: n.id, width: n.width, height: n.height })), spacing.nodeNode * 0.75);
    let w = 0;
    let h = 0;
    for (const r of packed.values()) {
      w = Math.max(w, r.x + r.width);
      h = Math.max(h, r.y + r.height);
    }
    block = { id: `orphans:${input.schema}`, width: w, height: h, items: new Map([...packed].map(([id, r]) => [id, { x: r.x, y: r.y }])) };
  }

  const compound: ElkNode = {
    id: `schema:${input.schema}`,
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.portConstraints': 'FIXED_ORDER',
      'elk.padding': `[top=${pad.top},left=${pad.side},bottom=${pad.bottom},right=${pad.side}]`,
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': String(spacing.nodeNode),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(spacing.betweenLayers),
      'elk.spacing.edgeNode': String(spacing.edgeNode),
      'elk.spacing.edgeEdge': String(spacing.edgeEdge),
      'elk.layered.spacing.edgeEdgeBetweenLayers': String(spacing.edgeEdge),
      'elk.layered.spacing.edgeNodeBetweenLayers': String(spacing.edgeNode),
      'elk.spacing.componentComponent': String(spacing.nodeNode * 1.5),
      'elk.separateConnectedComponents': 'true',
      'elk.aspectRatio': '1.6',
      // Long chains wrap into several rows instead of one 9000px line.
      ...(longestChain(edges) > 9 ? { 'elk.layered.wrapping.strategy': 'MULTI_EDGE', 'elk.layered.wrapping.additionalEdgeSpacing': '8' } : {}),
      'elk.layered.nodePlacement.strategy': elkEdges.length > 90 ? 'BRANDES_KOEPF' : 'NETWORK_SIMPLEX',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.crossingMinimization.forceNodeModelOrder': 'false',
      'elk.layered.thoroughness': String(input.thoroughness ?? 7),
      'elk.layered.unnecessaryBendpoints': 'false',
      'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',
    },
    children: [
      ...linked.map((n) => ({
        id: n.id,
        width: n.width,
        height: n.height,
      })),
      ...(block ? [{ id: block.id, width: block.width, height: block.height }] : []),
      // External ports are flat dummy nodes pinned to the first/last layer:
      // much cheaper for ELK than hierarchical ports on the compound.
      ...externals.map((p) => ({ id: p.id, width: 1, height: 1, layoutOptions: { 'elk.layered.layering.layerConstraint': p.side === 'W' ? 'FIRST' : 'LAST' } })),
    ],
    edges: elkEdges,
  };

  const root: ElkNode = {
    id: 'root',
    layoutOptions: { 'elk.algorithm': 'layered', 'elk.json.shapeCoords': 'ROOT', 'elk.json.edgeCoords': 'ROOT', 'elk.padding': '[top=0,left=0,bottom=0,right=0]' },
    children: [compound],
  };
  const laid = await elk.layout(root);
  const c = laid.children![0];
  const ox = c.x ?? 0;
  const oy = c.y ?? 0;
  const local = (p: { x: number; y: number }): Point => ({ x: p.x - ox, y: p.y - oy });

  const result: InnerResult = { width: round(c.width ?? 0), height: round(c.height ?? 0), nodes: new Map(), edges: new Map(), external: new Map(), ports: new Map() };
  const externalIds = new Map(externals.map((p) => [p.id, p]));
  for (const child of c.children ?? []) {
    const ext = externalIds.get(child.id);
    if (ext) {
      result.ports.set(child.id, { x: ext.side === 'W' ? 0 : result.width, y: round((child.y ?? 0) - oy) });
    } else if (block && child.id === block.id) {
      const bx = (child.x ?? 0) - ox;
      const by = (child.y ?? 0) - oy;
      for (const [id, p] of block.items) result.nodes.set(id, { x: round(bx + p.x), y: round(by + p.y) });
    } else {
      const l = local({ x: child.x ?? 0, y: child.y ?? 0 });
      result.nodes.set(child.id, { x: round(l.x), y: round(l.y) });
    }
  }
  if (input.routeEdges) routeInside(result, nodes, edges, externals);
  return result;
}

const opposite = (s: PortSide): PortSide => (s === 'W' ? 'E' : 'W');

/** Orthogonal routes for intra-schema edges and card → boundary-port legs. */
function routeInside(result: InnerResult, nodes: PreparedNode[], edges: PreparedEdge[], externals: ExternalPort[]) {
  const rect = new Map<string, Rect>();
  for (const n of nodes) {
    const p = result.nodes.get(n.id)!;
    rect.set(n.id, { x: p.x, y: p.y, width: n.width, height: n.height });
  }
  const anchor = (id: string, y: number, side: PortSide): Point => {
    const r = rect.get(id)!;
    return { x: side === 'W' ? r.x : r.x + r.width, y: r.y + y };
  };
  const requests: RouteRequest[] = [];
  for (const e of edges) {
    const c = rect.get(e.source)!;
    const p = rect.get(e.target)!;
    let cs: PortSide;
    let ps: PortSide;
    if (e.selfLoop) [cs, ps] = ['E', 'E'];
    else if (c.x >= p.x + p.width) [cs, ps] = ['W', 'E'];
    else if (c.x + c.width <= p.x) [cs, ps] = ['E', 'W'];
    else {
      // Same layer: loop on the side with more room (the box's nearer border).
      const side: PortSide = c.x + c.width / 2 < result.width / 2 ? 'W' : 'E';
      [cs, ps] = [side, side];
    }
    requests.push({ id: e.id, start: anchor(e.source, e.sourceY, cs), startSide: cs, end: anchor(e.target, e.targetY, ps), endSide: ps });
  }
  for (const p of externals) {
    const port = result.ports.get(p.id);
    if (!port) continue;
    for (const c of p.connections) {
      const key = externalKey(p.id, c.nodeId, c.y);
      requests.push({ id: `ext:${key}`, start: anchor(c.nodeId, c.y, p.side), startSide: p.side, end: port, endSide: opposite(p.side) });
    }
  }
  const routes = routeAll(requests, [...rect.values()], { ...DEFAULT_ROUTER_OPTIONS, margin: 14 }, { x: 0, y: 0, width: result.width, height: result.height });
  for (const [id, pts] of routes) {
    if (id.startsWith('ext:')) result.external.set(id.slice(4), pts);
    else result.edges.set(id, pts);
  }
}

/** Length of the longest FK chain (cycle-safe), i.e. the number of ELK layers it would need. */
function longestChain(edges: PreparedEdge[]): number {
  const out = new Map<string, string[]>();
  for (const e of edges) if (!e.selfLoop) out.set(e.target, [...(out.get(e.target) ?? []), e.source]);
  const memo = new Map<string, number>();
  const onStack = new Set<string>();
  const depth = (n: string): number => {
    const known = memo.get(n);
    if (known !== undefined) return known;
    if (onStack.has(n)) return 0;
    onStack.add(n);
    let best = 0;
    for (const m of out.get(n) ?? []) best = Math.max(best, 1 + depth(m));
    onStack.delete(n);
    memo.set(n, best);
    return best;
  };
  let max = 0;
  for (const n of out.keys()) max = Math.max(max, depth(n));
  return max;
}
