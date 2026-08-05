/**
 * A typed success/failure envelope used across services so that expected
 * failures (invalid model output, quota exhausted, provider unavailable) travel
 * as values rather than exceptions. Only genuinely unexpected conditions throw.
 */

export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };
export type Result<T, E = AppError> = Ok<T> | Err<E>;

export const ERROR_CODES = [
  'unauthenticated',
  'forbidden',
  'not_found',
  'invalid_input',
  'invalid_model_output',
  'provider_unavailable',
  'provider_unauthorized',
  'quota_exceeded',
  'rate_limited',
  'budget_exceeded',
  'too_large',
  'unsupported_media_type',
  'conflict',
  'not_configured',
  'timeout',
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface AppError {
  code: ErrorCode;
  /** Safe to show a user. Never contains secrets or raw provider payloads. */
  message: string;
  /** What still works despite this failure — surfaced in degraded-state UI. */
  stillUsable?: string;
  /** Non-sensitive structured context for logs. */
  details?: Record<string, string | number | boolean | null>;
  retryable?: boolean;
}

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err(
  code: ErrorCode,
  message: string,
  extra: Omit<AppError, 'code' | 'message'> = {},
): Err<AppError> {
  return { ok: false, error: { code, message, ...extra } };
}

export function isOk<T, E>(r: Result<T, E>): r is Ok<T> {
  return r.ok;
}

export function unwrapOr<T, E>(r: Result<T, E>, fallback: T): T {
  return r.ok ? r.value : fallback;
}

/** Map an AppError code to an HTTP status for route handlers. */
export function statusForError(code: ErrorCode): number {
  switch (code) {
    case 'unauthenticated':
      return 401;
    case 'forbidden':
      return 403;
    case 'not_found':
      return 404;
    case 'invalid_input':
      return 400;
    case 'conflict':
      return 409;
    case 'too_large':
      return 413;
    case 'unsupported_media_type':
      return 415;
    case 'rate_limited':
    case 'quota_exceeded':
    case 'budget_exceeded':
      return 429;
    case 'not_configured':
      return 503;
    case 'provider_unavailable':
    case 'provider_unauthorized':
      return 502;
    case 'timeout':
      return 504;
    case 'invalid_model_output':
    case 'internal':
    default:
      return 500;
  }
}

export class AppException extends Error {
  readonly appError: AppError;
  constructor(appError: AppError) {
    super(appError.message);
    this.name = 'AppException';
    this.appError = appError;
  }
}

export function throwIfErr<T>(r: Result<T>): T {
  if (!r.ok) throw new AppException(r.error);
  return r.value;
}
