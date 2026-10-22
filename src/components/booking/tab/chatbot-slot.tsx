'use client';

import { ChatbotPanel } from '@/components/booking/chatbot-panel';
import type { ChatbotConfig } from '@/lib/booking/chatbot-config';

/**
 * The Booking tab's Chatbot subtab: the page assistant's own panel (on/off,
 * the written answers, "Test a question", optional answers from the routine
 * on Arwin's Claude plan). It saves through its own route,
 * PATCH /api/booking/chatbot, which merges only settings.chatbot, so the
 * tab's other panels never undo it. Free: no paid AI (D-078).
 */
export function ChatbotSlot({ initial, canEdit }: { initial: ChatbotConfig; canEdit: boolean }) {
  return (
    <div data-tour="booking-chatbot">
      <ChatbotPanel initial={initial} canEdit={canEdit} />
    </div>
  );
}
