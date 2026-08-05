/**
 * Secret redaction for logs, audit metadata and error surfaces.
 *
 * This runs on the way *out* of the process (logs, audit rows, API error
 * bodies). It is a defence in depth measure — the primary control is never
 * putting a secret into those paths in the first place.
 */

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'anthropic_key', re: /sk-ant-[A-Za-z0-9_-]{10,}/g },
  { name: 'google_oauth_token', re: /ya29\.[A-Za-z0-9._-]{10,}/g },
  { name: 'google_refresh_token', re: /1\/\/[A-Za-z0-9._-]{20,}/g },
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: 'supabase_service_key', re: /sbp_[A-Za-z0-9]{20,}/g },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi },
  { name: 'aws_key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    name: 'private_key_block',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    name: 'password_assignment',
    re: /\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["']?[^\s"',}]{8,}/gi,
  },
];

const SENSITIVE_KEYS = new Set([
  'password',
  'secret',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'api_key',
  'apikey',
  'authorization',
  'cookie',
  'set-cookie',
  'ciphertext',
  'auth_tag',
  'iv',
  'session',
  'anthropic_api_key',
  'service_role_key',
]);

export function redactString(input: string): string {
  let out = input;
  for (const { name, re } of PATTERNS) {
    out = out.replace(re, `[redacted:${name}]`);
  }
  return out;
}

/**
 * Deep-redact an arbitrary value. Sensitive keys are replaced wholesale;
 * string values are pattern-scrubbed. Cycles are handled.
 */
export function redact<T>(value: T, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);

  if (Array.isArray(value)) return value.map((v) => redact(v, seen));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      out[k] = '[redacted]';
    } else {
      out[k] = redact(v, seen);
    }
  }
  return out;
}

/** Structured, redacted logger. The only logging entry point in the app. */
export const log = {
  info(message: string, meta?: Record<string, unknown>): void {
    emit('info', message, meta);
  },
  warn(message: string, meta?: Record<string, unknown>): void {
    emit('warn', message, meta);
  },
  error(message: string, meta?: Record<string, unknown>): void {
    emit('error', message, meta);
  },
};

function emit(level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) {
  const payload = {
    level,
    time: new Date().toISOString(),
    message: redactString(message),
    ...(meta ? { meta: redact(meta) } : {}),
  };
  const line = JSON.stringify(payload);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
