/**
 * Project file: everything needed to reproduce a diagram — the SQL itself,
 * view options and manual positions. Layout is *not* stored: it is
 * recomputed, and manual positions are re-applied on top. Plain JSON, so it
 * can later travel in a URL or a share service unchanged.
 */
import { DEFAULT_LAYOUT_OPTIONS, type LayoutOptions } from '../layout/types';
import { NO_FILTERS, type Filters } from '../view/graphQueries';

export const PROJECT_VERSION = 1;

export interface ProjectFile {
  format: 'dbviz-project';
  version: number;
  name: string;
  sql: string;
  layoutOptions: LayoutOptions;
  /** Manually moved tables: id → top-left position. */
  positions: Record<string, { x: number; y: number }>;
  locked: string[];
  filters: Filters;
  savedAt: string;
}

export function serializeProject(p: Omit<ProjectFile, 'format' | 'version' | 'savedAt'>): string {
  const file: ProjectFile = { format: 'dbviz-project', version: PROJECT_VERSION, savedAt: new Date().toISOString(), ...p };
  return JSON.stringify(file, null, 2);
}

export function parseProject(text: string): ProjectFile {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Not a JSON file.');
  }
  if (raw?.format !== 'dbviz-project' && raw?.format !== 'pgviz-project' /* legacy */) throw new Error('Not a dbviz project file.');
  if (typeof raw.version !== 'number' || raw.version > PROJECT_VERSION) throw new Error(`Unsupported project version ${raw.version}.`);
  if (typeof raw.sql !== 'string') throw new Error('Project has no SQL.');
  return {
    format: 'dbviz-project',
    version: raw.version,
    name: String(raw.name ?? 'project'),
    sql: raw.sql,
    layoutOptions: { ...DEFAULT_LAYOUT_OPTIONS, ...(raw.layoutOptions ?? {}) },
    positions: raw.positions && typeof raw.positions === 'object' ? raw.positions : {},
    locked: Array.isArray(raw.locked) ? raw.locked.map(String) : [],
    filters: { ...NO_FILTERS, ...(raw.filters ?? {}) },
    savedAt: String(raw.savedAt ?? ''),
  };
}

export function download(filename: string, data: Blob | string, type = 'application/octet-stream') {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
