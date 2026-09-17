/** Types for the pure functions the test suite imports from the Slack poller. */

export interface SlackMessage {
  ts: string;
  text: string;
}

export interface PendingQuestion {
  message_id: string;
  thread_id: string;
  deal_id: string | null;
  question: string;
  created_at?: string;
}

export interface AnswerPayload {
  message_id: string;
  answer: string;
}

export function toQuestionPayload(message: SlackMessage): PendingQuestion | null;
export function toAnswerPayload(message: SlackMessage): AnswerPayload | null;
export function toQuestionMessageText(pending: PendingQuestion): string;
