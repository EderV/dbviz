import { useStore, type NodeProps, type Node } from '@xyflow/react';
import { memo } from 'react';
import type { DatabaseModel, TableModel } from '../../domain/model';
import { CARD, truncate } from '../../layout/sizing';
import type { LayoutNode } from '../../layout/types';
import { schemaHue } from '../../view/graphQueries';
import { useApp } from '../state/store';

export type TableNodeData = { node: LayoutNode; schemaIndex: number };
export type TableFlowNode = Node<TableNodeData, 'table'>;
export type CollapsedFlowNode = Node<TableNodeData, 'collapsed'>;

// Level of detail thresholds (zoom factor).
export const LOD_HEADER_ONLY = 0.45;
export const LOD_BLOCK = 0.2;

const tableCache = new WeakMap<DatabaseModel, Map<string, TableModel>>();
export function tableLookup(model: DatabaseModel | undefined): Map<string, TableModel> {
  if (!model) return new Map();
  let m = tableCache.get(model);
  if (!m) tableCache.set(model, (m = new Map(model.tables.map((t) => [t.id, t]))));
  return m;
}

type Mode = '' | 'sel' | 'rel' | 'dim' | 'hov';

function useHighlight(id: string): Mode {
  return useApp((s) => (s.selected ? (s.selected === id ? 'sel' : s.related?.has(id) ? 'rel' : 'dim') : s.hovered === id ? 'hov' : ''));
}

function TableNodeImpl({ id, data }: NodeProps<TableFlowNode>) {
  const table = useApp((s) => tableLookup(s.parse?.model).get(id));
  const mode = useHighlight(id);
  const locked = useApp((s) => !!s.locked[id]);
  const focusColumn = useApp((s) => (s.selected === id ? s.selectedColumn : null));
  const lod = useStore((s) => (s.transform[2] < LOD_BLOCK ? 2 : s.transform[2] < LOD_HEADER_ONLY ? 1 : 0));
  const hover = useApp((s) => s.hover);
  const n = data.node;
  if (!table) return null;
  const hue = schemaHue(data.schemaIndex);
  const cc = n.cardColumns;
  // Mirrors measureCard(): [pad+icon][name][gap+type][gap+default][flag+pad].
  const cols = `${CARD.paddingX + CARD.iconWidth}px ${cc.name}px ${CARD.gap + cc.type}px${cc.default ? ` ${CARD.gap + cc.default}px` : ''} 1fr`;
  const byName = new Map(table.columns.map((c) => [c.name, c]));

  return (
    <div
      className={`card mode-${mode || 'none'} lod-${lod}${table.kind === 'external' ? ' external' : ''}`}
      style={{ width: n.width, height: n.height, ['--schema-hue' as string]: hue }}
      onMouseEnter={() => hover(id)}
      onMouseLeave={() => hover(null)}
    >
      <div className="card-head" style={{ height: CARD.headerHeight }}>
        <span className="card-title" title={table.id}>
          {truncate(table.name, CARD.maxTitleChars)}
        </span>
        {locked && (
          <span className="card-lock" title="Position locked">
            ⌖
          </span>
        )}
      </div>
      {lod === 0 && (
        <div className="card-rows" style={{ gridTemplateColumns: cols, columnGap: 0 }}>
          {n.columns.map((name) => {
            const c = byName.get(name);
            if (!c) return null;
            const icon = c.isPrimaryKey ? 'pk' : c.isForeignKey ? 'fk' : c.isUnique ? 'uq' : '';
            return (
              <div key={name} className={`row${focusColumn === name ? ' row-focus' : ''}`} title={c.comment ?? undefined}>
                <span className={`ico ${icon}`}>{icon === 'pk' ? 'P' : icon === 'fk' ? 'F' : icon === 'uq' ? 'U' : ''}</span>
                <span className={`cname${c.isPrimaryKey ? ' strong' : ''}`} title={c.name.length > CARD.maxNameChars ? c.name : undefined}>
                  {truncate(c.name, CARD.maxNameChars)}
                </span>
                <span className="ctype" style={{ paddingLeft: CARD.gap }} title={c.type.length > CARD.maxTypeChars ? c.type : undefined}>
                  {truncate(c.type, CARD.maxTypeChars)}
                </span>
                {cc.default > 0 && (
                  <span className="cdef" style={{ paddingLeft: CARD.gap }} title={c.defaultValue ? `default ${c.defaultValue}` : undefined}>
                    {c.defaultValue ? truncate(c.defaultValue, CARD.maxDefaultChars) : ''}
                  </span>
                )}
                <span className="cnull" title={c.nullable ? 'nullable' : 'not null'}>
                  {c.nullable && !c.isPrimaryKey ? '?' : ''}
                </span>
              </div>
            );
          })}
          {n.hiddenColumns > 0 && n.height > CARD.headerHeight + n.columns.length * CARD.rowHeight + 2 && (
            <div className="row more">
              <span />
              <span>+{n.hiddenColumns} more</span>
            </div>
          )}
        </div>
      )}
      {lod > 0 && (
        <div className="card-ghost">
          <span className="ghost-name" style={{ fontSize: lod === 2 ? 30 : 18 }}>
            {table.name}
          </span>
          {lod === 1 && <span className="ghost-meta">{table.columns.length} cols</span>}
        </div>
      )}
    </div>
  );
}

export const TableNode = memo(TableNodeImpl);

function CollapsedNodeImpl({ data }: NodeProps<CollapsedFlowNode>) {
  const n = data.node;
  const count = useApp((s) => s.layout?.schemas.find((x) => x.schema === n.schema)?.tableCount ?? 0);
  const toggle = useApp((s) => s.toggleSchemaCollapsed);
  return (
    <div
      className="collapsed-schema"
      style={{ width: n.width, height: n.height, ['--schema-hue' as string]: schemaHue(data.schemaIndex) }}
      onDoubleClick={() => toggle(n.schema)}
      title="Double-click to expand"
    >
      <div className="cs-name">{n.schema}</div>
      <div className="cs-meta">{count} tables · collapsed</div>
    </div>
  );
}

export const CollapsedNode = memo(CollapsedNodeImpl);
