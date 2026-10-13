/**
 * Messages between the UI thread and the pipeline worker.
 * Everything is plain structured-clone data: no classes, no functions.
 */
import type { LayoutOptions, LayoutResult } from '../layout/types';
import type { ParseResult } from '../parser/types';

export type PipelineRequest =
  /** Parse SQL and lay it out. */
  | { kind: 'process'; id: number; sql: string; options: LayoutOptions }
  /** Re-layout the last parsed model with new options (collapse, density…). */
  | { kind: 'relayout'; id: number; options: LayoutOptions };

export type PipelinePhase = 'loading-parser' | 'parsing' | 'layout';

export type PipelineResponse =
  | { kind: 'progress'; id: number; phase: PipelinePhase }
  | { kind: 'parsed'; id: number; parse: ParseResult }
  | { kind: 'laidOut'; id: number; layout: LayoutResult }
  | { kind: 'failed'; id: number; error: string };
