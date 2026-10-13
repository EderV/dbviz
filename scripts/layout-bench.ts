/**
 * Layout benchmark.
 *
 *   npm run bench:layout                 # all cases, all engines
 *   npm run bench:layout -- --svg out    # also write debug SVG snapshots
 *
 * Prints objective quality metrics per engine and case so algorithm changes
 * can be compared with numbers, not impressions.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLibpgQueryParser } from '../src/parser/pgParser';
import { parseSql } from '../src/parser/parseSql';
import { generateSchemaSql, type SyntheticOptions } from '../src/testing/synthetic';
import { ElkCompoundEngine } from '../src/layout/elk/elkCompound';
import { routerStats } from '../src/layout/gridRouter';
import { SchemaAwareEngine } from '../src/layout/elk/schemaAwareEngine';
import { DEFAULT_LAYOUT_OPTIONS, type LayoutEngine, type LayoutResult } from '../src/layout/types';

export const BENCH_CASES: Record<string, SyntheticOptions> = {
  'small-20': { seed: 1, schemas: 3, tables: 20, relationships: 30, hub: true, junctions: 1, selfReferences: 1, multiEdges: 1, orphans: 1 },
  'medium-50': { seed: 2, schemas: 5, tables: 50, relationships: 100, hub: true, junctions: 3, selfReferences: 2, multiEdges: 2, orphans: 3 },
  'large-100': { seed: 3, schemas: 10, tables: 100, relationships: 200, hub: true, junctions: 6, selfReferences: 3, multiEdges: 3, orphans: 5 },
  'huge-200': { seed: 4, schemas: 12, tables: 200, relationships: 500, hub: true, junctions: 10, selfReferences: 4, multiEdges: 4, orphans: 8, alterStyle: true },
  'xl-300': { seed: 5, schemas: 15, tables: 300, relationships: 1000, hub: true, junctions: 12, selfReferences: 5, multiEdges: 5, orphans: 10, alterStyle: true },
};

function debugSvg(r: LayoutResult): string {
  const pad = 40;
  const minX = Math.min(...r.nodes.map((n) => n.x), ...r.schemas.map((s) => s.x)) - pad;
  const minY = Math.min(...r.nodes.map((n) => n.y), ...r.schemas.map((s) => s.y)) - pad;
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${r.width + pad * 2} ${r.height + pad * 2}" width="${Math.min(4000, r.width + pad * 2)}"><rect x="${minX}" y="${minY}" width="100%" height="100%" fill="#fff"/>`);
  for (const s of r.schemas) {
    parts.push(`<rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" rx="10" fill="#f3f5f9" stroke="#b9c2d0"/>`);
    parts.push(`<text x="${s.x + 14}" y="${s.y + 26}" font-family="sans-serif" font-size="18" font-weight="700" fill="#4b5668">${s.schema}</text>`);
  }
  for (const e of r.edges) {
    const d = e.points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    parts.push(`<path d="${d}" fill="none" stroke="${e.crossSchema ? '#d0611f' : '#3d6fd8'}" stroke-width="1.4" opacity="0.8"/>`);
  }
  for (const n of r.nodes) {
    parts.push(`<rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="5" fill="#fff" stroke="#55606f"/>`);
    parts.push(`<rect x="${n.x}" y="${n.y}" width="${n.width}" height="34" rx="5" fill="#e4e9f2"/>`);
    parts.push(`<text x="${n.x + 10}" y="${n.y + 22}" font-family="monospace" font-size="13" font-weight="700">${n.id.split('.').pop()}</text>`);
  }
  parts.push('</svg>');
  return parts.join('\n');
}

async function main() {
  const svgDir = process.argv.includes('--svg') ? process.argv[process.argv.indexOf('--svg') + 1] : undefined;
  const only = process.argv.includes('--case') ? process.argv[process.argv.indexOf('--case') + 1] : undefined;
  const engineFilter = process.argv.includes('--engine') ? process.argv[process.argv.indexOf('--engine') + 1] : undefined;
  if (svgDir) mkdirSync(svgDir, { recursive: true });
  const parser = await createLibpgQueryParser();
  const engines: LayoutEngine[] = [new SchemaAwareEngine(), new ElkCompoundEngine()].filter((e) => !engineFilter || e.name === engineFilter);

  const rows: string[] = [];
  for (const [name, opts] of Object.entries(BENCH_CASES)) {
    if (only && name !== only) continue;
    const parsed = parseSql(generateSchemaSql(opts), parser);
    for (const engine of engines) {
      const r = await engine.layout({ model: parsed.model, options: DEFAULT_LAYOUT_OPTIONS });
      const m = r.metrics;
      rows.push(
        [name, engine.name, `${parsed.model.tables.length}t/${parsed.model.relationships.length}r`, `${r.durationMs.toFixed(0)}ms(${Object.entries(r.timings ?? {}).map(([k, v]) => `${k.replace('Ms', '')} ${v.toFixed(0)}`).join(', ')})`, `cross=${m.edgeCrossings}`, `thruTable=${m.edgeNodeOverlaps}`, `thruSchema=${m.edgeSchemaIntrusions}`, `overlap=${m.nodeOverlaps}/${m.schemaOverlaps}`, `meanLen=${m.meanEdgeLength}`, `bends=${m.bends}`, `${m.width}x${m.height}`, `fill=${m.areaUsage}`, `fail=${routerStats.failures}(unreach ${routerStats.unreachable ?? 0}) exp=${routerStats.expansions}`].join('  '),
      );
      if (svgDir) writeFileSync(join(svgDir, `${name}.${engine.name}.svg`), debugSvg(r));
    }
  }
  console.log(rows.join('\n'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
