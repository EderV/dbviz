import { readFileSync } from 'node:fs';
import { createLibpgQueryParser, type PgParserPort } from '../src/parser/pgParser';
import { parseSql } from '../src/parser/parseSql';

let parser: Promise<PgParserPort> | undefined;
export const getParser = () => (parser ??= createLibpgQueryParser());
export async function parse(sql: string) {
  return parseSql(sql, await getParser());
}
export const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
