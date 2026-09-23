import {
  countSectionHeadings,
  FORMAT_R_RE,
  FORMAT_S_RE,
  FORMAT_T_RE,
  type DealflowFormat,
} from '@/lib/updates/dealflow';
import { decodeEntities, stripFooters, unwrapEmphasis } from '@/lib/updates/mrkdwn';
import type { SlackMessage } from '@/lib/updates/types';

/**
 * Which kind of post a Slack message is — by its structure only. The routines
 * post through the Claude connector as a human member's own account, so
 * neither the author nor `bot_id` tells a report from a person's message.
 */

export const SYSTEM_SUBTYPES = new Set([
  'channel_join',
  'channel_leave',
  'channel_purpose',
  'channel_topic',
  'channel_name',
  'channel_archive',
  'bot_add',
  'bot_remove',
  'thread_broadcast',
  'pinned_item',
]);

const SYSTEM_TEXT_RES = [
  /^<@U\w+(\|[^>]*)?> has joined the channel$/,
  /^set the channel (description|purpose|topic):/,
  /^added an integration to this channel:/,
];

export const ROSTER_RE = /^(?::clipboard:|📋)\s*\*ROSTER v(\d+)\*/;
export const DIGEST_RUN_RE =
  /^(?::mailbox_with_mail:|📬)\s*(.+?)\s+digest\s+[—–-]\s+(.+?)(?:\s+[—–-]\s+(.+))?$/i;
export const REPOST_RE = /^REPOST \(reason: (.+?)\)/;

export function isSystemMessage(msg: Pick<SlackMessage, 'ts' | 'subtype' | 'thread_ts' | 'text'>) {
  if (msg.subtype && SYSTEM_SUBTYPES.has(msg.subtype)) return true;
  if (msg.thread_ts && msg.thread_ts !== msg.ts) return true;
  const text = (msg.text ?? '').trim();
  return SYSTEM_TEXT_RES.some((re) => re.test(text));
}

/**
 * A system notice inside a thread. A broadcast reply is still a real reply —
 * it is only a duplicate at the top level.
 */
export function isSystemReply(subtype: string | undefined): boolean {
  return Boolean(subtype && subtype !== 'thread_broadcast' && SYSTEM_SUBTYPES.has(subtype));
}

/**
 * The first non-empty line, emphasis wrapping removed, entities decoded, and
 * cut to a title's length so the header patterns never scan a huge line.
 */
export function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  return decodeEntities(unwrapEmphasis(line.trim())).slice(0, 500);
}

export type TopLevelClass =
  | { kind: 'hidden'; reason: 'system' | 'human' | 'empty' }
  | { kind: 'roster'; version: number }
  | { kind: 'digest'; repost: boolean }
  | { kind: 'dealflow'; format: DealflowFormat }
  | { kind: 'other'; fileOnly: boolean };

export function classifyTopLevel(msg: SlackMessage): TopLevelClass {
  if (isSystemMessage(msg)) return { kind: 'hidden', reason: 'system' };

  const { text: cleaned, hadFooter } = stripFooters(msg.text ?? '');
  const first = firstLine(cleaned);

  const roster = ROSTER_RE.exec(first);
  if (roster) return { kind: 'roster', version: Number(roster[1]) };
  if (DIGEST_RUN_RE.test(first)) return { kind: 'digest', repost: false };
  if (REPOST_RE.test(first)) return { kind: 'digest', repost: true };

  if (FORMAT_T_RE.test(first)) return { kind: 'dealflow', format: 'T' };
  if (FORMAT_S_RE.test(first)) return { kind: 'dealflow', format: 'S' };
  if (FORMAT_R_RE.test(first)) return { kind: 'dealflow', format: 'R' };
  if (countSectionHeadings(cleaned) >= 2) return { kind: 'dealflow', format: 'G' };

  if (!cleaned.trim()) {
    return msg.files && msg.files.length > 0
      ? { kind: 'other', fileOnly: true }
      : { kind: 'hidden', reason: 'empty' };
  }

  const bullets = cleaned.split('\n').filter((l) => /^\s*(?:[•◦]|-\s)/.test(l)).length;
  if (cleaned.trim().length >= 400 || hadFooter || bullets >= 3) {
    return { kind: 'other', fileOnly: false };
  }
  return { kind: 'hidden', reason: 'human' };
}

export type DigestReplyClass =
  'skip' | 'appendix' | 'housekeeping' | 'items' | 'repost' | 'correction' | 'note';

export function classifyDigestReply(text: string, subtype?: string): DigestReplyClass {
  if (isSystemReply(subtype)) return 'skip';
  const t = stripFooters(text).text.trim();
  if (!t) return 'skip';
  const first = (t.split('\n')[0] ?? '').trim();
  if (/^\*ROSTER v(\d+) [—–-] appendix\*/.test(first)) return 'appendix';
  if (/^─{10,}/.test(first)) return 'housekeeping';
  if (/^── /m.test(t)) return 'items';
  if (/^REPOST \(reason:/.test(first)) return 'repost';
  if (/^(stop including|add)\s+\S/i.test(t) && t.length < 400) return 'correction';
  return 'note';
}
