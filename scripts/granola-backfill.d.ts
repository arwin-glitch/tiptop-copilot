/** Types for the pure helpers the test suite imports from the backfill driver. */
export function backfillUrlFrom(webhookUrl: string): URL;

export function callUrl(
  url: URL | string,
  options?: { cursor?: string | null; pages?: number; full?: boolean },
): URL;
