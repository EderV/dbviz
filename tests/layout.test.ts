/**
 * Layout invariants. These are the properties that make a diagram readable;
 * each is checked on hand-written, pathological and synthetic schemas.
 */
import { describe, expect, it } from 'vitest';
import type { DatabaseModel } from '../src/domain/model';
import { SchemaAwareEngine } from '../src/layout/elk/schemaAwareEngine';
import { rectsOverlap, segmentHitsRect, segmentsOf } from '../src/layout/metrics';
import { rowCenterY } from '../src/layout/sizing';
import { DEFAULT_LAYOUT_OPTIONS, type LayoutOptions, type LayoutResult } from '../src/layout/types';
import { generateSchemaSql } from '../src/testing/synthetic';
import { fixture, parse } from './helpers';

const engine = new SchemaAwareEngine();
const layout = (model: DatabaseModel, options: Partial<LayoutOptions> = {}) => engine.layout({ model, options: { ...DEFAULT_LAYOUT_OPTIONS, ...options } });

function checkInvariants(r: LayoutResult, model: DatabaseModel) {
  // 1. No two tables overlap; no two schema boxes overlap.
  for (let i = 0; i < r.nodes.length; i++) for (let j = i + 1; j < r.nodes.length; j++) expect(rectsOverlap(r.nodes[i], r.nodes[j]), `${r.nodes[i].id} × ${r.nodes[j].id}`).toBe(false);
  for (let i = 0; i < r.schemas.length; i++) for (let j = i + 1; j < r.schemas.length; j++) expect(rectsOverlap(r.schemas[i], r.schemas[j])).toBe(false);
  // 2. Every table sits inside its schema box.
  const box = new Map(r.schemas.map((s) => [s.schema, s]));
  for (const n of r.nodes) {
    const s = box.get(n.schema)!;
    expect(n.x >= s.x && n.y >= s.y && n.x + n.width <= s.x + s.width + 0.5 && n.y + n.height <= s.y + s.height + 0.5, n.id).toBe(true);
  }
  // 3. Edges are orthogonal, start/end on the card border at the FK column row, and never cross a table.
  const nodeById = new Map(r.nodes.map((n) => [n.id, n]));
  for (const e of r.edges) {
    expect(e.points.length, e.id).toBeGreaterThanOrEqual(2);
    for (const s of segmentsOf(e.points)) expect(Math.abs(s.a.x - s.b.x) < 0.5 || Math.abs(s.a.y - s.b.y) < 0.5, `${e.id} diagonal`).toBe(true);
    const src = nodeById.get(e.source)!;
    const tgt = nodeById.get(e.target)!;
    const first = e.points[0];
    const last = e.points[e.points.length - 1];
    expect(Math.abs(first.x - src.x) < 1 || Math.abs(first.x - (src.x + src.width)) < 1, `${e.id} start on border`).toBe(true);
    expect(Math.abs(last.x - tgt.x) < 1 || Math.abs(last.x - (tgt.x + tgt.width)) < 1, `${e.id} end on border`).toBe(true);
    if (e.sourceColumn) expect(first.y - src.y).toBeCloseTo(rowCenterY(src.columns.indexOf(e.sourceColumn)), 0);
    if (e.targetColumn) expect(last.y - tgt.y).toBeCloseTo(rowCenterY(tgt.columns.indexOf(e.targetColumn)), 0);
  }
  expect(r.metrics.edgeNodeOverlaps).toBe(0);
  expect(r.metrics.nodeOverlaps).toBe(0);
  // 4. Every table is drawn exactly once.
  expect(r.nodes.filter((n) => n.kind === 'table').length).toBe(model.tables.length);
}

describe('schema-aware layout', () => {
  it('lays out the simple fixture as a crossing-free chain', async () => {
    const { model } = await parse(fixture('01-simple.sql'));
    const r = await layout(model);
    checkInvariants(r, model);
    expect(r.metrics.edgeCrossings).toBe(0);
    // Parent left of child: authors → books → reviews.
    const x = (id: string) => r.nodes.find((n) => n.id === id)!.x;
    expect(x('public.authors')).toBeLessThan(x('public.books'));
    expect(x('public.books')).toBeLessThan(x('public.reviews'));
  });

  it('handles the realistic pg_dump (cross-schema, composite FKs, self references)', async () => {
    const { model } = await parse(fixture('05-pg-dump-realistic.sql'));
    const r = await layout(model);
    checkInvariants(r, model);
    const self = r.edges.find((e) => e.selfLoop)!;
    expect(self).toBeDefined();
    // Self loops leave and re-enter on the same side.
    expect(self.points[0].x).toBeCloseTo(self.points[self.points.length - 1].x, 0);
  });

  it('survives pathological shapes', async () => {
    const { model } = await parse(fixture('04-pathological.sql'));
    const r = await layout(model);
    checkInvariants(r, model);
    // The six FKs between handoffs → people stay six separate, distinct lines.
    const parallel = r.edges.filter((e) => e.source === 'tangle.handoffs' && e.target === 'tangle.people');
    expect(parallel).toHaveLength(6);
    expect(new Set(parallel.map((e) => e.points[0].y)).size).toBe(6);
    // The 25-long chain is wrapped, not a 9000px ribbon.
    const chain = r.schemas.find((s) => s.schema === 'chain')!;
    expect(chain.width / chain.height).toBeLessThan(6);
  });

  it('keeps a mid-size multi-schema diagram clean', async () => {
    const { model } = await parse(generateSchemaSql({ seed: 7, schemas: 5, tables: 40, relationships: 70, hub: true, junctions: 2, selfReferences: 2, multiEdges: 2, orphans: 2 }));
    const r = await layout(model);
    checkInvariants(r, model);
    expect(r.metrics.edgeSchemaIntrusions).toBeLessThanOrEqual(5);
  });

  it('is deterministic', async () => {
    const { model } = await parse(fixture('02-multi-schema.sql'));
    const a = await layout(model);
    const b = await layout(model);
    expect(b.nodes.map((n) => [n.id, n.x, n.y])).toEqual(a.nodes.map((n) => [n.id, n.x, n.y]));
    expect(b.edges.map((e) => e.points)).toEqual(a.edges.map((e) => e.points));
  });

  it('collapses schemas into one node with merged edges', async () => {
    const { model } = await parse(fixture('05-pg-dump-realistic.sql'));
    const r = await layout(model, { collapsedSchemas: ['billing'] });
    expect(r.nodes.some((n) => n.id === 'schema:billing' && n.kind === 'collapsed-schema')).toBe(true);
    expect(r.nodes.some((n) => n.id.startsWith('billing.'))).toBe(false);
    const agg = r.edges.filter((e) => e.source === 'schema:billing' || e.target === 'schema:billing');
    expect(agg.length).toBeGreaterThan(0);
    for (const e of r.edges) for (const n of r.nodes) if (n.id !== e.source && n.id !== e.target) for (const s of segmentsOf(e.points)) expect(segmentHitsRect(s, n)).toBe(false);
  });

  it('respects column modes in card heights', async () => {
    const { model } = await parse(fixture('05-pg-dump-realistic.sql'));
    const all = await layout(model);
    const keys = await layout(model, { columnMode: 'keys' });
    const h = (r: LayoutResult) => r.nodes.find((n) => n.id === 'auth.users')!.height;
    expect(h(keys)).toBeLessThan(h(all));
    checkInvariants(keys, model);
  });
});
