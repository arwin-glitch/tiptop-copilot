/** Types for the pure functions the test suite imports from the Slack poller. */

export interface SlackMessage {
  ts: string;
  text: string;
  bot_profile?: { name?: string };
  username?: string;
}

export interface SlackPayload {
  external_id: string;
  title: string;
  occurred_at: string;
  attendee_emails: string;
  attendee_names: string;
  content: string;
  source_url?: string;
}

export function unescapeSlackText(text: string): string;
export function isBlockedUnfurl(text: string): boolean;
export function isGranolaMessage(message: unknown): boolean;
export function toPayload(message: SlackMessage): SlackPayload | null;
