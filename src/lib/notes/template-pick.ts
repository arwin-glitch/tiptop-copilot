import { BUILTIN_TEMPLATES, type NoteTemplate, type TemplateMeetingType } from '@/lib/types/notes';

/**
 * Which template a meeting's notes use when nobody picked one (D-076).
 * Granola can only default to "Auto"; Kraken knows the CRM, so it can tell
 * a founder pitch from an LP call before anyone types a word.
 *
 * In order:
 *   1. A custom template whose rule matches: a guest's domain first, then a
 *      word in the title, then the meeting type.
 *   2. The meeting type, from what Kraken knows about the guests:
 *      nobody from outside the team → internal; a portfolio company's domain
 *      → portfolio; someone on an LP list → LP call; a company in the deal
 *      pipeline → founder pitch.
 *   3. The title's own words ("board", "intro", "LP", "pitch").
 *   4. Nothing: general notes with no template.
 *
 * Pure and client-safe; services gather the CRM facts.
 */

export interface TemplatePickInput {
  title: string;
  /** Lowercased guest emails (the recorder and teammates excluded). */
  externalEmails: readonly string[];
  /** Everyone on the invite was a teammate (or nobody else was on it, and it is not ad hoc). */
  internalOnly: boolean;
  dealDomains: ReadonlySet<string>;
  portfolioDomains: ReadonlySet<string>;
  /** Emails and bare domains of people and firms on an LP list. */
  lpKeys: ReadonlySet<string>;
  customTemplates: readonly Pick<
    NoteTemplate,
    'id' | 'name' | 'meeting_type' | 'auto_rule' | 'archived'
  >[];
}

export interface TemplatePick {
  templateId: string | null;
  meetingType: TemplateMeetingType;
  /** Plain words, for the template chip's tooltip: "Acme is in the deal pipeline". */
  reason: string;
}

const BUILTIN_FOR: Record<TemplateMeetingType, string | null> = {
  pitch: 'builtin:founder_pitch',
  lp: 'builtin:lp_call',
  portfolio: 'builtin:portfolio_checkin',
  intro: 'builtin:intro_call',
  internal: 'builtin:internal_1on1',
  other: null,
};

const TITLE_RULES: readonly { re: RegExp; type: TemplateMeetingType; why: string }[] = [
  { re: /\b(board meeting|board call|board)\b/i, type: 'portfolio', why: 'the title says board' },
  {
    re: /\b(lp|limited partners?|fund ii|investor update)\b/i,
    type: 'lp',
    why: 'the title names an LP meeting',
  },
  {
    re: /\b(pitch|raising|fundrais\w*|pre-?seed|seed round|series [a-e])\b/i,
    type: 'pitch',
    why: 'the title names a pitch',
  },
  { re: /\b(intro|introduction)\b|<>/i, type: 'intro', why: 'the title names an intro' },
  {
    re: /\b(check-?in|catch-?up|portfolio)\b/i,
    type: 'portfolio',
    why: 'the title names a check-in',
  },
  { re: /\b(1:1|1-1|one-on-one|1on1)\b/i, type: 'internal', why: 'the title names a 1:1' },
];

export function domainOf(email: string): string | null {
  const at = email.lastIndexOf('@');
  return at < 0 ? null : email.slice(at + 1).toLowerCase();
}

/** The meeting type from the guests and the CRM, or null when they say nothing. */
export function meetingTypeFromGuests(
  input: Omit<TemplatePickInput, 'title' | 'customTemplates'>,
): { type: TemplateMeetingType; why: string } | null {
  if (input.internalOnly) return { type: 'internal', why: 'everyone on it is on the team' };
  const domains = input.externalEmails.map(domainOf).filter((d): d is string => Boolean(d));
  const hit = (set: ReadonlySet<string>) => domains.find((d) => set.has(d));
  const portfolio = hit(input.portfolioDomains);
  if (portfolio) return { type: 'portfolio', why: `${portfolio} is a portfolio company` };
  const lp =
    input.externalEmails.find((e) => input.lpKeys.has(e)) ??
    domains.find((d) => input.lpKeys.has(d));
  if (lp) return { type: 'lp', why: `${lp} is on an LP list` };
  const deal = hit(input.dealDomains);
  if (deal) return { type: 'pitch', why: `${deal} is in the deal pipeline` };
  return null;
}

export function pickTemplate(input: TemplatePickInput): TemplatePick {
  const domains = new Set(
    input.externalEmails.map(domainOf).filter((d): d is string => Boolean(d)),
  );
  const fromGuests = meetingTypeFromGuests(input);
  const fromTitle = TITLE_RULES.find((r) => r.re.test(input.title)) ?? null;
  const type: TemplateMeetingType = fromGuests?.type ?? fromTitle?.type ?? 'other';

  const custom = input.customTemplates.filter((t) => !t.archived && t.auto_rule);
  const byDomain = custom.find((t) =>
    (t.auto_rule?.domains ?? []).some((d) => domains.has(d.toLowerCase())),
  );
  if (byDomain) {
    return {
      templateId: byDomain.id,
      meetingType: byDomain.meeting_type,
      reason: `"${byDomain.name}" covers this guest's company`,
    };
  }
  const title = input.title.toLowerCase();
  const byTitle = custom.find((t) =>
    (t.auto_rule?.titleIncludes ?? []).some(
      (w) => w.trim() && title.includes(w.trim().toLowerCase()),
    ),
  );
  if (byTitle) {
    return {
      templateId: byTitle.id,
      meetingType: byTitle.meeting_type,
      reason: `"${byTitle.name}" matches the title`,
    };
  }
  const byType =
    type !== 'other'
      ? custom.find((t) => (t.auto_rule?.meetingTypes ?? []).includes(type))
      : undefined;
  if (byType) {
    return {
      templateId: byType.id,
      meetingType: type,
      reason: `"${byType.name}" is set for this kind of meeting`,
    };
  }

  const builtin = BUILTIN_FOR[type];
  if (!builtin)
    return { templateId: null, meetingType: 'other', reason: 'No template fits; general notes' };
  const name = BUILTIN_TEMPLATES.find((t) => t.id === builtin)?.name ?? builtin;
  const why = fromGuests?.why ?? fromTitle?.why ?? '';
  return { templateId: builtin, meetingType: type, reason: `${name}: ${why}` };
}
