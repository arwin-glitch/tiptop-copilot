import type { NeverRecordMatch, RecordingRule, RecordingRuleKind } from '@/lib/types/notes';

/**
 * Never-record rules (D-076): a meeting that matches one cannot be recorded,
 * and Start is replaced by NEVER_RECORD_MESSAGE. Pure and client-safe, so the
 * consent banner can show the block before anyone clicks, and the start route
 * checks the same thing again on the server.
 *
 * Three layers. The defaults below cover legal and family meetings by the
 * words in their titles. Everything specific to the firm (a company's domain,
 * a calendar, another word) is either a recording_rules row added in Settings
 * or an entry in the server's NOTES_NEVER_RECORD list (rulesFromList), never
 * a name in this file: the repository is public.
 */

export interface DefaultRecordingRule {
  /** 'default:<key>'. */
  id: string;
  kind: RecordingRuleKind;
  pattern: string;
  label: string;
}

const titleRule = (label: string, pattern: string): DefaultRecordingRule => ({
  id: `default:${label}:${pattern.replace(/\s+/g, '_')}`,
  kind: 'title',
  pattern,
  label,
});

export const DEFAULT_RECORDING_RULES: readonly DefaultRecordingRule[] = [
  ...['legal', 'counsel', 'attorney', 'lawyer', 'privileged', 'litigation'].map((w) =>
    titleRule('legal', w),
  ),
  ...['family', 'kids', 'pediatrician', 'doctor', 'dentist', 'therapy'].map((w) =>
    titleRule('family', w),
  ),
];

/** The label every NOTES_NEVER_RECORD entry carries. */
export const LIST_RULE_LABEL = 'portfolio-sensitive';

const DOMAIN = /^@?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The server's never-record list (NOTES_NEVER_RECORD, already split on
 * commas) as rules: "acme.example" (or "@acme.example") is a guest's domain,
 * "someone@acme.example" a guest, anything else words in the title. Each is
 * labelled 'portfolio-sensitive' and always enabled. Pure.
 */
export function rulesFromList(
  entries: readonly string[],
): Pick<RecordingRule, 'id' | 'kind' | 'pattern' | 'label' | 'enabled'>[] {
  const out: Pick<RecordingRule, 'id' | 'kind' | 'pattern' | 'label' | 'enabled'>[] = [];
  entries.forEach((raw, i) => {
    const entry = raw.trim();
    if (!entry) return;
    const kind: RecordingRuleKind = ADDRESS.test(entry)
      ? 'attendee_email'
      : DOMAIN.test(entry)
        ? 'attendee_domain'
        : 'title';
    out.push({
      id: `list:${i}`,
      kind,
      pattern: kind === 'attendee_domain' ? entry.replace(/^@/, '').toLowerCase() : entry,
      label: LIST_RULE_LABEL,
      enabled: true,
    });
  });
  return out;
}

export interface NeverRecordSubject {
  title: string;
  calendarId: string | null;
  attendeeEmails: readonly (string | null)[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole words, any case: 'legal' matches "Legal review", not "illegally". */
function titleHas(title: string, phrase: string): boolean {
  const words = phrase.trim().split(/\s+/).map(escapeRegExp).join('\\s+');
  if (!words) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${words}($|[^\\p{L}\\p{N}])`, 'iu').test(title);
}

function domainOf(email: string): string | null {
  const at = email.lastIndexOf('@');
  return at < 0 ? null : email.slice(at + 1).toLowerCase();
}

function matches(
  rule: { kind: RecordingRuleKind; pattern: string },
  subject: NeverRecordSubject,
): string | null {
  const pattern = rule.pattern.trim();
  if (!pattern) return null;
  const emails = subject.attendeeEmails
    .filter((e): e is string => typeof e === 'string' && e.length > 0)
    .map((e) => e.toLowerCase());
  switch (rule.kind) {
    case 'title':
      return titleHas(subject.title, pattern) ? `the title has "${pattern}"` : null;
    case 'attendee_domain': {
      const want = pattern.toLowerCase().replace(/^@/, '');
      const hit = emails.find((e) => {
        const d = domainOf(e);
        return d === want || (d !== null && d.endsWith(`.${want}`));
      });
      return hit ? `a guest is from ${want}` : null;
    }
    case 'attendee_email':
      return emails.includes(pattern.toLowerCase()) ? 'a guest is on the list' : null;
    case 'calendar_id':
      return subject.calendarId && subject.calendarId.toLowerCase() === pattern.toLowerCase()
        ? 'it is on a never-record calendar'
        : null;
    default:
      return null;
  }
}

/**
 * The first rule the meeting matches, the organization's own rules first,
 * then the defaults; null when it may be recorded. Disabled rules are skipped.
 */
export function matchNeverRecord(
  subject: NeverRecordSubject,
  rules: readonly Pick<RecordingRule, 'id' | 'kind' | 'pattern' | 'label' | 'enabled'>[],
  options: { includeDefaults?: boolean } = {},
): NeverRecordMatch | null {
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const reason = matches(rule, subject);
    if (reason) return { ruleId: rule.id, label: rule.label, reason };
  }
  if (options.includeDefaults === false) return null;
  for (const rule of DEFAULT_RECORDING_RULES) {
    const reason = matches(rule, subject);
    if (reason) return { ruleId: rule.id, label: rule.label, reason };
  }
  return null;
}
