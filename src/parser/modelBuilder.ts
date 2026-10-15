/**
 * Folds libpg-query ASTs into the normalized DatabaseModel.
 *
 * Statements are applied in script order, exactly like PostgreSQL would.
 * Anything that may point forward (foreign keys, comments, enum types) is
 * recorded as a draft and resolved in `finish()`, so it doesn't matter
 * whether a FK is declared inline, in a table constraint, or in an
 * `ALTER TABLE ... ADD CONSTRAINT` three thousand lines later.
 */
import type {
  CheckConstraintModel,
  ColumnModel,
  DatabaseModel,
  EnumModel,
  IndexModel,
  ReferentialAction,
  RelationshipModel,
  SchemaModel,
  SourceRef,
  TableId,
  TableKind,
  TableModel,
  UniqueConstraintModel,
} from '../domain/model';
import { tableId } from '../domain/model';
import { ByteMapper, type RawStmt } from './pgParser';
import { offsetToLineColumn, type LineIndex, type SqlStatement } from './splitter';
import { formatTypeName, minLocation, sliceExpression, stringList, stripOuterParens } from './sqlText';
import type { Diagnostic } from './types';

interface ColumnDraft extends ColumnModel {
  typeSchema?: string;
  typeBase: string;
}

interface TableDraft {
  id: TableId;
  schema: string;
  name: string;
  kind: TableKind;
  columns: Map<string, ColumnDraft>;
  primaryKey: string[];
  primaryKeyName?: string;
  uniques: UniqueConstraintModel[];
  checks: CheckConstraintModel[];
  indexes: IndexModel[];
  comment?: string;
  definition?: string;
  source?: SourceRef;
  order: number;
}

interface QualifiedName {
  schema?: string;
  name: string;
}

interface ForeignKeyDraft {
  name?: string;
  sourceTable: TableId;
  sourceColumns: string[];
  target: QualifiedName;
  targetColumns: string[];
  onDelete: ReferentialAction;
  onUpdate: ReferentialAction;
  searchPath: string[];
  source: SourceRef;
}

interface StatementContext {
  stmt: SqlStatement;
  mapper: ByteMapper;
}

export type ApplyOutcome = 'used' | 'ignored';

const FK_ACTIONS: Record<string, ReferentialAction> = {
  a: 'no action',
  r: 'restrict',
  c: 'cascade',
  n: 'set null',
  d: 'set default',
};

/** Statement kinds we parse successfully but that never affect the diagram. */
const KNOWN_IRRELEVANT = new Set([
  'CreateFunctionStmt', 'GrantStmt', 'GrantRoleStmt', 'CreateTrigStmt', 'CreateSeqStmt', 'AlterSeqStmt',
  'AlterOwnerStmt', 'TransactionStmt', 'CreateRoleStmt', 'AlterRoleStmt', 'CopyStmt', 'InsertStmt', 'UpdateStmt',
  'DeleteStmt', 'DoStmt', 'CreatePolicyStmt', 'AlterDefaultPrivilegesStmt', 'CreateTableAsStmt', 'RuleStmt',
  'DropStmt', 'CreateDomainStmt', 'CompositeTypeStmt', 'AlterFunctionStmt', 'AlterEnumStmt', 'CreateCastStmt',
]);

export class ModelBuilder {
  private readonly tables = new Map<TableId, TableDraft>();
  private readonly schemas = new Map<string, { declared: boolean; order: number }>();
  private readonly enums = new Map<string, EnumModel>();
  private readonly extensions: string[] = [];
  private readonly foreignKeys: ForeignKeyDraft[] = [];
  private readonly pendingComments: { target: string[]; kind: 'table' | 'column'; comment?: string; searchPath: string[] }[] = [];
  private searchPath: string[] = ['public'];
  private tableOrder = 0;
  readonly diagnostics: Diagnostic[] = [];

  constructor(private readonly source: string, private readonly lineIndex: LineIndex) {}

  // -------------------------------------------------------------------------
  // Statement dispatch
  // -------------------------------------------------------------------------

  apply(stmt: SqlStatement, raw: RawStmt): ApplyOutcome {
    const ctx: StatementContext = { stmt, mapper: new ByteMapper(stmt.text) };
    const [kind, node] = Object.entries(raw.stmt)[0] ?? [];
    switch (kind) {
      case 'CreateSchemaStmt':
        return this.createSchema(ctx, node);
      case 'CreateStmt':
        return this.createTable(ctx, node);
      case 'AlterTableStmt':
        return this.alterTable(ctx, node);
      case 'ViewStmt':
        return this.createView(ctx, node.view, node.query, stringList(node.aliases), 'view', !!node.replace);
      case 'CreateTableAsStmt':
        if (node.objtype !== 'OBJECT_MATVIEW') return 'ignored';
        return this.createView(ctx, node.into?.rel, node.query, stringList(node.into?.colNames), 'materialized-view', !!node.if_not_exists);
      case 'IndexStmt':
        return this.createIndex(ctx, node);
      case 'CreateEnumStmt':
        return this.createEnum(node);
      case 'CommentStmt':
        return this.comment(node);
      case 'CreateExtensionStmt':
        if (node.extname && !this.extensions.includes(node.extname)) this.extensions.push(node.extname);
        return 'used';
      case 'VariableSetStmt':
        return this.variableSet(node);
      case 'SelectStmt':
        return this.selectSetConfig(node);
      case 'RenameStmt':
        return this.rename(node);
      default:
        if (kind && !KNOWN_IRRELEVANT.has(kind)) return 'ignored';
        return 'ignored';
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private ref(ctx: StatementContext, byteLocation?: number): SourceRef {
    const local = typeof byteLocation === 'number' && byteLocation >= 0 ? ctx.mapper.toChar(byteLocation) : 0;
    const offset = ctx.stmt.start + local;
    const { line, column } = offsetToLineColumn(this.lineIndex, offset);
    return { line, column, offset };
  }

  private exprText(ctx: StatementContext, node: unknown, untilEnd = false): string | undefined {
    const loc = minLocation(node);
    if (loc < 0) return undefined;
    const text = sliceExpression(ctx.stmt.text, ctx.mapper.toChar(loc), { untilEnd });
    return text.length > 0 ? text : undefined;
  }

  private warn(ref: SourceRef, message: string, severity: Diagnostic['severity'] = 'warning') {
    const lineText = this.source.slice(this.lineIndex.lineStarts[ref.line - 1], this.lineIndex.lineStarts[ref.line] ?? this.source.length);
    this.diagnostics.push({ severity, message, line: ref.line, column: ref.column, offset: ref.offset, sourceLine: lineText.replace(/\n$/, '') });
  }

  private effectiveSearchPath(): string[] {
    return this.searchPath.length > 0 ? this.searchPath : ['public'];
  }

  private noteSchema(name: string, declared: boolean) {
    const existing = this.schemas.get(name);
    if (existing) {
      if (declared) existing.declared = true;
      return;
    }
    this.schemas.set(name, { declared, order: this.schemas.size });
  }

  private schemaForCreate(rv: any): string {
    return rv?.schemaname ?? this.effectiveSearchPath()[0];
  }

  /** Resolves a RangeVar to an existing table using the current search_path. */
  private resolveExisting(rv: any): TableDraft | undefined {
    if (!rv?.relname) return undefined;
    if (rv.schemaname) return this.tables.get(tableId(rv.schemaname, rv.relname));
    for (const s of this.effectiveSearchPath()) {
      const t = this.tables.get(tableId(s, rv.relname));
      if (t) return t;
    }
    return undefined;
  }

  private newTable(schema: string, name: string, kind: TableKind, source?: SourceRef): TableDraft {
    this.noteSchema(schema, false);
    const t: TableDraft = {
      id: tableId(schema, name),
      schema,
      name,
      kind,
      columns: new Map(),
      primaryKey: [],
      uniques: [],
      checks: [],
      indexes: [],
      source,
      order: this.tableOrder++,
    };
    this.tables.set(t.id, t);
    return t;
  }

  // -------------------------------------------------------------------------
  // CREATE SCHEMA / TYPE / EXTENSION / SET
  // -------------------------------------------------------------------------

  private createSchema(ctx: StatementContext, node: any): ApplyOutcome {
    const name: string | undefined = node.schemaname ?? node.authrole?.rolename;
    if (!name) return 'ignored';
    this.noteSchema(name, true);
    // CREATE SCHEMA s CREATE TABLE t (...) — elements live in the new schema.
    if (Array.isArray(node.schemaElts) && node.schemaElts.length > 0) {
      const saved = this.searchPath;
      this.searchPath = [name];
      for (const elt of node.schemaElts) this.apply(ctx.stmt, { stmt: elt });
      this.searchPath = saved;
    }
    return 'used';
  }

  private createEnum(node: any): ApplyOutcome {
    const names = stringList(node.typeName);
    const name = names[names.length - 1];
    const schema = names.length > 1 ? names[names.length - 2] : this.effectiveSearchPath()[0];
    if (!name) return 'ignored';
    this.noteSchema(schema, false);
    const id = `${schema}.${name}`;
    this.enums.set(id, { id, schema, name, values: stringList(node.vals) });
    return 'used';
  }

  private variableSet(node: any): ApplyOutcome {
    if (node.name !== 'search_path') return 'ignored';
    if (node.kind === 'VAR_RESET' || node.kind === 'VAR_SET_DEFAULT') this.searchPath = ['public'];
    else this.searchPath = parseSearchPath((node.args ?? []).map((a: any) => a?.A_Const?.sval?.sval ?? a?.String?.sval ?? '').join(','));
    return 'used';
  }

  /** pg_dump emits `SELECT pg_catalog.set_config('search_path', '', false);` */
  private selectSetConfig(node: any): ApplyOutcome {
    const fn = node.targetList?.[0]?.ResTarget?.val?.FuncCall;
    const fname = stringList(fn?.funcname).pop();
    if (fname !== 'set_config') return 'ignored';
    const args = fn.args ?? [];
    if (args[0]?.A_Const?.sval?.sval !== 'search_path') return 'ignored';
    this.searchPath = parseSearchPath(args[1]?.A_Const?.sval?.sval ?? '');
    return 'used';
  }

  // -------------------------------------------------------------------------
  // CREATE TABLE
  // -------------------------------------------------------------------------

  private createTable(ctx: StatementContext, node: any): ApplyOutcome {
    const rv = node.relation;
    if (!rv?.relname) return 'ignored';
    if (rv.relpersistence === 't') return 'ignored'; // temporary tables
    const schema = this.schemaForCreate(rv);
    const id = tableId(schema, rv.relname);
    const source = this.ref(ctx, rv.location);
    if (this.tables.has(id)) {
      if (node.if_not_exists) return 'used';
      this.warn(source, `Table ${id} is defined more than once; the later definition wins.`);
      this.tables.delete(id);
    }
    const table = this.newTable(schema, rv.relname, node.partspec ? 'partitioned' : 'table', source);

    for (const elt of node.tableElts ?? []) {
      if (elt.ColumnDef) this.addColumn(ctx, table, elt.ColumnDef);
      else if (elt.Constraint) this.addTableConstraint(ctx, table, elt.Constraint);
    }
    return 'used';
  }

  // -------------------------------------------------------------------------
  // CREATE [MATERIALIZED] VIEW
  // -------------------------------------------------------------------------

  /**
   * Views are drawn as cards too. Their columns come from the SELECT list;
   * a plain column reference borrows the type of the column it reads, so
   * views over tables declared earlier in the script get real types.
   */
  private createView(ctx: StatementContext, rv: any, query: any, aliases: string[], kind: 'view' | 'materialized-view', keepExisting: boolean): ApplyOutcome {
    if (!rv?.relname) return 'ignored';
    if (rv.relpersistence === 't') return 'ignored'; // temporary views
    const schema = this.schemaForCreate(rv);
    const id = tableId(schema, rv.relname);
    const source = this.ref(ctx, rv.location);
    const existing = this.tables.get(id);
    if (existing) {
      if (keepExisting && kind === 'materialized-view') return 'used'; // IF NOT EXISTS
      // CREATE OR REPLACE VIEW silently replaces; anything else is a real redefinition.
      if (!(keepExisting && existing.kind === kind)) this.warn(source, `${id} is defined more than once; the later definition wins.`);
      this.tables.delete(id);
    }
    const view = this.newTable(schema, rv.relname, kind, source);
    view.definition = viewDefinition(ctx.stmt.text, ctx.mapper.toChar(rv.location));

    const columns = this.viewColumns(query);
    aliases.forEach((alias, i) => {
      if (columns[i]) columns[i].name = alias;
    });
    for (const c of columns) view.columns.set(c.name, c);
    return 'used';
  }

  private viewColumns(query: any): ColumnDraft[] {
    let sel = query?.SelectStmt ?? query;
    // UNION / INTERSECT / EXCEPT: column names come from the leftmost branch.
    while (sel && sel.op && sel.op !== 'SETOP_NONE' && sel.larg) sel = sel.larg.SelectStmt ?? sel.larg;
    if (!sel) return [];
    if (Array.isArray(sel.valuesLists) && sel.valuesLists.length > 0) {
      const first = sel.valuesLists[0]?.List?.items ?? [];
      return first.map((_: unknown, i: number) => viewColumn(`column${i + 1}`, ''));
    }

    // Relations in FROM, keyed by alias (or name), in declaration order.
    const from = new Map<string, TableDraft>();
    const collect = (n: any) => {
      if (!n) return;
      if (n.RangeVar) {
        const t = this.resolveExisting(n.RangeVar);
        if (t) from.set(n.RangeVar.alias?.aliasname ?? n.RangeVar.relname, t);
      } else if (n.JoinExpr) {
        collect(n.JoinExpr.larg);
        collect(n.JoinExpr.rarg);
      }
    };
    for (const n of sel.fromClause ?? []) collect(n);

    const out: ColumnDraft[] = [];
    for (const item of sel.targetList ?? []) {
      const rt = item.ResTarget;
      if (!rt) continue;
      const val = rt.val ?? {};
      if (val.ColumnRef) {
        const fields: any[] = val.ColumnRef.fields ?? [];
        const qualifier: string | undefined = fields.length > 1 ? fields[fields.length - 2]?.String?.sval : undefined;
        const last = fields[fields.length - 1];
        const tables = qualifier ? [from.get(qualifier)].filter((t): t is TableDraft => !!t) : [...from.values()];
        if (last?.A_Star) {
          const expanded = tables.flatMap((t) => [...t.columns.values()].map((c) => viewColumn(c.name, c.type, c, t)));
          out.push(...(expanded.length > 0 ? expanded : [viewColumn('*', '')]));
          continue;
        }
        const colName: string = last?.String?.sval ?? '?column?';
        const owners = tables.filter((t) => t.columns.has(colName));
        const owner = owners.length === 1 ? owners[0] : undefined;
        const src = owner?.columns.get(colName);
        out.push(viewColumn(rt.name ?? colName, src?.type ?? '', src, owner));
        continue;
      }
      const cast = val.TypeCast;
      const fn = val.FuncCall ?? cast?.arg?.FuncCall;
      const inner = cast?.arg?.ColumnRef?.fields;
      const derived = inner ? inner[inner.length - 1]?.String?.sval : fn ? stringList(fn.funcname).pop() : cast ? formatTypeName(cast.typeName).baseName : undefined;
      const type = cast ? formatTypeName(cast.typeName) : undefined;
      const column = viewColumn(rt.name ?? derived ?? '?column?', type?.display ?? '');
      if (type) {
        column.typeBase = type.baseName;
        column.typeSchema = type.schema;
        column.isArray = type.isArray;
      }
      out.push(column);
    }
    return out;
  }

  private addColumn(ctx: StatementContext, table: TableDraft, def: any) {
    const name: string = def.colname;
    if (!name) return;
    const type = formatTypeName(def.typeName);
    const column: ColumnDraft = {
      name,
      type: type.display,
      typeSchema: type.schema,
      typeBase: type.baseName,
      nullable: !type.isSerial && !def.is_not_null,
      isPrimaryKey: false,
      isForeignKey: false,
      isUnique: false,
      isArray: type.isArray,
    };
    if (table.columns.has(name)) this.warn(this.ref(ctx, def.location), `Column ${table.id}.${name} is declared twice.`);
    table.columns.set(name, column);
    for (const c of def.constraints ?? []) {
      if (c.Constraint) this.addColumnConstraint(ctx, table, column, c.Constraint);
    }
  }

  private addColumnConstraint(ctx: StatementContext, table: TableDraft, column: ColumnDraft, c: any) {
    switch (c.contype) {
      case 'CONSTR_NOTNULL':
        column.nullable = false;
        break;
      case 'CONSTR_NULL':
        column.nullable = true;
        break;
      case 'CONSTR_DEFAULT':
        column.defaultValue = this.exprText(ctx, c.raw_expr);
        break;
      case 'CONSTR_IDENTITY':
        column.identity = c.generated_when === 'a' ? 'always' : 'by-default';
        column.nullable = false;
        break;
      case 'CONSTR_GENERATED':
        column.generatedExpression = this.exprText(ctx, c.raw_expr);
        break;
      case 'CONSTR_PRIMARY':
        table.primaryKey = [column.name];
        table.primaryKeyName = c.conname;
        break;
      case 'CONSTR_UNIQUE':
        table.uniques.push({ name: c.conname, columns: [column.name] });
        break;
      case 'CONSTR_CHECK': {
        const expression = this.exprText(ctx, c.raw_expr);
        if (expression) table.checks.push({ name: c.conname, expression });
        break;
      }
      case 'CONSTR_FOREIGN':
        this.addForeignKey(ctx, table, c, [column.name]);
        break;
    }
  }

  private addTableConstraint(ctx: StatementContext, table: TableDraft, c: any) {
    switch (c.contype) {
      case 'CONSTR_PRIMARY': {
        let keys = stringList(c.keys);
        if (keys.length === 0 && c.indexname) keys = table.indexes.find((i) => i.name === c.indexname)?.columns ?? [];
        table.primaryKey = keys;
        table.primaryKeyName = c.conname;
        break;
      }
      case 'CONSTR_UNIQUE': {
        let keys = stringList(c.keys);
        if (keys.length === 0 && c.indexname) keys = table.indexes.find((i) => i.name === c.indexname)?.columns ?? [];
        if (keys.length > 0) table.uniques.push({ name: c.conname, columns: keys });
        break;
      }
      case 'CONSTR_CHECK': {
        const expression = this.exprText(ctx, c.raw_expr);
        if (expression) table.checks.push({ name: c.conname, expression });
        break;
      }
      case 'CONSTR_FOREIGN':
        this.addForeignKey(ctx, table, c, stringList(c.fk_attrs));
        break;
      case 'CONSTR_NOTNULL': {
        // PG18: table-level `NOT NULL col` constraints.
        for (const k of stringList(c.keys)) {
          const col = table.columns.get(k);
          if (col) col.nullable = false;
        }
        break;
      }
    }
  }

  private addForeignKey(ctx: StatementContext, table: TableDraft, c: any, sourceColumns: string[]) {
    const pk = c.pktable;
    if (!pk?.relname) return;
    this.foreignKeys.push({
      name: c.conname,
      sourceTable: table.id,
      sourceColumns,
      target: { schema: pk.schemaname, name: pk.relname },
      targetColumns: stringList(c.pk_attrs),
      onDelete: FK_ACTIONS[c.fk_del_action] ?? 'no action',
      onUpdate: FK_ACTIONS[c.fk_upd_action] ?? 'no action',
      searchPath: this.effectiveSearchPath(),
      source: this.ref(ctx, c.location),
    });
  }

  // -------------------------------------------------------------------------
  // ALTER TABLE
  // -------------------------------------------------------------------------

  private alterTable(ctx: StatementContext, node: any): ApplyOutcome {
    if (node.objtype && node.objtype !== 'OBJECT_TABLE' && node.objtype !== 'OBJECT_FOREIGN_TABLE') return 'ignored';
    const table = this.resolveExisting(node.relation);
    const cmds: any[] = (node.cmds ?? []).map((c: any) => c.AlterTableCmd).filter(Boolean);
    const relevant = cmds.filter((c) => RELEVANT_ALTER.has(c.subtype));
    if (relevant.length === 0) return 'ignored';
    if (!table) {
      if (node.missing_ok) return 'ignored';
      const name = node.relation?.schemaname ? `${node.relation.schemaname}.${node.relation.relname}` : node.relation?.relname;
      this.warn(this.ref(ctx, node.relation?.location), `ALTER TABLE refers to ${name}, which has not been created yet. The change was skipped.`);
      return 'ignored';
    }
    for (const cmd of relevant) this.applyAlterCommand(ctx, table, cmd);
    return 'used';
  }

  private applyAlterCommand(ctx: StatementContext, table: TableDraft, cmd: any) {
    const column = cmd.name ? table.columns.get(cmd.name) : undefined;
    switch (cmd.subtype) {
      case 'AT_AddConstraint':
        if (cmd.def?.Constraint) this.addTableConstraint(ctx, table, cmd.def.Constraint);
        break;
      case 'AT_AddColumn':
        if (cmd.def?.ColumnDef) this.addColumn(ctx, table, cmd.def.ColumnDef);
        break;
      case 'AT_DropColumn':
        if (cmd.name) {
          table.columns.delete(cmd.name);
          table.primaryKey = table.primaryKey.filter((k) => k !== cmd.name);
        }
        break;
      case 'AT_ColumnDefault':
        if (column) column.defaultValue = cmd.def ? this.exprText(ctx, cmd.def, true) : undefined;
        break;
      case 'AT_SetNotNull':
        if (column) column.nullable = false;
        break;
      case 'AT_DropNotNull':
        if (column) column.nullable = true;
        break;
      case 'AT_AlterColumnType':
        if (column && cmd.def?.ColumnDef?.typeName) {
          const t = formatTypeName(cmd.def.ColumnDef.typeName);
          column.type = t.display;
          column.typeBase = t.baseName;
          column.typeSchema = t.schema;
          column.isArray = t.isArray;
        }
        break;
      case 'AT_AddIdentity':
        if (column) {
          column.identity = cmd.def?.Constraint?.generated_when === 'a' ? 'always' : 'by-default';
          column.nullable = false;
        }
        break;
      case 'AT_DropIdentity':
        if (column) column.identity = undefined;
        break;
      case 'AT_DropConstraint':
        this.dropConstraint(table, cmd.name);
        break;
    }
  }

  private dropConstraint(table: TableDraft, name?: string) {
    if (!name) return;
    if (table.primaryKeyName === name) {
      table.primaryKey = [];
      table.primaryKeyName = undefined;
    }
    table.uniques = table.uniques.filter((u) => u.name !== name);
    table.checks = table.checks.filter((c) => c.name !== name);
    for (let i = this.foreignKeys.length - 1; i >= 0; i--) {
      const fk = this.foreignKeys[i];
      if (fk.sourceTable === table.id && fk.name === name) this.foreignKeys.splice(i, 1);
    }
  }

  private rename(node: any): ApplyOutcome {
    if (node.renameType === 'OBJECT_COLUMN') {
      const table = this.resolveExisting(node.relation);
      const col = table?.columns.get(node.subname);
      if (!table || !col || !node.newname) return 'ignored';
      const entries = [...table.columns.entries()].map(([k, v]) => (k === node.subname ? [node.newname, { ...v, name: node.newname }] : [k, v]) as [string, ColumnDraft]);
      table.columns = new Map(entries);
      table.primaryKey = table.primaryKey.map((k) => (k === node.subname ? node.newname : k));
      return 'used';
    }
    return 'ignored';
  }

  // -------------------------------------------------------------------------
  // CREATE INDEX / COMMENT ON
  // -------------------------------------------------------------------------

  private createIndex(ctx: StatementContext, node: any): ApplyOutcome {
    const table = this.resolveExisting(node.relation);
    if (!table) {
      this.warn(this.ref(ctx, node.relation?.location), `Index ${node.idxname ?? ''} is on ${node.relation?.relname}, which is not defined. It was skipped.`, 'info');
      return 'ignored';
    }
    const columns: string[] = (node.indexParams ?? []).map((p: any) => {
      const e = p.IndexElem;
      if (!e) return '?';
      if (e.name) return e.name;
      return this.exprText(ctx, e.expr) ?? 'expression';
    });
    const where = node.whereClause ? this.exprText(ctx, node.whereClause, true) : undefined;
    table.indexes.push({
      name: node.idxname ?? `${table.name}_${columns.join('_')}_idx`,
      columns,
      unique: !!node.unique,
      method: node.accessMethod ?? 'btree',
      where: where ? stripOuterParens(where) : undefined,
      constraintBacked: !!node.primary || !!node.isconstraint,
    });
    return 'used';
  }

  private comment(node: any): ApplyOutcome {
    const kind = TABLE_LIKE_OBJECTS.has(node.objtype) ? 'table' : node.objtype === 'OBJECT_COLUMN' ? 'column' : undefined;
    if (!kind) return 'ignored';
    const target = stringList(node.object?.List?.items);
    this.pendingComments.push({ target, kind, comment: node.comment, searchPath: this.effectiveSearchPath() });
    return 'used';
  }

  // -------------------------------------------------------------------------
  // Finalization
  // -------------------------------------------------------------------------

  private lookup(name: QualifiedName, searchPath: string[]): TableDraft | undefined {
    if (name.schema) return this.tables.get(tableId(name.schema, name.name));
    for (const s of searchPath) {
      const t = this.tables.get(tableId(s, name.name));
      if (t) return t;
    }
    // Last resort: a uniquely named table anywhere.
    const matches = [...this.tables.values()].filter((t) => t.name === name.name);
    return matches.length === 1 ? matches[0] : undefined;
  }

  finish(): DatabaseModel {
    this.applyComments();
    this.resolveColumnFlags();
    const relationships = this.resolveForeignKeys();
    this.resolveEnums();

    const tables: TableModel[] = [...this.tables.values()]
      .sort((a, b) => a.order - b.order)
      .map((t) => ({
        id: t.id,
        schema: t.schema,
        name: t.name,
        kind: t.kind,
        columns: [...t.columns.values()].map(({ typeSchema: _s, typeBase: _b, ...c }) => c),
        primaryKey: t.primaryKey,
        primaryKeyName: t.primaryKeyName,
        uniques: t.uniques,
        checks: t.checks,
        indexes: withConstraintIndexes(t),
        comment: t.comment,
        definition: t.definition,
        source: t.source,
      }));

    const schemaOrder = [...this.schemas.entries()].sort((a, b) => a[1].order - b[1].order);
    const schemas: SchemaModel[] = schemaOrder
      .map(([name, info]) => ({ name, declared: info.declared, tableIds: tables.filter((t) => t.schema === name).map((t) => t.id) }))
      .filter((s) => s.declared || s.tableIds.length > 0);

    return { schemas, tables, relationships, enums: [...this.enums.values()], extensions: this.extensions };
  }

  private applyComments() {
    for (const c of this.pendingComments) {
      const parts = c.target;
      if (c.kind === 'table') {
        const name = parts.length >= 2 ? { schema: parts[parts.length - 2], name: parts[parts.length - 1] } : { name: parts[0] };
        const t = this.lookup(name, c.searchPath);
        if (t) t.comment = c.comment;
      } else {
        const colName = parts[parts.length - 1];
        const rel = parts.length >= 3 ? { schema: parts[parts.length - 3], name: parts[parts.length - 2] } : { name: parts[parts.length - 2] };
        const col = this.lookup(rel, c.searchPath)?.columns.get(colName);
        if (col) col.comment = c.comment;
      }
    }
  }

  private resolveColumnFlags() {
    for (const t of this.tables.values()) {
      for (const k of t.primaryKey) {
        const col = t.columns.get(k);
        if (col) {
          col.isPrimaryKey = true;
          col.nullable = false;
        }
      }
      const uniqueSets = [...t.uniques.map((u) => u.columns), ...t.indexes.filter((i) => i.unique && !i.where).map((i) => i.columns)];
      for (const set of uniqueSets) {
        if (set.length === 1) {
          const col = t.columns.get(set[0]);
          if (col) col.isUnique = true;
        }
      }
    }
  }

  private resolveEnums() {
    for (const t of this.tables.values()) {
      for (const col of t.columns.values()) {
        const candidates = col.typeSchema ? [`${col.typeSchema}.${col.typeBase}`] : [`${t.schema}.${col.typeBase}`, `public.${col.typeBase}`];
        let found = candidates.map((id) => this.enums.get(id)).find(Boolean);
        if (!found && !col.typeSchema) {
          const byName = [...this.enums.values()].filter((e) => e.name === col.typeBase);
          if (byName.length === 1) found = byName[0];
        }
        if (found) col.enumId = found.id;
      }
    }
  }

  private resolveForeignKeys(): RelationshipModel[] {
    const out: RelationshipModel[] = [];
    const usedIds = new Set<string>();
    for (const fk of this.foreignKeys) {
      const source = this.tables.get(fk.sourceTable);
      if (!source) continue;
      let target = this.lookup(fk.target, fk.searchPath);
      if (!target) {
        const schema = fk.target.schema ?? fk.searchPath[0] ?? 'public';
        target = this.newTable(schema, fk.target.name, 'external');
        for (const c of fk.targetColumns.length > 0 ? fk.targetColumns : ['id']) {
          target.columns.set(c, { name: c, type: '?', typeBase: '?', nullable: false, isPrimaryKey: false, isForeignKey: false, isUnique: false, isArray: false });
        }
        if (fk.targetColumns.length === 0) target.primaryKey = ['id'];
        this.warn(fk.source, `Foreign key ${fk.name ? fk.name + ' ' : ''}references ${schema}.${fk.target.name}, which is not defined in this script. It is shown as an external table.`);
      }
      let targetColumns = fk.targetColumns;
      if (targetColumns.length === 0) {
        targetColumns = target.primaryKey;
        if (targetColumns.length === 0) {
          this.warn(fk.source, `Foreign key ${fk.name ? fk.name + ' ' : ''}references ${target.id} without columns, and that table has no primary key.`);
          continue;
        }
      }
      for (const c of fk.sourceColumns) {
        const col = source.columns.get(c);
        if (col) col.isForeignKey = true;
        else this.warn(fk.source, `Foreign key ${fk.name ? fk.name + ' ' : ''}uses column ${c}, which does not exist in ${source.id}.`);
      }
      for (const c of targetColumns) {
        if (!target.columns.has(c) && target.kind !== 'external') {
          this.warn(fk.source, `Foreign key ${fk.name ? fk.name + ' ' : ''}references ${target.id}.${c}, which does not exist.`);
        }
      }

      const sorted = [...fk.sourceColumns].sort().join(',');
      const uniqueSets = [source.primaryKey, ...source.uniques.map((u) => u.columns), ...source.indexes.filter((i) => i.unique && !i.where).map((i) => i.columns)];
      const oneToOne = uniqueSets.some((s) => s.length > 0 && [...s].sort().join(',') === sorted);
      const optional = fk.sourceColumns.some((c) => source.columns.get(c)?.nullable ?? true);

      let id = fk.name ? `${source.id}#${fk.name}` : `${source.id}(${fk.sourceColumns.join(',')})->${target.id}(${targetColumns.join(',')})`;
      if (usedIds.has(id)) {
        let k = 2;
        while (usedIds.has(`${id}~${k}`)) k++;
        id = `${id}~${k}`;
      }
      usedIds.add(id);

      out.push({
        id,
        constraintName: fk.name,
        sourceTable: source.id,
        sourceColumns: fk.sourceColumns,
        targetTable: target.id,
        targetColumns,
        cardinality: oneToOne ? 'one-to-one' : 'many-to-one',
        optional,
        onDelete: fk.onDelete,
        onUpdate: fk.onUpdate,
        selfReference: source.id === target.id,
        crossSchema: source.schema !== target.schema,
        source: fk.source,
      });
    }
    return out;
  }
}

const RELEVANT_ALTER = new Set([
  'AT_AddConstraint', 'AT_AddColumn', 'AT_DropColumn', 'AT_ColumnDefault', 'AT_SetNotNull', 'AT_DropNotNull',
  'AT_AlterColumnType', 'AT_AddIdentity', 'AT_DropIdentity', 'AT_DropConstraint',
]);

const TABLE_LIKE_OBJECTS = new Set(['OBJECT_TABLE', 'OBJECT_VIEW', 'OBJECT_MATVIEW', 'OBJECT_FOREIGN_TABLE']);

function viewColumn(name: string, type: string, from?: ColumnDraft, owner?: TableDraft): ColumnDraft {
  // Primary-key columns are only marked NOT NULL in finish(), so check the key directly.
  const notNull = !!from && (!from.nullable || !!owner?.primaryKey.includes(from.name));
  return {
    name,
    type,
    typeSchema: from?.typeSchema,
    typeBase: from?.typeBase ?? type,
    nullable: !notNull,
    isPrimaryKey: false,
    isForeignKey: false,
    isUnique: false,
    isArray: from?.isArray ?? false,
  };
}

/** The SELECT text of a view, without the trailing `WITH ... CHECK OPTION` / `WITH [NO] DATA`. */
function viewDefinition(text: string, from: number): string | undefined {
  const rest = text.slice(from);
  const m = /\bAS\s+(?=\(?\s*(?:SELECT|WITH|VALUES|TABLE)\b)/i.exec(rest);
  if (!m) return undefined;
  const body = rest
    .slice(m.index + m[0].length)
    .replace(/;\s*$/, '')
    .replace(/\s+WITH\s+(?:(?:CASCADED|LOCAL)\s+)?CHECK\s+OPTION\s*$/i, '')
    .replace(/\s+WITH\s+(?:NO\s+)?DATA\s*$/i, '')
    .trim();
  return body.length > 0 ? body : undefined;
}

function parseSearchPath(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim().replace(/^"(.*)"$/, '$1'))
    .filter((s) => s.length > 0 && s !== '$user' && s !== 'pg_catalog');
}

/** PostgreSQL creates an index for every PRIMARY KEY and UNIQUE constraint. */
function withConstraintIndexes(t: TableDraft): IndexModel[] {
  const out = [...t.indexes];
  const has = (cols: string[]) => out.some((i) => i.unique && i.columns.join(',') === cols.join(','));
  if (t.primaryKey.length > 0 && !has(t.primaryKey)) {
    out.unshift({ name: t.primaryKeyName ?? `${t.name}_pkey`, columns: t.primaryKey, unique: true, method: 'btree', constraintBacked: true });
  }
  for (const u of t.uniques) {
    if (!has(u.columns)) out.push({ name: u.name ?? `${t.name}_${u.columns.join('_')}_key`, columns: u.columns, unique: true, method: 'btree', constraintBacked: true });
  }
  return out;
}
