import * as React from 'react';
import { Download } from 'lucide-react';
import { DownloadLink } from '@/components/lists/download-link';
import { crmNotesExportHref } from '@/lib/crm/view';
import { cn } from '@/lib/util/cn';

/**
 * "Export notes": every note on a company or person as a CSV. Render it for
 * members and above only, the roles the export route serves. Free of hooks
 * itself, so a server page (a profile) and the client side panel can both
 * render it; the download, and a refusal shown as a toast, are DownloadLink's.
 * Not in an iPhone app that cannot save a download.
 */
export function ExportNotesLink({
  recordId,
  recordName,
  className,
}: {
  recordId: string;
  recordName: string;
  className?: string;
}) {
  return (
    <DownloadLink
      href={crmNotesExportHref(recordId)}
      aria-label={`Export notes on ${recordName} as CSV`}
      className={cn(
        'text-mini ios-no-downloads:hidden inline-flex items-center gap-1 text-[var(--accent)] underline-offset-2 hover:underline data-[busy]:cursor-progress data-[busy]:opacity-60',
        className,
      )}
    >
      <Download className="size-3.5" aria-hidden="true" />
      Export notes
    </DownloadLink>
  );
}
