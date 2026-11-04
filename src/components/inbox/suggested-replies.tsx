'use client';

import * as React from 'react';
import { Sparkles } from 'lucide-react';

/** Read once per conversation's newest message in this tab; the server caches too. */
const cache = new Map<string, string[]>();

/**
 * Gmail's suggested replies, by Kraken AI: three short chips under the last
 * message, asked for when the conversation opens and kept per newest
 * message. A chip only fills the reply box; nothing sends or saves. When
 * the AI is off or over budget the chips simply do not show.
 */
export function SuggestedReplies({
  threadId,
  lastMessageId,
  onPick,
}: {
  threadId: string;
  lastMessageId: string;
  onPick: (text: string) => void;
}) {
  const key = `${threadId}:${lastMessageId}`;
  const [replies, setReplies] = React.useState<string[] | null>(() => cache.get(key) ?? null);
  const [shownFor, setShownFor] = React.useState(key);
  if (shownFor !== key) {
    setShownFor(key);
    setReplies(cache.get(key) ?? null);
  }

  React.useEffect(() => {
    if (cache.has(key)) return;
    let live = true;
    fetch('/api/inbox/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'replies', threadId }),
    })
      .then(async (r) => (r.ok ? ((await r.json()) as { replies: string[] }).replies : []))
      .catch(() => [] as string[])
      .then((list) => {
        cache.set(key, list);
        if (live) setReplies(list);
      });
    return () => {
      live = false;
    };
  }, [key, threadId]);

  if (!replies?.length) return null;
  return (
    <div
      role="group"
      aria-label="Suggested replies"
      className="mb-3 flex flex-wrap items-center gap-2"
    >
      <Sparkles className="size-4 text-[var(--gold)]" aria-hidden />
      {replies.map((r) => (
        <button
          key={r}
          type="button"
          onClick={() => onPick(r)}
          className="inline-flex h-8 max-w-full items-center truncate rounded-full border border-[var(--accent)] px-3 text-sm text-[var(--accent)] hover:bg-[var(--accent-soft)]"
        >
          {r}
        </button>
      ))}
    </div>
  );
}
