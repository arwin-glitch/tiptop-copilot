'use client';

import * as React from 'react';
import Link from 'next/link';
import { Check, ListPlus, Star } from 'lucide-react';
import type { ActionItem, SegmentView, SpeakerView } from '@/lib/types/notes';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SourcePopover } from './source-popover';

/**
 * The meeting's action items with their owners (from the resolved names,
 * never the transcript's spelling). "Add to Tasks" makes a task through the
 * tasks service: add-only, it goes to the principal, and nothing is sent.
 * The principal's own promises are flagged.
 */
export function ActionItemsCard({
  items,
  promiseLabel,
  segments,
  speakers,
  onAdd,
  onJump,
}: {
  items: readonly ActionItem[];
  /** "Your promise" for the recorder, "<name>'s promise" for anyone else. */
  promiseLabel: string;
  segments: readonly SegmentView[];
  speakers: readonly SpeakerView[];
  onAdd: (itemId: string) => Promise<boolean>;
  onJump: (seq: number) => void;
}) {
  const [adding, setAdding] = React.useState<string | null>(null);
  return (
    <Card data-action-items="">
      <CardHeader className="pb-2">
        <CardTitle as="h2">Action items</CardTitle>
        <Badge tone="outline">
          <span className="tabular">{items.length}</span>
        </Badge>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-[var(--fg-muted)]">
            No one promised anything that reads as an action item.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-start gap-x-3 gap-y-2 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm leading-relaxed">
                    {item.text}
                    <SourcePopover
                      ranges={item.sources}
                      segments={segments}
                      speakers={speakers}
                      onJump={onJump}
                      label={item.text.slice(0, 60)}
                    />
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-[var(--fg-muted)]">
                    <span>{item.ownerName ? `Owner: ${item.ownerName}` : 'No owner named'}</span>
                    {item.due ? <span>· Due {item.due}</span> : null}
                    {item.isPrincipalPromise ? (
                      <Badge tone="warn" className="gap-1">
                        <Star className="size-3" aria-hidden /> {promiseLabel}
                      </Badge>
                    ) : null}
                  </p>
                </div>
                {item.taskId ? (
                  <Button asChild size="sm" variant="ghost">
                    <Link href="/tasks">
                      <Check aria-hidden /> In Tasks
                    </Link>
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={adding === item.id}
                    disabled={adding !== null}
                    onClick={async () => {
                      setAdding(item.id);
                      await onAdd(item.id);
                      setAdding(null);
                    }}
                  >
                    <ListPlus aria-hidden /> Add to Tasks
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
