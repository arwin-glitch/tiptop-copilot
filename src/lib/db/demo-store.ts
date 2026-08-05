import 'server-only';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '@/lib/config/env';
import type { Organization, OrganizationMember, UserProfile } from '@/lib/types/domain';
import { applyOptions, matchesFilter, textRank } from './filter';
import type {
  DataStore,
  Filter,
  QueryOptions,
  Row,
  SearchHit,
  TableName,
  UpsertResult,
} from './store';

type Db = { [K in TableName]?: Record<string, unknown>[] };

/**
 * File-backed store used when no Supabase credentials are present.
 *
 * Persisting to disk (rather than keeping state in a module-level object) is
 * deliberate: Next.js route handlers and server components do not share a
 * single module instance across all requests in every runtime, so an in-memory
 * store would silently lose writes mid-flow and make the demo look broken.
 *
 * Writes are serialised through a promise chain and land via write-then-rename
 * so a crash cannot leave a half-written file.
 */
export class DemoStore implements DataStore {
  readonly kind = 'demo' as const;

  private db: Db | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly file: string;
  private readonly seed: () => Db;

  constructor(seed: () => Db, dir?: string) {
    this.seed = seed;
    const base = dir ?? env().demoDataDir;
    this.file = path.isAbsolute(base)
      ? path.join(base, 'store.json')
      : path.join(process.cwd(), base, 'store.json');
  }

  /** Test helper: discard in-memory and on-disk state and reseed. */
  async reset(): Promise<void> {
    this.db = this.seed();
    await this.persist();
  }

  private async load(): Promise<Db> {
    if (this.db) return this.db;
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as { version: number; data: Db };
      if (parsed.version === DEMO_STORE_VERSION) {
        this.db = parsed.data;
        return this.db;
      }
    } catch {
      // Missing, unreadable or stale: fall through to a fresh seed.
    }
    this.db = this.seed();
    await this.persist();
    return this.db;
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify({ version: DEMO_STORE_VERSION, data: this.db }, null, 0);
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot, 'utf8');
      await rename(tmp, this.file);
    });
    await this.writeChain;
  }

  private async table<T extends TableName>(name: T): Promise<Record<string, unknown>[]> {
    const db = await this.load();
    if (!db[name]) db[name] = [];
    return db[name];
  }

  async list<T extends TableName>(
    table: T,
    organizationId: string,
    filter?: Filter,
    options?: QueryOptions,
  ): Promise<Row<T>[]> {
    const rows = await this.table(table);
    const scoped = rows.filter((r) => scopeless(table) || r.organization_id === organizationId);
    const matched = scoped.filter((r) => matchesFilter(r, filter));
    return applyOptions(matched, options) as unknown as Row<T>[];
  }

  async get<T extends TableName>(
    table: T,
    organizationId: string,
    id: string,
  ): Promise<Row<T> | null> {
    const rows = await this.table(table);
    const found = rows.find(
      (r) => r.id === id && (scopeless(table) || r.organization_id === organizationId),
    );
    return (found as unknown as Row<T>) ?? null;
  }

  async findOne<T extends TableName>(
    table: T,
    organizationId: string,
    filter: Filter,
  ): Promise<Row<T> | null> {
    const results = await this.list(table, organizationId, filter, { limit: 1 });
    return results[0] ?? null;
  }

  async count<T extends TableName>(
    table: T,
    organizationId: string,
    filter?: Filter,
  ): Promise<number> {
    const results = await this.list(table, organizationId, filter);
    return results.length;
  }

  async insert<T extends TableName>(table: T, row: Row<T>): Promise<Row<T>> {
    const rows = await this.table(table);
    rows.push(row as unknown as Record<string, unknown>);
    await this.persist();
    return row;
  }

  async insertMany<T extends TableName>(table: T, newRows: Row<T>[]): Promise<Row<T>[]> {
    if (newRows.length === 0) return [];
    const rows = await this.table(table);
    for (const r of newRows) rows.push(r as unknown as Record<string, unknown>);
    await this.persist();
    return newRows;
  }

  async update<T extends TableName>(
    table: T,
    organizationId: string,
    id: string,
    patch: Partial<Row<T>>,
  ): Promise<Row<T>> {
    const rows = await this.table(table);
    const index = rows.findIndex(
      (r) => r.id === id && (scopeless(table) || r.organization_id === organizationId),
    );
    if (index < 0) throw new Error(`${table}:${id} not found in organization ${organizationId}`);
    const existing = rows[index] as Record<string, unknown>;
    const next = { ...existing, ...patch } as Record<string, unknown>;
    if ('updated_at' in existing && !('updated_at' in patch)) {
      next.updated_at = new Date().toISOString();
    }
    rows[index] = next;
    await this.persist();
    return next as unknown as Row<T>;
  }

  async upsert<T extends TableName>(
    table: T,
    row: Row<T>,
    conflictColumns: (keyof Row<T> & string)[],
  ): Promise<UpsertResult<Row<T>>> {
    const rows = await this.table(table);
    const candidate = row as unknown as Record<string, unknown>;
    const index = rows.findIndex((r) => conflictColumns.every((c) => r[c] === candidate[c]));
    if (index >= 0) {
      const existing = rows[index] as Record<string, unknown>;
      // Preserve identity and creation time; the natural key is what matters.
      const merged: Record<string, unknown> = {
        ...existing,
        ...candidate,
        id: existing.id,
        created_at: existing.created_at ?? candidate.created_at,
      };
      if ('updated_at' in merged) merged.updated_at = new Date().toISOString();
      rows[index] = merged;
      await this.persist();
      return { row: merged as unknown as Row<T>, created: false };
    }
    rows.push(candidate);
    await this.persist();
    return { row, created: true };
  }

  async remove<T extends TableName>(table: T, organizationId: string, id: string): Promise<void> {
    const rows = await this.table(table);
    const index = rows.findIndex(
      (r) => r.id === id && (scopeless(table) || r.organization_id === organizationId),
    );
    if (index >= 0) {
      rows.splice(index, 1);
      await this.persist();
    }
  }

  async removeWhere<T extends TableName>(
    table: T,
    organizationId: string,
    filter: Filter,
  ): Promise<number> {
    const rows = await this.table(table);
    const before = rows.length;
    const kept = rows.filter((r) => {
      const inScope = scopeless(table) || r.organization_id === organizationId;
      if (!inScope) return true;
      return !matchesFilter(r, filter);
    });
    if (kept.length !== before) {
      rows.length = 0;
      rows.push(...kept);
      await this.persist();
    }
    return before - kept.length;
  }

  async search<T extends TableName>(
    table: T,
    organizationId: string,
    query: string,
    columns: string[],
    filter?: Filter,
    limit = 20,
  ): Promise<SearchHit<Row<T>>[]> {
    const rows = await this.list(table, organizationId, filter);
    const hits: SearchHit<Row<T>>[] = [];
    for (const row of rows) {
      const haystack = columns
        .map((c) => {
          const v = (row as unknown as Record<string, unknown>)[c];
          if (typeof v === 'string') return v;
          if (Array.isArray(v)) return v.filter((x) => typeof x === 'string').join(' ');
          return '';
        })
        .join('\n');
      const rank = textRank(query, haystack);
      if (rank > 0) hits.push({ row, rank });
    }
    hits.sort((a, b) => b.rank - a.rank);
    return hits.slice(0, limit);
  }

  async membershipsForUser(userId: string): Promise<OrganizationMember[]> {
    const rows = await this.table('organization_members');
    return rows.filter((r) => r.user_id === userId) as unknown as OrganizationMember[];
  }

  async organizationById(id: string): Promise<Organization | null> {
    const rows = await this.table('organizations');
    return ((rows.find((r) => r.id === id) as unknown as Organization) ?? null) || null;
  }

  async userProfileById(userId: string): Promise<UserProfile | null> {
    const rows = await this.table('user_profiles');
    return ((rows.find((r) => r.id === userId) as unknown as UserProfile) ?? null) || null;
  }

  async upsertUserProfile(profile: UserProfile): Promise<UserProfile> {
    const rows = await this.table('user_profiles');
    const index = rows.findIndex((r) => r.id === profile.id);
    if (index >= 0) {
      rows[index] = { ...rows[index], ...profile } as Record<string, unknown>;
    } else {
      rows.push(profile as unknown as Record<string, unknown>);
    }
    await this.persist();
    return profile;
  }
}

export const DEMO_STORE_VERSION = 4;

/** Tables that are not organization-scoped. */
function scopeless(table: TableName): boolean {
  return table === 'organizations' || table === 'organization_members' || table === 'user_profiles';
}
