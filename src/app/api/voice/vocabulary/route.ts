import { NextResponse } from 'next/server';
import { authOrError } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import { statusForError } from '@/lib/util/result';
import type { Deal, NetworkContact, PortfolioCompany } from '@/lib/types/domain';

export const dynamic = 'force-dynamic';

const MAX_TERMS = 2_000;

/**
 * The names Voice Arwin spells speech toward (src/lib/voice/fix.ts):
 * portfolio companies, open deals and the team's network contacts. Signed in
 * only, the caller's organization only; names, nothing else. The browser asks
 * once per page load and keeps it in memory.
 */
export async function GET() {
  const auth = await authOrError();
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: statusForError(auth.error.code) },
    );
  }
  const limited = rateLimit(`voice-vocab:${auth.value.userId}`, 20, 60_000);
  if (!limited.ok) {
    return NextResponse.json(
      { ok: false, error: limited.error },
      { status: statusForError(limited.error.code) },
    );
  }
  const store = getStore();
  const org = auth.value.organizationId;
  const [portfolio, deals, contacts] = await Promise.all([
    (store.list('portfolio_companies', org, {}) as Promise<PortfolioCompany[]>).catch(() => []),
    (store.list('deals', org, { eq: { is_archived: false } }) as Promise<Deal[]>).catch(() => []),
    (store.list('network_contacts', org, {}) as Promise<NetworkContact[]>).catch(() => []),
  ]);
  const terms = new Set<string>();
  for (const p of portfolio) if (p.name?.trim()) terms.add(p.name.trim());
  for (const d of deals) if (d.company_name?.trim()) terms.add(d.company_name.trim());
  for (const c of contacts) {
    if (c.full_name?.trim()) terms.add(c.full_name.trim());
    if (c.company?.trim()) terms.add(c.company.trim());
  }
  return NextResponse.json(
    { ok: true, terms: [...terms].slice(0, MAX_TERMS) },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
