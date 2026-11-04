'use client';

import * as React from 'react';
import { Copy, Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';

interface Original {
  subject: string;
  fileName: string;
  summary: { name: string; value: string }[];
  source: string;
  bytes: number;
}

/** The address of one message's original, to show or (with `download`) to save as .eml. */
export function originalHref(threadId: string, messageId: string, download = false): string {
  const q = new URLSearchParams({ thread: threadId, id: messageId });
  if (download) q.set('download', '1');
  return `/api/inbox/original?${q.toString()}`;
}

/**
 * Gmail's "Show original": the summary (message id, date, sender, SPF, DKIM,
 * DMARC), then the whole source as plain, read-only text (React escapes it,
 * so nothing in it is rendered or run), with Download original and Copy.
 */
export function ShowOriginalDialog({
  target,
  onClose,
}: {
  target: { threadId: string; messageId: string } | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && onClose()}>
      {target ? (
        <DialogContent
          title="Original message"
          description="The message exactly as Gmail received it. Read-only."
          className="max-w-3xl"
        >
          <OriginalBody threadId={target.threadId} messageId={target.messageId} onClose={onClose} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function OriginalBody({
  threadId,
  messageId,
  onClose,
}: {
  threadId: string;
  messageId: string;
  onClose: () => void;
}) {
  const [read, setRead] = React.useState<Original | { error: string } | null>(null);
  React.useEffect(() => {
    let live = true;
    fetch(originalHref(threadId, messageId), { cache: 'no-store' })
      .then(async (r) => {
        const j = (await r.json().catch(() => null)) as
          (Original & { ok: true }) | { ok: false; error?: { message?: string } } | null;
        if (!j || !j.ok) {
          return { error: (j && !j.ok && j.error?.message) || 'Gmail did not answer.' };
        }
        return j;
      })
      .catch(() => ({ error: 'Could not reach Kraken. Try again.' }))
      .then((v) => {
        if (live) setRead(v);
      });
    return () => {
      live = false;
    };
  }, [threadId, messageId]);

  if (!read) {
    return (
      <p className="flex items-center gap-2 text-sm text-[var(--fg-muted)]">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Reading the original…
      </p>
    );
  }
  if ('error' in read) return <p className="text-sm text-[var(--danger)]">{read.error}</p>;
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-md border border-[var(--border)] bg-[var(--bg-sunken)] p-3 text-sm">
        {read.summary.map((r) => (
          <React.Fragment key={r.name}>
            <dt className="text-[var(--fg-muted)]">{r.name}</dt>
            <dd className="break-words">
              {/^(SPF|DKIM|DMARC)$/.test(r.name) ? (
                <span
                  className={
                    r.value === 'PASS'
                      ? 'font-semibold text-[var(--ok)]'
                      : 'font-semibold text-[var(--danger)]'
                  }
                >
                  {r.value}
                </span>
              ) : (
                r.value
              )}
            </dd>
          </React.Fragment>
        ))}
      </dl>
      <pre
        aria-label="Original source"
        tabIndex={0}
        className="max-h-[50vh] overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-raised)] p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap"
      >
        {read.source}
      </pre>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          Close
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() =>
            void navigator.clipboard.writeText(read.source).then(
              () => toast.success('Copied to clipboard'),
              () => toast.error('Could not copy. Select the text and copy it.'),
            )
          }
        >
          <Copy className="size-4" aria-hidden /> Copy to clipboard
        </Button>
        <a
          href={originalHref(threadId, messageId, true)}
          download={read.fileName}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[var(--primary)] px-3.5 text-sm font-medium text-[var(--primary-fg)] hover:bg-[var(--primary-hover)]"
        >
          <Download className="size-4" aria-hidden /> Download original
        </a>
      </DialogFooter>
    </div>
  );
}
