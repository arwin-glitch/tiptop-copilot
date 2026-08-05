import 'server-only';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { env } from '@/lib/config/env';
import { signedValue, verifySignedValue } from '@/lib/security/crypto';
import type { Organization, OrgRole, UserProfile } from '@/lib/types/domain';
import { DEFAULT_TIMEZONE } from '@/lib/util/time';
import { err, ok, type Result } from '@/lib/util/result';
import { getStore } from '@/lib/runtime';
import { DEMO_IDS } from '@/lib/demo/ids';
import { DEMO_USER } from '@/lib/demo/fixtures';

export const SESSION_COOKIE = 'tiptop_session';
export const DEMO_SESSION_COOKIE = 'tiptop_demo_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12; // 12 hours

export interface AuthContext {
  userId: string;
  organizationId: string;
  role: OrgRole;
  profile: UserProfile;
  organization: Organization;
  isDemo: boolean;
}

interface DemoSessionPayload {
  userId: string;
  organizationId: string;
  exp: number;
}

/* ------------------------------------------------------------ demo session */

export async function startDemoSession(): Promise<void> {
  const payload: DemoSessionPayload = {
    userId: DEMO_IDS.user,
    organizationId: DEMO_IDS.org,
    exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
  };
  const jar = await cookies();
  jar.set(DEMO_SESSION_COOKIE, signedValue(JSON.stringify(payload)), {
    httpOnly: true,
    secure: env().nodeEnv === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(DEMO_SESSION_COOKIE);
  jar.delete(SESSION_COOKIE);
}

async function readDemoSession(): Promise<DemoSessionPayload | null> {
  const jar = await cookies();
  const raw = jar.get(DEMO_SESSION_COOKIE)?.value;
  if (!raw) return null;
  const payload = verifySignedValue(raw);
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as DemoSessionPayload;
    if (typeof parsed.exp !== 'number' || parsed.exp < Date.now()) return null;
    if (!parsed.userId || !parsed.organizationId) return null;
    return parsed;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------- supabase auth */

export async function supabaseServerClient() {
  const e = env();
  if (!e.supabaseUrl || !e.supabaseAnonKey) return null;
  const jar = await cookies();
  return createServerClient(e.supabaseUrl, e.supabaseAnonKey, {
    cookies: {
      getAll() {
        return jar.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            jar.set(name, value, options);
          }
        } catch {
          // Called from a Server Component where cookies are read-only. The
          // session refresh still happens in the proxy, so this is safe to skip.
        }
      },
    },
  });
}

/* ------------------------------------------------------------- resolution */

/**
 * Resolve the caller's identity and organization.
 *
 * Returns null when unauthenticated. Everything downstream takes an
 * AuthContext, so there is no code path that reads data without one.
 */
export async function getAuthContext(): Promise<AuthContext | null> {
  const e = env();
  const store = getStore();

  if (e.demoMode) {
    const session = await readDemoSession();
    if (!session) return null;
    const organization = await store.organizationById(session.organizationId);
    const profile = await store.userProfileById(session.userId);
    if (!organization || !profile) return null;
    const memberships = await store.membershipsForUser(session.userId);
    const membership = memberships.find((m) => m.organization_id === session.organizationId);
    if (!membership) return null;
    return {
      userId: session.userId,
      organizationId: session.organizationId,
      role: membership.role,
      profile,
      organization,
      isDemo: true,
    };
  }

  const supabase = await supabaseServerClient();
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;

  const userId = data.user.id;
  const memberships = await store.membershipsForUser(userId);
  const membership = memberships[0];
  if (!membership) return null;

  const organization = await store.organizationById(membership.organization_id);
  if (!organization) return null;

  let profile = await store.userProfileById(userId);
  if (!profile) {
    // First sign-in: create the profile row so settings have somewhere to live.
    const now = new Date().toISOString();
    profile = await store.upsertUserProfile({
      id: userId,
      email: data.user.email ?? '',
      full_name: (data.user.user_metadata?.full_name as string | undefined) ?? null,
      avatar_url: (data.user.user_metadata?.avatar_url as string | undefined) ?? null,
      timezone: DEFAULT_TIMEZONE,
      theme: 'system',
      created_at: now,
      updated_at: now,
    });
  }

  return {
    userId,
    organizationId: membership.organization_id,
    role: membership.role,
    profile,
    organization,
    isDemo: false,
  };
}

/** Throwing variant for server components that are already behind the proxy. */
export async function requireAuth(): Promise<AuthContext> {
  const auth = await getAuthContext();
  if (!auth) throw new Error('UNAUTHENTICATED');
  return auth;
}

/** Result variant for route handlers, which must return a status not a throw. */
export async function authOrError(): Promise<Result<AuthContext>> {
  const auth = await getAuthContext();
  if (!auth) return err('unauthenticated', 'Sign in to continue.');
  return ok(auth);
}

const ROLE_RANK: Record<OrgRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export function hasRole(auth: AuthContext, minimum: OrgRole): boolean {
  return ROLE_RANK[auth.role] >= ROLE_RANK[minimum];
}

export function requireRole(auth: AuthContext, minimum: OrgRole): Result<true> {
  if (!hasRole(auth, minimum)) {
    return err('forbidden', `This action requires the ${minimum} role or higher.`);
  }
  return ok(true);
}

export const DEMO_IDENTITY = DEMO_USER;
