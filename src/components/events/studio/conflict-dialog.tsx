'use client';

import * as React from 'react';
import { fieldName } from '@/lib/events/editor/publish';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { useEditorRevision, useStudio } from './studio-context';

function show(value: unknown): string {
  if (value === null || value === undefined || value === '') return '(empty)';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 1).slice(0, 600);
  } catch {
    return String(value);
  }
}

/**
 * Per-section conflicts, one at a time: "Morgan changed Headline in Hero –
 * Keep mine / Use Morgan's / Compare side by side"; for a deleted section
 * "Alex deleted this section – Restore / Discard my change". Nothing is
 * overwritten until the person chooses.
 */
export function ConflictDialog() {
  const studio = useStudio();
  const { editor } = studio;
  useEditorRevision(editor);
  const item = editor.conflicts[0];
  const [compare, setCompare] = React.useState(false);
  if (!item) return null;
  const { conflict, pending } = item;
  const who = conflict.by?.name ?? 'Someone else';
  const first = who.split(/\s+/)[0] ?? who;
  const section =
    conflict.target === 'section'
      ? (pending.before.section ??
        studio.doc.sections.find((s) => s.id === conflict.sectionId) ??
        null)
      : null;
  const where =
    conflict.target === 'theme'
      ? 'the theme'
      : conflict.target === 'meta'
        ? 'the page settings'
        : section
          ? studio.labelOf(section)
          : 'a section';
  const fields = conflict.keys.map(fieldName).join(', ') || 'this';
  const mine: Record<string, unknown> =
    pending.op.kind === 'section.update' ||
    pending.op.kind === 'theme.update' ||
    pending.op.kind === 'page.update'
      ? (pending.op.set as Record<string, unknown>)
      : {};

  const close = () => setCompare(false);

  let title: string;
  let description: string;
  let keepLabel: string;
  let theirsLabel: string;
  if (conflict.kind === 'section_deleted') {
    title = `${who} deleted ${where}`;
    description = 'Your change was to a section that is no longer on the page.';
    keepLabel = 'Restore';
    theirsLabel = 'Discard my change';
  } else if (conflict.kind === 'section_changed') {
    title = `${who} changed ${where} since you last saw it`;
    description = 'You were deleting it. Their newer work is still there.';
    keepLabel = 'Delete anyway';
    theirsLabel = 'Keep the section';
  } else {
    title = `${who} changed ${fields} in ${where}`;
    description = 'You both edited the same thing. Choose which version to keep.';
    keepLabel = 'Keep mine';
    theirsLabel = `Use ${first}'s`;
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          editor.takeTheirs(item.id);
          close();
        }
      }}
    >
      <DialogContent title={title} description={description} className="max-w-xl">
        {compare && conflict.kind === 'key_changed' ? (
          <div className="grid gap-3 sm:grid-cols-2" aria-label="Side by side">
            <div>
              <h3 className="mb-1 text-xs font-semibold">Yours</h3>
              {conflict.keys.map((k) => (
                <pre
                  key={k}
                  className="mb-1 max-h-40 overflow-auto rounded-md bg-[var(--bg-sunken)] p-2 text-xs break-words whitespace-pre-wrap"
                >
                  {show(mine[k])}
                </pre>
              ))}
            </div>
            <div>
              <h3 className="mb-1 text-xs font-semibold">{first}&apos;s</h3>
              {conflict.keys.map((k) => (
                <pre
                  key={k}
                  className="mb-1 max-h-40 overflow-auto rounded-md bg-[var(--bg-sunken)] p-2 text-xs break-words whitespace-pre-wrap"
                >
                  {show(conflict.theirs[k])}
                </pre>
              ))}
            </div>
          </div>
        ) : null}
        <DialogFooter>
          {conflict.kind === 'key_changed' ? (
            <Button variant="ghost" onClick={() => setCompare((v) => !v)}>
              {compare ? 'Hide comparison' : 'Compare side by side'}
            </Button>
          ) : null}
          <Button
            variant="secondary"
            onClick={() => {
              editor.takeTheirs(item.id);
              close();
            }}
          >
            {theirsLabel}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              editor.keepMine(item.id);
              close();
            }}
          >
            {keepLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
