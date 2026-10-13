/**
 * Baseline: one ELK layered pass over the whole compound graph
 * (schemas as compound nodes, INCLUDE_CHILDREN hierarchy handling).
 * Kept as a benchmark reference for the production engine.
 */
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode, ElkExtendedEdge } from 'elkjs/lib/elk-api';
import { computeMetrics } from '../metrics';
import { prepareGraph } from '../prepare';
import type { LayoutEdge, LayoutEngine, LayoutInput, LayoutNode, LayoutResult, SchemaBounds } from '../types';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class ElkCompoundEngine implements LayoutEngine {
  readonly name = 'elk-compound';
  private readonly elk = new ELK();

  async layout(input: LayoutInput): Promise<LayoutResult> {
    const t0 = now();
    const g = prepareGraph(input.model, input.options);
    const portsOf = new Map<string, { id: string; x: number; y: number; side: 'WEST' | 'EAST' }[]>();
    const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
    const addPort = (nodeId: string, y: number, side: 'WEST' | 'EAST') => {
      const n = nodeById.get(nodeId)!;
      const id = `${nodeId}|${y}|${side}`;
      const list = portsOf.get(nodeId) ?? [];
      if (!list.some((p) => p.id === id)) list.push({ id, x: side === 'WEST' ? 0 : n.width, y, side });
      portsOf.set(nodeId, list);
      return id;
    };
    const edges: ElkExtendedEdge[] = g.edges.map((e) => ({
      id: e.id,
      sources: [addPort(e.target, e.targetY, 'EAST')],
      targets: [addPort(e.source, e.sourceY, 'WEST')],
    }));
    const root: ElkNode = {
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
        'elk.edgeRouting': 'ORTHOGONAL',
        'elk.layered.spacing.nodeNodeBetweenLayers': '90',
        'elk.spacing.nodeNode': '40',
        'elk.spacing.edgeNode': '24',
        'elk.spacing.edgeEdge': '12',
        'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
        'elk.json.shapeCoords': 'ROOT',
        'elk.json.edgeCoords': 'ROOT',
      },
      children: g.schemas.map((s) => ({
        id: `group:${s.name}`,
        layoutOptions: { 'elk.padding': '[top=52,left=28,bottom=28,right=28]' },
        children: s.nodeIds.map((id) => {
          const n = nodeById.get(id)!;
          return {
            id,
            width: n.width,
            height: n.height,
            layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
            ports: (portsOf.get(id) ?? []).map((p) => ({ id: p.id, x: p.side === 'WEST' ? -1 : p.x - 1, y: p.y - 1, width: 2, height: 2, layoutOptions: { 'elk.port.side': p.side } })),
          };
        }),
      })),
      edges,
    };
    const out = await this.elk.layout(root);
    const nodes: LayoutNode[] = [];
    const schemas: SchemaBounds[] = [];
    for (const grp of out.children ?? []) {
      const name = grp.id.slice('group:'.length);
      const ps = g.schemas.find((s) => s.name === name)!;
      schemas.push({ schema: name, x: grp.x!, y: grp.y!, width: grp.width!, height: grp.height!, collapsed: ps.collapsed, tableCount: ps.tableCount });
      for (const c of grp.children ?? []) {
        const n = nodeById.get(c.id)!;
        nodes.push({ id: n.id, kind: n.kind, schema: n.schema, x: c.x!, y: c.y!, width: n.width, height: n.height, columns: n.columns, hiddenColumns: n.hiddenColumns, cardColumns: n.cardColumns });
      }
    }
    const byId = new Map(g.edges.map((e) => [e.id, e]));
    const layoutEdges: LayoutEdge[] = (out.edges ?? []).map((e: any) => {
      const pe = byId.get(e.id)!;
      const sec = e.sections?.[0];
      const pts = sec ? [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint] : [];
      return { id: pe.id, relationshipIds: pe.relationshipIds, source: pe.source, target: pe.target, sourceColumn: pe.sourceColumn, targetColumn: pe.targetColumn, points: pts.reverse(), bridges: [], selfLoop: pe.selfLoop, crossSchema: pe.crossSchema };
    });
    const metrics = computeMetrics(nodes, layoutEdges, schemas);
    return { engine: this.name, nodes, edges: layoutEdges, schemas, width: metrics.width, height: metrics.height, metrics, durationMs: now() - t0 };
  }
}
