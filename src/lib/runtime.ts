import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { AnthropicProvider } from '@/lib/ai/anthropic';
import { MockAIProvider } from '@/lib/ai/mock';
import type { AIProvider } from '@/lib/ai/provider';
import {
  GoogleCalendarProvider,
  MockCalendarProvider,
  type CalendarProvider,
} from '@/lib/calendar/provider';
import { env } from '@/lib/config/env';
import { DemoStore } from '@/lib/db/demo-store';
import type { DataStore } from '@/lib/db/store';
import { SupabaseStore } from '@/lib/db/supabase-store';
import { buildDemoDb } from '@/lib/demo/fixtures';
import { GmailProvider } from '@/lib/email/gmail';
import { MockEmailProvider } from '@/lib/email/mock';
import type { EmailProvider } from '@/lib/email/provider';
import {
  AnthropicResearchProvider,
  CustomSearchProvider,
  NoResearchProvider,
  type ResearchProvider,
} from '@/lib/research/provider';
import {
  LocalStorageProvider,
  SupabaseStorageProvider,
  type StorageProvider,
} from '@/lib/storage/provider';
import type { Integration } from '@/lib/types/domain';

/**
 * The single place where "which implementation" is decided.
 *
 * Everything else in the codebase depends on an interface, not on whether the
 * environment happens to have credentials. That is what keeps demo mode from
 * leaking `if (demo)` branches into business logic.
 */

let storeSingleton: DataStore | null = null;
let aiSingleton: AIProvider | null = null;
let researchSingleton: ResearchProvider | null = null;
let storageSingleton: StorageProvider | null = null;

export function getStore(): DataStore {
  if (storeSingleton) return storeSingleton;
  const e = env();
  if (e.demoMode || !e.supabaseUrl || !e.supabaseServiceRoleKey) {
    storeSingleton = new DemoStore(() => buildDemoDb(new Date()) as never);
  } else {
    // Server-side data access uses the service role and relies on explicit
    // organization scoping in SupabaseStore plus RLS as the second gate.
    storeSingleton = new SupabaseStore(
      createClient(e.supabaseUrl, e.supabaseServiceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      }),
    );
  }
  return storeSingleton;
}

export function getAI(): AIProvider {
  if (aiSingleton) return aiSingleton;
  const e = env();
  aiSingleton = e.demoMode || !e.anthropicApiKey ? new MockAIProvider() : new AnthropicProvider();
  return aiSingleton;
}

export function getResearchProvider(): ResearchProvider {
  if (researchSingleton) return researchSingleton;
  const e = env();
  if (e.researchProvider === 'anthropic') {
    researchSingleton = new AnthropicResearchProvider(getAI());
  } else if (e.researchProvider === 'custom') {
    researchSingleton = new CustomSearchProvider();
  } else {
    researchSingleton = new NoResearchProvider();
  }
  return researchSingleton;
}

export function getStorage(): StorageProvider {
  if (storageSingleton) return storageSingleton;
  const e = env();
  storageSingleton =
    e.demoMode || !e.supabaseServiceRoleKey
      ? new LocalStorageProvider()
      : new SupabaseStorageProvider();
  return storageSingleton;
}

/**
 * Mailbox and calendar are per-integration, so these are factories rather than
 * singletons. A missing or disconnected integration returns null and callers
 * degrade gracefully instead of throwing.
 */
export function getEmailProvider(integration: Integration | null): EmailProvider | null {
  if (env().demoMode) return new MockEmailProvider();
  if (!integration || integration.status === 'disconnected') return null;
  if (!integration.kinds.includes('gmail')) return null;
  return new GmailProvider(getStore(), integration);
}

export function getCalendarProvider(integration: Integration | null): CalendarProvider | null {
  if (env().demoMode) return new MockCalendarProvider();
  if (!integration || integration.status === 'disconnected') return null;
  if (!integration.kinds.includes('calendar')) return null;
  return new GoogleCalendarProvider(getStore(), integration);
}

/** Test hook: rebuild every singleton after changing process.env. */
export function resetRuntime(): void {
  storeSingleton = null;
  aiSingleton = null;
  researchSingleton = null;
  storageSingleton = null;
}

/** Test hook: inject a pre-seeded store. */
export function setStoreForTesting(store: DataStore | null): void {
  storeSingleton = store;
}
