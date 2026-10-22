'use client';

import { Bot } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Notice } from '@/components/ui/feedback';
import type { ChatbotConfig } from '@/lib/booking/chatbot-config';

/**
 * The Booking tab's Chatbot subtab. The chatbot builder's panel goes here:
 *
 * TODO(integrator): replace this component's body with
 *   `return <ChatbotPanel initial={initial} canEdit={canEdit} />;`
 * importing `ChatbotPanel` from '@/components/booking/chatbot-panel' (it
 * saves through its own route, PATCH /api/booking/chatbot). Until then this
 * shows what is saved, read-only.
 */
export function ChatbotSlot({ initial, canEdit }: { initial: ChatbotConfig; canEdit: boolean }) {
  return (
    <div className="space-y-4" data-tour="booking-chatbot">
      <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius-panel)] border border-[var(--border)] p-4">
        <span
          aria-hidden="true"
          className="flex size-10 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[var(--accent)]"
        >
          <Bot className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Arwin on the booking page</p>
          <p className="text-sm text-[var(--fg-muted)]">
            Finds open times, answers from the list below, and takes a note. Costs nothing.
          </p>
        </div>
        <Badge tone={initial.enabled ? 'ok' : 'neutral'}>{initial.enabled ? 'On' : 'Off'}</Badge>
      </div>
      {initial.faqItems.length ? (
        <ul className="space-y-2">
          {initial.faqItems.map((item, i) => (
            <li key={i} className="rounded-md border border-[var(--border)] p-3 text-sm">
              {item.q ? <p className="font-medium">{item.q}</p> : null}
              <p className="whitespace-pre-line text-[var(--fg-muted)]">{item.a}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-[var(--fg-muted)]">No answers written yet.</p>
      )}
      <Notice>
        {canEdit
          ? 'Editing the chatbot arrives with its own panel here.'
          : 'Only an admin or the owner can change the chatbot.'}
      </Notice>
    </div>
  );
}
