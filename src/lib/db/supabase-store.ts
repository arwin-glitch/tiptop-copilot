import 'server-only';
import type { PostgrestFilterBuilder } from '@supabase/postgrest-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Organization, OrganizationMember, UserProfile } from '@/lib/types/domain';
import type {
  DataStore,
  Filter,
  QueryOptions,
  Row,
  SearchHit,
  TableName,
  UpsertResult,
} from './store';
import { assertScoped, scopeless } from './store';

/* eslint-disable @typescript-eslint/no-explicit-any -- The Supabase client is
   generically typed against a generated schema we do not ship; this adapter is
   the single place where that untyped surface is contained, and every value
   leaving it is cast to a domain type declared in lib/types/domain.ts. */

type Builder = PostgrestFilterBuilder<any, any, any, any, any>;

/**
 * Postgres implementation. Every query passes organization_id explicitly even
 * though row-level security also enforces it — the policy is the security
 * boundary, the parameter is the correctness boundary, and a bug in either one
 * is caught by the other.
 */
export class SupabaseStore implements DataStore {
  readonly kind = 'supabase' as const;

  constructor(private readonly client: SupabaseClient<any, any, any>) {}

  private applyFilter(builder: Builder, filter?: Filter): Builder {
    if (!filter) return builder;
    let b = builder;
    if (filter.eq)
      for (const [k, v] of Object.entries(filter.eq)) b = v === null ? b.is(k, null) : b.eq(k, v);
    if (filter.neq) for (const [k, v] of Object.entries(filter.neq)) b = b.neq(k, v as never);
    if (filter.in) for (const [k, v] of Object.entries(filter.in)) b = b.in(k, v as never[]);
    if (filter.gte) for (const [k, v] of Object.entries(filter.gte)) b = b.gte(k, v);
    if (filter.lte) for (const [k, v] of Object.entries(filter.lte)) b = b.lte(k, v);
    if (filter.gt) for (const [k, v] of Object.entries(filter.gt)) b = b.gt(k, v);
    if (filter.lt) for (const [k, v] of Object.entries(filter.lt)) b = b.lt(k, v);
    if (filter.isNull) for (const k of filter.isNull) b = b.is(k, null);
    if (filter.notNull) for (const k of filter.notNull) b = b.not(k, 'is', null);
    if (filter.arrayContains) {
      for (const [k, v] of Object.entries(filter.arrayContains)) b = b.contains(k, [v]);
    }
    if (filter.textSearch) {
      const escaped = filter.textSearch.query.replace(/[%,()]/g, ' ').trim();
      if (escaped) {
        const ors = filter.textSearch.columns.map((c) => `${c}.ilike.%${escaped}%`).join(',');
        b = b.or(ors);
      }
    }
    return b;
  }

  private applyOptions(builder: Builder, options?: QueryOptions): Builder {
    let b = builder;
    for (const o of options?.orderBy ?? []) {
      b = b.order(o.field, { ascending: o.direction === 'asc', nullsFirst: false });
    }
    if (options?.limit != null) {
      const from = options.offset ?? 0;
      b = b.range(from, from + options.limit - 1);
    } else if (options?.offset) {
      b = b.range(options.offset, options.offset + 999);
    }
    return b;
  }

  private scoped(table: TableName, organizationId: string): Builder {
    assertScoped(table, organizationId);
    const base = this.client.from(table).select('*') as unknown as Builder;
    return scopeless(table) ? base : base.eq('organization_id', organizationId);
  }

  async list<T extends TableName>(
    table: T,
    organizationId: string,
    filter?: Filter,
    options?: QueryOptions,
  ): Promise<Row<T>[]> {
    let b = this.scoped(table, organizationId);
    b = this.applyFilter(b, filter);
    b = this.applyOptions(b, options);
    const { data, error } = await b;
    if (error) throw new Error(`[${table}] list failed: ${error.message}`);
    return (data ?? []) as Row<T>[];
  }

  async get<T extends TableName>(
    table: T,
    organizationId: string,
    id: string,
  ): Promise<Row<T> | null> {
    const b = this.scoped(table, organizationId).eq('id', id).limit(1);
    const { data, error } = await b;
    if (error) throw new Error(`[${table}] get failed: ${error.message}`);
    return ((data ?? [])[0] as Row<T>) ?? null;
  }

  async findOne<T extends TableName>(
    table: T,
    organizationId: string,
    filter: Filter,
  ): Promise<Row<T> | null> {
    const rows = await this.list(table, organizationId, filter, { limit: 1 });
    return rows[0] ?? null;
  }

  async count<T extends TableName>(
    table: T,
    organizationId: string,
    filter?: Filter,
  ): Promise<number> {
    let b = this.client
      .from(table)
      .select('id', { count: 'exact', head: true }) as unknown as Builder;
    assertScoped(table, organizationId);
    if (!scopeless(table)) b = b.eq('organization_id', organizationId);
    b = this.applyFilter(b, filter);
    const { count, error } = (await b) as unknown as {
      count: number | null;
      error: { message: string } | null;
    };
    if (error) throw new Error(`[${table}] count failed: ${error.message}`);
    return count ?? 0;
  }

  async insert<T extends TableName>(table: T, row: Row<T>): Promise<Row<T>> {
    const { data, error } = await this.client
      .from(table)
      .insert(row as never)
      .select()
      .limit(1);
    if (error) throw new Error(`[${table}] insert failed: ${error.message}`);
    return ((data ?? [])[0] as Row<T>) ?? row;
  }

  async insertMany<T extends TableName>(table: T, rows: Row<T>[]): Promise<Row<T>[]> {
    if (rows.length === 0) return [];
    const { data, error } = await this.client
      .from(table)
      .insert(rows as never)
      .select();
    if (error) throw new Error(`[${table}] insertMany failed: ${error.message}`);
    return (data ?? []) as Row<T>[];
  }

  async update<T extends TableName>(
    table: T,
    organizationId: string,
    id: string,
    patch: Partial<Row<T>>,
  ): Promise<Row<T>> {
    let b = this.client
      .from(table)
      .update(patch as never)
      .eq('id', id) as unknown as Builder;
    assertScoped(table, organizationId);
    if (!scopeless(table)) b = b.eq('organization_id', organizationId);
    const { data, error } = await (
      b as unknown as {
        select: () => Promise<{ data: unknown[] | null; error: { message: string } | null }>;
      }
    ).select();
    if (error) throw new Error(`[${table}] update failed: ${error.message}`);
    const updated = (data ?? [])[0] as Row<T> | undefined;
    if (!updated) throw new Error(`[${table}] ${id} not found in organization ${organizationId}`);
    return updated;
  }

  async upsert<T extends TableName>(
    table: T,
    row: Row<T>,
    conflictColumns: (keyof Row<T> & string)[],
  ): Promise<UpsertResult<Row<T>>> {
    // Determine existence first so the caller can report created-vs-updated
    // accurately; Postgres `ON CONFLICT` alone does not tell us which happened.
    const probeFilter: Filter = { eq: {} };
    for (const c of conflictColumns) {
      const v = (row as unknown as Record<string, unknown>)[c];
      probeFilter.eq![c] = (v ?? null) as string | number | boolean | null;
    }
    const orgId = (row as { organization_id?: string }).organization_id ?? '';
    const existing = await this.findOne(table, orgId, probeFilter);

    const { data, error } = await this.client
      .from(table)
      .upsert(row as never, { onConflict: conflictColumns.join(',') })
      .select()
      .limit(1);
    if (error) throw new Error(`[${table}] upsert failed: ${error.message}`);
    return {
      row: ((data ?? [])[0] as Row<T>) ?? row,
      created: existing === null,
    };
  }

  async remove<T extends TableName>(table: T, organizationId: string, id: string): Promise<void> {
    let b = this.client.from(table).delete().eq('id', id) as unknown as Builder;
    assertScoped(table, organizationId);
    if (!scopeless(table)) b = b.eq('organization_id', organizationId);
    const { error } = await b;
    if (error) throw new Error(`[${table}] delete failed: ${error.message}`);
  }

  async removeWhere<T extends TableName>(
    table: T,
    organizationId: string,
    filter: Filter,
  ): Promise<number> {
    const doomed = await this.list(table, organizationId, filter);
    if (doomed.length === 0) return 0;
    const ids = doomed.map((r) => (r as { id: string }).id);
    let b = this.client.from(table).delete().in('id', ids) as unknown as Builder;
    assertScoped(table, organizationId);
    if (!scopeless(table)) b = b.eq('organization_id', organizationId);
    const { error } = await b;
    if (error) throw new Error(`[${table}] removeWhere failed: ${error.message}`);
    return doomed.length;
  }

  async search<T extends TableName>(
    table: T,
    organizationId: string,
    query: string,
    columns: string[],
    filter?: Filter,
    limit = 20,
  ): Promise<SearchHit<Row<T>>[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    // `search_vector` is a generated tsvector column on every searchable table
    // (see supabase/migrations). websearch_to_tsquery handles user-typed input
    // safely, including quoted phrases and `-exclusions`.
    let b = this.scoped(table, organizationId).textSearch('search_vector', trimmed, {
      type: 'websearch',
      config: 'english',
    });
    b = this.applyFilter(b, filter);
    b = b.limit(limit);
    const { data, error } = await b;
    if (error) {
      // Fall back to ILIKE so a search never hard-fails the page.
      const rows = await this.list(
        table,
        organizationId,
        { ...filter, textSearch: { columns, query: trimmed } },
        { limit },
      );
      return rows.map((row, i) => ({ row, rank: 1 - i / Math.max(rows.length, 1) }));
    }
    const rows = (data ?? []) as Row<T>[];
    return rows.map((row, i) => ({ row, rank: 1 - i / Math.max(rows.length, 1) }));
  }

  async membershipsForUser(userId: string): Promise<OrganizationMember[]> {
    const { data, error } = await this.client
      .from('organization_members')
      .select('*')
      .eq('user_id', userId);
    if (error) throw new Error(`membershipsForUser failed: ${error.message}`);
    return (data ?? []) as OrganizationMember[];
  }

  async organizationById(id: string): Promise<Organization | null> {
    const { data, error } = await this.client
      .from('organizations')
      .select('*')
      .eq('id', id)
      .limit(1);
    if (error) throw new Error(`organizationById failed: ${error.message}`);
    return ((data ?? [])[0] as Organization) ?? null;
  }

  async userProfileById(userId: string): Promise<UserProfile | null> {
    const { data, error } = await this.client
      .from('user_profiles')
      .select('*')
      .eq('id', userId)
      .limit(1);
    if (error) throw new Error(`userProfileById failed: ${error.message}`);
    return ((data ?? [])[0] as UserProfile) ?? null;
  }

  async upsertUserProfile(profile: UserProfile): Promise<UserProfile> {
    const { data, error } = await this.client
      .from('user_profiles')
      .upsert(profile as never, { onConflict: 'id' })
      .select()
      .limit(1);
    if (error) throw new Error(`upsertUserProfile failed: ${error.message}`);
    return ((data ?? [])[0] as UserProfile) ?? profile;
  }
}
