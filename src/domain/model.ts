/**
 * Normalized database model.
 *
 * This is the contract between the parser and everything downstream
 * (graph analysis, layout, rendering, export). Nothing in here knows about
 * SQL text or a particular parser library, and nothing knows about pixels.
 * Every value is plain JSON so the model can cross a Web Worker boundary,
 * be serialized into a project file, or be diffed against another model.
 */

/** `schema.table`, unquoted, case preserved exactly as PostgreSQL stores it. */
export type TableId = string;
export type RelationshipId = string;

export interface SourceRef {
  /** 1-based line of the statement that declared the object. */
  line: number;
  /** 1-based column. */
  column: number;
  /** Character offset into the original SQL. */
  offset: number;
}

export interface ColumnModel {
  name: string;
  /** Canonical, human-readable PostgreSQL type, e.g. `varchar(255)`, `timestamptz`, `text[]`. */
  type: string;
  nullable: boolean;
  /** Original SQL text of the default expression, e.g. `now()` or `'{}'::text[]`. */
  defaultValue?: string;
  /** `GENERATED ALWAYS AS IDENTITY` / `BY DEFAULT`. */
  identity?: 'always' | 'by-default';
  /** `GENERATED ALWAYS AS (expr) STORED`. */
  generatedExpression?: string;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  /** Covered by a single-column UNIQUE constraint or unique index. */
  isUnique: boolean;
  isArray: boolean;
  /** Set when the type resolves to an enum declared in the same file. */
  enumId?: string;
  comment?: string;
}

export interface IndexModel {
  name: string;
  /** Column names, or the expression text for expression indexes. */
  columns: string[];
  unique: boolean;
  method: string;
  where?: string;
  /** True for implicit indexes backing a PRIMARY KEY / UNIQUE constraint. */
  constraintBacked: boolean;
}

export interface UniqueConstraintModel {
  name?: string;
  columns: string[];
}

export interface CheckConstraintModel {
  name?: string;
  expression: string;
}

/** `external` = referenced by a foreign key but never declared in the input. */
export type TableKind = 'table' | 'partitioned' | 'external';

export interface TableModel {
  id: TableId;
  schema: string;
  name: string;
  kind: TableKind;
  columns: ColumnModel[];
  primaryKey: string[];
  primaryKeyName?: string;
  uniques: UniqueConstraintModel[];
  checks: CheckConstraintModel[];
  indexes: IndexModel[];
  comment?: string;
  source?: SourceRef;
}

export type Cardinality = 'one-to-one' | 'many-to-one';

export type ReferentialAction = 'no action' | 'restrict' | 'cascade' | 'set null' | 'set default';

export interface RelationshipModel {
  id: RelationshipId;
  constraintName?: string;
  /** The referencing (child) table: the one that owns the FOREIGN KEY. */
  sourceTable: TableId;
  sourceColumns: string[];
  /** The referenced (parent) table. */
  targetTable: TableId;
  targetColumns: string[];
  cardinality: Cardinality;
  /** True when any FK column is nullable: the child row may exist without a parent. */
  optional: boolean;
  onDelete: ReferentialAction;
  onUpdate: ReferentialAction;
  selfReference: boolean;
  crossSchema: boolean;
  source?: SourceRef;
}

export interface EnumModel {
  id: string;
  schema: string;
  name: string;
  values: string[];
}

export interface SchemaModel {
  name: string;
  tableIds: TableId[];
  /** Declared by CREATE SCHEMA (false for implicit `public` or schemas only seen in references). */
  declared: boolean;
}

export interface DatabaseModel {
  schemas: SchemaModel[];
  tables: TableModel[];
  relationships: RelationshipModel[];
  enums: EnumModel[];
  extensions: string[];
}

export function emptyModel(): DatabaseModel {
  return { schemas: [], tables: [], relationships: [], enums: [], extensions: [] };
}

export function tableId(schema: string, name: string): TableId {
  return `${schema}.${name}`;
}

export interface ModelStats {
  schemas: number;
  tables: number;
  relationships: number;
  indexes: number;
  enums: number;
  columns: number;
}

export function modelStats(model: DatabaseModel): ModelStats {
  let indexes = 0;
  let columns = 0;
  let tables = 0;
  for (const t of model.tables) {
    if (t.kind === 'external') continue;
    tables++;
    indexes += t.indexes.length;
    columns += t.columns.length;
  }
  return {
    schemas: model.schemas.length,
    tables,
    relationships: model.relationships.length,
    indexes,
    enums: model.enums.length,
    columns,
  };
}
