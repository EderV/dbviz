/**
 * The diagram. React Flow provides the viewport (zoom, pan, drag, culling);
 * tables are its nodes. Relationships and schema backgrounds are drawn in
 * one SVG layer inside the viewport, beneath the cards — they never need
 * React Flow's handle machinery because the router already knows the exact
 * column anchors.
 */
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  useReactFlow,
  ViewportPortal,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RelationshipModel } from '../../domain/model';
import { SCHEMA_PAD } from '../../export/svgExport';
import type { LayoutEdge, LayoutNode } from '../../layout/types';
import { boundsOf, edgePathD, endMarkers, resolveEdge } from '../../render/edgeGeometry';
import { schemaHue, visibleTables } from '../../view/graphQueries';
import { useApp } from '../state/store';
import { CollapsedNode, TableNode, type TableNodeData } from './TableNode';

const nodeTypes = { table: TableNode, collapsed: CollapsedNode };

export function useVisibleSet() {
  const model = useApp((s) => s.parse?.model);
  const index = useApp((s) => s.index);
  const filters = useApp((s) => s.filters);
  return useMemo(() => (model && index ? visibleTables(model, index, filters) : null), [model, index, filters]);
}

export function Diagram() {
  const layout = useApp((s) => s.layout);
  const model = useApp((s) => s.parse?.model);
  const locked = useApp((s) => s.locked);
  const theme = useApp((s) => s.theme);
  const visible = useVisibleSet();
  const [nodes, setNodes] = useState<Node<TableNodeData>[]>([]);
  const rf = useReactFlow();

  const schemaIndex = useMemo(() => new Map(model?.schemas.map((s, i) => [s.name, i]) ?? []), [model]);

  // Rebuild flow nodes only when geometry or visibility changes, never on hover/selection.
  useEffect(() => {
    if (!layout) return setNodes([]);
    const positions = useApp.getState().positions;
    setNodes(
      layout.nodes.map((n) => ({
        id: n.id,
        type: n.kind === 'collapsed-schema' ? 'collapsed' : 'table',
        position: positions[n.id] ?? { x: n.x, y: n.y },
        data: { node: n, schemaIndex: schemaIndex.get(n.schema) ?? 0 },
        width: n.width,
        height: n.height,
        draggable: !useApp.getState().locked[n.id],
        hidden: !!visible && n.kind === 'table' && !visible.has(n.id),
        selectable: false,
      })),
    );
  }, [layout, visible, schemaIndex]);

  useEffect(() => {
    setNodes((ns) => ns.map((n) => (n.draggable === !locked[n.id] ? n : { ...n, draggable: !locked[n.id] })));
  }, [locked]);

  const moveNode = useApp((s) => s.moveNode);
  const onNodesChange = useCallback(
    (changes: NodeChange<Node<TableNodeData>>[]) => {
      setNodes((ns) => applyNodeChanges(changes, ns));
      for (const c of changes) if (c.type === 'position' && c.position) moveNode(c.id, c.position);
    },
    [moveNode],
  );

  // Fit / focus requests from anywhere in the app.
  const fitRequest = useApp((s) => s.fitRequest);
  useEffect(() => {
    if (!fitRequest) return;
    const t = setTimeout(() => {
      const ids = visible ? nodes.filter((n) => visible.has(n.id)).map((n) => ({ id: n.id })) : undefined;
      rf.fitView({ nodes: ids, padding: 0.08, duration: 350, maxZoom: 1.2 });
    }, 30);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitRequest]);

  const focusRequest = useApp((s) => s.focusRequest);
  useEffect(() => {
    if (!focusRequest || !layout) return;
    const n = layout.nodes.find((x) => x.id === focusRequest.id);
    if (!n) return;
    const st = useApp.getState();
    const p = st.positions[n.id] ?? n;
    const zoom = Math.max(rf.getZoom(), 0.95);
    // Keep the card clear of the inspector panel on the right.
    const shift = st.inspectorOpen && window.innerWidth > 820 ? 170 / zoom : 0;
    rf.setCenter(p.x + n.width / 2 + shift, p.y + Math.min(n.height, 300) / 2, { zoom, duration: 450 });
  }, [focusRequest, layout, rf]);

  const select = useApp((s) => s.select);
  const focusOn = useApp((s) => s.focusOn);

  if (!layout) return <EmptyDiagram />;

  return (
    <ReactFlow
      nodes={nodes}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onNodeClick={(_, n) => select(n.id)}
      onNodeDoubleClick={(_, n) => focusOn(n.id)}
      onPaneClick={() => select(null)}
      minZoom={0.04}
      maxZoom={2.5}
      onlyRenderVisibleElements
      nodesConnectable={false}
      elementsSelectable={false}
      zoomOnDoubleClick={false}
      colorMode={theme}
      fitView
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="var(--grid)" />
      <ViewportPortal>
        <EdgeLayer visible={visible} schemaIndex={schemaIndex} />
      </ViewportPortal>
      <MiniMap
        pannable
        zoomable
        nodeColor={(n) => `hsl(${schemaHue((n.data as TableNodeData).schemaIndex)} 40% 55% / 0.8)`}
        nodeStrokeWidth={0}
        maskColor="color-mix(in srgb, var(--bg) 70%, transparent)"
        style={{ background: 'var(--panel)' }}
      />
      <EdgeTooltip />
    </ReactFlow>
  );
}

function EmptyDiagram() {
  const status = useApp((s) => s.status);
  const phase = useApp((s) => s.phase);
  return (
    <div className="empty">
      {status === 'working' ? (
        <div className="empty-msg">
          <span className="spinner" /> {phase === 'loading-parser' ? 'Loading PostgreSQL parser…' : phase === 'layout' ? 'Computing layout…' : 'Parsing…'}
        </div>
      ) : (
        <div className="empty-msg">
          <strong>Paste a PostgreSQL schema</strong>
          <span>or drop a .sql file, then press Generate (Ctrl/⌘ + Enter).</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface EdgeLayerProps {
  visible: Set<string> | null;
  schemaIndex: Map<string, number>;
}

function EdgeLayer({ visible, schemaIndex }: EdgeLayerProps) {
  const layout = useApp((s) => s.layout)!;
  const model = useApp((s) => s.parse?.model);
  const positions = useApp((s) => s.positions);
  const selected = useApp((s) => s.selected);
  const hovered = useApp((s) => s.hovered);
  const hoveredEdge = useApp((s) => s.hoveredEdge);
  const nodeById = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);
  const rels = useMemo(() => new Map(model?.relationships.map((r) => [r.id, r]) ?? []), [model]);
  const shown = (id: string) => !visible || visible.has(id) || id.startsWith('schema:');
  const focus = selected ?? hovered;

  const schemas = layout.schemas.flatMap((s) => {
    if (s.collapsed) return [];
    const members = layout.nodes.filter((n) => n.schema === s.schema && shown(n.id));
    if (members.length === 0) return [];
    const touched = members.some((n) => positions[n.id]);
    const r = touched || visible ? boundsOf(members.map((n) => ({ ...(positions[n.id] ?? n), width: n.width, height: n.height })), SCHEMA_PAD) : s;
    return [{ schema: s.schema, ...r }];
  });

  return (
    <svg className="edge-layer" width={1} height={1} style={{ overflow: 'visible', position: 'absolute', left: 0, top: 0 }}>
      <g className="schemas">
        {schemas.map((s) => (
          <g key={s.schema} style={{ ['--schema-hue' as string]: schemaHue(schemaIndex.get(s.schema) ?? 0) }}>
            <rect className="schema-box" x={s.x} y={s.y} width={s.width} height={s.height} rx={12} />
            <text className="schema-label" x={s.x + 16} y={s.y + 27}>
              {s.schema}
            </text>
          </g>
        ))}
      </g>
      <g className={`edges${focus ? ' has-focus' : ''}`}>
        {layout.edges.map((e) => {
          if (!shown(e.source) || !shown(e.target)) return null;
          const s = nodeById.get(e.source)!;
          const t = nodeById.get(e.target)!;
          const active = !!focus && (e.source === focus || e.target === focus);
          return (
            <EdgePath
              key={e.id}
              edge={e}
              source={s}
              target={t}
              sp={positions[s.id]}
              tp={positions[t.id]}
              rel={rels.get(e.relationshipIds[0])}
              state={hoveredEdge === e.id ? 'hover' : active ? 'active' : focus && selected ? 'dim' : ''}
            />
          );
        })}
      </g>
    </svg>
  );
}

interface EdgePathProps {
  edge: LayoutEdge;
  source: LayoutNode;
  target: LayoutNode;
  sp?: { x: number; y: number };
  tp?: { x: number; y: number };
  rel?: RelationshipModel;
  state: '' | 'active' | 'dim' | 'hover';
}

const EdgePath = memo(function EdgePath({ edge, source, target, sp, tp, rel, state }: EdgePathProps) {
  const hoverEdge = useApp((s) => s.hoverEdge);
  const r = resolveEdge(edge, source, target, sp, tp);
  const d = edgePathD(r.points, r.bridges);
  const mk = endMarkers(r.points, rel?.cardinality ?? 'many-to-one', rel?.optional ?? false);
  return (
    <g className={`edge ${edge.crossSchema ? 'cross' : ''} ${state}`}>
      <path className="edge-line" d={d} />
      <path className="edge-mark" d={`${mk.child} ${mk.parent}`} />
      <path className="edge-hit" d={d} onMouseEnter={() => hoverEdge(edge.id)} onMouseLeave={() => hoverEdge(null)} />
    </g>
  );
});

function EdgeTooltip() {
  const hoveredEdge = useApp((s) => s.hoveredEdge);
  const layout = useApp((s) => s.layout);
  const model = useApp((s) => s.parse?.model);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (ref.current) ref.current.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 14}px)`;
    };
    window.addEventListener('mousemove', move);
    return () => window.removeEventListener('mousemove', move);
  }, []);
  const edge = hoveredEdge ? layout?.edges.find((e) => e.id === hoveredEdge) : undefined;
  const rels = edge ? model?.relationships.filter((r) => edge.relationshipIds.includes(r.id)) ?? [] : [];
  return (
    <div ref={ref} className="edge-tip" style={{ display: rels.length ? 'block' : 'none' }}>
      {rels.slice(0, 4).map((r) => (
        <div key={r.id}>
          <div className="tip-name">{r.constraintName ?? 'foreign key'}</div>
          <div className="tip-cols">
            {r.sourceTable}({r.sourceColumns.join(', ')}) → {r.targetTable}({r.targetColumns.join(', ')})
          </div>
          <div className="tip-meta">
            {r.cardinality === 'one-to-one' ? '1 : 1' : 'N : 1'}
            {r.optional ? ' · optional' : ''}
            {r.onDelete !== 'no action' ? ` · on delete ${r.onDelete}` : ''}
          </div>
        </div>
      ))}
      {rels.length > 4 && <div className="tip-meta">+{rels.length - 4} more</div>}
    </div>
  );
}
