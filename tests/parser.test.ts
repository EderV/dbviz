import { describe, expect, it } from 'vitest';
import { fixture, parse } from './helpers';

describe('parser → model', () => {
  it('reads inline and table-level constraints', async () => {
    const { model, diagnostics } = await parse(fixture('01-simple.sql'));
    expect(diagnostics).toEqual([]);
    expect(model.tables.map((t) => t.id).sort()).toEqual(['public.authors', 'public.books', 'public.reviews']);
    const books = model.tables.find((t) => t.name === 'books')!;
    expect(books.primaryKey).toEqual(['id']);
    expect(books.columns.find((c) => c.name === 'author_id')).toMatchObject({ nullable: false, isForeignKey: true, type: 'integer' });
    expect(books.columns.find((c) => c.name === 'price')?.defaultValue).toBe('0');
    const fk = model.relationships.find((r) => r.constraintName === 'reviews_book_fk')!;
    expect(fk).toMatchObject({ sourceTable: 'public.reviews', targetTable: 'public.books', sourceColumns: ['book_id'], targetColumns: ['id'] });
    const cascade = model.relationships.find((r) => r.sourceTable === 'public.books')!;
    expect(cascade.onDelete).toBe('cascade');
  });

  it('reads pg_dump style ALTER TABLE ONLY constraints, enums, comments and quoted identifiers', async () => {
    const { model, diagnostics, stats } = await parse(fixture('05-pg-dump-realistic.sql'));
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(stats.failed).toBe(0);
    const articles = model.tables.find((t) => t.id === 'Content.Articles')!;
    expect(articles).toBeDefined();
    expect(articles.primaryKey).toEqual(['id']);
    expect(articles.comment).toMatch(/Quoted/);
    expect(articles.columns.find((c) => c.name === 'authorId')?.comment).toBe('Who wrote it');
    expect(articles.columns.find((c) => c.name === 'tags')).toMatchObject({ isArray: true });
    expect(articles.columns.find((c) => c.name === 'state')?.enumId).toBe('Content.publish_state');
    expect(articles.columns.find((c) => c.name === 'search')?.generatedExpression).toMatch(/to_tsvector/);
    expect(model.enums.find((e) => e.id === 'billing.plan_tier')?.values).toEqual(['free', 'team', 'business', 'enterprise']);

    const users = model.tables.find((t) => t.id === 'auth.users')!;
    expect(users.columns.find((c) => c.name === 'email')).toMatchObject({ isUnique: true, comment: 'Case-insensitive, unique.' });
    expect(users.columns.find((c) => c.name === 'preferences')?.defaultValue).toContain("'::jsonb");

    const identities = model.tables.find((t) => t.id === 'auth.identities')!;
    expect(identities.columns.find((c) => c.name === 'id')?.defaultValue).toContain('nextval');
    const teams = model.tables.find((t) => t.id === 'public.teams')!;
    expect(teams.columns.find((c) => c.name === 'id')?.identity).toBe('always');
    expect(model.tables.find((t) => t.id === 'public.audit_log')?.kind).toBe('partitioned');
  });

  it('resolves composite foreign keys', async () => {
    const { model } = await parse(fixture('05-pg-dump-realistic.sql'));
    const fk = model.relationships.find((r) => r.constraintName === 'team_members_membership_fkey')!;
    expect(fk.sourceColumns).toEqual(['organization_id', 'user_id']);
    expect(fk.targetTable).toBe('public.memberships');
    expect(fk.targetColumns).toEqual(['organization_id', 'user_id']);
  });

  it('marks self references, cross-schema references and cardinality', async () => {
    const { model } = await parse(`
      CREATE SCHEMA a; CREATE SCHEMA b;
      CREATE TABLE a.p (id int PRIMARY KEY, parent_id int REFERENCES a.p (id));
      CREATE TABLE b.c (id int PRIMARY KEY, p_id int NOT NULL UNIQUE REFERENCES a.p (id), q_id int REFERENCES a.p);
    `);
    const self = model.relationships.find((r) => r.sourceTable === 'a.p')!;
    expect(self.selfReference).toBe(true);
    const one = model.relationships.find((r) => r.sourceColumns[0] === 'p_id')!;
    expect(one).toMatchObject({ crossSchema: true, cardinality: 'one-to-one', optional: false });
    const implicit = model.relationships.find((r) => r.sourceColumns[0] === 'q_id')!;
    expect(implicit).toMatchObject({ targetColumns: ['id'], cardinality: 'many-to-one', optional: true });
  });

  it('keeps multiple FKs between the same pair distinct', async () => {
    const { model } = await parse(fixture('04-pathological.sql'));
    const handoffs = model.relationships.filter((r) => r.sourceTable === 'tangle.handoffs');
    expect(handoffs).toHaveLength(6);
    expect(new Set(handoffs.map((r) => r.id)).size).toBe(6);
  });

  it('reports syntax errors with exact positions and still builds the rest', async () => {
    const { model, diagnostics, stats } = await parse(fixture('06-with-errors.sql'));
    const errors = diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({ line: 10, column: 7 });
    expect(errors[0].message).toMatch(/TABEL/);
    expect(errors[1].line).toBe(24);
    expect(stats.failed).toBe(2);
    expect(model.tables.find((t) => t.id === 'app.users')).toBeDefined();
    // The FK to the table that failed to parse becomes an external placeholder.
    expect(model.tables.find((t) => t.id === 'app.teams')?.kind).toBe('external');
    expect(diagnostics.some((d) => d.severity === 'warning' && /app\.teams/.test(d.message))).toBe(true);
  });

  it('honours search_path for unqualified names', async () => {
    const { model } = await parse(`CREATE SCHEMA s; SET search_path = s; CREATE TABLE t (id int PRIMARY KEY); CREATE TABLE u (t_id int REFERENCES t);`);
    expect(model.tables.map((t) => t.id).sort()).toEqual(['s.t', 's.u']);
    expect(model.relationships[0].targetTable).toBe('s.t');
  });

  it('records indexes, including partial and expression-free ones', async () => {
    const { model } = await parse(fixture('05-pg-dump-realistic.sql'));
    const m = model.tables.find((t) => t.id === 'public.memberships')!;
    const partial = m.indexes.find((i) => i.name === 'memberships_one_owner_idx')!;
    expect(partial).toMatchObject({ unique: true, columns: ['organization_id'] });
    expect(partial.where).toMatch(/owner/);
    const brin = model.tables.find((t) => t.id === 'auth.sessions')!.indexes.find((i) => i.name === 'sessions_expires_idx');
    expect(brin?.method).toBe('brin');
  });

  it('parses every fixture without errors (except the error demo)', async () => {
    for (const f of ['01-simple.sql', '02-multi-schema.sql', '03-complex.sql', '04-pathological.sql', '05-pg-dump-realistic.sql']) {
      const { diagnostics, stats } = await parse(fixture(f));
      expect(diagnostics.filter((d) => d.severity === 'error'), f).toEqual([]);
      expect(stats.failed, f).toBe(0);
    }
  });
});

describe('views', () => {
  const sql = `
CREATE SCHEMA reporting;
CREATE TABLE public.users (id bigint PRIMARY KEY, email text NOT NULL, created_at timestamptz);
CREATE TABLE public.orders (id bigint PRIMARY KEY, user_id bigint REFERENCES users(id), total numeric(10,2));
CREATE VIEW reporting.user_orders AS
  SELECT u.id AS user_id, u.email, o.total, count(*) AS n, o.total::text AS total_label
  FROM users u JOIN orders o ON o.user_id = u.id
  GROUP BY 1, 2, 3
  WITH LOCAL CHECK OPTION;
CREATE OR REPLACE VIEW reporting.user_orders AS SELECT u.id AS user_id, u.email FROM users u;
CREATE VIEW all_users (uid, mail) AS SELECT * FROM users;
CREATE MATERIALIZED VIEW reporting.totals AS SELECT user_id, sum(total) AS total FROM orders GROUP BY user_id WITH NO DATA;
CREATE UNIQUE INDEX totals_user ON reporting.totals (user_id);
COMMENT ON VIEW all_users IS 'Everyone';
`;

  it('parses CREATE [MATERIALIZED] VIEW into view nodes with typed columns', async () => {
    const { model, diagnostics } = await parse(sql);
    expect(diagnostics).toEqual([]);

    const uo = model.tables.find((t) => t.id === 'reporting.user_orders')!;
    expect(uo.kind).toBe('view');
    // CREATE OR REPLACE swaps the definition in place.
    expect(uo.columns.map((c) => [c.name, c.type])).toEqual([
      ['user_id', 'bigint'],
      ['email', 'text'],
    ]);
    expect(uo.definition).toBe('SELECT u.id AS user_id, u.email FROM users u');
    expect(uo.columns.map((c) => c.nullable)).toEqual([false, false]);
    expect(uo.primaryKey).toEqual([]);

    const all = model.tables.find((t) => t.id === 'public.all_users')!;
    expect(all.kind).toBe('view');
    expect(all.columns.map((c) => c.name)).toEqual(['uid', 'mail', 'created_at']);
    expect(all.comment).toBe('Everyone');

    const totals = model.tables.find((t) => t.id === 'reporting.totals')!;
    expect(totals.kind).toBe('materialized-view');
    expect(totals.columns.map((c) => c.name)).toEqual(['user_id', 'total']);
    expect(totals.columns[0]).toMatchObject({ type: 'bigint', isUnique: true });
    expect(totals.definition).toBe('SELECT user_id, sum(total) AS total FROM orders GROUP BY user_id');

    expect(model.relationships).toHaveLength(1);
    expect(model.schemas.find((s) => s.name === 'reporting')?.tableIds).toEqual(['reporting.user_orders', 'reporting.totals']);
  });

  it('derives column names from expressions and set operations', async () => {
    const { model } = await parse(`
CREATE TABLE t (a int, b text);
CREATE VIEW v AS SELECT a, now(), b::varchar(5), 1 + 1 FROM t UNION ALL SELECT a, now(), b, 2 FROM t;
CREATE VIEW vals AS VALUES (1, 'x');`);
    const v = model.tables.find((t) => t.id === 'public.v')!;
    expect(v.columns.map((c) => [c.name, c.type])).toEqual([
      ['a', 'integer'],
      ['now', ''],
      ['b', 'varchar(5)'],
      ['?column?', ''],
    ]);
    expect(model.tables.find((t) => t.id === 'public.vals')!.columns.map((c) => c.name)).toEqual(['column1', 'column2']);
  });

  it('counts views separately in model stats', async () => {
    const { modelStats } = await import('../src/domain/model');
    const { model } = await parse(sql);
    expect(modelStats(model)).toMatchObject({ tables: 2, views: 3 });
  });
});

describe('views in a pg_dump', () => {
  it('reads views over parenthesized joins', async () => {
    const { model } = await parse(fixture('05-pg-dump-realistic.sql'));
    const v = model.tables.find((t) => t.id === 'billing.active_subscriptions')!;
    expect(v.kind).toBe('view');
    expect(v.columns.map((c) => c.name)).toEqual(['id', 'organization_id', 'tier']);
    expect(v.columns.find((c) => c.name === 'tier')?.enumId).toBe('billing.plan_tier');
  });
});
