import { htmlToPlainText } from '@/lib/util/text';
import { weekdayOf } from './grid';
import type { RangeAttendee } from './range-types';

/**
 * How an event's card words things, the way Google Calendar's does: the
 * repeat rule ("Weekly on Monday, 12 times"), the guests' answers ("2 yes,
 * 1 awaiting"), a place as a Maps link, and a description that an invite's
 * sender wrote, shown as plain text with its links clickable and nothing
 * else of its HTML kept. Pure, so the tests and the page share it.
 */

/* ------------------------------------------------------------ repeating */

const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
const WEEKDAY_NAMES: Record<string, string> = {
  SU: 'Sunday',
  MO: 'Monday',
  TU: 'Tuesday',
  WE: 'Wednesday',
  TH: 'Thursday',
  FR: 'Friday',
  SA: 'Saturday',
};
const ORDINALS: Record<string, string> = {
  '1': 'first',
  '2': 'second',
  '3': 'third',
  '4': 'fourth',
  '5': 'fifth',
  '-1': 'last',
};

function dayLabel(dateKey: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options }).format(
    new Date(`${dateKey}T12:00:00Z`),
  );
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * A series' repeat rule in Google Calendar's words: "Daily", "Weekly on
 * Monday", "Every weekday (Monday to Friday)", "Monthly on the third
 * Thursday", "Annually on October 21", with ", 12 times" or ", until Dec 31,
 * 2026". `firstDay` is the series' first date, which fills in what the rule
 * leaves to it. Null when there is no rule; "Repeats" for one it cannot read.
 */
export function recurrenceSummary(
  rules: readonly string[] | null | undefined,
  firstDay: string | null,
): string | null {
  const line = rules?.find((r) => /^RRULE:/i.test(r));
  if (!line) return null;
  const parts: Record<string, string> = {};
  for (const piece of line.slice(6).split(';')) {
    const [key, value] = piece.split('=');
    if (key && value) parts[key.toUpperCase()] = value.toUpperCase();
  }
  const interval = Math.max(1, Number(parts.INTERVAL) || 1);
  const first = firstDay && /^\d{4}-\d{2}-\d{2}$/.test(firstDay) ? firstDay : null;
  let text: string;
  switch (parts.FREQ) {
    case 'DAILY':
      text = interval === 1 ? 'Daily' : `Every ${interval} days`;
      break;
    case 'WEEKLY': {
      const listed = (parts.BYDAY ?? '')
        .split(',')
        .map((d) => d.replace(/^[+-]?\d+/, ''))
        .filter((d) => d in WEEKDAY_NAMES);
      const codes = listed.length
        ? [...new Set(listed)].sort(
            (a, b) =>
              WEEKDAY_CODES.indexOf(a as (typeof WEEKDAY_CODES)[number]) -
              WEEKDAY_CODES.indexOf(b as (typeof WEEKDAY_CODES)[number]),
          )
        : first
          ? [WEEKDAY_CODES[weekdayOf(first)]!]
          : [];
      if (interval === 1 && codes.join(',') === 'MO,TU,WE,TH,FR') {
        text = 'Every weekday (Monday to Friday)';
      } else {
        const names = joinNames(codes.map((c) => WEEKDAY_NAMES[c]!));
        text = `${interval === 1 ? 'Weekly' : `Every ${interval} weeks`}${names ? ` on ${names}` : ''}`;
      }
      break;
    }
    case 'MONTHLY': {
      const head = interval === 1 ? 'Monthly' : `Every ${interval} months`;
      const nth = /^([+-]?\d)(SU|MO|TU|WE|TH|FR|SA)$/.exec(parts.BYDAY ?? '');
      const ordinal = nth ? ORDINALS[String(Number(nth[1]))] : undefined;
      if (nth && ordinal) {
        text = `${head} on the ${ordinal} ${WEEKDAY_NAMES[nth[2]!]}`;
      } else {
        const day = Number(parts.BYMONTHDAY) || (first ? Number(first.slice(8)) : 0);
        text = day > 0 ? `${head} on day ${day}` : head;
      }
      break;
    }
    case 'YEARLY': {
      const head = interval === 1 ? 'Annually' : `Every ${interval} years`;
      text = first ? `${head} on ${dayLabel(first, { month: 'long', day: 'numeric' })}` : head;
      break;
    }
    default:
      return 'Repeats';
  }
  const count = Number(parts.COUNT);
  if (Number.isInteger(count) && count > 0) {
    text += count === 1 ? ', once' : `, ${count} times`;
  } else {
    const until = /^(\d{4})(\d{2})(\d{2})/.exec(parts.UNTIL ?? '');
    if (until) {
      text += `, until ${dayLabel(`${until[1]}-${until[2]}-${until[3]}`, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })}`;
    }
  }
  return text;
}

/* --------------------------------------------------------------- guests */

export interface ResponseCounts {
  yes: number;
  no: number;
  maybe: number;
  awaiting: number;
}

/** How the guests answered, as Google counts them. */
export function responseCounts(people: readonly Pick<RangeAttendee, 'response'>[]): ResponseCounts {
  const counts: ResponseCounts = { yes: 0, no: 0, maybe: 0, awaiting: 0 };
  for (const p of people) {
    if (p.response === 'accepted') counts.yes++;
    else if (p.response === 'declined') counts.no++;
    else if (p.response === 'tentative') counts.maybe++;
    else counts.awaiting++;
  }
  return counts;
}

/** "2 yes, 1 no, 1 awaiting": only the answers someone gave. */
export function responseSummary(counts: ResponseCounts): string {
  return [
    counts.yes ? `${counts.yes} yes` : null,
    counts.no ? `${counts.no} no` : null,
    counts.maybe ? `${counts.maybe} maybe` : null,
    counts.awaiting ? `${counts.awaiting} awaiting` : null,
  ]
    .filter(Boolean)
    .join(', ');
}

/* ---------------------------------------------------------------- place */

/** A place as a Google Maps search, the link Google Calendar puts on a location. */
export function mapsUrl(location: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location.trim())}`;
}

/* ---------------------------------------------------------- description */

export type DescriptionPart =
  | { type: 'text'; text: string }
  | {
      type: 'link';
      href: string;
      label: string;
      /** Where it really goes, when the words shown are not the address itself. */
      host: string | null;
    };

const ANCHOR = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi;
const LOOKS_HTML = /<\/?[a-z][^>]*>/i;
const BARE_LINK = /\b(?:https?:\/\/|mailto:)[^\s<>"'`]+/gi;
const TRAILING = /[.,;:!?)\]]+$/;
const MARK = /(\u0002\d+\u0003)/;

/** A link the card may open: http, https or mailto, with no credentials in it. */
export function safeHref(raw: string): string | null {
  const value = raw.replace(/&amp;/gi, '&').trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) return null;
  if (url.username || url.password) return null;
  return url.href;
}

function hostOf(href: string): string | null {
  try {
    const url = new URL(href);
    return url.protocol === 'mailto:' ? url.pathname : url.hostname;
  } catch {
    return null;
  }
}

/** An address without its scheme or a closing slash, to tell whether a label is just the link. */
const bareLink = (value: string) =>
  value
    .trim()
    .replace(/^(https?:\/\/|mailto:)/i, '')
    .replace(/\/$/, '')
    .toLowerCase();

function decoded(href: string): string {
  try {
    return decodeURI(href);
  } catch {
    return href;
  }
}

function linkPart(href: string, label: string): DescriptionPart {
  const shown = label.trim() || href;
  const same = bareLink(shown) === bareLink(href) || bareLink(shown) === bareLink(decoded(href));
  return { type: 'link', href, label: shown, host: same ? null : hostOf(href) };
}

/**
 * An event description as plain text and links. Google keeps descriptions as
 * the HTML an invite's sender wrote: its links stay clickable (http, https
 * and mailto only; anything else is shown as words), every other tag is
 * dropped, and nothing is ever drawn as HTML.
 */
export function descriptionParts(description: string | null | undefined): DescriptionPart[] {
  if (!description?.trim()) return [];
  const anchors: { href: string | null; label: string }[] = [];
  let text = description;
  if (LOOKS_HTML.test(text)) {
    text = text.replace(ANCHOR, (_, a?: string, b?: string, c?: string, inner = '') => {
      anchors.push({ href: safeHref(a ?? b ?? c ?? ''), label: htmlToPlainText(inner) });
      return `\u0002${anchors.length - 1}\u0003`;
    });
    text = htmlToPlainText(text);
  }

  const parts: DescriptionPart[] = [];
  const pushText = (value: string) => {
    if (!value) return;
    const last = parts[parts.length - 1];
    if (last?.type === 'text') last.text += value;
    else parts.push({ type: 'text', text: value });
  };
  for (const piece of text.split(MARK)) {
    const mark = /^\u0002(\d+)\u0003$/.exec(piece);
    if (mark) {
      const anchor = anchors[Number(mark[1])];
      if (!anchor) continue;
      if (anchor.href) parts.push(linkPart(anchor.href, anchor.label));
      else pushText(anchor.label);
      continue;
    }
    let last = 0;
    for (const match of piece.matchAll(BARE_LINK)) {
      const raw = match[0].replace(TRAILING, '');
      const href = safeHref(raw);
      if (!href) continue;
      pushText(piece.slice(last, match.index));
      parts.push(linkPart(href, raw));
      last = match.index + raw.length;
    }
    pushText(piece.slice(last));
  }
  return parts;
}
