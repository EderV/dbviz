/**
 * Diagram → standalone SVG (and PNG via canvas).
 *
 * Built from the model + layout + manual positions, never from the DOM, so
 * the export is complete regardless of what is on screen, crisp at any
 * scale, and identical to the live view (shared geometry + tokens).
 */
import type { DatabaseModel, TableModel } from '../domain/model';
import type { LayoutNode, LayoutResult } from '../layout/types';
import { CARD, truncate, VIEW_BADGE, viewBadgeLabel, viewBadgeWidth } from '../layout/sizing';
import { boundsOf, edgePathD, endMarkers, resolveEdge } from '../render/edgeGeometry';
import { FONT_MONO, FONT_UI, schemaColors, type ThemeTokens } from '../render/theme';
import { schemaHue } from '../view/graphQueries';

export interface SvgExportInput {
  model: DatabaseModel;
  layout: LayoutResult;
  positions: Record<string, { x: number; y: number }>;
  theme: ThemeTokens;
  /** Restrict to these tables (current filter). */
  visible?: Set<string> | null;
  /** Inline @font-face CSS (base64 fonts) so rasterisation matches the app. */
  fontCss?: string;
  background?: boolean;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r1 = (v: number) => Math.round(v * 10) / 10;

export const SCHEMA_PAD = { top: 44, side: 22, bottom: 22 };

export function exportSvg(input: SvgExportInput): { svg: string; width: number; height: number } {
  const { model, layout, positions, theme: t, visible } = input;
  const tables = new Map(model.tables.map((x) => [x.id, x]));
  const schemaIndex = new Map(model.schemas.map((s, i) => [s.name, i]));
  const shown = (id: string) => !visible || visible.has(id) || id.startsWith('schema:');
  const nodes = layout.nodes.filter((n) => shown(n.id));
  const nodeById = new Map(layout.nodes.map((n) => [n.id, n]));
  const pos = (n: LayoutNode) => positions[n.id] ?? { x: n.x, y: n.y };

  // Schema backgrounds follow the (possibly moved) tables.
  const schemaRects = layout.schemas
    .map((s) => {
      const members = nodes.filter((n) => n.schema === s.schema);
      if (members.length === 0) return null;
      const untouched = members.every((n) => !positions[n.id]);
      const rect = untouched ? s : boundsOf(members.map((n) => ({ ...pos(n), width: n.width, height: n.height })), SCHEMA_PAD);
      return { schema: s.schema, collapsed: s.collapsed, ...rect };
    })
    .filter((s): s is NonNullable<typeof s> => !!s && !s.collapsed);

  const edges = layout.edges.filter((e) => shown(e.source) && shown(e.target));
  const rels = new Map(model.relationships.map((r) => [r.id, r]));

  // Bounds
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const grow = (x: number, y: number) => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  for (const s of schemaRects) {
    grow(s.x, s.y);
    grow(s.x + s.width, s.y + s.height);
  }
  for (const n of nodes) {
    const p = pos(n);
    grow(p.x, p.y);
    grow(p.x + n.width, p.y + n.height);
  }
  const resolved = edges.map((e) => {
    const s = nodeById.get(e.source)!;
    const tg = nodeById.get(e.target)!;
    const r = resolveEdge(e, s, tg, positions[s.id], positions[tg.id]);
    for (const p of r.points) grow(p.x, p.y);
    return { e, r };
  });
  if (!isFinite(x0)) {
    x0 = y0 = 0;
    x1 = y1 = 100;
  }
  const pad = 32;
  const vx = x0 - pad;
  const vy = y0 - pad;
  const width = Math.ceil(x1 - x0 + pad * 2);
  const height = Math.ceil(y1 - y0 + pad * 2);

  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r1(vx)} ${r1(vy)} ${width} ${height}" width="${width}" height="${height}">`);
  out.push('<defs><style>');
  if (input.fontCss) out.push(input.fontCss);
  out.push(
    `.m{font-family:${FONT_MONO};font-size:${CARD.fontSize}px}.t{font-family:${FONT_MONO};font-size:${CARD.headerFontSize}px;font-weight:600}.u{font-family:${FONT_UI}}`,
  );
  out.push('</style></defs>');
  if (input.background !== false) out.push(`<rect x="${r1(vx)}" y="${r1(vy)}" width="${width}" height="${height}" fill="${t.bg}"/>`);

  for (const s of schemaRects) {
    const c = schemaColors(t, schemaHue(schemaIndex.get(s.schema) ?? 0));
    out.push(`<rect x="${r1(s.x)}" y="${r1(s.y)}" width="${r1(s.width)}" height="${r1(s.height)}" rx="12" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.2"/>`);
    out.push(`<text class="u" x="${r1(s.x + 16)}" y="${r1(s.y + 27)}" font-size="15" font-weight="600" fill="${c.solid}">${esc(s.schema)}</text>`);
  }

  for (const { e, r } of resolved) {
    const rel = rels.get(e.relationshipIds[0]);
    const color = e.crossSchema ? t.edgeCross : t.edge;
    out.push(`<path d="${edgePathD(r.points, r.bridges)}" fill="none" stroke="${color}" stroke-width="1.3" stroke-linejoin="round"${e.crossSchema ? ' stroke-dasharray="6 3"' : ''}/>`);
    const mk = endMarkers(r.points, rel?.cardinality ?? 'many-to-one', rel?.optional ?? false);
    out.push(`<path d="${mk.child} ${mk.parent}" fill="none" stroke="${color}" stroke-width="1.3"/>`);
  }

  for (const n of nodes) {
    const p = pos(n);
    if (n.kind === 'collapsed-schema') {
      const c = schemaColors(t, schemaHue(schemaIndex.get(n.schema) ?? 0));
      const count = layout.schemas.find((s) => s.schema === n.schema)?.tableCount ?? 0;
      out.push(`<g transform="translate(${r1(p.x)},${r1(p.y)})">`);
      out.push(`<rect width="${n.width}" height="${n.height}" rx="12" fill="${c.fill}" stroke="${c.solid}" stroke-width="1.5" stroke-dasharray="5 3"/>`);
      out.push(`<text class="u" x="16" y="40" font-size="17" font-weight="600" fill="${c.solid}">${esc(n.schema)}</text>`);
      out.push(`<text class="u" x="16" y="64" font-size="13" fill="${t.inkMuted}">${count} tables (collapsed)</text></g>`);
      continue;
    }
    const table = tables.get(n.id);
    if (table) out.push(card(n, p, table, t, schemaColors(t, schemaHue(schemaIndex.get(n.schema) ?? 0)).solid));
  }
  out.push('</svg>');
  return { svg: out.join('\n'), width, height };
}

function card(n: LayoutNode, p: { x: number; y: number }, table: TableModel, t: ThemeTokens, schemaColor: string): string {
  const o: string[] = [];
  o.push(`<g transform="translate(${r1(p.x)},${r1(p.y)})">`);
  const badge = viewBadgeLabel(table.kind);
  const stroke = table.kind === 'external' ? ` stroke="${t.inkFaint}" stroke-dasharray="4 3"` : badge ? ` stroke="${t.view}" stroke-width="1.5"${table.kind === 'view' ? ' stroke-dasharray="5 3"' : ''}` : ` stroke="${t.cardBorder}"`;
  o.push(`<rect width="${n.width}" height="${n.height}" rx="6" fill="${t.card}"${stroke}/>`);
  o.push(`<path d="M0.5,6 a5.5,5.5 0 0 1 5.5,-5.5 h${n.width - 12} a5.5,5.5 0 0 1 5.5,5.5 v${CARD.headerHeight - 6} h${-(n.width - 1)} z" fill="${badge ? t.viewHeader : t.cardHeader}"/>`);
  o.push(`<rect x="0" y="0" width="3" height="${CARD.headerHeight}" rx="1.5" fill="${schemaColor}"/>`);
  o.push(`<line x1="0" x2="${n.width}" y1="${CARD.headerHeight}" y2="${CARD.headerHeight}" stroke="${t.cardBorder}"/>`);
  o.push(`<text class="t" x="${CARD.paddingX + 2}" y="${CARD.headerHeight / 2 + 4.5}" fill="${badge ? t.view : t.ink}"${badge ? ' font-style="italic"' : ''}>${esc(truncate(table.name, CARD.maxTitleChars))}</text>`);
  if (badge) {
    const bw = viewBadgeWidth(badge);
    const bx = n.width - CARD.paddingX - bw;
    const by = (CARD.headerHeight - VIEW_BADGE.height) / 2;
    const solid = table.kind === 'materialized-view';
    o.push(`<rect x="${r1(bx)}" y="${by}" width="${bw}" height="${VIEW_BADGE.height}" rx="${VIEW_BADGE.height / 2}" fill="${solid ? t.view : 'none'}" stroke="${t.view}"/>`);
    o.push(`<text class="m" x="${r1(bx + VIEW_BADGE.paddingX)}" y="${by + 11.5}" font-size="${VIEW_BADGE.fontSize}" font-weight="700" fill="${solid ? t.card : t.view}">${badge}</text>`);
  }
  const byName = new Map(table.columns.map((c) => [c.name, c]));
  const cc = n.cardColumns;
  const xName = CARD.paddingX + CARD.iconWidth;
  const xType = xName + cc.name + CARD.gap;
  const xDefault = xType + cc.type + CARD.gap;
  n.columns.forEach((name, i) => {
    const c = byName.get(name);
    if (!c) return;
    const y = CARD.headerHeight + i * CARD.rowHeight + CARD.rowHeight / 2 + 4;
    const icon = c.isPrimaryKey ? ['P', t.pk] : c.isForeignKey ? ['F', t.fk] : c.isUnique ? ['U', t.uq] : null;
    if (icon) o.push(`<text class="m" x="${CARD.paddingX}" y="${y}" font-weight="700" font-size="10" fill="${icon[1]}">${icon[0]}</text>`);
    o.push(`<text class="m" x="${xName}" y="${y}" fill="${t.ink}"${c.isPrimaryKey ? ' font-weight="600"' : ''}>${esc(truncate(c.name, CARD.maxNameChars))}</text>`);
    o.push(`<text class="m" x="${xType}" y="${y}" fill="${t.inkMuted}">${esc(truncate(c.type, CARD.maxTypeChars))}</text>`);
    if (c.defaultValue && cc.default > 0) o.push(`<text class="m" x="${xDefault}" y="${y}" fill="${t.inkFaint}" font-size="11">${esc(truncate(c.defaultValue, CARD.maxDefaultChars))}</text>`);
    if (c.nullable && !c.isPrimaryKey) o.push(`<text class="m" x="${n.width - CARD.paddingX - 8}" y="${y}" fill="${t.inkFaint}">?</text>`);
  });
  if (n.hiddenColumns > 0) {
    const y = CARD.headerHeight + n.columns.length * CARD.rowHeight + CARD.rowHeight / 2 + 4;
    if (n.height > CARD.headerHeight + n.columns.length * CARD.rowHeight + 2) o.push(`<text class="m" x="${xName}" y="${y}" fill="${t.inkFaint}" font-size="11">+${n.hiddenColumns} more</text>`);
  }
  o.push('</g>');
  return o.join('');
}

/** Inline the card/UI fonts as base64 so the rasterised PNG uses them. */
export async function embeddedFontCss(urls: { family: string; weight: number; url: string }[]): Promise<string> {
  const rules = await Promise.all(
    urls.map(async (f) => {
      try {
        const buf = await (await fetch(f.url)).arrayBuffer();
        let bin = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return `@font-face{font-family:'${f.family}';font-weight:${f.weight};src:url(data:font/woff2;base64,${btoa(bin)}) format('woff2');}`;
      } catch {
        return '';
      }
    }),
  );
  return rules.join('');
}

/** Rasterise an SVG string. Very large diagrams are scaled to fit the canvas limit. */
export async function svgToPng(svg: string, width: number, height: number, scale = 2): Promise<Blob> {
  const maxSide = 16000;
  const maxArea = 120_000_000;
  let s = Math.min(scale, maxSide / width, maxSide / height);
  if (width * height * s * s > maxArea) s = Math.sqrt(maxArea / (width * height));
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Could not render SVG'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * s));
    canvas.height = Math.max(1, Math.round(height * s));
    const ctx = canvas.getContext('2d')!;
    ctx.scale(s, s);
    ctx.drawImage(img, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}
