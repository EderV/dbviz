/**
 * Card geometry.
 *
 * Shared by the layout engine (which needs sizes before anything is drawn)
 * and the renderer (which must draw exactly those sizes). Card text uses a
 * monospace face whose advance width is exactly 0.6em, so widths are exact
 * arithmetic instead of DOM measurement — which also means sizing runs in a
 * Web Worker.
 */
import type { ColumnModel, TableModel } from '../domain/model';
import type { CardColumns, ColumnMode } from './types';

export const CARD = {
  fontSize: 12,
  headerFontSize: 13,
  /** Advance width of the monospace face, as a fraction of font size. */
  advance: 0.6,
  headerHeight: 34,
  rowHeight: 22,
  paddingX: 10,
  iconWidth: 18,
  gap: 12,
  /** Room for the nullability marker at the end of a row. */
  flagWidth: 14,
  bottomPadding: 4,
  minWidth: 170,
  maxNameChars: 28,
  maxTypeChars: 22,
  maxDefaultChars: 14,
  maxTitleChars: 34,
} as const;

export const COLLAPSED_SCHEMA = { width: 240, height: 96 } as const;

const charW = CARD.fontSize * CARD.advance;
const headerCharW = CARD.headerFontSize * CARD.advance;

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

export interface CardSize {
  width: number;
  height: number;
  columns: ColumnModel[];
  hiddenColumns: number;
  cardColumns: CardColumns;
}

/** Columns that stay visible when a card is reduced to its keys. */
export function isKeyColumn(c: ColumnModel, referenced: Set<string>): boolean {
  return c.isPrimaryKey || c.isForeignKey || referenced.has(c.name);
}

export function visibleColumns(table: TableModel, mode: ColumnMode, referenced: Set<string>): ColumnModel[] {
  if (mode === 'all') return table.columns;
  if (mode === 'none') return [];
  return table.columns.filter((c) => isKeyColumn(c, referenced));
}

export function measureCard(table: TableModel, mode: ColumnMode, referenced: Set<string>): CardSize {
  const columns = visibleColumns(table, mode, referenced);
  const hiddenColumns = table.columns.length - columns.length;

  let nameChars = 0;
  let typeChars = 0;
  let defaultChars = 0;
  for (const c of columns) {
    nameChars = Math.max(nameChars, Math.min(c.name.length, CARD.maxNameChars));
    typeChars = Math.max(typeChars, Math.min(c.type.length, CARD.maxTypeChars));
    if (c.defaultValue) defaultChars = Math.max(defaultChars, Math.min(c.defaultValue.length, CARD.maxDefaultChars));
  }
  const cardColumns: CardColumns = {
    name: Math.ceil(nameChars * charW),
    type: Math.ceil(typeChars * charW),
    default: defaultChars > 0 ? Math.ceil(defaultChars * charW) : 0,
  };
  const rowWidth =
    CARD.paddingX * 2 + CARD.iconWidth + cardColumns.name + CARD.gap + cardColumns.type + (cardColumns.default > 0 ? CARD.gap + cardColumns.default : 0) + CARD.flagWidth;
  const titleWidth = CARD.paddingX * 2 + Math.min(table.name.length, CARD.maxTitleChars) * headerCharW + 28;
  const width = Math.ceil(Math.max(CARD.minWidth, rowWidth, titleWidth));

  // Give any slack to the type column so rows stay left-aligned and tidy.
  const slack = width - rowWidth;
  if (slack > 0) cardColumns.type += slack;

  const footerRows = hiddenColumns > 0 && mode !== 'none' ? 1 : 0;
  const height = CARD.headerHeight + (columns.length + footerRows) * CARD.rowHeight + (columns.length > 0 ? CARD.bottomPadding : 0);
  return { width, height, columns, hiddenColumns, cardColumns };
}

/** Y offset (from the card top) of a column row's centre, or the header centre. */
export function rowCenterY(index: number): number {
  if (index < 0) return CARD.headerHeight / 2;
  return CARD.headerHeight + index * CARD.rowHeight + CARD.rowHeight / 2;
}
