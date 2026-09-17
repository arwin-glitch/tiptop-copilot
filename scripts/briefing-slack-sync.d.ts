/** Types for the pure function the test suite imports from the Slack poller. */

export interface SlackMessage {
  ts: string;
  text: string;
}

export interface BriefingPayload {
  kind: 'morning' | 'afternoon' | 'dossier';
  date_key: string;
  title: string;
  summary: string;
  source_url?: string;
}

export function toPayload(message: SlackMessage): BriefingPayload | null;
