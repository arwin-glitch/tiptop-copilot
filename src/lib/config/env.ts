import 'server-only';

/**
 * Server-only environment access. Nothing in this module may be imported from a
 * client component — the `server-only` import makes that a build error.
 *
 * Reading is lazy and never throws at import time: a missing variable produces a
 * degraded capability plus a diagnostics entry, so the app still boots and can
 * tell the operator exactly what is missing.
 */

function str(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

function bool(name: string, fallback = false): boolean {
  const v = str(name);
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function int(name: string, fallback: number): number {
  const v = str(name);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function num(name: string, fallback: number): number {
  const v = str(name);
  if (v === undefined) return fallback;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

export type ResearchProviderName = 'none' | 'anthropic' | 'custom';

export interface AppEnv {
  nodeEnv: string;
  appUrl: string;
  demoMode: boolean;

  sessionSecret: string | undefined;
  encryptionKey: string | undefined;

  supabaseUrl: string | undefined;
  supabaseAnonKey: string | undefined;
  supabaseServiceRoleKey: string | undefined;
  supabaseStorageBucket: string;

  anthropicApiKey: string | undefined;
  modelFast: string;
  modelDeep: string;
  aiEffortDeep: 'low' | 'medium' | 'high' | 'xhigh' | 'max';

  googleClientId: string | undefined;
  googleClientSecret: string | undefined;
  googleRedirectUri: string;

  researchProvider: ResearchProviderName;
  researchApiUrl: string | undefined;
  researchApiKey: string | undefined;

  cronSecret: string | undefined;
  demoDataDir: string;
}

let cached: AppEnv | null = null;

export function env(): AppEnv {
  if (cached) return cached;
  const appUrl = str('APP_URL') ?? str('NEXT_PUBLIC_APP_URL') ?? 'http://localhost:3000';
  const effort = (str('AI_EFFORT_DEEP') ?? 'high').toLowerCase();
  cached = {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    appUrl,
    demoMode: bool('DEMO_MODE', false),

    sessionSecret: str('SESSION_SECRET'),
    encryptionKey: str('APP_ENCRYPTION_KEY'),

    supabaseUrl: str('NEXT_PUBLIC_SUPABASE_URL') ?? str('SUPABASE_URL'),
    supabaseAnonKey: str('NEXT_PUBLIC_SUPABASE_ANON_KEY') ?? str('SUPABASE_ANON_KEY'),
    supabaseServiceRoleKey: str('SUPABASE_SERVICE_ROLE_KEY'),
    supabaseStorageBucket: str('SUPABASE_STORAGE_BUCKET') ?? 'deal-attachments',

    anthropicApiKey: str('ANTHROPIC_API_KEY'),
    modelFast: str('AI_MODEL_FAST') ?? 'claude-haiku-4-5',
    modelDeep: str('AI_MODEL_DEEP') ?? 'claude-opus-5',
    aiEffortDeep: (['low', 'medium', 'high', 'xhigh', 'max'] as const).includes(
      effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
    )
      ? (effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max')
      : 'high',

    googleClientId: str('GOOGLE_CLIENT_ID'),
    googleClientSecret: str('GOOGLE_CLIENT_SECRET'),
    googleRedirectUri: str('GOOGLE_REDIRECT_URI') ?? `${appUrl}/api/integrations/google/callback`,

    researchProvider: ((): ResearchProviderName => {
      const v = (str('RESEARCH_PROVIDER') ?? 'none').toLowerCase();
      return v === 'anthropic' || v === 'custom' ? v : 'none';
    })(),
    researchApiUrl: str('RESEARCH_API_URL'),
    researchApiKey: str('RESEARCH_API_KEY'),

    cronSecret: str('CRON_SECRET'),
    demoDataDir: str('DEMO_DATA_DIR') ?? '.demo-data',
  };
  return cached;
}

/** Test-only: forget the memoised env so a test can vary process.env. */
export function resetEnvCache(): void {
  cached = null;
  cachedLimits = null;
}

/* ------------------------------------------------------------------ limits */

export interface CostLimits {
  maxEmailsPerSync: number;
  defaultLookbackDays: number;
  maxAttachmentsPerAnalysis: number;
  maxAttachmentBytes: number;
  maxAttachmentPages: number;
  maxDocumentChars: number;
  maxAiRequestsPerUserPerHour: number;
  dailyAiBudgetUsd: number;
  autoAnalyzeEnabled: boolean;
  deepAutoAnalysis: boolean;
}

let cachedLimits: CostLimits | null = null;

/** Environment ceilings. Per-organization settings may lower these, never raise. */
export function envLimits(): CostLimits {
  if (cachedLimits) return cachedLimits;
  cachedLimits = {
    maxEmailsPerSync: int('MAX_EMAILS_PER_SYNC', 250),
    defaultLookbackDays: int('DEFAULT_LOOKBACK_DAYS', 14),
    maxAttachmentsPerAnalysis: int('MAX_ATTACHMENTS_PER_ANALYSIS', 5),
    maxAttachmentBytes: int('MAX_ATTACHMENT_BYTES', 25 * 1024 * 1024),
    maxAttachmentPages: int('MAX_ATTACHMENT_PAGES', 80),
    maxDocumentChars: int('MAX_DOCUMENT_CHARS', 400_000),
    maxAiRequestsPerUserPerHour: int('MAX_AI_REQUESTS_PER_USER_PER_HOUR', 120),
    dailyAiBudgetUsd: num('DAILY_AI_BUDGET_USD', 25),
    autoAnalyzeEnabled: bool('AUTO_ANALYZE_ENABLED', true),
    deepAutoAnalysis: bool('DEEP_AUTO_ANALYSIS', false),
  };
  return cachedLimits;
}

/* ------------------------------------------------------- capability report */

export type CapabilityStatus = 'ready' | 'demo' | 'missing' | 'optional-missing';

export interface CapabilityCheck {
  key: string;
  label: string;
  status: CapabilityStatus;
  detail: string;
  /** Names of the variables involved. Values are NEVER included. */
  variables: string[];
  required: boolean;
}

/**
 * Diagnostics for the in-app setup page. Reports presence and shape only —
 * it must never echo a secret value.
 */
export function capabilityReport(): CapabilityCheck[] {
  const e = env();
  const checks: CapabilityCheck[] = [];

  const has = (v: string | undefined) => v !== undefined && v.length > 0;

  checks.push({
    key: 'mode',
    label: 'Runtime mode',
    status: e.demoMode ? 'demo' : 'ready',
    detail: e.demoMode
      ? 'Demo mode is ON. All data is fictional and no external calls are made.'
      : 'Live mode. Real integrations are used where configured.',
    variables: ['DEMO_MODE'],
    required: false,
  });

  checks.push({
    key: 'session',
    label: 'Session signing key',
    status: has(e.sessionSecret)
      ? (e.sessionSecret?.length ?? 0) >= 32
        ? 'ready'
        : 'missing'
      : e.demoMode
        ? 'demo'
        : 'missing',
    detail: has(e.sessionSecret)
      ? (e.sessionSecret?.length ?? 0) >= 32
        ? 'Present and at least 32 characters.'
        : 'Present but shorter than the 32-character minimum.'
      : 'Not set. Required before deploying; demo mode uses an ephemeral key.',
    variables: ['SESSION_SECRET'],
    required: true,
  });

  const keyOk = (() => {
    if (!e.encryptionKey) return false;
    try {
      return Buffer.from(e.encryptionKey, 'base64').length === 32;
    } catch {
      return false;
    }
  })();
  checks.push({
    key: 'encryption',
    label: 'Provider-token encryption key',
    status: keyOk ? 'ready' : e.demoMode ? 'demo' : 'missing',
    detail: keyOk
      ? 'Present and decodes to 32 bytes (AES-256-GCM).'
      : 'Must be 32 random bytes, base64-encoded. Required to store Google tokens.',
    variables: ['APP_ENCRYPTION_KEY'],
    required: true,
  });

  const supabaseReady = has(e.supabaseUrl) && has(e.supabaseAnonKey);
  checks.push({
    key: 'supabase',
    label: 'Supabase database & auth',
    status: supabaseReady ? 'ready' : e.demoMode ? 'demo' : 'missing',
    detail: supabaseReady
      ? 'Project URL and anon key present.'
      : 'Not configured. Demo mode uses a local file-backed store instead.',
    variables: ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'],
    required: true,
  });

  checks.push({
    key: 'supabase_service',
    label: 'Supabase service role key',
    status: has(e.supabaseServiceRoleKey) ? 'ready' : e.demoMode ? 'demo' : 'missing',
    detail: has(e.supabaseServiceRoleKey)
      ? 'Present. Used server-side only for storage signing and scheduled jobs.'
      : 'Not set. Storage signing and cron jobs will be unavailable.',
    variables: ['SUPABASE_SERVICE_ROLE_KEY'],
    required: true,
  });

  checks.push({
    key: 'anthropic',
    label: 'Anthropic API',
    status: has(e.anthropicApiKey) ? 'ready' : e.demoMode ? 'demo' : 'missing',
    detail: has(e.anthropicApiKey)
      ? `Key present. Fast model: ${e.modelFast}. Deep model: ${e.modelDeep}.`
      : 'Not set. Demo mode uses a deterministic offline model stub.',
    variables: ['ANTHROPIC_API_KEY', 'AI_MODEL_FAST', 'AI_MODEL_DEEP'],
    required: true,
  });

  const googleReady = has(e.googleClientId) && has(e.googleClientSecret);
  checks.push({
    key: 'google',
    label: 'Google Workspace (Gmail + Calendar)',
    status: googleReady ? 'ready' : e.demoMode ? 'demo' : 'optional-missing',
    detail: googleReady
      ? `OAuth client configured. Redirect URI: ${e.googleRedirectUri}`
      : 'Not configured. Inbox and Calendar run on fixtures until connected.',
    variables: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'],
    required: false,
  });

  checks.push({
    key: 'research',
    label: 'Public web research',
    status:
      e.researchProvider === 'none'
        ? 'optional-missing'
        : e.researchProvider === 'anthropic'
          ? has(e.anthropicApiKey)
            ? 'ready'
            : 'missing'
          : has(e.researchApiUrl) && has(e.researchApiKey)
            ? 'ready'
            : 'missing',
    detail:
      e.researchProvider === 'none'
        ? 'Disabled. The app will say research is unavailable rather than guess.'
        : `Provider: ${e.researchProvider}.`,
    variables: ['RESEARCH_PROVIDER', 'RESEARCH_API_URL', 'RESEARCH_API_KEY'],
    required: false,
  });

  checks.push({
    key: 'cron',
    label: 'Scheduled job secret',
    status: has(e.cronSecret) ? 'ready' : 'optional-missing',
    detail: has(e.cronSecret)
      ? 'Present. Cron endpoints require a matching bearer token.'
      : 'Not set. Scheduled sync/outlook endpoints will reject all callers.',
    variables: ['CRON_SECRET'],
    required: false,
  });

  return checks;
}

export function isDemoMode(): boolean {
  return env().demoMode;
}
