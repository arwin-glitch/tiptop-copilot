'use client';

import * as React from 'react';
import { toast } from 'sonner';
import {
  ArrowDown,
  ArrowUp,
  Bot,
  CheckCircle2,
  CircleDashed,
  MessageSquareText,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { AiTag } from '@/components/ask/ai-tag';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/feedback';
import { Input, Label, Switch, Textarea } from '@/components/ui/form';
import type { ChatbotPanelData } from '@/lib/booking/chat';
import {
  DAILY_AI_CAP_MAX,
  FAQ_LIMITS,
  type ChatbotConfig,
  type FaqItem,
} from '@/lib/booking/chatbot-config';
import { builtInEntries, faqEntries, matchFaq, type PublicFacts } from '@/lib/booking/faq';
import { cn } from '@/lib/util/cn';

/**
 * The Booking tab's assistant panel (D-078): whether "Arwin" shows on the
 * booking page, the questions and answers it gives word for word (add, edit,
 * reorder, delete, and a "Test a question" box that shows which answer a
 * visitor's words would get, run on the unsaved list), and the optional AI
 * answers on Arwin's own Claude plan with their daily cap and whether the
 * booking assistant routine is set up. Saves through PATCH
 * /api/booking/chatbot, which merges into the link's settings as `chatbot`.
 */

export interface ChatbotPanelProps {
  initial: ChatbotConfig;
  canEdit: boolean;
}

type Tab = 'answers' | 'ai';

interface Row extends FaqItem {
  key: string;
}

let rowSeq = 0;
const rowKey = () => `r${++rowSeq}`;
const toRows = (items: readonly FaqItem[]): Row[] => items.map((i) => ({ ...i, key: rowKey() }));

const NO_FACTS: PublicFacts = {
  hostName: '',
  hostFirst: '',
  title: '',
  bio: '',
  firmName: '',
  offersCall: true,
  inPersonKinds: [],
  places: [],
  allowCustomPlace: false,
  guestsAllowed: true,
  maxGuests: 5,
};

function when(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function ChatbotPanel({ initial, canEdit }: ChatbotPanelProps) {
  const [enabled, setEnabled] = React.useState(initial.enabled);
  const [rows, setRows] = React.useState<Row[]>(() => toRows(initial.faqItems));
  const [aiAnswers, setAiAnswers] = React.useState(initial.aiAnswers);
  const [dailyAiCap, setDailyAiCap] = React.useState(initial.dailyAiCap);
  const [tab, setTab] = React.useState<Tab>('answers');
  const [panel, setPanel] = React.useState<ChatbotPanelData | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [test, setTest] = React.useState('');
  const uid = React.useId();
  const disabled = !canEdit;

  React.useEffect(() => {
    let live = true;
    void fetch('/api/booking/chatbot')
      .then((r) => r.json())
      .then((json: { ok?: boolean; panel?: ChatbotPanelData }) => {
        if (live && json.ok && json.panel) setPanel(json.panel);
      })
      .catch(() => null);
    return () => {
      live = false;
    };
  }, []);

  const touch = () => {
    setDirty(true);
    setProblem(null);
  };
  const updateRow = (key: string, patch: Partial<FaqItem>) => {
    setRows((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    touch();
  };
  const move = (index: number, by: -1 | 1) => {
    setRows((list) => {
      const next = [...list];
      const target = index + by;
      if (target < 0 || target >= next.length) return list;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
    touch();
  };

  const filled = rows.filter((r) => r.q.trim() || r.a.trim());
  const facts = panel?.facts ?? NO_FACTS;
  const result = test.trim()
    ? matchFaq(test, [
        ...faqEntries(filled.map(({ q, a }) => ({ q, a }))),
        ...builtInEntries(facts),
      ])
    : null;

  const save = async () => {
    setProblem(null);
    const half = filled.find((r) => !r.q.trim() || !r.a.trim());
    if (half) {
      setProblem('Every question needs its answer (and every answer its question).');
      setTab('answers');
      return;
    }
    setSaving(true);
    const res = await fetch('/api/booking/chatbot', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled,
        faqItems: filled.map(({ q, a }) => ({ q: q.trim(), a: a.trim() })),
        aiAnswers,
        dailyAiCap,
      }),
    }).catch(() => null);
    setSaving(false);
    const json = (await res?.json().catch(() => null)) as {
      ok?: boolean;
      config?: ChatbotConfig;
      error?: { message?: string };
    } | null;
    if (!res?.ok || !json?.ok || !json.config) {
      setProblem(json?.error?.message ?? 'The assistant settings were not saved. Try again.');
      return;
    }
    setRows(toRows(json.config.faqItems));
    setEnabled(json.config.enabled);
    setAiAnswers(json.config.aiAnswers);
    setDailyAiCap(json.config.dailyAiCap);
    setDirty(false);
    toast.success('Assistant saved');
  };

  const status = panel?.status;
  const statusLine = !status
    ? { tone: 'muted' as const, text: 'Checking…' }
    : !status.tableReady
      ? {
          tone: 'warn' as const,
          text: 'Needs its table: run supabase/migrations/20261022200100_booking_chat.sql.',
        }
      : !status.configured
        ? { tone: 'muted' as const, text: 'Not set up yet - needs the booking assistant routine' }
        : status.lastAnswerAt
          ? { tone: 'ok' as const, text: `Working - last answer ${when(status.lastAnswerAt)}` }
          : { tone: 'ok' as const, text: 'Set up - no answers yet' };

  return (
    <section
      aria-labelledby={`${uid}-title`}
      data-tour="booking-assistant"
      className="space-y-4 rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--bg-raised)] p-4 sm:p-5"
    >
      <header className="flex flex-wrap items-start gap-3">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--jewel)] font-serif text-sm font-semibold text-[var(--jewel-fg)]"
        >
          A
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={`${uid}-title`} className="flex items-center gap-1.5 text-base font-semibold">
            Arwin on the booking page <AiTag />
          </h2>
          <p className="text-sm text-[var(--fg-muted)]">
            Books times, answers from your list, passes on messages. Free: no API key.
          </p>
        </div>
        <div className="flex items-center gap-2" data-tour="booking-assistant-on">
          <Label htmlFor={`${uid}-on`} className="text-sm">
            {enabled ? 'On' : 'Off'}
          </Label>
          <Switch
            id={`${uid}-on`}
            checked={enabled}
            disabled={disabled}
            onCheckedChange={(v) => {
              setEnabled(v);
              touch();
            }}
            aria-label="Show Arwin on the booking page"
          />
        </div>
      </header>

      <div
        role="tablist"
        aria-label="Assistant settings"
        data-tour="booking-ai"
        className="flex gap-1 border-b border-[var(--border)]"
      >
        <TabButton
          active={tab === 'answers'}
          onClick={() => setTab('answers')}
          id={`${uid}-tab-answers`}
          controls={`${uid}-answers`}
        >
          <MessageSquareText className="size-4" aria-hidden="true" />
          Answers
          <span className="text-xs text-[var(--fg-subtle)]">
            {filled.length}/{FAQ_LIMITS.items}
          </span>
        </TabButton>
        <TabButton
          active={tab === 'ai'}
          onClick={() => setTab('ai')}
          id={`${uid}-tab-ai`}
          controls={`${uid}-ai`}
        >
          <Bot className="size-4" aria-hidden="true" />
          AI answers
        </TabButton>
      </div>

      {tab === 'answers' ? (
        <div
          id={`${uid}-answers`}
          role="tabpanel"
          aria-labelledby={`${uid}-tab-answers`}
          className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]"
        >
          <div className="space-y-2.5" data-tour="booking-answers">
            {rows.length === 0 ? (
              <p className="rounded-md border border-dashed border-[var(--border-strong)] p-3 text-sm text-[var(--fg-muted)]">
                No answers yet. Add the questions founders ask most: stage, check size, how to
                pitch.
              </p>
            ) : null}
            <ol className="space-y-2.5">
              {rows.map((row, index) => (
                <li
                  key={row.key}
                  className="space-y-2 rounded-md border border-[var(--border)] bg-[var(--bg)] p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-xs font-semibold text-[var(--accent)]">
                      {index + 1}
                    </span>
                    {/* A phone gives the question its own full row under the number and buttons. */}
                    <div className="order-last basis-full sm:order-none sm:min-w-0 sm:flex-1 sm:basis-0">
                      <Label htmlFor={`${uid}-q-${row.key}`} className="sr-only">
                        Question {index + 1}
                      </Label>
                      <Input
                        id={`${uid}-q-${row.key}`}
                        value={row.q}
                        placeholder="Question, e.g. What stage do you invest in?"
                        maxLength={FAQ_LIMITS.question}
                        disabled={disabled}
                        onChange={(e) => updateRow(row.key, { q: e.target.value })}
                      />
                    </div>
                    <div className="ml-auto flex shrink-0">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Move question ${index + 1} up`}
                        disabled={disabled || index === 0}
                        onClick={() => move(index, -1)}
                      >
                        <ArrowUp aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Move question ${index + 1} down`}
                        disabled={disabled || index === rows.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        <ArrowDown aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete question ${index + 1}`}
                        disabled={disabled}
                        onClick={() => {
                          setRows((list) => list.filter((r) => r.key !== row.key));
                          touch();
                        }}
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                  <Label htmlFor={`${uid}-a-${row.key}`} className="sr-only">
                    Answer {index + 1}
                  </Label>
                  <Textarea
                    id={`${uid}-a-${row.key}`}
                    value={row.a}
                    placeholder="The answer, word for word. Public: nothing private."
                    maxLength={FAQ_LIMITS.answer}
                    disabled={disabled}
                    className="min-h-16"
                    onChange={(e) => updateRow(row.key, { a: e.target.value })}
                  />
                  <p className="text-right text-[11px] text-[var(--fg-subtle)]">
                    {row.a.length}/{FAQ_LIMITS.answer}
                  </p>
                </li>
              ))}
            </ol>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={disabled || rows.length >= FAQ_LIMITS.items}
              onClick={() => {
                setRows((list) => [...list, { q: '', a: '', key: rowKey() }]);
                touch();
              }}
            >
              <Plus aria-hidden="true" />
              Add a question
            </Button>
          </div>

          <aside
            className="space-y-2 rounded-md border border-[var(--border)] bg-[var(--note-soft)] p-3"
            aria-label="Test a question"
            data-tour="booking-test"
          >
            <Label htmlFor={`${uid}-test`} className="flex items-center gap-1.5">
              <Search className="size-4" aria-hidden="true" />
              Test a question
            </Label>
            <Input
              id={`${uid}-test`}
              value={test}
              maxLength={300}
              placeholder="Type what a founder might ask"
              onChange={(e) => setTest(e.target.value)}
            />
            {result ? (
              result.best ? (
                <div className="space-y-1 text-sm" data-testid="test-result">
                  <p className="flex items-center gap-1.5 font-medium">
                    <CheckCircle2 className="size-4 text-[var(--ok)]" aria-hidden="true" />
                    Answered by: {result.best.entry.q}
                  </p>
                  <p className="line-clamp-4 text-[var(--fg-muted)]">{result.best.entry.a}</p>
                  {result.best.entry.builtIn ? (
                    <p className="text-xs text-[var(--fg-subtle)]">Built from the public card.</p>
                  ) : null}
                </div>
              ) : (
                <div className="space-y-1 text-sm" data-testid="test-result">
                  <p className="flex items-center gap-1.5 font-medium">
                    <CircleDashed className="size-4 text-[var(--fg-subtle)]" aria-hidden="true" />
                    No answer matches
                  </p>
                  <p className="text-[var(--fg-muted)]">
                    {aiAnswers && status?.configured
                      ? 'It goes to AI answers (a minute or two).'
                      : 'The visitor is offered to leave it as a message.'}
                  </p>
                </div>
              )
            ) : (
              <p className="text-xs text-[var(--fg-muted)]">
                Shows which answer a visitor would get.
              </p>
            )}
            {result?.suggestions.length ? (
              <div className="space-y-1">
                <p className="text-xs text-[var(--fg-subtle)]">Also close:</p>
                <ul className="flex flex-wrap gap-1">
                  {result.suggestions.map((m) => (
                    <li key={m.entry.id}>
                      <span className="inline-block rounded-full border border-[var(--border)] bg-[var(--bg-raised)] px-2 py-0.5 text-[11px] text-[var(--fg-muted)]">
                        {m.entry.q}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </aside>
        </div>
      ) : (
        <div
          id={`${uid}-ai`}
          role="tabpanel"
          aria-labelledby={`${uid}-tab-ai`}
          className="space-y-3"
        >
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-[var(--border)] p-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Answer other questions with AI</p>
              <p className="text-sm text-[var(--fg-muted)]">
                Runs on your Claude plan: no API key, no bill. It sees only the public card, your
                answers and open times.
              </p>
            </div>
            <Switch
              checked={aiAnswers}
              disabled={disabled}
              onCheckedChange={(v) => {
                setAiAnswers(v);
                touch();
              }}
              aria-label="Answer other questions with AI"
            />
          </div>
          <p
            className={cn(
              'flex items-center gap-2 rounded-md px-3 py-2 text-sm',
              statusLine.tone === 'ok' && 'bg-[var(--accent-soft)]',
              statusLine.tone === 'warn' && 'bg-[var(--warn-soft)]',
              statusLine.tone === 'muted' && 'bg-[var(--bg)] text-[var(--fg-muted)]',
            )}
            data-testid="ai-status"
          >
            {statusLine.tone === 'ok' ? (
              <CheckCircle2 className="size-4 shrink-0 text-[var(--accent)]" aria-hidden="true" />
            ) : (
              <CircleDashed className="size-4 shrink-0" aria-hidden="true" />
            )}
            {statusLine.text}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-cap`}>AI answers a day, at most</Label>
              <Input
                id={`${uid}-cap`}
                type="number"
                inputMode="numeric"
                min={0}
                max={DAILY_AI_CAP_MAX}
                value={Number.isFinite(dailyAiCap) ? dailyAiCap : ''}
                disabled={disabled}
                onChange={(e) => {
                  const n = Math.round(Number(e.target.value));
                  setDailyAiCap(
                    Number.isFinite(n) ? Math.max(0, Math.min(DAILY_AI_CAP_MAX, n)) : 0,
                  );
                  touch();
                }}
              />
            </div>
            <div className="rounded-md bg-[var(--bg)] p-3 text-sm text-[var(--fg-muted)]">
              <p>
                Used today:{' '}
                <span className="font-medium text-[var(--fg)]">{status?.askedToday ?? 0}</span> of{' '}
                {dailyAiCap}
              </p>
              <p className="text-xs">Also: 3 per visitor, 5 per address a day.</p>
            </div>
          </div>
          <Notice tone="note">
            Past a cap, or while it is off, Arwin answers from your list and offers to take a
            message.
          </Notice>
        </div>
      )}

      {problem ? (
        <div role="alert">
          <Notice tone="warn">{problem}</Notice>
        </div>
      ) : null}
      {panel && !panel.saved && panel.available ? (
        <Notice tone="info">Save the booking link once first, then these can be saved.</Notice>
      ) : null}
      <div className="flex flex-wrap items-center gap-3 border-t border-[var(--border)] pt-4">
        <Button
          variant="primary"
          onClick={() => void save()}
          loading={saving}
          disabled={disabled || !dirty}
        >
          Save assistant
        </Button>
        {dirty ? <Badge tone="warn">Unsaved changes</Badge> : null}
        {!canEdit ? (
          <span className="text-xs text-[var(--fg-muted)]">
            Only an admin or the owner can change these.
          </span>
        ) : null}
      </div>
    </section>
  );
}

function TabButton({
  active,
  onClick,
  id,
  controls,
  children,
}: {
  active: boolean;
  onClick: () => void;
  id: string;
  controls: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={id}
      aria-selected={active}
      aria-controls={controls}
      onClick={onClick}
      className={cn(
        '-mb-px inline-flex min-h-10 items-center gap-1.5 border-b-2 px-3 text-sm font-medium',
        active
          ? 'border-[var(--primary)] text-[var(--fg)]'
          : 'border-transparent text-[var(--fg-muted)] hover:text-[var(--fg)]',
      )}
    >
      {children}
    </button>
  );
}
