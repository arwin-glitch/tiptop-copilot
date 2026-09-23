'use client';

import { VersionWatcher } from '@/components/shell/version-watcher';

/**
 * Keeps an open Today tab's briefing cards current: a `VersionWatcher` on
 * the briefing fingerprint.
 */
export function BriefingWatcher({ version }: { version: string }) {
  return <VersionWatcher version={version} endpoint="/api/briefings/current" />;
}
