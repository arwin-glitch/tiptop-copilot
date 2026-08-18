/** Types for the pure functions the test suite imports from the watcher. */

export interface GranolaPayload {
  external_id: string;
  title: string;
  occurred_at: string;
  attendee_emails: string;
  attendee_names: string;
  content: string;
}

export function parseCache(rawText: string): unknown[];
export function toPayload(doc: unknown): GranolaPayload | null;
export function contentHash(payload: GranolaPayload): string;
