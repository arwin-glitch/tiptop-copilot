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

  /**
   * Email domains permitted to sign in, lowercase and without the `@`.
   *
   * Empty means no restriction, which is not the same as safe: the
   * `on_auth_user_created` trigger provisions an organization for every new
   * user, so an unrestricted project hands a workspace to anyone who can reach
   * the login page. `/diagnostics` reports the difference.
   */
  authAllowedDomains: readonly string[];

  researchProvider: ResearchProviderName;
  researchApiUrl: string | undefined;
  researchApiKey: string | undefined;

  cronSecret: string | undefined;
  /**
   * Optional override of the Web Push (VAPID) public key. The default is built
   * in; the private half is a GitHub Actions secret, never set here.
   */
  vapidPublicKey: string | undefined;
  granolaWebhookSecret: string | undefined;
  /**
   * An ingest-only credential for senders that can post notes but must never
   * be able to start a backfill.
   *
   * It exists because of where these credentials live. A cloud routine keeps
   * its token inside its own prompt, and the routines API returns that prompt
   * in full on `get`, on `run`, and in a run log — so the value surfaces in a
   * transcript every time anyone touches the routine. Treating that as
   * eventually-public is the only honest assumption.
   *
   * `GRANOLA_WEBHOOK_SECRET` also opens `/backfill`, which spends Granola API
   * quota and can walk the whole history. A leaked ingest token should be able
   * to file a junk meeting note and nothing else, so a sender that only needs
   * to post gets this instead.
   */
  granolaBridgeToken: string | undefined;
  granolaSigningSecret: string | undefined;
  granolaApiKey: string | undefined;
  /**
   * Affinity's API key, for the daily Affinity sync (lib/services/affinity-sync.ts)
   * that runs until the subscription is cancelled. Read only on the server and
   * sent only to api.affinity.co; never logged, never returned to a page. Unset
   * means the sync reports itself not configured and does nothing.
   */
  affinityApiKey: string | undefined;
  /**
   * Full Pub/Sub topic name for Gmail push, e.g.
   * `projects/tiptop-copilot/topics/gmail-push`. Unset means no push
   * registration is attempted and the mailbox is synced on the daily schedule
   * and on demand — which is a working configuration, not a broken one.
   */
  gmailPushTopic: string | undefined;
  demoDataDir: string;

  /**
   * Ingest-only credential for the two routines that post the Today-page
   * briefing card (Daily Overview, Daily Recap). Same reasoning as
   * `granolaBridgeToken`: a cloud routine's prompt is returned in full by the
   * routines API on every `get`, `run`, and run log, so this value is
   * assumed public. Holding it lets someone put junk text on a briefing card
   * until that kind's next routine post (a date_key later than today is
   * refused, so it cannot pin a card for good), and nothing more — no other
   * endpoint accepts it. The routines cannot reach the webhook today; cards
   * arrive through `askRelaySlackToken`'s channel instead.
   */
  briefingBridgeToken: string | undefined;

  /**
   * Ingest-only credential for `/api/integrations/portfolio/webhook`, used by
   * the watchers that notice a new investment. Same "assume eventually
   * public" reasoning as `briefingBridgeToken`: holding it lets someone add a
   * company that is not yet listed, and nothing more.
   */
  portfolioBridgeToken: string | undefined;

  /**
   * Ingest-only credential for `/api/integrations/tasks/webhook`, used by the
   * watcher that notices a follow-up worth tracking. Same "assume eventually
   * public" reasoning: holding it lets someone add a task that does not
   * already exist by title, and nothing more.
   */
  taskBridgeToken: string | undefined;

  /**
   * Ingest-and-answer credential for the Ask bridge: an external Claude
   * session with live Gmail/Calendar/Slack access that answers questions
   * asked on the Ask page instead of the in-app Anthropic call, which has no
   * access to anything not already synced. When set, `ask()` always routes
   * new questions to the bridge rather than calling Anthropic directly — see
   * `src/lib/services/chat.ts`. Same "assume eventually public" reasoning as
   * `briefingBridgeToken`: this value lives inside a routine's own prompt.
   */
  askBridgeToken: string | undefined;

  /**
   * Makes the Ask bridge event-driven instead of polled. When both are set,
   * `ask()` calls the routine's API-trigger URL the moment a question is
   * asked, so the routine starts immediately rather than on its hourly timer.
   * Copy the URL and token from the routine's "API trigger" settings on
   * claude.ai (the URL ends in `/fire`). The token can only fire that one
   * routine.
   */
  askRoutineFireUrl: string | undefined;
  askRoutineToken: string | undefined;

  /**
   * Read-only Slack bot token. Needs `channels:history` for the relay channel
   * (Ask answers, Today briefing cards) and `groups:history` plus membership
   * for the Updates tab's private channels. The app posts only the optional
   * task snapshot (`taskSnapshotFeed`), which also needs `chat:write`.
   */
  askRelaySlackToken: string | undefined;
  askRelayChannelId: string;

  /**
   * The booking page assistant's optional AI answers (D-078), on Arwin's own
   * Claude plan: no API key, nothing billed. When both are set, a visitor's
   * question that no written answer matches fires the booking assistant
   * routine (a Claude Code routine with no data connectors; its prompt is in
   * docs/BOOKING_CHAT_ROUTINE.md), and the app reads its answer back from the
   * Slack relay with `askRelaySlackToken`. Either unset: the feature is off
   * and the assistant answers from the written questions only. Copy both from
   * the routine's "API trigger" settings on claude.ai (the URL ends in
   * `/fire`); the token can only fire that one routine.
   */
  bookingChatFireUrl: string | undefined;
  bookingChatToken: string | undefined;
  /**
   * Where the routine posts `BOOKING_ANSWER_V1`: a private channel of its
   * own that no other relay reads. No default: a stranger's question must
   * never reach a channel (or an account) the task, briefing or follow-up
   * readers trust, so AI answers stay off until it is set
   * (lib/booking/chat-bridge.ts bookingChatConfigured).
   */
  bookingChatRelayChannelId: string | undefined;
  /**
   * The Slack user IDs whose `BOOKING_ANSWER_V1` posts are read; everyone
   * else's are ignored. No default, and none of them may be a task or deal
   * relay poster: the routine posts as an account no other relay trusts.
   */
  bookingChatPosterIds: readonly string[];
  /**
   * The public job board assistant's optional AI answers ("Ask Arwin" on the
   * board), on Arwin's own Claude plan like the booking assistant: no API
   * key, nothing billed. When both are set (and the relay below is safe), a
   * question the board's data and written answers cannot answer fires the
   * jobs assistant routine (no data connectors; its prompt is in
   * docs/JOBS_CHAT_ROUTINE.md), and its answer is read back from the Slack
   * relay with `askRelaySlackToken`. Either unset: the assistant answers
   * from the board and the written answers only.
   */
  jobsChatFireUrl: string | undefined;
  jobsChatToken: string | undefined;
  /** Where the jobs routine posts `JOBS_ANSWER_V1`: a private channel no task, deal or Ask reader trusts. No default. */
  jobsChatRelayChannelId: string | undefined;
  /** The Slack user IDs whose `JOBS_ANSWER_V1` posts are read. No default; never a task or deal relay poster. */
  jobsChatPosterIds: readonly string[];
  /**
   * Tests only: the end-to-end suite's demo server takes every spec's
   * visitors on one shared calendar, so the booking link's daily brakes are
   * loosened there. Honoured only with DEMO_MODE on; production never.
   */
  bookingBrakesRelaxed: boolean;

  /**
   * The private Slack channel the deal-sorter routine posts deal updates to
   * (`DEAL_UPSERT_V1` / `DEAL_SORTER_RUN_V1`), read with
   * `askRelaySlackToken` — which then also needs `groups:history`. Not a
   * secret, so the channel ID is the code default. There is deliberately no
   * fallback to the public relay channel.
   */
  dealRelayChannelId: string;
  /** When non-empty, deal relay messages from any other Slack user ID are ignored. */
  dealRelayPosterIds: readonly string[];

  /**
   * The Slack user IDs whose `TASK_ADD_V1` and `TASK_CLOSE_V1` posts are
   * read; everyone else's are ignored. Never empty: a post that closes a task
   * is only trusted from the account the routines post as.
   */
  taskRelayPosterIds: readonly string[];
  /** The app's own "Reply to" check (on unless `TASK_REPLY_AUTOCLOSE=off`). */
  taskReplyAutoclose: boolean;
  /**
   * The `TASK_OPEN_V1` snapshot feed: `auto` tries to post and backs off
   * quietly while the Slack app lacks `chat:write`; `off` never posts.
   */
  taskSnapshotFeed: 'auto' | 'off';

  /**
   * Where the desktop app's installers are published, as `owner/name`. The
   * server looks the newest one up and streams it from /api/desktop/download,
   * so no page links anywhere else.
   */
  desktopReleaseRepo: string;
  /**
   * Optional. Lets the server look up and fetch installers with its own API
   * quota instead of the shared anonymous one; read access to releases is
   * enough.
   */
  desktopReleaseToken: string | undefined;

  /**
   * Kraken Notes (D-076), off by default. 'off' hides the feature and its
   * routes answer 404; 'beta' shows it to whoever turns on the "Kraken Notes
   * (beta)" switch in Settings; 'on' shows it to everyone.
   */
  notesEnabled: NotesMode;
  /**
   * 32 random bytes, base64: seals voice identifiers (biometric data) at rest.
   * Unset means nobody can be enrolled; consent can still be recorded.
   */
  voiceprintEncKey: string | undefined;
  /**
   * Mixed into every share-link token's hash, so a leaked table of hashes
   * cannot be checked against guesses without it. Unset means share links
   * cannot be made outside demo mode.
   */
  notesSharePepper: string | undefined;
  /**
   * The meeting-follow-up routine's API trigger (its /fire URL and token), so
   * the recap starts as soon as a meeting's notes are ready. Unset: the
   * routine's own schedule picks the meeting up instead.
   */
  meetingFollowupFireUrl: string | undefined;
  meetingFollowupFireToken: string | undefined;
  /**
   * The most characters of a NOTES_REQUEST_V1 sent to Arwin's routine (the
   * Ask bridge's trigger). A longer meeting is condensed to fit: consecutive
   * lines merged, fillers dropped, then the middle trimmed with a marker.
   */
  notesFireMaxChars: number;
  /**
   * The private Slack channel the routine posts NOTES_RESULT_V1 to, and the
   * app reads it from (NOTES_RELAY_CHANNEL_ID). No default: until one is set,
   * apart from the Ask relay channel, no meeting is sent to the routine and
   * meetings keep their Quick notes (see notesRelayChannel in lib/notes/relay).
   */
  notesRelayChannelId: string | undefined;
  /**
   * The Slack user IDs whose NOTES_RESULT_V1 posts are read; everyone else's
   * are ignored, because a result writes a meeting's notes and files tasks.
   * NOTES_RELAY_POSTER_IDS, comma separated; defaults to taskRelayPosterIds
   * (the account the routines post as). Never empty.
   */
  notesRelayPosterIds: readonly string[];
  /**
   * The team's own never-record list (NOTES_NEVER_RECORD), comma separated:
   * a domain ("acme.example") never records a meeting with a guest from it,
   * an address one with that guest, anything else one with those words in
   * its title. Kept out of the repository, which is public. Outside demo
   * mode a recording does not start until this list, or a rule in Settings,
   * exists.
   */
  notesNeverRecord: readonly string[];
}

export type NotesMode = 'off' | 'beta' | 'on';

/** NOTES_ENABLED: 'on' (or true/1/yes), 'beta', anything else off. */
function notesMode(value: string | undefined): NotesMode {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'beta') return 'beta';
  if (['on', 'true', '1', 'yes'].includes(v)) return 'on';
  return 'off';
}

/** The desktop app's release repository when DESKTOP_RELEASE_REPO is unset or malformed. */
export const DEFAULT_DESKTOP_RELEASE_REPO = 'arwin-glitch/tiptop-copilot';

/**
 * Every channel a trusted relay reads (Ask, deals and tasks, meeting notes),
 * and every account one of them trusts. A public assistant's relay may use
 * none of them: NOTES_RESULT_V1 posts write meeting notes and file tasks, so
 * the notes relay is as trusted as the task relay.
 */
function trustedRelayChannels(e: AppEnv): string[] {
  return [e.askRelayChannelId, e.dealRelayChannelId, e.notesRelayChannelId].filter(
    (c): c is string => Boolean(c),
  );
}

function trustedRelayPosters(e: AppEnv): Set<string> {
  return new Set([...e.taskRelayPosterIds, ...e.dealRelayPosterIds, ...e.notesRelayPosterIds]);
}

/**
 * Why the routine's Slack relay is not safe to use, in plain words, or null
 * when it is. A stranger's question reaches the routine, so its answers
 * must come back through a channel no other relay reads, posted by an
 * account no other relay trusts: a prompt-injected answer can then never
 * pass for a task, a briefing or a queued email (D-078).
 */
export function bookingChatRelayProblem(e: AppEnv = env()): string | null {
  const channel = e.bookingChatRelayChannelId;
  if (!channel) {
    return 'BOOKING_CHAT_RELAY_CHANNEL_ID is not set: give the routine a private channel of its own.';
  }
  if (trustedRelayChannels(e).includes(channel)) {
    return 'BOOKING_CHAT_RELAY_CHANNEL_ID is a channel another relay reads: give the routine a private channel of its own.';
  }
  if (e.bookingChatPosterIds.length === 0) {
    return 'BOOKING_CHAT_POSTER_IDS is not set: name the Slack account the routine posts as.';
  }
  const trusted = trustedRelayPosters(e);
  if (e.bookingChatPosterIds.some((id) => trusted.has(id))) {
    return 'BOOKING_CHAT_POSTER_IDS names an account another relay trusts: connect the routine to Slack as an account no other relay trusts.';
  }
  return null;
}

/**
 * The same check for the job board assistant's relay (JOBS_CHAT_*): a
 * stranger's question reaches that routine too, so its answers must come
 * back through a channel no trusted relay reads, from an account no trusted
 * relay trusts. Sharing the booking assistant's channel and account is
 * allowed: both carry only public assistants' answers, matched by question
 * id and marker.
 */
export function jobsChatRelayProblem(e: AppEnv = env()): string | null {
  const channel = e.jobsChatRelayChannelId;
  if (!channel) {
    return 'JOBS_CHAT_RELAY_CHANNEL_ID is not set: give the routine a private channel of its own.';
  }
  if (trustedRelayChannels(e).includes(channel)) {
    return 'JOBS_CHAT_RELAY_CHANNEL_ID is a channel another relay reads: give the routine a private channel of its own.';
  }
  if (e.jobsChatPosterIds.length === 0) {
    return 'JOBS_CHAT_POSTER_IDS is not set: name the Slack account the routine posts as.';
  }
  const trusted = trustedRelayPosters(e);
  if (e.jobsChatPosterIds.some((id) => trusted.has(id))) {
    return 'JOBS_CHAT_POSTER_IDS names an account another relay trusts: connect the routine to Slack as an account no other relay trusts.';
  }
  return null;
}

/** The account the task routines post as, so nothing has to be set on Render. */
export const DEFAULT_TASK_RELAY_POSTER_IDS: readonly string[] = ['U0AKEG0Q389'];

function switchedOff(value: string | undefined): boolean {
  return ['off', 'false', '0', 'no'].includes((value ?? '').trim().toLowerCase());
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
    modelDeep: str('AI_MODEL_DEEP') ?? 'claude-opus-5-5',
    aiEffortDeep: (['low', 'medium', 'high', 'xhigh', 'max'] as const).includes(
      effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
    )
      ? (effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max')
      : 'high',

    googleClientId: str('GOOGLE_CLIENT_ID'),
    googleClientSecret: str('GOOGLE_CLIENT_SECRET'),
    googleRedirectUri: str('GOOGLE_REDIRECT_URI') ?? `${appUrl}/api/integrations/google/callback`,

    authAllowedDomains: (str('AUTH_ALLOWED_EMAIL_DOMAINS') ?? '')
      .split(',')
      .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
      .filter(Boolean),

    researchProvider: ((): ResearchProviderName => {
      const v = (str('RESEARCH_PROVIDER') ?? 'none').toLowerCase();
      return v === 'anthropic' || v === 'custom' ? v : 'none';
    })(),
    researchApiUrl: str('RESEARCH_API_URL'),
    researchApiKey: str('RESEARCH_API_KEY'),

    cronSecret: str('CRON_SECRET'),
    vapidPublicKey: str('VAPID_PUBLIC_KEY'),
    granolaWebhookSecret: str('GRANOLA_WEBHOOK_SECRET'),
    granolaBridgeToken: str('GRANOLA_BRIDGE_TOKEN'),
    granolaSigningSecret: str('GRANOLA_SIGNING_SECRET'),
    granolaApiKey: str('GRANOLA_API_KEY'),
    affinityApiKey: str('AFFINITY_API_KEY'),
    gmailPushTopic: str('GMAIL_PUSH_TOPIC'),
    demoDataDir: str('DEMO_DATA_DIR') ?? '.demo-data',
    briefingBridgeToken: str('BRIEFING_BRIDGE_TOKEN'),
    portfolioBridgeToken: str('PORTFOLIO_BRIDGE_TOKEN'),
    taskBridgeToken: str('TASK_BRIDGE_TOKEN'),
    askBridgeToken: str('ASK_BRIDGE_TOKEN'),
    askRoutineFireUrl: str('ASK_ROUTINE_FIRE_URL'),
    askRoutineToken: str('ASK_ROUTINE_TOKEN'),
    askRelaySlackToken: str('ASK_RELAY_SLACK_TOKEN'),
    askRelayChannelId: str('ASK_RELAY_CHANNEL_ID') ?? 'C0C3JPW6PTJ',
    bookingChatFireUrl: str('BOOKING_CHAT_FIRE_URL'),
    bookingChatToken: str('BOOKING_CHAT_TOKEN'),
    bookingChatRelayChannelId: str('BOOKING_CHAT_RELAY_CHANNEL_ID'),
    bookingChatPosterIds: (str('BOOKING_CHAT_POSTER_IDS') ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
    jobsChatFireUrl: str('JOBS_CHAT_FIRE_URL'),
    jobsChatToken: str('JOBS_CHAT_TOKEN'),
    jobsChatRelayChannelId: str('JOBS_CHAT_RELAY_CHANNEL_ID'),
    jobsChatPosterIds: (str('JOBS_CHAT_POSTER_IDS') ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
    bookingBrakesRelaxed: bool('DEMO_MODE', false) && str('E2E_BOOKING_BRAKES') === 'relaxed',
    dealRelayChannelId: str('DEAL_RELAY_CHANNEL_ID') ?? 'C0C40TVD4DP',
    dealRelayPosterIds: (str('DEAL_RELAY_POSTER_IDS') ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
    taskRelayPosterIds: ((): readonly string[] => {
      const ids = (str('TASK_RELAY_POSTER_IDS') ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
      return ids.length > 0 ? ids : DEFAULT_TASK_RELAY_POSTER_IDS;
    })(),
    taskReplyAutoclose: !switchedOff(str('TASK_REPLY_AUTOCLOSE')),
    taskSnapshotFeed: switchedOff(str('TASK_SNAPSHOT_FEED')) ? 'off' : 'auto',
    desktopReleaseRepo: ((): string => {
      const repo = str('DESKTOP_RELEASE_REPO');
      return repo && /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : DEFAULT_DESKTOP_RELEASE_REPO;
    })(),
    desktopReleaseToken: str('DESKTOP_RELEASE_TOKEN'),
    notesEnabled: notesMode(str('NOTES_ENABLED')),
    voiceprintEncKey: str('VOICEPRINT_ENC_KEY'),
    notesSharePepper: str('NOTES_SHARE_PEPPER'),
    meetingFollowupFireUrl: str('MEETING_FOLLOWUP_FIRE_URL'),
    meetingFollowupFireToken: str('MEETING_FOLLOWUP_FIRE_TOKEN'),
    notesFireMaxChars: Math.min(Math.max(int('NOTES_FIRE_MAX_CHARS', 60_000), 8_000), 400_000),
    notesRelayChannelId: str('NOTES_RELAY_CHANNEL_ID'),
    notesRelayPosterIds: ((): readonly string[] => {
      const ids = (str('NOTES_RELAY_POSTER_IDS') ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
      if (ids.length > 0) return ids;
      const task = (str('TASK_RELAY_POSTER_IDS') ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
      return task.length > 0 ? task : DEFAULT_TASK_RELAY_POSTER_IDS;
    })(),
    notesNeverRecord: (str('NOTES_NEVER_RECORD') ?? '')
      .split(',')
      .map((entry) => entry.trim().slice(0, 200))
      .filter(Boolean)
      .slice(0, 100),
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

/** What the running app knows about the task-closer, as plain text; see `taskCloserRuntime`. */
export interface TaskCloserRuntime {
  relay: string;
  lastRun: string | null;
  snapshot: string;
  reply: string;
}

/**
 * Diagnostics for the in-app setup page. Reports presence and shape only —
 * it must never echo a secret value. `runtime` adds what this instance has
 * seen (the Diagnostics page passes it; the health endpoint does not).
 */
export function capabilityReport(
  runtime: { taskCloser?: TaskCloserRuntime } = {},
): CapabilityCheck[] {
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

  // A path on the project URL is the single easiest mistake to make here: the
  // Supabase dashboard shows both the bare project URL and the RESTful
  // endpoint ending `/rest/v1`, and copying the wrong one produces
  // `https://<ref>.supabase.co/rest/v1/auth/v1/authorize` — which answers
  // {"message":"No API key found in request"} and says nothing about the cause.
  const supabaseUrlPath = (() => {
    if (!has(e.supabaseUrl)) return null;
    try {
      const path = new URL(e.supabaseUrl as string).pathname.replace(/\/$/, '');
      return path === '' ? null : path;
    } catch {
      return 'malformed';
    }
  })();

  const supabaseReady = has(e.supabaseUrl) && has(e.supabaseAnonKey) && supabaseUrlPath === null;
  checks.push({
    key: 'supabase',
    label: 'Supabase database & auth',
    status: supabaseReady ? 'ready' : e.demoMode ? 'demo' : 'missing',
    detail: supabaseReady
      ? 'Project URL and anon key present.'
      : supabaseUrlPath === 'malformed'
        ? 'NEXT_PUBLIC_SUPABASE_URL is not a valid URL.'
        : supabaseUrlPath !== null
          ? `NEXT_PUBLIC_SUPABASE_URL must be the bare project origin, with no path. It currently ends in "${supabaseUrlPath}" — that is the RESTful endpoint, not the project URL. Remove the path.`
          : 'Not configured. Demo mode uses a local file-backed store instead.',
    variables: ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'],
    required: true,
  });

  // APP_URL silently defaults to localhost, and it builds every OAuth redirect.
  // Left unset on a hosted deployment, sign-in sends the user to their own
  // machine — a failure that looks like the identity provider's fault.
  const appUrlIsLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(e.appUrl);
  checks.push({
    key: 'app_url',
    label: 'Public origin',
    status: e.demoMode ? 'demo' : appUrlIsLocal ? 'missing' : 'ready',
    detail: appUrlIsLocal
      ? `APP_URL is "${e.appUrl}". On a hosted deployment this must be the public origin, because every OAuth redirect is built from it — sign-in will send the user to their own machine.`
      : `Public origin: ${e.appUrl}`,
    variables: ['APP_URL'],
    required: true,
  });

  checks.push({
    key: 'supabase_service',
    label: 'Supabase service role key',
    status: has(e.supabaseServiceRoleKey) ? 'ready' : e.demoMode ? 'demo' : 'missing',
    detail: has(e.supabaseServiceRoleKey)
      ? 'Present. Used server-side only for storage signing and scheduled jobs.'
      : 'Not set. Outside demo mode the app refuses to start a database or storage session rather than falling back to fixtures, so this is required, not optional.',
    variables: ['SUPABASE_SERVICE_ROLE_KEY'],
    required: true,
  });

  checks.push({
    key: 'anthropic',
    label: 'Anthropic API',
    status: has(e.anthropicApiKey) ? 'ready' : e.demoMode ? 'demo' : 'missing',
    detail: has(e.anthropicApiKey)
      ? `Key present. Fast model: ${e.modelFast}. Deep model: ${e.modelDeep}.`
      : e.demoMode
        ? 'Not set. Demo mode uses a deterministic offline model stub.'
        : 'Not set. Every AI feature reports itself as unavailable rather than generating anything. Email, calendar, deals, documents, tasks and portfolio are unaffected.',
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
    key: 'auth_domains',
    label: 'Permitted sign-in domains',
    status: e.authAllowedDomains.length > 0 ? 'ready' : e.demoMode ? 'demo' : 'missing',
    detail:
      e.authAllowedDomains.length > 0
        ? `Sign-in restricted to ${e.authAllowedDomains.map((d) => `@${d}`).join(', ')}.`
        : 'Unrestricted. Any account the identity provider accepts is given its own workspace, because the database provisions an organization for every new user. Set this before inviting anyone.',
    variables: ['AUTH_ALLOWED_EMAIL_DOMAINS'],
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
      : 'Not set. The scheduled sync and briefing endpoints will reject all callers.',
    variables: ['CRON_SECRET'],
    required: false,
  });

  // Granola needs both halves: the signature proves a delivery is genuine, and
  // the key fetches the content the delivery deliberately omits. Either alone
  // is a dead end, so they are reported as one capability.
  const granolaNative = has(e.granolaSigningSecret) && has(e.granolaApiKey);
  checks.push({
    key: 'granola',
    label: 'Granola meeting notes',
    status: granolaNative || has(e.granolaWebhookSecret) ? 'ready' : 'optional-missing',
    detail: granolaNative
      ? 'Connected. Granola signs each delivery and the API key fetches the note it names.'
      : has(e.granolaSigningSecret)
        ? 'Deliveries can be verified, but GRANOLA_API_KEY is missing — a webhook carries only a note id, never its content, so nothing can be read.'
        : has(e.granolaApiKey)
          ? 'Notes could be fetched, but GRANOLA_SIGNING_SECRET is missing, so no delivery can be trusted.'
          : 'Not set. Meeting notes do not arrive; nothing else is affected.',
    variables: [
      'GRANOLA_SIGNING_SECRET',
      'GRANOLA_API_KEY',
      'GRANOLA_WEBHOOK_SECRET',
      'GRANOLA_BRIDGE_TOKEN',
    ],
    required: false,
  });

  // Reported separately because it answers a different question. The check
  // above asks whether Granola's own notes can arrive; this one asks whether
  // the bridge that carries the notes Granola's API will not serve — the
  // private ones — has a credential of its own, or is borrowing the stronger
  // secret it should not be holding.
  checks.push({
    key: 'granola-bridge',
    label: 'Granola bridge (private notes)',
    status: has(e.granolaBridgeToken) ? 'ready' : 'optional-missing',
    detail: has(e.granolaBridgeToken)
      ? 'An ingest-only token is set. A sender holding it can file notes but cannot start a backfill.'
      : has(e.granolaWebhookSecret)
        ? 'Not set. An external sender would have to hold GRANOLA_WEBHOOK_SECRET, which also opens /backfill — more than posting a note requires.'
        : 'Not set. Nothing can post notes to this app; Granola-native delivery is unaffected.',
    variables: ['GRANOLA_BRIDGE_TOKEN'],
    required: false,
  });

  checks.push({
    key: 'affinity',
    label: 'Daily Affinity sync',
    status: has(e.affinityApiKey) ? 'ready' : 'optional-missing',
    detail: has(e.affinityApiKey)
      ? 'Set. Every list, record and note in Affinity is copied into the CRM each morning (also "Sync now" on Knowledge → Affinity import).'
      : 'Not set. Affinity is not synced; CSV exports can still be imported by hand on Knowledge → Affinity import.',
    variables: ['AFFINITY_API_KEY'],
    required: false,
  });

  // Keyed on the Slack token, not BRIEFING_BRIDGE_TOKEN: the routines cannot
  // reach the webhook, so the relay channel is the only way a card arrives.
  checks.push({
    key: 'briefing-bridge',
    label: 'Routine briefing card (Today page)',
    status: has(e.askRelaySlackToken) ? 'ready' : 'optional-missing',
    detail: has(e.askRelaySlackToken)
      ? 'Set. The Today page reads Daily Overview and Daily Recap cards from the Slack relay channel.'
      : 'Not set. Routine briefing cards never reach the Today page; the rest of Today is unaffected.',
    variables: ['ASK_RELAY_SLACK_TOKEN'],
    required: false,
  });

  checks.push({
    key: 'portfolio-bridge',
    label: 'Automatic portfolio additions',
    status: has(e.portfolioBridgeToken) ? 'ready' : 'optional-missing',
    detail: has(e.portfolioBridgeToken)
      ? 'An add-only token is set. The sheet and closed-deal watchers can add new portfolio companies.'
      : 'Not set. New portfolio companies must be added by hand; the Portfolio page is unaffected.',
    variables: ['PORTFOLIO_BRIDGE_TOKEN'],
    required: false,
  });

  checks.push({
    key: 'task-bridge',
    label: 'Automatic task suggestions',
    status: has(e.taskBridgeToken) ? 'ready' : 'optional-missing',
    detail: has(e.taskBridgeToken)
      ? 'An add-only token is set. The watcher can add suggested follow-up tasks.'
      : 'Not set. New tasks must be added by hand; the Tasks page is unaffected.',
    variables: ['TASK_BRIDGE_TOKEN'],
    required: false,
  });

  checks.push({
    key: 'deal-relay',
    label: 'Automatic deal pipeline',
    status: has(e.askRelaySlackToken) ? 'ready' : 'optional-missing',
    detail: has(e.askRelaySlackToken)
      ? `Set. The Deals page reads the deal-sorter's posts from the private #deal-relay channel (${e.dealRelayChannelId})${e.dealRelayPosterIds.length > 0 ? ', from the listed posters only' : ''}. The Slack app must be a member and have groups:history.`
      : 'Not set. Deals from the deal-sorter routine never arrive; Portfolio companies still show under Invested.',
    variables: ['ASK_RELAY_SLACK_TOKEN', 'DEAL_RELAY_CHANNEL_ID', 'DEAL_RELAY_POSTER_IDS'],
    required: false,
  });

  const closer = runtime.taskCloser;
  const posters = `${e.taskRelayPosterIds.length} poster${e.taskRelayPosterIds.length === 1 ? '' : 's'}`;
  const replyCheck = closer
    ? ` "Reply to" check: ${closer.reply}.`
    : e.taskReplyAutoclose
      ? ` The app's own "Reply to" check runs once a day after 3 PM Central.`
      : ` The app's own "Reply to" check is off.`;
  checks.push({
    key: 'task-closer',
    label: 'Automatic task closing (task-closer)',
    status: has(e.askRelaySlackToken) ? 'ready' : 'optional-missing',
    detail: has(e.askRelaySlackToken)
      ? `Set. Tasks close from the task-closer's TASK_CLOSE_V1 posts in #deal-relay (${e.dealRelayChannelId}), from ${posters} only.` +
        (closer
          ? ` Relay: ${closer.relay}. Last run: ${closer.lastRun ?? 'none reported in the last 14 days'}. Snapshot feed: ${closer.snapshot}.`
          : '') +
        replyCheck
      : `Not set. Only a person closes tasks, apart from the app's own "Reply to" check.${closer ? ` "Reply to" check: ${closer.reply}.` : ''}`,
    variables: [
      'ASK_RELAY_SLACK_TOKEN',
      'TASK_RELAY_POSTER_IDS',
      'TASK_REPLY_AUTOCLOSE',
      'TASK_SNAPSHOT_FEED',
    ],
    required: false,
  });

  checks.push({
    key: 'ask-bridge',
    label: 'Ask bridge (external Claude answers)',
    status: has(e.askBridgeToken) ? 'ready' : e.demoMode ? 'demo' : 'optional-missing',
    detail: has(e.askBridgeToken)
      ? 'Set. Every new question on the Ask page waits for an external Claude session to answer it, rather than the in-app Anthropic call.'
      : has(e.anthropicApiKey)
        ? 'Not set. Ask answers in-process using the configured Anthropic key instead.'
        : 'Not set, and no Anthropic key either — Ask has no way to answer a question and stays hidden.',
    variables: ['ASK_BRIDGE_TOKEN'],
    required: false,
  });

  const directCall =
    has(e.askRoutineFireUrl) && has(e.askRoutineToken) && has(e.askRelaySlackToken);
  checks.push({
    key: 'ask-direct-call',
    label: 'Ask direct call (instant answers)',
    status: directCall ? 'ready' : 'optional-missing',
    detail: directCall
      ? 'Set. A new question fires the answering routine immediately, and the app reads the answer back from the Slack relay channel itself.'
      : 'Not set. Questions wait for the answering routine on its hourly timer (via the GitHub relay) instead of starting instantly.',
    variables: ['ASK_ROUTINE_FIRE_URL', 'ASK_ROUTINE_TOKEN', 'ASK_RELAY_SLACK_TOKEN'],
    required: false,
  });

  const bookingAssistantKeys =
    has(e.bookingChatFireUrl) && has(e.bookingChatToken) && has(e.askRelaySlackToken);
  const relayProblem = bookingChatRelayProblem(e);
  const bookingAssistant = bookingAssistantKeys && relayProblem === null;
  checks.push({
    key: 'booking-assistant',
    label: 'Booking page assistant: AI answers (optional)',
    status: bookingAssistant ? 'ready' : 'optional-missing',
    detail: bookingAssistant
      ? `Set. A question the written answers do not cover goes to the booking assistant routine on Arwin's Claude plan (no API key), and its answer is read back from its own Slack channel (${e.bookingChatRelayChannelId}), from its own poster only. Turn it on in the Booking tab's assistant panel.`
      : bookingAssistantKeys && relayProblem
        ? `Off: ${relayProblem} Until then the assistant answers from the written questions only (docs/BOOKING_CHAT_ROUTINE.md).`
        : 'Not set. The booking page assistant answers from the written questions only and books times; nothing else changes. Set it up with docs/BOOKING_CHAT_ROUTINE.md.',
    variables: [
      'BOOKING_CHAT_FIRE_URL',
      'BOOKING_CHAT_TOKEN',
      'ASK_RELAY_SLACK_TOKEN',
      'BOOKING_CHAT_RELAY_CHANNEL_ID',
      'BOOKING_CHAT_POSTER_IDS',
    ],
    required: false,
  });

  const jobsAssistantKeys =
    has(e.jobsChatFireUrl) && has(e.jobsChatToken) && has(e.askRelaySlackToken);
  const jobsRelayProblem = jobsChatRelayProblem(e);
  const jobsAssistant = jobsAssistantKeys && jobsRelayProblem === null;
  checks.push({
    key: 'jobs-assistant',
    label: 'Job board assistant: AI answers (optional)',
    status: jobsAssistant ? 'ready' : 'optional-missing',
    detail: jobsAssistant
      ? `Set. A question the board and the written answers do not cover goes to the jobs assistant routine on Arwin's Claude plan (no API key), and its answer is read back from its own Slack channel (${e.jobsChatRelayChannelId}), from its own poster only. Turn it on in Portfolio > Jobs, Ask Arwin.`
      : jobsAssistantKeys && jobsRelayProblem
        ? `Off: ${jobsRelayProblem} Until then the board assistant answers from the board and the written answers only (docs/JOBS_CHAT_ROUTINE.md).`
        : 'Not set. The job board assistant answers from the board and the written answers only; nothing else changes. Set it up with docs/JOBS_CHAT_ROUTINE.md.',
    variables: [
      'JOBS_CHAT_FIRE_URL',
      'JOBS_CHAT_TOKEN',
      'ASK_RELAY_SLACK_TOKEN',
      'JOBS_CHAT_RELAY_CHANNEL_ID',
      'JOBS_CHAT_POSTER_IDS',
    ],
    required: false,
  });

  const updatesOpen = e.authAllowedDomains.length > 0;
  checks.push({
    key: 'updates-tab',
    label: 'Updates tab (dealflow & digests)',
    status: e.demoMode
      ? 'demo'
      : has(e.askRelaySlackToken) && updatesOpen
        ? 'ready'
        : 'optional-missing',
    detail: e.demoMode
      ? 'Demo mode: the Updates tab shows invented reports from a fake Slack.'
      : !updatesOpen
        ? 'Closed. The Updates tab reads confidential channels, so it shows nothing until AUTH_ALLOWED_EMAIL_DOMAINS limits who can sign in.'
        : has(e.askRelaySlackToken)
          ? 'Set. The Updates tab reads the dealflow and digest channels live. Each private channel also needs the groups:history scope and the bot invited; /updates shows the status per channel.'
          : 'Not set. The Updates tab shows setup steps instead of reports; nothing else is affected.',
    variables: ['ASK_RELAY_SLACK_TOKEN', 'AUTH_ALLOWED_EMAIL_DOMAINS'],
    required: false,
  });

  // Kraken Notes (D-076). Off by default; each row reports presence only.
  // Speech-to-text needs no key: Whisper runs in the recorder's own browser.
  checks.push({
    key: 'notes',
    label: 'Kraken Notes (meeting transcripts)',
    status: e.notesEnabled === 'off' ? 'optional-missing' : e.demoMode ? 'demo' : 'ready',
    detail:
      e.notesEnabled === 'off'
        ? 'Off (NOTES_ENABLED is not set). Meetings are not recorded; Granola notes are unaffected.'
        : e.demoMode
          ? 'Demo mode: recording plays a scripted, fictional call and runs no speech model.'
          : `${e.notesEnabled === 'beta' ? 'Beta: on for whoever turns on the Settings switch.' : 'On for everyone.'} Speech-to-text runs free in the recorder's browser (Whisper); audio never leaves that computer.`,
    variables: ['NOTES_ENABLED'],
    required: false,
  });

  // Both refuse rather than fall back (D-076): with no never-record list a
  // recording does not start, and with no private relay channel apart from
  // the Ask one no meeting is sent to Arwin's routine.
  const notesOn = e.notesEnabled !== 'off' && !e.demoMode;
  checks.push({
    key: 'notes-never-record',
    label: 'Kraken Notes never-record list',
    status:
      e.notesNeverRecord.length > 0
        ? 'ready'
        : e.demoMode
          ? 'demo'
          : notesOn
            ? 'missing'
            : 'optional-missing',
    detail:
      e.notesNeverRecord.length > 0
        ? `Set: ${e.notesNeverRecord.length} entr${e.notesNeverRecord.length === 1 ? 'y' : 'ies'}, checked on the server before every recording, with the legal and family words built in.`
        : 'Not set. Recording does not start until it is set, or until a rule is added in Notes settings › Never record.',
    variables: ['NOTES_NEVER_RECORD'],
    required: false,
  });

  const notesRelayOk = has(e.notesRelayChannelId) && e.notesRelayChannelId !== e.askRelayChannelId;
  checks.push({
    key: 'notes-relay',
    label: "Kraken Notes: Arwin's notes channel",
    status: notesRelayOk ? 'ready' : e.demoMode ? 'demo' : notesOn ? 'missing' : 'optional-missing',
    detail: notesRelayOk
      ? `Set (${e.notesRelayChannelId}), apart from the Ask relay channel. Results are read from ${e.notesRelayPosterIds.length} poster${e.notesRelayPosterIds.length === 1 ? '' : 's'} only.`
      : has(e.notesRelayChannelId)
        ? "Set to the Ask relay channel, which every member can read. No meeting is sent to Arwin's routine until a private channel of its own is set; meetings keep their Quick notes."
        : "Not set. No meeting is sent to Arwin's routine until a private channel is set; meetings keep their Quick notes.",
    variables: ['NOTES_RELAY_CHANNEL_ID', 'NOTES_RELAY_POSTER_IDS'],
    required: false,
  });

  checks.push({
    key: 'notes-share',
    label: 'Kraken Notes share links',
    status: has(e.notesSharePepper)
      ? (e.notesSharePepper?.length ?? 0) >= 32
        ? 'ready'
        : 'missing'
      : e.demoMode
        ? 'demo'
        : 'optional-missing',
    detail: has(e.notesSharePepper)
      ? (e.notesSharePepper?.length ?? 0) >= 32
        ? 'Present. Only a peppered hash of each link is stored.'
        : 'Present but shorter than 32 characters; share links stay off until it is longer.'
      : 'Not set. Notes cannot be shared by link; everything else works.',
    variables: ['NOTES_SHARE_PEPPER'],
    required: false,
  });

  const voiceKeyOk = (() => {
    if (!e.voiceprintEncKey) return false;
    try {
      return Buffer.from(e.voiceprintEncKey, 'base64').length === 32;
    } catch {
      return false;
    }
  })();
  checks.push({
    key: 'notes-voice',
    label: 'Kraken Notes voice profiles (opt-in)',
    status: voiceKeyOk ? 'ready' : 'optional-missing',
    detail: voiceKeyOk
      ? 'Present and decodes to 32 bytes. Voice identifiers are sealed with it, for people who consented only.'
      : 'Not set (or not 32 bytes, base64). Nobody can be enrolled; names come from the calendar and from taps instead.',
    variables: ['VOICEPRINT_ENC_KEY'],
    required: false,
  });

  const followUp = has(e.meetingFollowupFireUrl) && has(e.meetingFollowupFireToken);
  checks.push({
    key: 'meeting-followup',
    label: 'Meeting recap trigger',
    status: followUp ? 'ready' : 'optional-missing',
    detail: followUp
      ? "Set. The meeting-follow-up routine starts as soon as a meeting's notes are ready."
      : 'Not set. The meeting-follow-up routine picks new notes up on its own schedule.',
    variables: ['MEETING_FOLLOWUP_FIRE_URL', 'MEETING_FOLLOWUP_FIRE_TOKEN'],
    required: false,
  });

  return checks;
}

export function isDemoMode(): boolean {
  return env().demoMode;
}
