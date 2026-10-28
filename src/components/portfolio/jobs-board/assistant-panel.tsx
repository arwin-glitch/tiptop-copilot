'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { Bot, Plus, Trash2 } from 'lucide-react';
import { readJobsAssistantAction, saveJobsAssistantAction } from '@/app/actions/jobs-assistant';
import { AiTag } from '@/components/ask/ai-tag';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from '@/components/ui/dialog';
import { Field, Input, Switch, Textarea } from '@/components/ui/form';
import { FAQ_LIMITS, type FaqItem } from '@/lib/booking/chatbot-config';
import {
  DEFAULT_JOBS_FAQ,
  JOBS_DAILY_AI_CAP_MAX,
  type JobsAssistantConfig,
} from '@/lib/jobs-board/assistant-config';
import type { JobsAssistantPanel } from '@/lib/services/jobs-chat';

/**
 * Portfolio > Jobs > Ask Arwin: the public board assistant's settings. On or
 * off, the written answers it gives word for word (after what the board's own
 * roles answer), and whether a question nothing else answers may go to the
 * jobs assistant routine on Arwin's Claude plan (no API key; it needs the
 * routine set up first, docs/JOBS_CHAT_ROUTINE.md). Loaded when opened.
 */

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? 'recently'
    : d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
}

export function JobsAssistantButton() {
  const [open, setOpen] = React.useState(false);
  const [panel, setPanel] = React.useState<JobsAssistantPanel | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<JobsAssistantConfig | null>(null);
  const [pending, start] = React.useTransition();
  const uid = React.useId();

  React.useEffect(() => {
    if (!open) return;
    let live = true;
    void readJobsAssistantAction().then((result) => {
      if (!live) return;
      if (result.ok && result.data) {
        setPanel(result.data);
        setDraft(result.data.config);
      } else {
        setProblem(result.error?.message ?? 'Ask Arwin settings could not be loaded.');
      }
    });
    return () => {
      live = false;
    };
  }, [open]);

  const set = (patch: Partial<JobsAssistantConfig>) =>
    setDraft((d) => (d ? { ...d, ...patch } : d));
  const setItem = (index: number, patch: Partial<FaqItem>) =>
    set({
      faqItems: (draft?.faqItems ?? []).map((item, i) =>
        i === index ? { ...item, ...patch } : item,
      ),
    });

  const status = panel?.status;
  const editable = panel?.editable ?? false;
  const statusLine = !status
    ? 'Checking…'
    : !status.tableReady
      ? `AI answers need their table: run ${panel?.migration}.`
      : !status.configured
        ? 'AI answers are not set up yet: they need the jobs assistant routine.'
        : status.lastAnswerAt
          ? `Working. Last answer ${when(status.lastAnswerAt)}; ${status.askedToday} asked today.`
          : 'Set up. No answers yet.';

  const save = () => {
    if (!draft) return;
    const faqItems = draft.faqItems
      .map((item) => ({ q: item.q.trim(), a: item.a.trim() }))
      .filter((item) => item.q || item.a);
    start(async () => {
      const result = await saveJobsAssistantAction({ ...draft, faqItems });
      if (result.ok && result.data) {
        setDraft(result.data);
        toast.success('Ask Arwin saved');
        setOpen(false);
      } else {
        toast.error(result.error?.message ?? 'Ask Arwin was not saved. Nothing was changed.');
      }
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setProblem(null);
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost">
          <Bot aria-hidden="true" />
          Ask Arwin
        </Button>
      </DialogTrigger>
      <DialogContent
        title="Ask Arwin on the board"
        description="A chat on every public board page. It answers from the published roles first, then from the answers below."
      >
        {problem ? <p className="text-sm text-[var(--danger)]">{problem}</p> : null}
        {!draft ? (
          problem ? null : (
            <p className="text-sm text-[var(--fg-muted)]">Loading…</p>
          )
        ) : (
          <div className="space-y-5 overflow-y-auto">
            {!editable && panel ? (
              <p className="rounded-md border border-[var(--warn)] p-2 text-sm">
                Editing needs one more database change: run {panel.migration} in the Supabase SQL
                editor. Until then Arwin uses the answers shown here.
              </p>
            ) : null}
            <label className="flex items-center justify-between gap-3 text-sm font-medium">
              Show Ask Arwin on the public board
              <Switch
                checked={draft.enabled}
                disabled={!editable || pending}
                onCheckedChange={(v) => set({ enabled: v })}
                aria-label="Show Ask Arwin on the public board"
              />
            </label>

            <fieldset className="space-y-3">
              <legend className="text-sm font-semibold">
                Written answers{' '}
                <span className="text-xs font-normal text-[var(--fg-subtle)]">
                  {draft.faqItems.length}/{FAQ_LIMITS.items}
                </span>
              </legend>
              <p className="text-xs text-[var(--fg-muted)]">
                Given word for word when a visitor asks something close. Only write what is true for
                every company on the board.
              </p>
              {draft.faqItems.map((item, i) => (
                <div key={i} className="space-y-2 rounded-md border border-[var(--border)] p-3">
                  <Field label="Question" htmlFor={`${uid}-q-${i}`}>
                    <Input
                      id={`${uid}-q-${i}`}
                      value={item.q}
                      maxLength={FAQ_LIMITS.question}
                      disabled={!editable || pending}
                      onChange={(e) => setItem(i, { q: e.target.value })}
                    />
                  </Field>
                  <Field label="Answer" htmlFor={`${uid}-a-${i}`}>
                    <Textarea
                      id={`${uid}-a-${i}`}
                      value={item.a}
                      maxLength={FAQ_LIMITS.answer}
                      disabled={!editable || pending}
                      onChange={(e) => setItem(i, { a: e.target.value })}
                    />
                  </Field>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!editable || pending}
                    onClick={() => set({ faqItems: draft.faqItems.filter((_, j) => j !== i) })}
                  >
                    <Trash2 aria-hidden="true" />
                    Remove
                  </Button>
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!editable || pending || draft.faqItems.length >= FAQ_LIMITS.items}
                  onClick={() => set({ faqItems: [...draft.faqItems, { q: '', a: '' }] })}
                >
                  <Plus aria-hidden="true" />
                  Add an answer
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!editable || pending}
                  onClick={() => set({ faqItems: [...DEFAULT_JOBS_FAQ] })}
                >
                  Restore the defaults
                </Button>
              </div>
            </fieldset>

            <fieldset className="space-y-3">
              <legend className="flex items-center gap-1.5 text-sm font-semibold">
                AI answers <AiTag />
              </legend>
              <p className="text-xs text-[var(--fg-muted)]">{statusLine}</p>
              <label className="flex items-center justify-between gap-3 text-sm">
                Answer other questions with AI (Arwin&rsquo;s Claude plan, no API key)
                <Switch
                  checked={draft.aiAnswers}
                  disabled={!editable || pending || !status?.configured}
                  onCheckedChange={(v) => set({ aiAnswers: v })}
                  aria-label="Answer other questions with AI"
                />
              </label>
              <Field
                label="AI questions a day, for the whole board"
                htmlFor={`${uid}-cap`}
                hint={`Each visitor also gets at most 3 per visit and 5 a day. Up to ${JOBS_DAILY_AI_CAP_MAX}.`}
              >
                <Input
                  id={`${uid}-cap`}
                  type="number"
                  min={0}
                  max={JOBS_DAILY_AI_CAP_MAX}
                  value={draft.dailyAiCap}
                  disabled={!editable || pending}
                  onChange={(e) =>
                    set({
                      dailyAiCap: Math.max(
                        0,
                        Math.min(JOBS_DAILY_AI_CAP_MAX, Math.floor(Number(e.target.value) || 0)),
                      ),
                    })
                  }
                />
              </Field>
            </fieldset>
          </div>
        )}
        <DialogFooter>
          <Button variant="primary" disabled={!draft || !editable || pending} onClick={save}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
