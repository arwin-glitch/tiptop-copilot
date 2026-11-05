'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, EyeOff, Eye, Link2, Sparkles, Unlink, UserPlus, X } from 'lucide-react';
import {
  addSpaceTaskAction,
  answerSpaceInviteAction,
  askSpaceAction,
  createSpaceAction,
  disconnectSpaceGoogleAction,
  inviteSpaceMemberAction,
  removeSpaceMemberAction,
  setSpaceItemHiddenAction,
} from '@/app/actions/spaces';
import { updateTaskStatusAction } from '@/app/actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label, Select, Textarea } from '@/components/ui/form';
import { PlainText } from '@/components/ui/feedback';
import { cn } from '@/lib/util/cn';

/**
 * The small interactive pieces of the Spaces pages. Each calls one server
 * action and refreshes the page; none sends, labels or changes mail.
 */

function useAct() {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const run = (
    fn: () => Promise<{ ok: boolean; error?: { message: string } }>,
    after?: () => void,
  ) =>
    start(async () => {
      setError(null);
      const res = await fn();
      if (!res.ok) {
        setError(res.error?.message ?? 'That did not work.');
        return;
      }
      after?.();
      router.refresh();
    });
  return { pending, error, run, router };
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="mt-1 text-xs text-[var(--danger)]">
      {error}
    </p>
  ) : null;
}

/* ---------------------------------------------------- suggested Spaces -- */

export function MakeSuggestedSpace({ domain, name }: { domain: string; name: string }) {
  const { pending, error, run, router } = useAct();
  return (
    <div>
      <Button
        size="sm"
        variant="secondary"
        loading={pending}
        aria-label={`Make a Space for ${name}`}
        onClick={() =>
          run(async () => {
            const res = await createSpaceAction({
              name,
              domains: domain,
              sourceKind: 'suggested',
              sourceRef: domain,
            });
            if (res.ok && res.data) router.push(`/spaces/${res.data.id}`);
            return res;
          })
        }
      >
        Make Space
      </Button>
      <ErrorLine error={error} />
    </div>
  );
}

/* --------------------------------------------------------------- hide -- */

export function HideItemButton({
  spaceId,
  kind,
  id,
  label,
  hidden = false,
}: {
  spaceId: string;
  kind: 'email' | 'meeting' | 'note';
  id: string;
  label: string;
  hidden?: boolean;
}) {
  const { pending, error, run } = useAct();
  return (
    <span className="inline-flex flex-col items-end">
      <Button
        size="sm"
        variant="ghost"
        loading={pending}
        aria-label={`${hidden ? 'Show again' : 'Hide from Space'}: ${label}`}
        title={hidden ? 'Show it in the Space again' : 'Hide it from this Space, for everyone'}
        onClick={() => run(() => setSpaceItemHiddenAction(spaceId, { kind, id }, !hidden))}
      >
        {hidden ? <Eye aria-hidden="true" /> : <EyeOff aria-hidden="true" />}
        <span className="max-sm:sr-only">{hidden ? 'Show' : 'Hide'}</span>
      </Button>
      <ErrorLine error={error} />
    </span>
  );
}

/* ------------------------------------------------------------ invites -- */

export function InviteAnswer({ spaceId }: { spaceId: string }) {
  const { pending, error, run } = useAct();
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          size="sm"
          loading={pending}
          onClick={() => run(() => answerSpaceInviteAction(spaceId, 'accept'))}
        >
          <Check aria-hidden="true" />
          Accept invite
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={pending}
          onClick={() => run(() => answerSpaceInviteAction(spaceId, 'decline'))}
        >
          Decline
        </Button>
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

export type Contribution = 'main' | 'connected' | 'paused' | 'none';

export interface MemberRow {
  userId: string;
  name: string;
  email: string | null;
  role: 'owner' | 'member';
  status: 'invited' | 'accepted' | 'declined' | 'left';
  /**
   * What they contribute (D-081): the main mailbox; their own Google,
   * Connected or Paused (Google stopped answering: reconnect); or nothing yet.
   * Null for someone not in the Space (invited, declined, left).
   */
  contribution: Contribution | null;
  isMe: boolean;
}

const CONTRIBUTION: Record<
  Contribution,
  { label: string; tone: 'ok' | 'warn' | 'neutral' | 'accent'; title: string }
> = {
  main: {
    label: 'Main mailbox',
    tone: 'accent',
    title: 'The workspace mailbox: its matching mail and meetings are in the Space.',
  },
  connected: {
    label: 'Connected',
    tone: 'ok',
    title: 'Their own Google, read-only: only mail and meetings matching this Space come in.',
  },
  paused: {
    label: 'Paused',
    tone: 'warn',
    title: 'Google stopped answering for their connection. They can reconnect it.',
  },
  none: {
    label: 'Not connected',
    tone: 'neutral',
    title: 'They see everything in the Space; their own mail is not in it.',
  },
};

/** Where "Connect your Google to contribute" starts: Google's consent, read-only scopes only. */
export function memberConnectHref(spaceId?: string): string {
  return `/api/integrations/google/start?member=1${spaceId ? `&space=${spaceId}` : ''}`;
}

/** "Connect your Google to contribute": a link to Google's consent (read-only). */
export function ConnectSpaceGoogle({
  spaceId,
  label = 'Connect your Google to contribute',
  variant = 'primary',
}: {
  spaceId?: string;
  label?: string;
  variant?: 'primary' | 'secondary';
}) {
  return (
    <Button asChild size="sm" variant={variant}>
      <a href={memberConnectHref(spaceId)}>
        <Link2 aria-hidden="true" />
        {label}
      </a>
    </Button>
  );
}

/**
 * Disconnects your own Google for Spaces: revoked at Google, deleted here,
 * and your items leave every Space at once. Asks once before it does.
 */
export function DisconnectSpaceGoogle({ email }: { email?: string | null }) {
  const { pending, error, run } = useAct();
  const [sure, setSure] = React.useState(false);
  return (
    <span className="inline-flex flex-col items-start">
      {sure ? (
        <span className="inline-flex flex-wrap items-center gap-2">
          <span className="text-xs text-[var(--fg-muted)]">
            Disconnect {email ?? 'your Google'}? Your items leave every Space.
          </span>
          <Button
            size="sm"
            variant="danger"
            loading={pending}
            onClick={() =>
              run(
                () => disconnectSpaceGoogleAction(),
                () => setSure(false),
              )
            }
          >
            Disconnect
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSure(false)}>
            Cancel
          </Button>
        </span>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          aria-label="Disconnect your Google from Spaces"
          onClick={() => setSure(true)}
        >
          <Unlink aria-hidden="true" />
          Disconnect
        </Button>
      )}
      <ErrorLine error={error} />
    </span>
  );
}

export function MembersPanel({
  spaceId,
  members,
  invitable,
  canManage,
  canConnect = false,
}: {
  spaceId: string;
  members: MemberRow[];
  invitable: { userId: string; name: string }[];
  canManage: boolean;
  /** Member connections can be made here (Google is set up, not the demo, migration run). */
  canConnect?: boolean;
}) {
  const { pending, error, run } = useAct();
  const [chosen, setPick] = React.useState(invitable[0]?.userId ?? '');
  // After an invite the list shrinks: fall back to the first still invitable.
  const pick = invitable.some((p) => p.userId === chosen) ? chosen : (invitable[0]?.userId ?? '');
  return (
    <div className="space-y-4">
      {canManage ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (pick) run(() => inviteSpaceMemberAction(spaceId, pick));
          }}
        >
          <div className="min-w-48 flex-1 space-y-1.5 sm:flex-none">
            <Label htmlFor="space-invite">Invite a colleague</Label>
            <Select
              id="space-invite"
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              disabled={!invitable.length}
            >
              {invitable.length ? (
                invitable.map((p) => (
                  <option key={p.userId} value={p.userId}>
                    {p.name}
                  </option>
                ))
              ) : (
                <option value="">Everyone is in already</option>
              )}
            </Select>
          </div>
          <Button type="submit" size="md" variant="secondary" loading={pending} disabled={!pick}>
            <UserPlus aria-hidden="true" />
            Invite
          </Button>
        </form>
      ) : null}
      <ErrorLine error={error} />
      <ul className="divide-y divide-[var(--border)] rounded-[var(--radius-card)] border border-[var(--border)]">
        {members.map((m) => (
          <li key={m.userId} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {m.name}
                {m.isMe ? <span className="text-[var(--fg-muted)]"> (you)</span> : null}
              </p>
              <p className="text-xs text-[var(--fg-muted)]">
                {m.role === 'owner'
                  ? 'Owner'
                  : m.status === 'invited'
                    ? 'Invited, not answered yet'
                    : m.status === 'accepted'
                      ? 'Member'
                      : m.status === 'declined'
                        ? 'Declined'
                        : 'Left'}
              </p>
            </div>
            {m.contribution ? (
              <Badge
                tone={CONTRIBUTION[m.contribution].tone}
                title={CONTRIBUTION[m.contribution].title}
                data-testid="contribution"
              >
                {CONTRIBUTION[m.contribution].label}
              </Badge>
            ) : null}
            {m.isMe && m.contribution === 'paused' && canConnect ? (
              <ConnectSpaceGoogle spaceId={spaceId} label="Reconnect" variant="secondary" />
            ) : null}
            {m.isMe && (m.contribution === 'connected' || m.contribution === 'paused') ? (
              <DisconnectSpaceGoogle email={m.email} />
            ) : null}
            {m.role !== 'owner' &&
            (canManage || m.isMe) &&
            m.status !== 'declined' &&
            m.status !== 'left' ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                aria-label={m.isMe ? 'Leave this Space' : `Remove ${m.name}`}
                onClick={() => run(() => removeSpaceMemberAction(spaceId, m.userId))}
              >
                <X aria-hidden="true" />
                {m.isMe ? 'Leave' : 'Remove'}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------- action items -- */

export interface TaskRow {
  id: string;
  title: string;
  detail: string | null;
  dueAt: string | null;
  owner: string | null;
  done: boolean;
  suggested: boolean;
}

export interface SuggestionRow {
  id: string;
  title: string;
  owner: string | null;
  detail: string;
}

const dueLabel = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    : null;

export function ActionItems({
  spaceId,
  tasks,
  suggestions,
  people,
}: {
  spaceId: string;
  tasks: TaskRow[];
  suggestions: SuggestionRow[];
  people: { userId: string; name: string }[];
}) {
  const { pending, error, run } = useAct();
  const [title, setTitle] = React.useState('');
  const [due, setDue] = React.useState('');
  const [owner, setOwner] = React.useState('');

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    run(
      () =>
        addSpaceTaskAction(spaceId, {
          title,
          dueAt: due ? new Date(`${due}T17:00:00Z`).toISOString() : null,
          assignedTo: owner || null,
        }),
      () => {
        setTitle('');
        setDue('');
      },
    );
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
      <section aria-labelledby="space-items-heading" className="min-w-0">
        <h2 id="space-items-heading" className="font-serif text-base font-semibold">
          Action items
        </h2>
        <form onSubmit={add} className="mt-2 flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1 space-y-1">
            <Label htmlFor="space-task-title" className="sr-only">
              New action item
            </Label>
            <Input
              id="space-task-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Add an action item"
              maxLength={300}
            />
          </div>
          <Input
            type="date"
            aria-label="Due date"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            className="w-40"
          />
          <Select
            aria-label="Owner"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            className="w-40"
          >
            <option value="">Default owner</option>
            {people.map((p) => (
              <option key={p.userId} value={p.userId}>
                {p.name}
              </option>
            ))}
          </Select>
          <Button
            type="submit"
            variant="primary"
            size="md"
            loading={pending}
            disabled={!title.trim()}
          >
            Add
          </Button>
        </form>
        <ErrorLine error={error} />
        {tasks.length ? (
          <ul className="mt-3 divide-y divide-[var(--border)] rounded-[var(--radius-card)] border border-[var(--border)]">
            {tasks.map((t) => (
              <li key={t.id} className="flex items-start gap-3 px-3 py-2.5">
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-[var(--primary)]"
                  checked={t.done}
                  aria-label={`${t.done ? 'Reopen' : 'Mark done'}: ${t.title}`}
                  disabled={pending}
                  onChange={() =>
                    run(() => updateTaskStatusAction(t.id, t.done ? 'open' : 'complete'))
                  }
                />
                <div className="min-w-0 flex-1">
                  <p className={cn('text-sm', t.done && 'text-[var(--fg-muted)] line-through')}>
                    {t.title}
                  </p>
                  <p className="text-xs text-[var(--fg-muted)]">
                    {[
                      t.owner ? `Owner: ${t.owner}` : null,
                      dueLabel(t.dueAt) ? `Due ${dueLabel(t.dueAt)}` : 'No due date',
                      t.suggested ? 'Suggested' : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-[var(--fg-muted)]">
            No action items yet. Add one above, or add a suggestion.
          </p>
        )}
      </section>
      <section aria-labelledby="space-suggestions-heading" className="min-w-0">
        <h2
          id="space-suggestions-heading"
          className="flex items-center gap-1.5 font-serif text-base font-semibold"
        >
          <Sparkles className="size-4 text-[var(--gold)]" aria-hidden="true" />
          Suggested from emails and notes
        </h2>
        {suggestions.length ? (
          <ul className="mt-2 space-y-2">
            {suggestions.map((s) => (
              <li
                key={s.id}
                className="rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-2.5"
              >
                <p className="text-sm">{s.title}</p>
                <p className="mt-0.5 text-xs text-[var(--fg-muted)]">
                  {s.owner ? `For ${s.owner} · ` : null}
                  {s.detail.split(' · ')[0]}
                </p>
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={pending}
                    aria-label={`Add: ${s.title}`}
                    onClick={() =>
                      run(() =>
                        addSpaceTaskAction(spaceId, {
                          title: s.title,
                          detail: s.detail,
                          suggested: true,
                        }),
                      )
                    }
                  >
                    Add
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    aria-label={`Dismiss: ${s.title}`}
                    onClick={() =>
                      run(() =>
                        setSpaceItemHiddenAction(spaceId, { kind: 'suggestion', id: s.id }, true),
                      )
                    }
                  >
                    Dismiss
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-[var(--fg-muted)]">
            Nothing to suggest right now. New suggestions come from the Space&apos;s notes and the
            emails waiting on a reply.
          </p>
        )}
      </section>
    </div>
  );
}

/* ---------------------------------------------------------------- ask -- */

interface Answer {
  answer: string;
  sources: { kind: string; id: string; label: string; at: string }[];
  demo: boolean;
}

export function SpaceAsk({
  spaceId,
  mode = 'ask',
}: {
  spaceId: string;
  /** `summary`: one button for the Overview's short summary. */
  mode?: 'ask' | 'summary';
}) {
  const [question, setQuestion] = React.useState('');
  const [answer, setAnswer] = React.useState<Answer | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();

  const ask = (summary: boolean) =>
    start(async () => {
      setError(null);
      const res = await askSpaceAction(spaceId, summary ? '' : question, { summary });
      if (!res.ok || !res.data) {
        setError(res.error?.message ?? 'No answer came back.');
        return;
      }
      setAnswer(res.data);
    });

  return (
    <div className="space-y-3">
      {mode === 'summary' ? (
        <Button size="sm" variant="secondary" loading={pending} onClick={() => ask(true)}>
          <Sparkles aria-hidden="true" />
          {answer ? 'Summarise again' : 'Summarise this Space'}
        </Button>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (question.trim()) ask(false);
          }}
          className="space-y-2"
        >
          <Label htmlFor="space-question">Ask about this Space</Label>
          <Textarea
            id="space-question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="What is still open with them? Who owns the next step?"
            className="min-h-20"
            maxLength={500}
          />
          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={pending}
            disabled={!question.trim()}
          >
            Ask
          </Button>
        </form>
      )}
      {error ? (
        <p role="alert" className="text-sm text-[var(--danger)]">
          {error}
        </p>
      ) : null}
      {answer ? (
        <div
          className="rounded-[var(--radius-card)] border border-l-2 border-[var(--border)] border-l-[var(--gold)] bg-[var(--note-soft)] px-3 py-2.5"
          aria-live="polite"
        >
          <p className="text-micro mb-1 font-medium tracking-wider text-[var(--fg-subtle)] uppercase">
            Arwin{answer.demo ? ' · demo, no model used' : ' · AI'}
          </p>
          <PlainText text={answer.answer} className="text-sm" />
          {answer.sources.length ? (
            <p className="mt-2 text-xs text-[var(--fg-muted)]">
              From:{' '}
              {answer.sources
                .slice(0, 5)
                .map((s) => s.label)
                .join(' · ')}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
