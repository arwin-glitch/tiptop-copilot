'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Check, CircleAlert } from 'lucide-react';
import { toast } from 'sonner';
import type { PublishResult } from '@/lib/events/contracts';
import { studioFetch } from '@/lib/events/editor/api';
import { diffLine, publishDiff, readyChecklist } from '@/lib/events/editor/publish';
import { cn } from '@/lib/util/cn';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { useStudio } from './studio-context';

interface ActivityRow {
  op: string;
  sectionId: string | null;
  authorName: string;
  outside: boolean;
}

/**
 * Publish (owners only): the section-level diff since the last publish with
 * who made each change ("Hero – headline, background – Morgan (outside)"),
 * then the Ready checklist. Missing alt text blocks; the other checks warn
 * and the owner may publish anyway. Publishing goes through WS1's
 * /api/events/[id]/publish with the draft version this dialog showed.
 */
export function PublishDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const studio = useStudio();
  const router = useRouter();
  const { boot, doc } = studio;
  const [authors, setAuthors] = React.useState<Map<string, string[]>>(new Map());
  const [override, setOverride] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const published = studio.publishedDoc;

  const diff = React.useMemo(
    () => publishDiff(published, doc, studio.labelOf),
    [doc, published, studio.labelOf],
  );
  const checklist = React.useMemo(
    () =>
      readyChecklist({ doc, facts: boot.facts, media: studio.mediaItems, labelOf: studio.labelOf }),
    [boot.facts, doc, studio.labelOf, studio.mediaItems],
  );
  const blocked = checklist.some((c) => c.blocking && !c.ok);
  const warnings = checklist.filter((c) => !c.blocking && !c.ok);

  React.useEffect(() => {
    if (!boot.endpoints.activity) return;
    let live = true;
    void studioFetch<{ entries: ActivityRow[] }>(
      `${boot.endpoints.activity}?since=${studio.publishedDraftVersion}`,
    ).then((r) => {
      if (!live || !r.ok) return;
      const map = new Map<string, string[]>();
      for (const row of r.value.entries) {
        const key =
          row.op === 'theme' ? 'theme' : row.op === 'page' ? 'meta' : (row.sectionId ?? '');
        const name = `${row.authorName}${row.outside ? ' (outside)' : ''}`;
        const list = map.get(key) ?? [];
        if (!list.includes(name)) list.push(name);
        map.set(key, list);
      }
      setAuthors(map);
    });
    return () => {
      live = false;
    };
  }, [boot.endpoints.activity, studio.publishedDraftVersion]);

  async function publish() {
    if (!boot.endpoints.publish) return;
    setBusy(true);
    await studio.session.flush();
    if (studio.editor.hasUnsaved) {
      setBusy(false);
      toast.error('Some changes are still saving. Try again in a moment.');
      return;
    }
    const r = await studioFetch<PublishResult>(boot.endpoints.publish, {
      method: 'POST',
      json: { expectedDraftVersion: studio.editor.version },
    });
    setBusy(false);
    if (!r.ok) {
      if (r.status === 404) toast.error('Publishing is still being built.');
      else if (r.status === 409)
        toast.error(
          'Someone changed the page while you were publishing. Check the changes and try again.',
        );
      else toast.error(r.error.message);
      return;
    }
    studio.markPublished(structuredClone(doc), studio.editor.version);
    onOpenChange(false);
    const url = `${window.location.origin}${r.value.path}`;
    toast.success('Published. The page is live.', {
      action: {
        label: 'Copy link',
        onClick: () => void navigator.clipboard?.writeText(url),
      },
      cancel: {
        label: 'Draft invite',
        onClick: () => router.push(`/events/${boot.eventId}?tab=messages`),
      },
      duration: 12_000,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={published ? 'Publish changes' : 'Publish this page'}
        description={
          published
            ? 'Guests see the new version as soon as you publish.'
            : 'The page goes live at its link. Nothing is emailed.'
        }
        className="max-w-xl"
      >
        <section aria-label="What changes" className="space-y-2">
          <h3 className="text-sm font-semibold">
            {published ? `Changes since the last publish (${diff.length})` : 'First publish'}
          </h3>
          {published && diff.length === 0 ? (
            <p className="text-sm text-[var(--fg-muted)]">
              Nothing has changed since the last publish.
            </p>
          ) : null}
          {!published ? (
            <p className="text-sm text-[var(--fg-muted)]">
              {doc.sections.length} section{doc.sections.length === 1 ? '' : 's'} go live.
            </p>
          ) : null}
          {published ? (
            <ul className="max-h-48 space-y-1 overflow-y-auto text-sm">
              {diff.map((item) => {
                const names = authors.get(item.id);
                return (
                  <li key={`${item.kind}-${item.id}`}>
                    {diffLine(item)}
                    {names?.length ? (
                      <span className="text-[var(--fg-muted)]"> – {names.join(', ')}</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>
        <section aria-label="Ready checklist" className="mt-4 space-y-2">
          <h3 className="text-sm font-semibold">Ready to publish?</h3>
          <ul className="space-y-1.5">
            {checklist.map((item) => (
              <li key={item.id} className="flex items-start gap-2 text-sm">
                {item.ok ? (
                  <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[var(--ok)]" />
                ) : item.blocking ? (
                  <CircleAlert
                    aria-hidden="true"
                    className="mt-0.5 size-4 shrink-0 text-[var(--danger)]"
                  />
                ) : (
                  <AlertTriangle
                    aria-hidden="true"
                    className="mt-0.5 size-4 shrink-0 text-[var(--warn)]"
                  />
                )}
                <span>
                  <span className={cn(!item.ok && 'font-medium')}>
                    {item.label}
                    <span className="sr-only">
                      {item.ok ? ' (ready)' : item.blocking ? ' (blocks publishing)' : ' (warning)'}
                    </span>
                  </span>
                  {item.detail && !item.ok ? (
                    <span className="block text-xs text-[var(--fg-muted)]">{item.detail}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
          {warnings.length && !blocked ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={override}
                onChange={(e) => setOverride(e.target.checked)}
              />
              Publish anyway ({warnings.length} warning{warnings.length === 1 ? '' : 's'})
            </label>
          ) : null}
        </section>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Not yet
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={blocked || (warnings.length > 0 && !override) || !boot.endpoints.publish}
            onClick={() => void publish()}
          >
            Publish
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
