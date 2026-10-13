import { describe, expect, it } from 'vitest';
import { splitStatements } from '../src/parser/splitter';

const texts = (sql: string) => splitStatements(sql).map((s) => s.text.trim());

describe('splitStatements', () => {
  it('splits on top-level semicolons only', () => {
    expect(texts("SELECT 1; SELECT ';' ; SELECT \"a;b\";")).toEqual(['SELECT 1', "SELECT ';'", 'SELECT "a;b"']);
  });

  it('keeps dollar-quoted bodies intact, including tagged quotes', () => {
    const sql = 'CREATE FUNCTION f() RETURNS int AS $$ BEGIN; RETURN 1; END; $$ LANGUAGE plpgsql;\nCREATE FUNCTION g() AS $x$ a; $$ b; $x$;\nSELECT 2;';
    const out = texts(sql);
    expect(out).toHaveLength(3);
    expect(out[0]).toContain('RETURN 1; END;');
    expect(out[1]).toContain('$$ b;');
  });

  it('ignores semicolons in line and nested block comments', () => {
    expect(texts('SELECT 1 -- a; b\n; /* x; /* y; */ z; */ SELECT 2;')).toHaveLength(2);
  });

  it('handles E-strings with escaped quotes', () => {
    expect(texts("SELECT E'it\\'s; fine'; SELECT 2;")).toHaveLength(2);
  });

  it('skips psql meta-commands and COPY ... FROM stdin data', () => {
    const sql = "\\connect db\nCOPY t (a) FROM stdin;\n1;2\nx;y\n\\.\nSELECT 3;";
    const out = texts(sql);
    expect(out.some((t) => t.startsWith('COPY'))).toBe(true);
    expect(out.some((t) => t.includes('x;y'))).toBe(false);
    expect(out[out.length - 1]).toBe('SELECT 3');
  });

  it('reports start offsets and 1-based positions', () => {
    const [a, b] = splitStatements('SELECT 1;\n  SELECT 2;');
    expect(a.start).toBe(0);
    expect(b.text.trimStart().startsWith('SELECT 2')).toBe(true);
    expect(b.line).toBe(2);
  });
});
