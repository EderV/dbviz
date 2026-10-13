/**
 * Recovering readable text from the AST.
 *
 * For defaults, CHECK and index predicates we show what the user actually
 * wrote rather than a re-printed AST: `'{}'::text[]` must stay
 * `'{}'::text[]`. libpg-query gives node locations, so we find the leftmost
 * location inside the expression subtree (operators report their own
 * position, not their left operand's) and scan forward to the end of the
 * expression with a small tokenizer.
 */

/** Smallest `location` field anywhere inside an AST subtree (byte offset), or -1. */
export function minLocation(node: unknown): number {
  let best = -1;
  const visit = (n: unknown) => {
    if (n === null || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      for (const item of n) visit(item);
      return;
    }
    for (const [key, value] of Object.entries(n as Record<string, unknown>)) {
      if (key === 'location' && typeof value === 'number' && value >= 0) {
        if (best === -1 || value < best) best = value;
      } else if (typeof value === 'object') visit(value);
    }
  };
  visit(node);
  return best;
}

const STOP_KEYWORDS = new Set([
  'NOT', 'NULL', 'CONSTRAINT', 'REFERENCES', 'CHECK', 'UNIQUE', 'PRIMARY', 'GENERATED', 'COLLATE', 'DEFAULT',
  'DEFERRABLE', 'INITIALLY', 'ASC', 'DESC', 'NULLS', 'INCLUDE', 'WITH', 'TABLESPACE',
]);

/**
 * Reads one expression starting at character `start` and returns its text.
 * Stops at a top-level `,`, an unmatched `)`, `;`, or a column-constraint
 * keyword that follows at least one token.
 */
export function sliceExpression(text: string, start: number, options: { untilEnd?: boolean } = {}): string {
  let i = start;
  let depth = 0;
  let tokens = 0;
  let end = text.length;
  const n = text.length;
  scan: while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '-' && text[i + 1] === '-') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (c === "'" || c === '"') {
      const escapeMode = c === "'" && i > 0 && /[Ee]/.test(text[i - 1]);
      i++;
      while (i < n) {
        if (text[i] === c) {
          if (text[i + 1] === c) {
            i += 2;
            continue;
          }
          break;
        }
        if (escapeMode && text[i] === '\\') i++;
        i++;
      }
      i++;
      tokens++;
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
      if (m) {
        const close = text.indexOf(m[0], i + m[0].length);
        i = close === -1 ? n : close + m[0].length;
        tokens++;
        continue;
      }
    }
    if (c === '(' || c === '[') {
      depth++;
      i++;
      tokens++;
      continue;
    }
    if (c === ')' || c === ']') {
      if (depth === 0) {
        end = i;
        break;
      }
      depth--;
      i++;
      continue;
    }
    if (depth === 0 && (c === ',' || c === ';') && !options.untilEnd) {
      end = i;
      break;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(text[j])) j++;
      const word = text.slice(i, j).toUpperCase();
      if (depth === 0 && tokens > 0 && !options.untilEnd && STOP_KEYWORDS.has(word)) {
        // `IS NOT NULL` / `NOT NULL` inside an expression is legitimately part of it.
        const before = text.slice(Math.max(start, i - 4), i).toUpperCase();
        if (!(word === 'NOT' && /\bIS\s*$/.test(before)) && !(word === 'NULL' && /\b(IS|NOT)\s*$/.test(before))) {
          end = i;
          break scan;
        }
      }
      tokens++;
      i = j;
      continue;
    }
    tokens++;
    i++;
  }
  return compactWhitespace(text.slice(start, end).trim());
}

export function compactWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ');
}

/** Removes one level of wrapping parentheses: `((a))` → `(a)`. */
export function stripOuterParens(s: string): string {
  const t = s.trim();
  if (!t.startsWith('(') || !t.endsWith(')')) return t;
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '(') depth++;
    else if (t[i] === ')') {
      depth--;
      if (depth === 0 && i < t.length - 1) return t;
    }
  }
  return t.slice(1, -1).trim();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const CATALOG_TYPE_NAMES: Record<string, string> = {
  int2: 'smallint',
  int4: 'integer',
  int8: 'bigint',
  float4: 'real',
  float8: 'double precision',
  bool: 'boolean',
  bpchar: 'char',
  varchar: 'varchar',
  numeric: 'numeric',
  timestamp: 'timestamp',
  timestamptz: 'timestamptz',
  time: 'time',
  timetz: 'timetz',
  interval: 'interval',
  bit: 'bit',
  varbit: 'varbit',
};

export interface FormattedType {
  /** Display string, e.g. `varchar(255)[]`. */
  display: string;
  /** Unqualified base type name, used for enum resolution. */
  baseName: string;
  /** Schema qualifier when one was written (excluding pg_catalog). */
  schema?: string;
  isArray: boolean;
  isSerial: boolean;
}

function constValue(node: any): string | undefined {
  const c = node?.A_Const;
  if (!c) return node?.ColumnRef ? node.ColumnRef.fields?.map((f: any) => f.String?.sval).join('.') : undefined;
  if (c.ival) return String(c.ival.ival ?? 0);
  if (c.ival === undefined && c.fval) return String(c.fval.fval);
  if (c.sval) return c.sval.sval;
  if ('ival' in c) return '0';
  return undefined;
}

export function formatTypeName(typeName: any): FormattedType {
  const names: string[] = (typeName?.names ?? []).map((n: any) => n.String?.sval ?? '');
  let schema: string | undefined;
  let base: string;
  if (names.length >= 2) {
    schema = names[names.length - 2];
    base = names[names.length - 1];
  } else base = names[0] ?? 'unknown';

  let display: string;
  if (schema === 'pg_catalog') {
    schema = undefined;
    display = CATALOG_TYPE_NAMES[base] ?? base;
  } else display = schema && schema !== 'public' ? `${schema}.${base}` : base;

  const isSerial = !schema && /^(small|big)?serial[248]?$/i.test(base);

  // Typmods. interval encodes a field bitmask we don't try to decode.
  const mods: string[] = (typeName?.typmods ?? []).map(constValue).filter((v: string | undefined) => v !== undefined) as string[];
  if (mods.length > 0 && base !== 'interval') display += `(${mods.join(',')})`;

  const bounds = typeName?.arrayBounds ?? [];
  const isArray = bounds.length > 0;
  for (const b of bounds) {
    const v = b?.Integer?.ival;
    display += v !== undefined && v >= 0 ? `[${v}]` : '[]';
  }
  if (typeName?.pct_type) display += '%TYPE';
  if (typeName?.setof) display = `setof ${display}`;
  return { display, baseName: base, schema, isArray, isSerial };
}

export function stringList(nodes: any[] | undefined): string[] {
  return (nodes ?? []).map((n) => n?.String?.sval).filter((s): s is string => typeof s === 'string');
}
