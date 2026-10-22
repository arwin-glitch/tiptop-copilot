'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Select } from '@/components/ui/form';
import type { ImportTarget } from '@/lib/events/csv';
import type { RegistrationQuestion } from '@/lib/events/questions';
import type { ImportResult } from '@/lib/services/event-guests';
import { api, plural } from './guest-ui';

/**
 * CSV import (D-075): pick a file, see which column holds emails and what
 * each header maps to (names, company, title, phone, tags or one of the
 * registration questions), fix the mapping, see a preview with counts, then
 * add. Deduplicated on email; nothing is emailed.
 */

const FIXED_TARGETS: { value: ImportTarget; label: string }[] = [
  { value: 'ignore', label: 'Ignore' },
  { value: 'email', label: 'Email' },
  { value: 'first_name', label: 'First name' },
  { value: 'last_name', label: 'Last name' },
  { value: 'full_name', label: 'Full name' },
  { value: 'company', label: 'Company' },
  { value: 'title', label: 'Title' },
  { value: 'phone', label: 'Phone' },
  { value: 'tags', label: 'Tags' },
];

export function ImportDialog({
  eventId,
  sessions,
  questions,
  open,
  onOpenChange,
  onImported,
}: {
  eventId: string;
  sessions: { id: string; name: string }[];
  questions: RegistrationQuestion[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}) {
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [mapping, setMapping] = useState<Record<string, ImportTarget>>({});
  const [sessionIds, setSessionIds] = useState<string[]>(sessions.map((s) => s.id));
  const [status, setStatus] = useState<'invited' | 'going'>('invited');
  const [busy, setBusy] = useState(false);
  const targets = [
    ...FIXED_TARGETS,
    ...questions
      .filter((q) => !q.removed_at)
      .map((q) => ({ value: `question:${q.id}` as ImportTarget, label: `Question: ${q.label}` })),
  ];

  async function run(
    commit: boolean,
    text = csv,
    map: Record<string, ImportTarget> | undefined = preview ? mapping : undefined,
  ) {
    if (!text) return;
    setBusy(true);
    const res = await api<{ preview: ImportResult }>(`/api/events/${eventId}/guests/import`, {
      method: 'POST',
      body: { csv: text, mapping: map, sessionIds, tags: [], status, commit },
    });
    setBusy(false);
    if (!res.ok || !res.data) {
      toast.error(res.error?.message ?? 'That file could not be read.');
      return;
    }
    const p = res.data.preview;
    setPreview(p);
    setMapping(p.mapping);
    if (commit && p.committed) {
      toast.success(
        `Imported ${plural(p.committed.added.length, 'guest')}${p.committed.merged.length ? ` · ${p.committed.merged.length} already on the list` : ''}`,
      );
      onImported();
      onOpenChange(false);
      setCsv(null);
      setPreview(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Import guests from CSV"
        description="Any column holding emails is found for you. Nothing is emailed."
      >
        <div className="space-y-4" data-import-guests>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">CSV file</span>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (file.size > 1_000_000) {
                  toast.error('That file is over 1 MB. Split it and import in parts.');
                  return;
                }
                const text = await file.text();
                setCsv(text);
                setFileName(file.name);
                setPreview(null);
                await run(false, text, undefined);
              }}
            />
          </label>
          {preview ? (
            <>
              <p className="text-sm">
                {fileName}: {plural(preview.people, 'person', 'people')}
                {preview.existing ? ` · ${preview.existing} already on the list` : ''}
                {preview.duplicateInFile ? ` · ${preview.duplicateInFile} repeated` : ''}
                {preview.invalidLines.length
                  ? ` · ${preview.invalidLines.length} without a valid email (rows ${preview.invalidLines.slice(0, 5).join(', ')}${preview.invalidLines.length > 5 ? '…' : ''})`
                  : ''}
              </p>
              <div className="space-y-2">
                <p className="text-sm font-medium">Columns</p>
                {preview.headers.map((h) => (
                  <div key={h} className="grid grid-cols-2 items-center gap-2 text-sm">
                    <span className="truncate" title={h}>
                      {h}
                    </span>
                    <Select
                      aria-label={`Map ${h}`}
                      value={mapping[h] ?? 'ignore'}
                      onChange={(e) =>
                        setMapping({ ...mapping, [h]: e.target.value as ImportTarget })
                      }
                    >
                      {targets.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                ))}
                <Button size="sm" disabled={busy} onClick={() => run(false)}>
                  Update preview
                </Button>
              </div>
              {preview.sample.length ? (
                <ul className="space-y-1 rounded-md border border-[var(--border)] p-2 text-sm">
                  {preview.sample.map((s) => (
                    <li key={s.email}>
                      {s.name || '—'} <span className="text-[var(--fg-muted)]">{s.email}</span>
                      {s.company ? ` · ${s.company}` : ''}
                      {s.tags.length ? ` · ${s.tags.join(', ')}` : ''}
                    </li>
                  ))}
                </ul>
              ) : null}
              <fieldset className="space-y-1.5">
                <legend className="text-sm font-medium">Sessions</legend>
                <div className="flex flex-wrap gap-3">
                  {sessions.map((s) => (
                    <label key={s.id} className="flex items-center gap-1.5 text-sm">
                      <input
                        type="checkbox"
                        checked={sessionIds.includes(s.id)}
                        onChange={() =>
                          setSessionIds(
                            sessionIds.includes(s.id)
                              ? sessionIds.filter((x) => x !== s.id)
                              : [...sessionIds, s.id],
                          )
                        }
                      />
                      {s.name}
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="block text-sm">
                <span className="mb-1 block font-medium">Add them as</span>
                <Select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as 'invited' | 'going')}
                >
                  <option value="invited">Invited</option>
                  <option value="going">Going, directly (skips approval and capacity)</option>
                </Select>
              </label>
            </>
          ) : null}
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!preview || !preview.people || busy || !sessionIds.length}
            loading={busy}
            onClick={() => run(true)}
          >
            {preview ? `Import ${plural(preview.people, 'person', 'people')}` : 'Import'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
