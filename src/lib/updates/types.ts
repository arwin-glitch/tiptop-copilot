/**
 * The Updates tab's shapes. Pure types, shared by the parsers, the Slack
 * reader and the components — nothing here reads the environment.
 */

export type UpdateGroup = 'dealflow' | 'digest';
export type UpdateSourceIcon = 'rocket' | 'radar' | 'handshake' | 'mailbox';

export interface UpdateSource {
  /** URL-safe, used in `?source=`. */
  key: string;
  group: UpdateGroup;
  label: string;
  channelId: string;
  /** null: the name is never shown; the UI says "the <label> channel" and links by ID. */
  channelName: string | null;
  /** Display only, e.g. 'Weekly · Fri'. */
  cadence: string;
  /** Overdue threshold. */
  staleAfterDays: number;
  icon: UpdateSourceIcon;
}

/** The subset of a Slack message the tab reads. */
export interface SlackMessage {
  ts: string;
  text?: string;
  subtype?: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
  files?: unknown[];
  user?: string;
  bot_id?: string;
}

/** One inline run of text. `href` is only ever set by the whitelist. */
export interface Seg {
  text: string;
  bold?: true;
  italic?: true;
  code?: true;
  strike?: true;
  href?: string;
}

export type Block =
  | { type: 'para'; lines: Seg[][] }
  | { type: 'bullet'; depth: 0 | 1; segs: Seg[] }
  | { type: 'numbered'; n: number; segs: Seg[] }
  | { type: 'label'; segs: Seg[] };

export type SectionKey =
  'summary' | 'new' | 'updates' | 'actions' | 'deadlines' | 'risks' | 'whatsnew' | 'other';

export interface ReportSection {
  key: SectionKey;
  title: string;
  blocks: Block[];
  /** Items in it; for new deals and updates, null when the section cannot be counted. */
  count: number | null;
}

interface PostBase {
  ts: string;
  /** ISO, from ts. */
  postedAt: string;
  /** `${workspaceUrl}archives/${channelId}/p${ts without '.'}` */
  permalink: string | null;
  /** Parent < 10 min old: its thread may still be posting. */
  settling: boolean;
  /** Replies could not be read. */
  threadMissing: boolean;
}

export interface DealflowPost extends PostBase {
  type: 'dealflow';
  /** First line as posted (runtime content). */
  heading: string;
  windowLabel: string | null;
  /** Baseline:/Note: lines, shown muted. */
  meta: string[];
  flags: { baseline: boolean; incremental: boolean; confidential: boolean };
  /** 0 only when the report says "None"; null when the section is missing or uncountable. */
  counts: { newDeals: number | null; updates: number | null };
  /** Canonical order: summary, new, updates, actions, deadlines, risks, whatsnew, then other in posted order. */
  sections: ReportSection[];
  /** Thread replies that are not part of the report — people talking about it. */
  notes: Block[][];
}

export interface DigestItemGroup {
  /** '' for text that continues after a one-line status. */
  label: string;
  tone: 'default' | 'attention' | 'done';
  blocks: Block[];
}

export interface DigestItem {
  title: string;
  detail: string | null;
  cadence: string | null;
  newsletter: boolean;
  locked: boolean;
  lockNote: string | null;
  repost: string | null;
  /** From/Subject/Received, Period. */
  meta: string[];
  groups: DigestItemGroup[];
  /** From Link: lines, whitelisted. */
  links: { label: string; href: string }[];
  needsAttention: boolean;
}

export interface DigestNote {
  ts: string;
  correction: boolean;
  blocks: Block[];
}

export type DigestKind =
  'weekly' | 'month-start' | 'month-end' | 'supplemental' | 'catch-up' | 'repost' | 'other';

export interface DigestPost extends PostBase {
  type: 'digest';
  kind: DigestKind;
  kindLabel: string;
  dateLabel: string;
  covering: string | null;
  counts: { total: number; weekly: number; monthly: number } | null;
  provisional: boolean;
  empty: boolean;
  /** "Running on ROSTER vN." and the scope note, shown muted. */
  meta: string[];
  attention: Block[];
  /** The parent's other lines: run notes, warnings, flags. */
  lead: Block[];
  /** Sentences in `lead` that flag something (time-sensitive, flags, investors-only). */
  callouts: Block[];
  /** An open "Candidate series noticed" block: the routine is waiting on a decision. */
  asks: Block[];
  items: DigestItem[];
  housekeeping: Block[];
  notes: DigestNote[];
}

export interface RosterList {
  title: string;
  count: number | null;
  blocks: Block[];
}

export interface RosterPost extends PostBase {
  type: 'roster';
  version: number;
  confidential: boolean;
  lists: RosterList[];
  appendix: Block[];
}

export interface OtherPost extends PostBase {
  type: 'other';
  firstLine: string;
  blocks: Block[];
  fileOnly: boolean;
}

export type UpdatePost = DealflowPost | DigestPost | RosterPost | OtherPost;

export type UpdateAccess =
  | { state: 'ok' }
  | { state: 'no_token' }
  | { state: 'token_rejected'; code: string }
  | { state: 'missing_scope'; needed: string }
  | { state: 'not_invited'; code: 'channel_not_found' | 'not_in_channel' }
  | { state: 'rate_limited'; retryAfterSec: number }
  | { state: 'unreachable' }
  | { state: 'error'; code: string };

export interface UpdateSourceView {
  source: UpdateSource;
  access: UpdateAccess;
  posts: UpdatePost[];
  /** Newest routine post (dealflow report or digest run), never a human or other post. */
  lastPostAt: string | null;
  /** Access ok and lastPostAt older than staleAfterDays. */
  overdue: boolean;
  /** Serving the last good copy after a failure. */
  stale: { since: string } | null;
  /** `${workspaceUrl}archives/${channelId}` */
  channelUrl: string | null;
  checkedAt: string;
}

export type SetupProblem =
  | { kind: 'no_token' }
  | { kind: 'token_rejected'; code: string }
  | { kind: 'missing_scope'; needed: string };

export interface UpdatesSnapshot {
  sources: UpdateSourceView[];
  workspace: { botHandle: string | null; url: string | null };
  setup: SetupProblem | null;
  /** A forced read was held back by the floor or Retry-After. */
  throttled: boolean;
  checkedAt: string;
}
