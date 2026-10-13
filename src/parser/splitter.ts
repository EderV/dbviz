/**
 * Splits a PostgreSQL script into statements.
 *
 * This is deliberately *not* a parser: it only needs to find statement
 * boundaries so each statement can be handed to the real PostgreSQL grammar
 * (libpg-query) independently. That gives us per-statement error isolation:
 * one broken statement produces one diagnostic and the rest still renders.
 *
 * It understands everything that can hide a `;`:
 *   - `-- line comments` and nested `/* block comments *\/`
 *   - 'strings' with '' escapes, E'strings' with backslash escapes
 *   - "quoted identifiers"
 *   - $$dollar$$ and $tag$dollar$tag$ quoting (function bodies)
 *   - BEGIN ATOMIC ... END bodies (SQL-standard functions, PG14+)
 * and the pg_dump artifacts that are not SQL at all:
 *   - psql meta-commands (`\connect`, `\restrict`, ...)
 *   - `COPY ... FROM stdin;` data blocks terminated by `\.`
 */

export interface SqlStatement {
  /** Statement text without the trailing semicolon. */
  text: string;
  /** Character offset of `text[0]` in the original script. */
  start: number;
  /** 1-based line/column of `text[0]`. */
  line: number;
  column: number;
}

export interface LineIndex {
  lineStarts: number[];
}

export function buildLineIndex(source: string): LineIndex {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  return { lineStarts };
}

export function offsetToLineColumn(index: LineIndex, offset: number): { line: number; column: number } {
  const starts = index.lineStarts;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo] + 1 };
}

const isIdentStart = (c: string) => /[A-Za-z_\u0080-\uffff]/.test(c);
const isIdentChar = (c: string) => /[A-Za-z0-9_$\u0080-\uffff]/.test(c);

/** Reads a dollar-quote opening tag at `i` (`$$` or `$tag$`), or returns null. */
function readDollarTag(src: string, i: number): string | null {
  if (src[i] !== '$') return null;
  // `$1` is a positional parameter, not a dollar quote.
  if (i > 0 && isIdentChar(src[i - 1])) return null;
  let j = i + 1;
  if (src[j] === '$') return '$$';
  if (!isIdentStart(src[j] ?? '')) return null;
  while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
  return src[j] === '$' ? src.slice(i, j + 1) : null;
}

function skipToLineEnd(src: string, i: number): number {
  const nl = src.indexOf('\n', i);
  return nl === -1 ? src.length : nl;
}

export function splitStatements(source: string, lineIndex: LineIndex = buildLineIndex(source)): SqlStatement[] {
  const out: SqlStatement[] = [];
  const n = source.length;
  let i = 0;
  let stmtStart = -1; // first significant char of current statement
  let atomicDepth = 0; // inside BEGIN ATOMIC ... END
  let lastWord = '';

  const emit = (endExclusive: number) => {
    if (stmtStart >= 0) {
      const text = source.slice(stmtStart, endExclusive).trimEnd();
      if (text.length > 0) {
        const { line, column } = offsetToLineColumn(lineIndex, stmtStart);
        out.push({ text, start: stmtStart, line, column });
      }
    }
    stmtStart = -1;
    atomicDepth = 0;
    lastWord = '';
  };

  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    // psql meta-command: only meaningful between statements, at line start.
    if (c === '\\' && stmtStart < 0) {
      i = skipToLineEnd(source, i);
      continue;
    }
    if (c === '-' && next === '-') {
      i = skipToLineEnd(source, i);
      continue;
    }
    if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (source[i] === '/' && source[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (source[i] === '*' && source[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }

    if (stmtStart < 0) stmtStart = i;

    if (c === "'") {
      const escapeStrings = i > 0 && (source[i - 1] === 'E' || source[i - 1] === 'e') && !(i > 1 && isIdentChar(source[i - 2]));
      i++;
      while (i < n) {
        if (escapeStrings && source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === "'") {
          if (source[i + 1] === "'") {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      i++;
      lastWord = '';
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n) {
        if (source[i] === '"') {
          if (source[i + 1] === '"') {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      i++;
      lastWord = '';
      continue;
    }
    if (c === '$') {
      const tag = readDollarTag(source, i);
      if (tag) {
        const close = source.indexOf(tag, i + tag.length);
        i = close === -1 ? n : close + tag.length;
        lastWord = '';
        continue;
      }
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentChar(source[j])) j++;
      const word = source.slice(i, j).toUpperCase();
      if (word === 'ATOMIC' && lastWord === 'BEGIN') atomicDepth++;
      else if (atomicDepth > 0 && (word === 'CASE')) atomicDepth++;
      else if (atomicDepth > 0 && word === 'END') atomicDepth--;
      lastWord = word;
      i = j;
      continue;
    }
    if (c === ';' && atomicDepth === 0) {
      const text = stmtStart >= 0 ? source.slice(stmtStart, i) : '';
      emit(i);
      i++;
      // COPY ... FROM stdin is followed by raw data rows up to a `\.` line.
      if (/^COPY\b[\s\S]*\bFROM\s+STDIN\b/i.test(text)) {
        let lineStart = source.indexOf('\n', i);
        while (lineStart !== -1) {
          const lineEnd = skipToLineEnd(source, lineStart + 1);
          const line = source.slice(lineStart + 1, lineEnd).trimEnd();
          if (line === '\\.') {
            lineStart = lineEnd;
            break;
          }
          if (lineEnd >= n) {
            lineStart = n;
            break;
          }
          lineStart = lineEnd;
        }
        i = lineStart === -1 ? n : lineStart;
      }
      continue;
    }
    lastWord = '';
    i++;
  }
  emit(n);
  return out;
}
