'use client';

import * as React from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { studioFetch } from '@/lib/events/editor/api';
import { Button } from '@/components/ui/button';

interface Preview {
  eventId: string;
  eventTitle: string;
  label: string;
  role: 'editor' | 'viewer' | 'checkin';
  scope: { design: boolean; content: boolean; sections: 'all' | string[]; brand_locked: boolean };
  sectionNames: string[];
  expiresAt: string;
  editingPaused: boolean;
}

type State =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'invalid'; message: string }
  | { kind: 'ready'; preview: Preview };

/**
 * /e/edit#k=<secret>: reads the secret from the fragment, removes it from
 * the address bar at once, and asks who the link is for (no side effects).
 * Only the explicit "Open editor" click claims it, so mail scanners and
 * link previews that fetch the page can never use it up or start a session.
 */
export function EditEntry() {
  const token = React.useRef<string | null>(null);
  const [state, setState] = React.useState<State>({ kind: 'loading' });
  const [confirmed, setConfirmed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const hash = window.location.hash.replace(/^#/, '');
    const secret = new URLSearchParams(hash).get('k');
    // The secret leaves the address bar (and history) before anything else.
    if (hash) window.history.replaceState(null, '', window.location.pathname);
    // Kept in memory only. A second run of this effect (development's
    // double mount) finds the fragment already gone and keeps the first.
    if (secret) token.current = secret;
    const value = token.current;
    let live = true;
    void (async () => {
      if (!value) {
        await Promise.resolve();
        if (live) setState({ kind: 'missing' });
        return;
      }
      const r = await studioFetch<{ preview: Preview }>('/api/e/edit/session', {
        method: 'POST',
        json: { token: value, claim: false },
      });
      if (!live) return;
      if (r.ok) setState({ kind: 'ready', preview: r.value.preview });
      else
        setState({
          kind: 'invalid',
          message:
            r.status === 429
              ? r.error.message
              : 'This link is not valid. It may have expired or been replaced. Ask TipTop for a new one.',
        });
    })();
    return () => {
      live = false;
    };
  }, []);

  async function open() {
    if (!token.current) return;
    setBusy(true);
    setError(null);
    const r = await studioFetch<{ location: string }>('/api/e/edit/session', {
      method: 'POST',
      json: { token: token.current, claim: true },
    });
    if (!r.ok) {
      setBusy(false);
      setError(
        r.status === 429 ? r.error.message : 'This link stopped working. Ask TipTop for a new one.',
      );
      return;
    }
    token.current = null;
    // A full load, so the editor gets its own page and cookie path.
    window.location.assign(r.value.location);
  }

  return (
    <main
      id="main"
      className="flex min-h-dvh items-center justify-center bg-[var(--bg)] px-4 py-10 text-[var(--fg)]"
    >
      <div className="shadow-raised w-full max-w-lg rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--bg-raised)] p-6">
        <p className="text-xs font-medium tracking-wide text-[var(--fg-muted)] uppercase">
          TipTop events
        </p>
        {state.kind === 'loading' ? (
          <p className="mt-4 flex items-center gap-2 text-sm text-[var(--fg-muted)]">
            <Loader2 aria-hidden="true" className="size-4 animate-spin" /> Checking your link…
          </p>
        ) : null}
        {state.kind === 'missing' ? (
          <>
            <h1 className="mt-2 font-serif text-2xl font-semibold">This link is incomplete</h1>
            <p className="mt-2 text-sm text-[var(--fg-muted)]">
              Open the full link from the message TipTop sent you. It ends with a long code after
              “#k=”.
            </p>
          </>
        ) : null}
        {state.kind === 'invalid' ? (
          <>
            <h1 className="mt-2 font-serif text-2xl font-semibold">This link is not valid</h1>
            <p className="mt-2 text-sm text-[var(--fg-muted)]">{state.message}</p>
          </>
        ) : null}
        {state.kind === 'ready' ? (
          <Invitation
            preview={state.preview}
            confirmed={confirmed}
            onConfirm={setConfirmed}
            busy={busy}
            error={error}
            onOpen={() => void open()}
          />
        ) : null}
      </div>
    </main>
  );
}

function Invitation({
  preview,
  confirmed,
  onConfirm,
  busy,
  error,
  onOpen,
}: {
  preview: Preview;
  confirmed: boolean;
  onConfirm: (v: boolean) => void;
  busy: boolean;
  error: string | null;
  onOpen: () => void;
}) {
  const viewer = preview.role === 'viewer';
  const can: string[] = [];
  if (viewer) can.push('See the unpublished page, on desktop and phone');
  else {
    const where =
      preview.scope.sections === 'all'
        ? 'every section'
        : `these sections: ${preview.sectionNames.join(', ') || 'the ones TipTop chose'}`;
    if (preview.scope.content) can.push(`Change the words, photos and lists in ${where}`);
    if (preview.scope.design)
      can.push(
        `Change the design: layouts, theme and effects${preview.scope.brand_locked ? ' (TipTop’s logo, colours, fonts and intro stay locked)' : ''}`,
      );
    if (preview.scope.sections === 'all') can.push('Add, reorder and remove sections');
    can.push('Tell TipTop when your changes are ready for review');
  }
  const cannot = [
    viewer ? 'Change anything' : 'Publish: changes go live only when TipTop publishes',
    'See the guest list, answers or anyone’s email',
    'Send messages or change the date, venue, capacity or link',
    'Open anything else in TipTop’s Kraken',
  ];
  const expires = new Date(preview.expiresAt).toLocaleDateString(undefined, {
    dateStyle: 'medium',
  });
  return (
    <>
      <h1 className="mt-2 font-serif text-2xl leading-snug font-semibold">
        You&apos;ve been invited to {viewer ? 'preview' : 'edit'} {preview.eventTitle} as{' '}
        {preview.label}
      </h1>
      {preview.editingPaused && !viewer ? (
        <p className="mt-3 rounded-md bg-[var(--warn-soft)] px-3 py-2 text-sm">
          Editing is paused right now. You can look around; changes wait until TipTop reopens it.
        </p>
      ) : null}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <section aria-label="You can">
          <h2 className="text-sm font-semibold">You can</h2>
          <ul className="mt-1 space-y-1 text-sm">
            {can.map((line) => (
              <li key={line} className="flex gap-1.5">
                <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[var(--ok)]" />
                {line}
              </li>
            ))}
          </ul>
        </section>
        <section aria-label="You can't">
          <h2 className="text-sm font-semibold">You can&apos;t</h2>
          <ul className="mt-1 space-y-1 text-sm">
            {cannot.map((line) => (
              <li key={line} className="flex gap-1.5">
                <X aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[var(--fg-muted)]" />
                {line}
              </li>
            ))}
          </ul>
        </section>
      </div>
      <p className="mt-4 text-xs text-[var(--fg-muted)]">
        This link is personal to you and works until {expires}. Please don&apos;t forward it.
      </p>
      <label className="mt-4 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={confirmed}
          onChange={(e) => onConfirm(e.target.checked)}
        />
        <span>Yes, I&apos;m {preview.label}</span>
      </label>
      {error ? <p className="mt-2 text-sm text-[var(--danger)]">{error}</p> : null}
      <Button
        className="mt-4 w-full"
        size="lg"
        variant="primary"
        disabled={!confirmed}
        loading={busy}
        onClick={onOpen}
      >
        {viewer ? 'Open preview' : 'Open editor'}
      </Button>
    </>
  );
}
