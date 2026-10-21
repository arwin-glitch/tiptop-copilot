'use client';

import { AlertTriangle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * What did not upload, and why, in the server's own words: kept on the page
 * under the uploader until the next upload or until dismissed, beside the
 * toast. A toast alone can come and go unseen, and a count that simply stays
 * at 0 says nothing about why.
 */
export function UploadProblems({
  title,
  problems,
  onDismiss,
}: {
  title: string;
  problems: string[];
  onDismiss: () => void;
}) {
  if (!problems.length) return null;
  return (
    <div
      role="alert"
      className="rounded-md border border-[var(--danger)]/30 bg-[var(--danger-soft)] px-3 py-2 text-xs"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle
          className="mt-0.5 size-3.5 shrink-0 text-[var(--danger)]"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-semibold text-[var(--danger)]">{title}</p>
          <ul className="space-y-0.5 text-[var(--fg)]">
            {problems.map((problem, i) => (
              <li key={i} className="break-words">
                {problem}
              </li>
            ))}
          </ul>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Dismiss: ${title}`}
          onClick={onDismiss}
          className="size-7 shrink-0"
        >
          <X aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
