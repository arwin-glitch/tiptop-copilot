'use client';

import * as React from 'react';
import Link from 'next/link';
import { Send } from 'lucide-react';
import { meetingPagePath, NOTES_API } from '@/lib/notes/api';
import {
  NOTES_LIMITS,
  type ChatScope,
  type NotesChatResponse,
  type ParticipantView,
  type RecipeView,
} from '@/lib/types/notes';
import { Button } from '@/components/ui/button';
import { Select, Textarea } from '@/components/ui/form';
import { cn } from '@/lib/util/cn';
import { notesCall } from './api-client';
import { domainOf, splitCitations, type AnswerPart } from './helpers';

const SCOPES: { value: ChatScope; label: string }[] = [
  { value: 'meeting', label: 'This meeting' },
  { value: 'person', label: 'This person' },
  { value: 'company', label: 'This company' },
  { value: 'all', label: 'All meetings' },
];

interface Message {
  id: number;
  role: 'you' | 'arwin';
  text: string;
  parts?: AnswerPart[];
  failed?: boolean;
}

export interface ChatPreset {
  scope: ChatScope;
  personEmail?: string | null;
  /** A recipe's prompt, put in the question box (not sent: Ask sends it). */
  question?: string;
  /** Bumped to apply the same preset twice. */
  nonce: number;
}

/**
 * Ask Arwin about this meeting, a person, a company or every meeting (D-076).
 * Answers cite the lines they rest on as "[12:31 Dana Reyes]", each a jump to
 * that moment. It reads meeting content as data: nothing it says is acted on
 * by itself. "/" offers the saved recipes.
 */
export function ChatPanel({
  meetingId,
  participants,
  recipes,
  preset,
  onJump,
}: {
  meetingId: string;
  participants: readonly ParticipantView[];
  recipes: readonly RecipeView[];
  preset: ChatPreset | null;
  onJump: (seq: number) => void;
}) {
  const people = participants.filter((p) => p.email && p.role !== 'self');
  const domains = [
    ...new Set(
      participants
        .filter((p) => p.isExternal)
        .map((p) => domainOf(p.email))
        .filter((d): d is string => Boolean(d)),
    ),
  ];
  const [scope, setScope] = React.useState<ChatScope>(preset?.scope ?? 'meeting');
  const [personEmail, setPersonEmail] = React.useState<string>(
    preset?.personEmail ?? people[0]?.email ?? '',
  );
  const [company, setCompany] = React.useState<string>(domains[0] ?? '');
  const [question, setQuestion] = React.useState('');
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [asking, setAsking] = React.useState(false);
  const counter = React.useRef(0);
  const questionId = React.useId();
  const personId = React.useId();
  const companyId = React.useId();

  // "Chat about this person" from the People tab.
  const [appliedNonce, setAppliedNonce] = React.useState<number | null>(null);
  if (preset && preset.nonce !== appliedNonce) {
    setAppliedNonce(preset.nonce);
    setScope(preset.scope);
    if (preset.personEmail) setPersonEmail(preset.personEmail);
    if (preset.question) setQuestion(preset.question);
  }

  const recipeMatches = question.startsWith('/')
    ? recipes.filter((r) => r.name.toLowerCase().includes(question.slice(1).toLowerCase()))
    : [];

  const ask = async () => {
    const text = question.trim();
    if (!text || asking) return;
    if (scope === 'person' && !personEmail) return;
    if (scope === 'company' && !company) return;
    setAsking(true);
    setQuestion('');
    const mine: Message = { id: counter.current++, role: 'you', text };
    setMessages((m) => [...m, mine]);
    const res = await notesCall<Omit<NotesChatResponse, 'ok'>>('POST', NOTES_API.chat(meetingId), {
      scope,
      question: text,
      personEmail: scope === 'person' ? personEmail : null,
      companyDomain: scope === 'company' ? company : null,
    });
    setMessages((m) => [
      ...m,
      res.ok
        ? {
            id: counter.current++,
            role: 'arwin',
            text: res.answer,
            parts: splitCitations(res.answer, res.citations),
          }
        : { id: counter.current++, role: 'arwin', text: res.message, failed: true },
    ]);
    setAsking(false);
  };

  return (
    <section aria-label="Ask Arwin about meetings" className="flex flex-col gap-3" data-chat="">
      <div role="radiogroup" aria-label="Ask about" className="flex flex-wrap gap-1.5">
        {SCOPES.map((s) => {
          const disabled =
            (s.value === 'person' && people.length === 0) ||
            (s.value === 'company' && domains.length === 0);
          return (
            <button
              key={s.value}
              type="button"
              role="radio"
              aria-checked={scope === s.value}
              disabled={disabled}
              onClick={() => setScope(s.value)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:opacity-40',
                scope === s.value
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--fg)]'
                  : 'border-[var(--border)] text-[var(--fg-muted)] hover:text-[var(--fg)]',
              )}
            >
              {s.label}
            </button>
          );
        })}
      </div>
      {scope === 'person' ? (
        <div className="flex items-center gap-2">
          <label htmlFor={personId} className="text-xs text-[var(--fg-muted)]">
            Person
          </label>
          <Select
            id={personId}
            value={personEmail}
            onChange={(e) => setPersonEmail(e.target.value)}
            className="h-8 max-w-xs text-[13px]"
          >
            {people.map((p) => (
              <option key={p.email} value={p.email ?? ''}>
                {p.name ?? p.email}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
      {scope === 'company' ? (
        <div className="flex items-center gap-2">
          <label htmlFor={companyId} className="text-xs text-[var(--fg-muted)]">
            Company
          </label>
          <Select
            id={companyId}
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            className="h-8 max-w-xs text-[13px]"
          >
            {domains.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Select>
        </div>
      ) : null}

      <ol className="space-y-3" aria-live="polite">
        {messages.length === 0 ? (
          <li className="rounded-md border border-dashed border-[var(--border-strong)] px-3 py-4 text-sm text-[var(--fg-muted)]">
            Ask about what was said: the round, a number, who promised what. Answers point at the
            lines they come from.
          </li>
        ) : null}
        {messages.map((m) => (
          <li
            key={m.id}
            className={cn(
              'max-w-[90%] rounded-2xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap',
              m.role === 'you'
                ? 'ml-auto rounded-br-md bg-[var(--bg-sunken)]'
                : m.failed
                  ? 'rounded-bl-md bg-[var(--danger-soft)] text-[var(--danger)]'
                  : 'rounded-bl-md border border-[var(--border)] bg-[var(--bg-raised)]',
            )}
            data-chat-message={m.role}
          >
            {m.role === 'arwin' ? (
              <span className="text-micro mb-0.5 block font-semibold tracking-wider text-[var(--label-gold)] uppercase">
                Arwin
              </span>
            ) : null}
            {m.parts
              ? m.parts.map((part, i) =>
                  part.kind === 'text' ? (
                    <React.Fragment key={i}>{part.text}</React.Fragment>
                  ) : part.citation.meetingId === meetingId ? (
                    <button
                      key={i}
                      type="button"
                      onClick={() => onJump(part.citation.seq)}
                      className="link-inline font-medium"
                      data-citation=""
                    >
                      {part.citation.label}
                    </button>
                  ) : (
                    <Link
                      key={i}
                      href={meetingPagePath(part.citation.meetingId, part.citation.startMs)}
                      className="link-inline font-medium"
                      data-citation=""
                    >
                      {part.citation.label}
                    </Link>
                  ),
                )
              : m.text}
          </li>
        ))}
      </ol>

      <form
        className="relative"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <label htmlFor={questionId} className="sr-only">
          Your question
        </label>
        <Textarea
          id={questionId}
          value={question}
          maxLength={NOTES_LIMITS.maxChatQuestionChars}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void ask();
            }
          }}
          placeholder="Ask Arwin… (type / for a saved recipe)"
          className="min-h-20 pr-12"
        />
        <Button
          type="submit"
          size="icon"
          variant="primary"
          aria-label="Ask"
          loading={asking}
          disabled={!question.trim() || asking}
          className="absolute right-2 bottom-2 size-8"
        >
          {asking ? null : <Send aria-hidden />}
        </Button>
        {recipeMatches.length > 0 ? (
          <ul
            aria-label="Recipes"
            className="shadow-overlay absolute bottom-full left-0 z-10 mb-1 max-h-48 w-full overflow-y-auto rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-raised)] p-1"
          >
            {recipeMatches.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setQuestion(r.prompt)}
                  className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-[var(--bg-hover)]"
                >
                  <span className="font-medium">{r.name}</span>
                  <span className="block truncate text-xs text-[var(--fg-muted)]">{r.prompt}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </form>
    </section>
  );
}
