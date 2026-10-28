'use client';

import * as React from 'react';
import Link from 'next/link';
import { ExternalLink, Loader2, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ThreadLinksForHref } from '@/components/email/thread-links';
import type {
  AffinityAtTarget,
  WarmPaths as WarmPathsResult,
  WarmPerson,
} from '@/lib/services/warm-paths';
import { relativeTime } from '@/lib/util/time';

type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; result: WarmPathsResult };

/**
 * "Who can intro?": on click, asks /api/fund-ii/warm-paths who Nick already
 * knows at this person's firm and who else shares emails with them. Pass one
 * of `email`, `thread` (with an optional `firm` hint) or `firm`. When the
 * thread does not make clear who the LP is, the people on it are offered to
 * look up instead. Renders inline, as plain text, below the button; place it
 * in a flex-wrap row.
 */
export function WarmPaths({
  email,
  thread,
  firm,
}: {
  email?: string | null;
  thread?: string | null;
  firm?: string | null;
}) {
  const [open, setOpen] = React.useState(false);
  const [state, setState] = React.useState<State>({ status: 'idle' });
  /** Someone picked from the thread's people, looked up by address instead. */
  const [picked, setPicked] = React.useState<string | null>(null);
  const panelId = React.useId();

  const search = React.useMemo(() => {
    const params = new URLSearchParams();
    if (picked) params.set('email', picked);
    else if (email) params.set('email', email);
    else if (thread) {
      params.set('thread', thread);
      if (firm) params.set('firm', firm);
    } else if (firm) params.set('firm', firm);
    return params.toString();
  }, [picked, email, thread, firm]);

  const load = React.useCallback(async (query: string) => {
    setState({ status: 'loading' });
    try {
      const res = await fetch(`/api/fund-ii/warm-paths?${query}`, { cache: 'no-store' });
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        result?: WarmPathsResult;
        error?: { message?: string };
      } | null;
      if (!res.ok || !json?.ok || !json.result) {
        setState({
          status: 'error',
          message: json?.error?.message ?? "Couldn't look that up. Try again.",
        });
        return;
      }
      setState({ status: 'done', result: json.result });
    } catch {
      setState({ status: 'error', message: "Couldn't reach the app. Try again." });
    }
  }, []);

  if (!search) return null;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && (state.status === 'idle' || state.status === 'error')) void load(search);
  };

  const pick = (address: string) => {
    setPicked(address);
    void load(new URLSearchParams({ email: address }).toString());
  };

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={panelId}
      >
        <Users aria-hidden />
        Who can intro?
      </Button>
      {open ? (
        <div
          id={panelId}
          aria-live="polite"
          className="w-full min-w-0 basis-full rounded-md border border-[var(--border)] bg-[var(--bg-sunken)] px-3 py-2.5 text-sm"
        >
          {state.status === 'loading' || state.status === 'idle' ? (
            <p className="flex items-center gap-2 text-[var(--fg-muted)]">
              <Loader2 className="size-4 animate-spin" aria-hidden /> Looking through your mail…
            </p>
          ) : state.status === 'error' ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[var(--danger)]">{state.message}</p>
              <Button size="sm" variant="secondary" onClick={() => void load(search)}>
                Try again
              </Button>
            </div>
          ) : (
            <Answer result={state.result} onPick={pick} />
          )}
        </div>
      ) : null}
    </>
  );
}

function Answer({ result, onPick }: { result: WarmPathsResult; onPick: (email: string) => void }) {
  if (result.state !== 'ok' || !result.target) {
    return (
      <div>
        <p>{result.message ?? 'Nothing to go on here.'}</p>
        {result.candidates.length > 0 ? (
          <p className="mt-1 text-xs break-words text-[var(--fg-muted)]">
            Seen in your mail: {result.candidates.join(', ')}
          </p>
        ) : null}
        {result.choices.length > 0 ? (
          <div className="mt-2">
            <p className="text-xs text-[var(--fg-muted)]">Look up someone on the thread instead:</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {result.choices.map((c) => (
                <Button
                  key={c.email}
                  size="sm"
                  variant="secondary"
                  onClick={() => onPick(c.email)}
                  title={c.email}
                >
                  {c.name ?? c.email}
                  {c.name ? <span className="sr-only"> ({c.email})</span> : null}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  const { target } = result;
  const atFirm = target.kind === 'domain';
  const who = atFirm ? `anyone at ${target.label}` : target.label;
  const affinity = (
    <InAffinity people={result.affinity ?? []} label={atFirm ? target.label : null} />
  );
  if (result.known.length === 0 && result.introducers.length === 0) {
    const skipped = result.groupThreadsSkipped;
    return (
      <div className="space-y-3">
        <p className="break-words">
          {skipped > 0
            ? `You haven't emailed with ${who} in the last 3 years, apart from ${skipped} large group ${plural(skipped, 'email')}.`
            : `You haven't emailed with ${who} in the last 3 years.`}
        </p>
        {affinity}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {affinity}
      {result.known.length === 0 ? (
        <p className="break-words">You haven&apos;t emailed with {who} directly.</p>
      ) : (
        <div>
          <p className="text-xs font-semibold tracking-wide text-[var(--fg-muted)] uppercase">
            {atFirm ? `You already know at ${target.label}` : `Your threads with ${target.label}`}
          </p>
          <ul className="mt-1 space-y-1.5">
            {result.known.map((p) => (
              <PersonLine key={p.email} person={p} withThem={false} />
            ))}
          </ul>
        </div>
      )}
      <div>
        <p className="text-xs font-semibold tracking-wide text-[var(--fg-muted)] uppercase">
          Could introduce you
        </p>
        {result.introducers.length === 0 ? (
          <p className="mt-1 text-[var(--fg-subtle)]">
            Nobody else outside TipTop was on those emails with them.
          </p>
        ) : (
          <ul className="mt-1 space-y-1.5">
            {result.introducers.map((p) => (
              <PersonLine key={p.email} person={p} withThem />
            ))}
          </ul>
        )}
      </div>
      <p className="text-xs text-[var(--fg-subtle)]">
        From {result.threadsSearched} {plural(result.threadsSearched, 'thread')} in the last 3
        years.
        {result.groupThreadsSkipped > 0
          ? ` Left out ${result.groupThreadsSkipped} large group ${plural(result.groupThreadsSkipped, 'email')}.`
          : ''}
      </p>
    </div>
  );
}

/** The people Affinity holds at the firm (or with the address), with their lists; nothing when none. */
function InAffinity({ people, label }: { people: AffinityAtTarget[]; label: string | null }) {
  if (people.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-semibold tracking-wide text-[var(--fg-muted)] uppercase">
        {label ? `In Affinity at ${label}` : 'In Affinity'}
      </p>
      <ul className="mt-1 space-y-1">
        {people.map((p) => (
          <li key={p.recordId} className="min-w-0 break-words">
            <Link
              href={`/lists/records/${p.recordId}`}
              className="font-medium underline-offset-2 hover:underline"
            >
              {p.name}
            </Link>
            {p.title ? <span className="text-[var(--fg-muted)]">, {p.title}</span> : null}
            {p.lists.length > 0 ? (
              <span className="text-xs text-[var(--fg-subtle)]"> · on {p.lists.join(', ')}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PersonLine({ person: p, withThem }: { person: WarmPerson; withThem: boolean }) {
  return (
    <li className="min-w-0">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium break-all">{p.name ?? p.email}</span>
        {p.name ? (
          <span className="text-xs break-all text-[var(--fg-subtle)]">{p.email}</span>
        ) : null}
        <span className="text-xs text-[var(--fg-muted)]">
          {p.threads} {plural(p.threads, 'thread')}
          {withThem ? ' with them' : ''}
          {p.lastAt ? ` · last ${relativeTime(p.lastAt)}` : ''}
        </span>
      </p>
      {/* Their newest shared thread, in Kraken's Inbox or in Gmail. */}
      {p.href ? (
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs">
          <span className="min-w-0 truncate text-[var(--fg-muted)]">{p.subject}</span>
          <ThreadLinksForHref
            href={p.href}
            label={p.subject || '(no subject)'}
            variant="text"
            fallback={
              <a
                href={p.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[var(--accent)] underline-offset-2 hover:underline"
              >
                Open <ExternalLink className="size-3 shrink-0" aria-hidden />
              </a>
            }
          />
        </p>
      ) : null}
    </li>
  );
}

const plural = (n: number, word: string) => (n === 1 ? word : `${word}s`);
