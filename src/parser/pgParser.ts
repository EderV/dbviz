/**
 * Port for "something that turns one PostgreSQL statement into an AST".
 *
 * The only implementation is libpg-query (PostgreSQL's own grammar compiled
 * to WebAssembly), but the model builder depends on this interface, not on
 * the library, so the adapter can be swapped or faked in tests.
 */

export interface RawStmt {
  stmt: Record<string, any>;
  stmt_location?: number;
  stmt_len?: number;
}

export type RawParseResult =
  | { ok: true; stmts: RawStmt[] }
  | { ok: false; message: string; /** 0-based character index within the input, if known. */ position?: number };

export interface PgParserPort {
  parse(sql: string): RawParseResult;
}

interface LibpgQueryModule {
  loadModule(): Promise<void>;
  parseSync(sql: string): { stmts?: RawStmt[] };
}

/**
 * libpg-query reports positions as UTF-8 byte offsets. JavaScript strings are
 * indexed in UTF-16 code units, so every location coming out of the AST goes
 * through this mapper before it touches the source text.
 */
export class ByteMapper {
  private readonly ascii: boolean;
  private byteToChar?: Int32Array;

  constructor(private readonly text: string) {
    // eslint-disable-next-line no-control-regex
    this.ascii = /^[\x00-\x7f]*$/.test(text);
  }

  toChar(byteOffset: number): number {
    if (this.ascii) return byteOffset;
    if (!this.byteToChar) this.byteToChar = this.buildMap();
    const clamped = Math.max(0, Math.min(byteOffset, this.byteToChar.length - 1));
    return this.byteToChar[clamped];
  }

  private buildMap(): Int32Array {
    const encoder = new TextEncoder();
    const total = encoder.encode(this.text).length;
    const map = new Int32Array(total + 1);
    let byte = 0;
    for (let ci = 0; ci < this.text.length; ci++) {
      const code = this.text.codePointAt(ci)!;
      const len = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
      for (let k = 0; k < len; k++) map[byte + k] = ci;
      byte += len;
      if (code >= 0x10000) ci++; // surrogate pair
    }
    map[total] = this.text.length;
    return map;
  }
}

export async function createLibpgQueryParser(
  load: () => Promise<LibpgQueryModule> = () => import('libpg-query') as Promise<LibpgQueryModule>,
): Promise<PgParserPort> {
  const lib = await load();
  await lib.loadModule();
  return {
    parse(sql: string): RawParseResult {
      try {
        const result = lib.parseSync(sql);
        return { ok: true, stmts: result.stmts ?? [] };
      } catch (err: any) {
        const details = err?.sqlDetails;
        const cursor: number | undefined = details?.cursorPosition;
        const position = typeof cursor === 'number' && cursor > 0 ? new ByteMapper(sql).toChar(cursor - 1) : undefined;
        return { ok: false, message: String(details?.message ?? err?.message ?? err), position };
      }
    },
  };
}
