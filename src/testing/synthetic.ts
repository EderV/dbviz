/**
 * Deterministic generator of realistic-looking PostgreSQL schemas.
 *
 * Used for fixtures, tests and the layout benchmark. It emits SQL text, not a
 * model, so every synthetic case exercises the full pipeline
 * (split → parse → model → layout).
 *
 * The graph shape is not uniform-random: real schemas have domains (schemas)
 * with dense internal references, a few hub tables (users, organizations),
 * junction tables, chains, and a minority of cross-domain references. The
 * generator reproduces those structures because that is what the layout has
 * to cope with.
 */

export interface SyntheticOptions {
  seed?: number;
  schemas: number;
  tables: number;
  relationships: number;
  /** Fraction of relationships that cross schema boundaries (0..1). */
  crossSchemaRatio?: number;
  /** Add a hub table referenced from many places (the "users" problem). */
  hub?: boolean;
  junctions?: number;
  selfReferences?: number;
  /** Pairs of tables connected by more than one FK. */
  multiEdges?: number;
  /** Tables with no relationships at all. */
  orphans?: number;
  /** Put FKs in ALTER TABLE statements (pg_dump style) instead of inline. */
  alterStyle?: boolean;
}

const DOMAINS = [
  'identity', 'billing', 'catalog', 'orders', 'shipping', 'inventory', 'support', 'analytics', 'content', 'messaging',
  'clubs', 'recordings', 'scheduling', 'payments', 'audit', 'reporting', 'search', 'media', 'crm', 'hr',
];

const NOUNS = [
  'accounts', 'profiles', 'sessions', 'tokens', 'invoices', 'line_items', 'products', 'variants', 'prices', 'carts',
  'orders', 'order_items', 'shipments', 'parcels', 'carriers', 'warehouses', 'stock_levels', 'tickets', 'replies',
  'agents', 'events', 'metrics', 'dashboards', 'articles', 'revisions', 'tags', 'threads', 'messages', 'attachments',
  'members', 'teams', 'roles', 'permissions', 'cameras', 'clips', 'venues', 'bookings', 'slots', 'refunds', 'payouts',
  'ledgers', 'entries', 'reports', 'exports', 'queries', 'indexes_meta', 'assets', 'folders', 'contacts', 'deals',
  'employees', 'departments', 'contracts', 'reviews', 'notes', 'webhooks', 'subscriptions', 'plans', 'coupons', 'regions',
];

const COLUMN_POOL: [string, string][] = [
  ['name', 'text NOT NULL'],
  ['title', 'varchar(200)'],
  ['description', 'text'],
  ['status', 'text NOT NULL DEFAULT \'active\''],
  ['amount', 'numeric(12,2)'],
  ['quantity', 'integer NOT NULL DEFAULT 0'],
  ['metadata', 'jsonb NOT NULL DEFAULT \'{}\'::jsonb'],
  ['is_enabled', 'boolean NOT NULL DEFAULT true'],
  ['position', 'smallint'],
  ['starts_at', 'timestamptz'],
  ['ends_at', 'timestamptz'],
  ['external_ref', 'varchar(64)'],
  ['tags', 'text[]'],
  ['payload', 'bytea'],
  ['duration', 'interval'],
];

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface GenTable {
  schema: string;
  name: string;
  columns: string[];
  fks: { cols: string[]; target: GenTable; name: string }[];
}

export function generateSchemaSql(options: SyntheticOptions): string {
  const rand = mulberry32(options.seed ?? 42);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const crossRatio = options.crossSchemaRatio ?? 0.2;

  const schemas = DOMAINS.slice(0, options.schemas).map((d, i) => (i < DOMAINS.length ? d : `domain_${i}`));
  const tables: GenTable[] = [];
  const used = new Set<string>();

  // Distribute tables unevenly across schemas (real domains differ in size).
  const weights = schemas.map(() => 0.5 + rand() * 1.5);
  const wsum = weights.reduce((a, b) => a + b, 0);
  const perSchema = weights.map((w) => Math.max(1, Math.round((w / wsum) * options.tables)));
  let diff = options.tables - perSchema.reduce((a, b) => a + b, 0);
  for (let i = 0; diff !== 0; i = (i + 1) % perSchema.length) {
    if (diff > 0) {
      perSchema[i]++;
      diff--;
    } else if (perSchema[i] > 1) {
      perSchema[i]--;
      diff++;
    }
  }

  schemas.forEach((schema, si) => {
    for (let k = 0; k < perSchema[si]; k++) {
      let name = pick(NOUNS);
      let n = 2;
      while (used.has(`${schema}.${name}`)) name = `${pick(NOUNS)}${n++ > 3 ? '_' + n : ''}`;
      used.add(`${schema}.${name}`);
      const colCount = 2 + Math.floor(rand() * 6);
      const cols: string[] = [];
      const seen = new Set<string>();
      for (let c = 0; c < colCount; c++) {
        const [cn, ct] = pick(COLUMN_POOL);
        if (seen.has(cn)) continue;
        seen.add(cn);
        cols.push(`${cn} ${ct}`);
      }
      tables.push({ schema, name, columns: cols, fks: [] });
    }
  });

  const bySchema = new Map<string, GenTable[]>();
  for (const t of tables) bySchema.set(t.schema, [...(bySchema.get(t.schema) ?? []), t]);

  let hub: GenTable | undefined;
  if (options.hub && tables.length > 0) {
    hub = tables[0];
    hub.name = 'users';
  }

  const addFk = (from: GenTable, to: GenTable, colBase?: string) => {
    let col = `${colBase ?? singular(to.name)}_id`;
    let n = 2;
    while (from.fks.some((f) => f.cols[0] === col)) col = `${colBase ?? singular(to.name)}_${n++}_id`;
    from.fks.push({ cols: [col], target: to, name: `fk_${from.name}_${col}`.slice(0, 63) });
  };

  const orphanSet = new Set<GenTable>(tables.slice(-Math.min(options.orphans ?? 0, tables.length)));
  const linkable = tables.filter((t) => !orphanSet.has(t));

  let budget = options.relationships;

  // Chains inside each schema: a natural parent → child backbone.
  for (const list of bySchema.values()) {
    const l = list.filter((t) => !orphanSet.has(t));
    for (let i = 1; i < l.length && budget > 0; i++) {
      if (rand() < 0.75) {
        addFk(l[i], l[Math.floor(rand() * i)]);
        budget--;
      }
    }
  }
  // Hub references, a large share from every schema.
  if (hub) {
    const share = Math.min(budget, Math.round(options.relationships * 0.15));
    const candidates = linkable.filter((t) => t !== hub);
    for (let i = 0; i < share; i++) {
      addFk(pick(candidates), hub, pick(['user', 'owner', 'author', 'created_by', 'assignee']));
      budget--;
    }
  }
  for (let j = 0; j < (options.junctions ?? 0); j++) {
    const a = pick(linkable);
    const b = pick(linkable);
    if (a === b) continue;
    const jt: GenTable = { schema: a.schema, name: `${singular(a.name)}_${b.name}`.slice(0, 60), columns: ['created_at timestamptz NOT NULL DEFAULT now()'], fks: [] };
    if (used.has(`${jt.schema}.${jt.name}`)) continue;
    used.add(`${jt.schema}.${jt.name}`);
    jt.fks.push({ cols: [`${singular(a.name)}_id`], target: a, name: `fk_${jt.name}_a`.slice(0, 63) });
    jt.fks.push({ cols: [`${singular(b.name)}_id`], target: b, name: `fk_${jt.name}_b`.slice(0, 63) });
    (jt as GenTable & { junction?: boolean }).junction = true;
    tables.push(jt);
    budget -= 2;
  }
  for (let s = 0; s < (options.selfReferences ?? 0); s++) {
    addFk(pick(linkable), pick(linkable), 'parent');
    const t = linkable[Math.floor(rand() * linkable.length)];
    t.fks.push({ cols: ['parent_id'], target: t, name: `fk_${t.name}_parent_self`.slice(0, 63) });
    budget -= 2;
  }
  for (let m = 0; m < (options.multiEdges ?? 0); m++) {
    const a = pick(linkable);
    const b = pick(linkable);
    if (a === b) continue;
    addFk(a, b, 'billing_' + singular(b.name));
    addFk(a, b, 'shipping_' + singular(b.name));
    budget -= 2;
  }
  // Remaining budget: mostly intra-schema, some cross-schema.
  let guard = 0;
  while (budget > 0 && guard++ < options.relationships * 20) {
    const from = pick(linkable);
    const sameSchema = rand() > crossRatio;
    const pool = sameSchema ? (bySchema.get(from.schema) ?? []).filter((t) => !orphanSet.has(t)) : linkable.filter((t) => t.schema !== from.schema);
    if (pool.length === 0) continue;
    const to = pick(pool);
    if (to === from) continue;
    addFk(from, to);
    budget--;
  }

  // ---- emit SQL --------------------------------------------------------
  const out: string[] = [];
  out.push(`-- Synthetic schema: ${options.schemas} schemas, ${tables.length} tables (seed ${options.seed ?? 42})`);
  out.push('CREATE EXTENSION IF NOT EXISTS pgcrypto;');
  for (const s of schemas) out.push(`CREATE SCHEMA ${s};`);
  out.push('');
  const q = (t: GenTable) => `${t.schema}.${t.name}`;
  for (const t of tables) {
    const lines = ['    id uuid PRIMARY KEY DEFAULT gen_random_uuid()'];
    for (const fk of t.fks) {
      const nullable = rand() < 0.3 ? '' : ' NOT NULL';
      lines.push(`    ${fk.cols[0]} uuid${nullable}`);
    }
    for (const c of t.columns) lines.push(`    ${c}`);
    if (!t.columns.some((c) => c.startsWith('created_at '))) lines.push('    created_at timestamptz NOT NULL DEFAULT now()');
    if (!options.alterStyle) {
      for (const fk of t.fks) lines.push(`    CONSTRAINT ${fk.name} FOREIGN KEY (${fk.cols.join(', ')}) REFERENCES ${q(fk.target)}(id)`);
    }
    out.push(`CREATE TABLE ${q(t)} (\n${lines.join(',\n')}\n);`);
  }
  if (options.alterStyle) {
    out.push('');
    for (const t of tables) {
      for (const fk of t.fks) {
        out.push(`ALTER TABLE ONLY ${q(t)}\n    ADD CONSTRAINT ${fk.name} FOREIGN KEY (${fk.cols.join(', ')}) REFERENCES ${q(fk.target)}(id);`);
      }
    }
  }
  out.push('');
  for (const t of tables) {
    for (const fk of t.fks) out.push(`CREATE INDEX ${`idx_${t.name}_${fk.cols[0]}`.slice(0, 63)} ON ${q(t)} (${fk.cols[0]});`);
  }
  return out.join('\n') + '\n';
}

function singular(name: string): string {
  if (name.endsWith('ies')) return name.slice(0, -3) + 'y';
  if (name.endsWith('ses')) return name.slice(0, -2);
  if (name.endsWith('s')) return name.slice(0, -1);
  return name;
}
