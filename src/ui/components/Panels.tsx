import { useMemo, useState } from 'react';
import { modelStats } from '../../domain/model';
import { hubThreshold, isFiltering, schemaHue } from '../../view/graphQueries';
import { useApp } from '../state/store';
import { useVisibleSet } from './Diagram';
import { tableLookup } from './TableNode';

const NO_DIAGNOSTICS: never[] = [];

/** Schemas: collapse / hide / focus, plus graph filters. */
export function SchemaPanel() {
  const model = useApp((s) => s.parse?.model);
  const filters = useApp((s) => s.filters);
  const collapsed = useApp((s) => s.layoutOptions.collapsedSchemas);
  const selected = useApp((s) => s.selected);
  const index = useApp((s) => s.index);
  const { setFilters, clearFilters, toggleSchemaCollapsed } = useApp.getState();
  const [open, setOpen] = useState(() => typeof window === 'undefined' || window.innerWidth > 820);
  if (!model) return null;
  if (!open)
    return (
      <button className="panel panel-tab" onClick={() => setOpen(true)} title="Show schemas & filters">
        Schemas <span className="muted">{model.schemas.length}</span>
        {isFiltering(filters) && <span className="filter-dot" />}
      </button>
    );
  const hub = index ? hubThreshold(index) : 0;

  return (
    <section className="panel schema-panel">
      <div className="panel-head">
        <span>Schemas</span>
        <span>
          {isFiltering(filters) && (
            <button className="link" onClick={clearFilters}>
              Clear filters
            </button>
          )}
          <button className="link fold" onClick={() => setOpen(false)} title="Hide panel">
            ‹
          </button>
        </span>
      </div>
      <ul className="schema-list">
        {model.schemas.map((s, i) => {
          const hidden = filters.hiddenSchemas.includes(s.name);
          const focused = filters.focusSchema === s.name;
          const isCollapsed = collapsed.includes(s.name);
          return (
            <li key={s.name} className={`${hidden ? 'off' : ''} ${focused ? 'focused' : ''}`} style={{ ['--schema-hue' as string]: schemaHue(i) }}>
              <span className="dot" />
              <span className="sname" title={s.name}>
                {s.name}
              </span>
              <span className="count">{s.tableIds.length}</span>
              <span className="actions">
                <button title={isCollapsed ? 'Expand' : 'Collapse into one box'} onClick={() => toggleSchemaCollapsed(s.name)} className={isCollapsed ? 'on' : ''}>
                  {isCollapsed ? '▸' : '▾'}
                </button>
                <button
                  title={hidden ? 'Show' : 'Hide'}
                  className={hidden ? 'on' : ''}
                  onClick={() => setFilters({ hiddenSchemas: hidden ? filters.hiddenSchemas.filter((x) => x !== s.name) : [...filters.hiddenSchemas, s.name] })}
                >
                  {hidden ? '○' : '●'}
                </button>
                <button title={focused ? 'Unfocus' : 'Show only this schema'} className={focused ? 'on' : ''} onClick={() => setFilters({ focusSchema: focused ? undefined : s.name })}>
                  ◎
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      <div className="panel-head sub">Filters</div>
      <div className="filters">
        <label className="check" title={selected ? '' : 'Select a table first'}>
          <input
            type="checkbox"
            disabled={!selected && !filters.relatedTo}
            checked={!!filters.relatedTo}
            onChange={(e) => setFilters({ relatedTo: e.target.checked && selected ? { table: selected, depth: filters.relatedTo?.depth ?? 1 } : undefined })}
          />
          Related to {filters.relatedTo ? <b>{filters.relatedTo.table.split('.').pop()}</b> : 'selection'}
          {filters.relatedTo && (
            <select value={filters.relatedTo.depth} onChange={(e) => setFilters({ relatedTo: { ...filters.relatedTo!, depth: Number(e.target.value) } })}>
              <option value={1}>1 hop</option>
              <option value={2}>2 hops</option>
              <option value={3}>3 hops</option>
            </select>
          )}
        </label>
        <label className="check">
          <input type="checkbox" checked={filters.hubsOnly} onChange={(e) => setFilters({ hubsOnly: e.target.checked, orphansOnly: false })} />
          Highly connected <span className="muted">(≥ {hub} links)</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={filters.orphansOnly} onChange={(e) => setFilters({ orphansOnly: e.target.checked, hubsOnly: false })} />
          Orphans <span className="muted">(no relations)</span>
        </label>
      </div>
    </section>
  );
}

/** Details of the selected table. */
export function Inspector() {
  const selected = useApp((s) => s.selected);
  const model = useApp((s) => s.parse?.model);
  const index = useApp((s) => s.index);
  const locked = useApp((s) => (selected ? !!s.locked[selected] : false));
  const { toggleLock, select, focusOn, jumpToSource, setFilters } = useApp.getState();
  const table = selected ? tableLookup(model).get(selected) : undefined;
  if (!model || !table) return <section className="panel inspector muted-panel">Select a table to inspect it.</section>;
  const outgoing = model.relationships.filter((r) => r.sourceTable === table.id);
  const incoming = model.relationships.filter((r) => r.targetTable === table.id && r.sourceTable !== table.id);
  const enumOf = (id?: string) => (id ? model.enums.find((e) => e.id === id) : undefined);

  return (
    <section className="panel inspector">
      <div className="insp-head">
        <div>
          <div className="insp-schema">{table.schema}</div>
          <div className="insp-name">{table.name}</div>
        </div>
        <button className="btn icon" onClick={() => select(null)} title="Close">
          ×
        </button>
      </div>
      <div className="insp-actions">
        <button className="btn small" onClick={() => focusOn(table.id)}>
          Center
        </button>
        <button className={`btn small ${locked ? 'on' : ''}`} onClick={() => toggleLock(table.id)} title="Pin this table where it is">
          {locked ? 'Unlock' : 'Lock'}
        </button>
        <button className="btn small" onClick={() => setFilters({ relatedTo: { table: table.id, depth: 1 } })}>
          Isolate
        </button>
        {table.source && (
          <button className="btn small" onClick={() => jumpToSource(table.source!.offset)}>
            Source
          </button>
        )}
      </div>
      {table.kind !== 'table' && <div className="insp-note">{table.kind === 'external' ? 'Referenced but not defined in this script.' : 'Partitioned table'}</div>}
      {table.comment && <p className="insp-comment">{table.comment}</p>}
      <div className="insp-section">
        Columns <span className="muted">{table.columns.length}</span>
      </div>
      <table className="insp-cols">
        <tbody>
          {table.columns.map((c) => {
            const en = enumOf(c.enumId);
            return (
              <tr key={c.name}>
                <td className="flags">
                  {c.isPrimaryKey && <span className="ico pk">P</span>}
                  {c.isForeignKey && <span className="ico fk">F</span>}
                  {c.isUnique && !c.isPrimaryKey && <span className="ico uq">U</span>}
                </td>
                <td>
                  <div className="c-name">
                    {c.name}
                    {!c.nullable && <span className="nn">not null</span>}
                  </div>
                  <div className="c-type">
                    {c.type}
                    {c.identity && <span> · identity {c.identity}</span>}
                  </div>
                  {c.defaultValue && <div className="c-def">default {c.defaultValue}</div>}
                  {c.generatedExpression && <div className="c-def">generated {c.generatedExpression}</div>}
                  {en && <div className="c-enum">{en.values.join(' | ')}</div>}
                  {c.comment && <div className="c-comment">{c.comment}</div>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {(outgoing.length > 0 || incoming.length > 0) && (
        <>
          <div className="insp-section">
            Relationships <span className="muted">{outgoing.length + incoming.length}</span>
          </div>
          <ul className="insp-rels">
            {outgoing.map((r) => (
              <li key={r.id}>
                <span className="dir">→</span>
                <button className="link" onClick={() => select(r.targetTable, true)}>
                  {r.targetTable}
                </button>
                <span className="muted">
                  ({r.sourceColumns.join(', ')}) {r.constraintName ?? ''}
                </span>
              </li>
            ))}
            {incoming.map((r) => (
              <li key={r.id}>
                <span className="dir">←</span>
                <button className="link" onClick={() => select(r.sourceTable, true)}>
                  {r.sourceTable}
                </button>
                <span className="muted">({r.sourceColumns.join(', ')})</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {table.indexes.length > 0 && (
        <>
          <div className="insp-section">
            Indexes <span className="muted">{table.indexes.length}</span>
          </div>
          <ul className="insp-idx">
            {table.indexes.map((ix) => (
              <li key={ix.name}>
                <code>{ix.name}</code>
                <span className="muted">
                  {ix.unique ? 'unique ' : ''}
                  {ix.method !== 'btree' ? ix.method + ' ' : ''}({ix.columns.join(', ')}){ix.where ? ` where ${ix.where}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {table.checks.length > 0 && (
        <>
          <div className="insp-section">Checks</div>
          <ul className="insp-idx">
            {table.checks.map((c, i) => (
              <li key={i}>
                <code>{c.name ?? 'check'}</code> <span className="muted">{c.expression}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {index && <div className="insp-foot muted">Degree {index.degree.get(table.id) ?? 0}</div>}
    </section>
  );
}

export function DiagnosticsPanel() {
  const diagnostics = useApp((s) => s.parse?.diagnostics) ?? NO_DIAGNOSTICS;
  const error = useApp((s) => s.error);
  const jumpToSource = useApp((s) => s.jumpToSource);
  if (!error && diagnostics.length === 0) return null;
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  return (
    <section className="diagnostics">
      <div className="diag-head">
        {errors > 0 ? <span className="err">{errors} error{errors > 1 ? 's' : ''}</span> : null}
        {diagnostics.length - errors > 0 && <span className="warn">{diagnostics.length - errors} warning{diagnostics.length - errors > 1 ? 's' : ''}</span>}
        {errors > 0 && <span className="muted">— everything else was still drawn</span>}
      </div>
      <ul>
        {error && <li className="fatal">{error}</li>}
        {diagnostics.map((d, i) => (
          <li key={i} className={d.severity} onClick={() => jumpToSource(d.offset)} title="Jump to source">
            <span className="pos">
              {d.line}:{d.column}
            </span>
            <span className="msg">{d.message}</span>
            {d.near && <code className="near">{d.near}</code>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function StatusBar() {
  const model = useApp((s) => s.parse?.model);
  const stats = useApp((s) => s.parse?.stats);
  const layout = useApp((s) => s.layout);
  const status = useApp((s) => s.status);
  const phase = useApp((s) => s.phase);
  const visible = useVisibleSet();
  const m = useMemo(() => (model ? modelStats(model) : null), [model]);
  return (
    <footer className="statusbar">
      {m ? (
        <>
          <span>
            <b>{m.schemas}</b> schemas
          </span>
          <span>
            <b>{m.tables}</b> tables
          </span>
          <span>
            <b>{m.relationships}</b> relations
          </span>
          <span>
            <b>{m.indexes}</b> indexes
          </span>
          {m.enums > 0 && (
            <span>
              <b>{m.enums}</b> enums
            </span>
          )}
          {visible && (
            <span className="accent">
              showing <b>{visible.size}</b>
            </span>
          )}
        </>
      ) : (
        <span className="muted">No schema loaded</span>
      )}
      <span className="grow" />
      {status === 'working' && (
        <span>
          <span className="spinner small" /> {phase ?? 'working'}
        </span>
      )}
      {stats && <span className="muted">parse {stats.durationMs.toFixed(0)} ms</span>}
      {layout && (
        <span className="muted" title={`crossings ${layout.metrics.edgeCrossings} · bends ${layout.metrics.bends} · through tables ${layout.metrics.edgeNodeOverlaps}`}>
          layout {layout.durationMs.toFixed(0)} ms · {layout.metrics.edgeCrossings} crossings
        </span>
      )}
      <span className="muted" title="Your SQL never leaves this browser tab">
        local only
      </span>
    </footer>
  );
}
