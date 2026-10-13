import { ModelBuilder } from './modelBuilder';
import type { PgParserPort } from './pgParser';
import { buildLineIndex, offsetToLineColumn, splitStatements } from './splitter';
import type { Diagnostic, ParseResult } from './types';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * SQL text → normalized model.
 *
 * Each statement is parsed on its own so a syntax error costs exactly one
 * statement: the diagnostic points at the precise line/column PostgreSQL
 * would report, and everything else still makes it into the diagram.
 */
export function parseSql(sql: string, parser: PgParserPort): ParseResult {
  const started = now();
  const lineIndex = buildLineIndex(sql);
  const statements = splitStatements(sql, lineIndex);
  const builder = new ModelBuilder(sql, lineIndex);
  const diagnostics: Diagnostic[] = [];
  let used = 0;
  let ignored = 0;
  let failed = 0;

  for (const stmt of statements) {
    const result = parser.parse(stmt.text);
    if (!result.ok) {
      failed++;
      const local = result.position ?? 0;
      const offset = stmt.start + local;
      const { line, column } = offsetToLineColumn(lineIndex, offset);
      const lineStart = lineIndex.lineStarts[line - 1];
      const lineEnd = lineIndex.lineStarts[line] ?? sql.length;
      diagnostics.push({
        severity: 'error',
        message: tidyMessage(result.message),
        line,
        column,
        offset,
        sourceLine: sql.slice(lineStart, lineEnd).replace(/\r?\n$/, ''),
        near: excerpt(stmt.text, local),
      });
      continue;
    }
    for (const raw of result.stmts) {
      const outcome = builder.apply(stmt, raw);
      if (outcome === 'used') used++;
      else ignored++;
    }
  }

  const model = builder.finish();
  diagnostics.push(...builder.diagnostics);
  diagnostics.sort((a, b) => a.offset - b.offset);
  return {
    model,
    diagnostics,
    stats: { statements: statements.length, used, ignored, failed, durationMs: now() - started },
  };
}

/** PostgreSQL quotes the rest of the statement after "at or near"; keep it short. */
function tidyMessage(message: string): string {
  const m = capitalize(message.replace(/\s+/g, ' '));
  return m.replace(/(at or near ")([^"]{40})[^"]*"/, '$1$2…"');
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

/** A single-line excerpt centred on the error position. */
function excerpt(text: string, position: number): string {
  const start = Math.max(0, position - 30);
  const end = Math.min(text.length, position + 40);
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
}
