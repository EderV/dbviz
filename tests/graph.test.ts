import { describe, expect, it } from 'vitest';
import { modelStats } from '../src/domain/model';
import { parseProject, serializeProject } from '../src/export/project';
import { DEFAULT_LAYOUT_OPTIONS } from '../src/layout/types';
import { buildGraphIndex, hubThreshold, NO_FILTERS, relatedWithin, search, visibleTables } from '../src/view/graphQueries';
import { fixture, parse } from './helpers';

describe('graph model queries', async () => {
  const { model } = await parse(fixture('05-pg-dump-realistic.sql'));
  const index = buildGraphIndex(model);

  it('counts what the status bar shows', () => {
    const s = modelStats(model);
    expect(s.schemas).toBe(4);
    expect(s.tables).toBe(20);
    expect(s.relationships).toBe(33);
    expect(s.enums).toBe(4);
  });

  it('computes neighbourhoods by hop count', () => {
    const one = relatedWithin(index, 'billing.refunds', 1);
    expect([...one].sort()).toEqual(['auth.users', 'billing.payments', 'billing.refunds']);
    expect(relatedWithin(index, 'billing.refunds', 2).has('billing.invoices')).toBe(true);
  });

  it('identifies hubs and orphans', () => {
    expect(index.degree.get('auth.users')).toBeGreaterThanOrEqual(hubThreshold(index));
    const orphans = visibleTables(model, index, { ...NO_FILTERS, orphansOnly: true })!;
    expect([...orphans]).toEqual(['public.feature_flags']);
    const hubs = visibleTables(model, index, { ...NO_FILTERS, hubsOnly: true })!;
    expect(hubs.has('auth.users')).toBe(true);
  });

  it('filters by schema, focus and relation', () => {
    expect(visibleTables(model, index, NO_FILTERS)).toBeNull();
    const noAuth = visibleTables(model, index, { ...NO_FILTERS, hiddenSchemas: ['auth'] })!;
    expect([...noAuth].some((id) => id.startsWith('auth.'))).toBe(false);
    const billing = visibleTables(model, index, { ...NO_FILTERS, focusSchema: 'billing' })!;
    expect([...billing].every((id) => id.startsWith('billing.'))).toBe(true);
    const near = visibleTables(model, index, { ...NO_FILTERS, relatedTo: { table: 'billing.plans', depth: 1 } })!;
    expect([...near].sort()).toEqual(['billing.plans', 'billing.subscriptions']);
  });

  it('searches tables and columns, exact and prefix matches first', () => {
    const hits = search(model, 'user');
    expect(hits[0]).toMatchObject({ kind: 'table', table: 'auth.users' });
    expect(hits.some((h) => h.kind === 'column' && h.column === 'user_id')).toBe(true);
    expect(search(model, 'authorid')[0]).toMatchObject({ kind: 'column', table: 'Content.Articles', column: 'authorId' });
  });
});

describe('project file', () => {
  it('round-trips', () => {
    const text = serializeProject({ name: 'x', sql: 'select 1', layoutOptions: { ...DEFAULT_LAYOUT_OPTIONS, density: 'compact' }, positions: { 'a.b': { x: 1, y: 2 } }, locked: ['a.b'], filters: NO_FILTERS });
    const p = parseProject(text);
    expect(p.sql).toBe('select 1');
    expect(p.layoutOptions.density).toBe('compact');
    expect(p.positions['a.b']).toEqual({ x: 1, y: 2 });
    expect(p.locked).toEqual(['a.b']);
  });
  it('rejects foreign JSON', () => {
    expect(() => parseProject('{"hello":1}')).toThrow(/dbviz/);
    expect(() => parseProject('nope')).toThrow(/JSON/);
  });
});
