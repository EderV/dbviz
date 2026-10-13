import type { DatabaseModel } from '../domain/model';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: DiagnosticSeverity;
  message: string;
  /** 1-based position of the problem in the original script. */
  line: number;
  column: number;
  /** Character offset in the original script (for editor navigation). */
  offset: number;
  /** The offending source line, for display. */
  sourceLine?: string;
  /** A short excerpt of the statement around the problem. */
  near?: string;
}

export interface ParseStats {
  statements: number;
  /** Statements recognized and folded into the model. */
  used: number;
  /** Valid statements that don't affect the diagram (functions, grants, views...). */
  ignored: number;
  failed: number;
  durationMs: number;
}

export interface ParseResult {
  model: DatabaseModel;
  diagnostics: Diagnostic[];
  stats: ParseStats;
}
