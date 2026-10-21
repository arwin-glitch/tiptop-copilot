import {
  CRM_FIELD_TYPES,
  type CrmField,
  type CrmFieldType,
  type CrmList,
  type CrmValue,
} from '@/lib/types/domain';

/**
 * CRM field helpers: keys, value coercion and validation.
 *
 * Pure and dependency-free, so the import route, the service and client
 * components all agree on what a field key is and how a CSV cell becomes a
 * stored value — an import that keyed or parsed a column one way and a page
 * that read it another would show blanks where the data is.
 */

/** Field types whose value is a list of strings. */
export const CRM_ARRAY_FIELD_TYPES: ReadonlySet<CrmFieldType> = new Set([
  'multi',
  'person',
  'company',
]);

/** Field types that carry a fixed set of `options`. */
export const CRM_OPTION_FIELD_TYPES: ReadonlySet<CrmFieldType> = new Set(['status', 'multi']);

export function isCrmFieldType(value: unknown): value is CrmFieldType {
  return typeof value === 'string' && (CRM_FIELD_TYPES as readonly string[]).includes(value);
}

/**
 * The case-insensitive identity of a name: trimmed, inner whitespace collapsed,
 * lowercased. `crm_records.name_key` holds exactly this, so it must be the only
 * place it is computed.
 */
export function crmNameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Where a person record keeps their company, as exports name the column, most specific first. */
export const PERSON_COMPANY_KEYS = [
  'Organization',
  'Organizations',
  'Company',
  'Current Organization',
] as const;

/** The field holding a person's company now, and its (first) value; null when none is set. */
export function personCompanyOf(
  fields: Record<string, CrmValue> | null | undefined,
): { key: string; value: string } | null {
  for (const key of PERSON_COMPANY_KEYS) {
    const raw = fields?.[key];
    // Typed loosely on purpose: the review reads this for every recipient, and
    // one odd value in a contact's free-form fields must not take it down.
    const value = (Array.isArray(raw) ? (raw as unknown[]) : [raw])
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .find(Boolean);
    if (value) return { key, value };
  }
  return null;
}

const KEY_RE = /^[a-z][a-z0-9_]{0,59}$/;

/**
 * A field key from a column label: "Time in Current Status" becomes
 * `time_in_current_status`. Keys are what entry values are stored under and
 * what PostgREST paths address (`values->>status`), hence the narrow alphabet;
 * a key that would start with a digit gets an `f_` prefix so it can never read
 * as an array index. `taken` keys get a numeric suffix; the result is added
 * to `taken`.
 */
export function crmFieldKey(name: string, taken?: Set<string>): string {
  let base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);
  if (!base) base = 'field';
  if (!/^[a-z]/.test(base)) base = `f_${base}`;
  let key = base;
  for (let n = 2; taken?.has(key); n++) key = `${base}_${n}`;
  taken?.add(key);
  return key;
}

/** A field as a caller describes it: the key is derived from the name when omitted. */
export interface CrmFieldInput {
  key?: string | null;
  name: string;
  type?: CrmFieldType | string | null;
  options?: readonly string[] | null;
}

function cleanOptions(options: readonly string[] | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of options ?? []) {
    const option = typeof raw === 'string' ? raw.trim() : '';
    if (!option || seen.has(option.toLowerCase())) continue;
    seen.add(option.toLowerCase());
    out.push(option);
  }
  return out;
}

/**
 * Validated, de-duplicated fields: unnamed fields are dropped, unknown types
 * become 'text', keys are unique, and only status/multi fields keep options.
 */
export function normalizeCrmFields(input: readonly CrmFieldInput[]): CrmField[] {
  const taken = new Set<string>();
  const out: CrmField[] = [];
  for (const raw of input) {
    const name = raw.name?.trim();
    if (!name) continue;
    const type: CrmFieldType = isCrmFieldType(raw.type) ? raw.type : 'text';
    const wanted = raw.key?.trim();
    let key: string;
    if (wanted && KEY_RE.test(wanted) && !taken.has(wanted)) {
      key = wanted;
      taken.add(key);
    } else {
      key = crmFieldKey(name, taken);
    }
    const field: CrmField = { key, name: name.slice(0, 200), type };
    if (CRM_OPTION_FIELD_TYPES.has(type)) field.options = cleanOptions(raw.options);
    out.push(field);
  }
  return out;
}

/**
 * Existing fields updated with incoming ones, for re-importing a list.
 *
 * An incoming field matches an existing one by key, else by label (case-
 * insensitive); a match keeps the existing key — so values already stored stay
 * addressable — and takes the incoming label and type, with options unioned in
 * their existing order. Unmatched incoming fields are appended; existing
 * fields the import does not mention are kept. Callers key entry values by the
 * merged list's keys, not by the keys they sent.
 */
export function mergeCrmFields(existing: readonly CrmField[], incoming: readonly CrmField[]) {
  const out = existing.map((f) => ({ ...f, options: f.options ? [...f.options] : undefined }));
  const taken = new Set(out.map((f) => f.key));
  for (const field of incoming) {
    const match =
      out.find((f) => f.key === field.key) ??
      out.find((f) => f.name.toLowerCase() === field.name.toLowerCase());
    if (match) {
      match.name = field.name;
      match.type = field.type;
      if (CRM_OPTION_FIELD_TYPES.has(field.type)) {
        match.options = cleanOptions([...(match.options ?? []), ...(field.options ?? [])]);
      } else {
        delete match.options;
      }
      continue;
    }
    const key = taken.has(field.key) ? crmFieldKey(field.name, taken) : field.key;
    taken.add(key);
    out.push({ ...field, key, options: field.options ? [...field.options] : undefined });
  }
  return out.map((f) => {
    if (f.options === undefined) delete f.options;
    return f as CrmField;
  });
}

/** The list's pipeline field: the status field keyed or named "status", else the first one. */
export function statusFieldOf(list: Pick<CrmList, 'fields'>): CrmField | null {
  const statuses = list.fields.filter((f) => f.type === 'status');
  return (
    statuses.find((f) => f.key === 'status' || f.name.trim().toLowerCase() === 'status') ??
    statuses[0] ??
    null
  );
}

/* --------------------------------------------------------------- coercion */

function parseNumber(raw: string, money: boolean): number | null {
  let s = raw.replace(/\s+/g, '');
  if (money) s = s.replace(/^(usd|us\$|\$|€|£)|(usd)$/i, '');
  let multiplier = 1;
  const suffix = /^(.*\d)([kmb])$/i.exec(s);
  if (money && suffix) {
    s = suffix[1] as string;
    multiplier = { k: 1e3, m: 1e6, b: 1e9 }[(suffix[2] as string).toLowerCase() as 'k' | 'm' | 'b'];
  }
  if (!money && s.endsWith('%')) s = s.slice(0, -1);
  if (!/^[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?$/.test(s) || !/\d/.test(s)) return null;
  const n = Number(s.replace(/,/g, '')) * multiplier;
  if (!Number.isFinite(n)) return null;
  // 2.3 × 1e6 is 2299999.9999999995 in floating point; a suffixed amount is
  // never meant to carry fractions of a cent.
  return multiplier === 1 ? n : Math.round(n * 100) / 100;
}

function parseDate(raw: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return Number.isNaN(Date.parse(raw)) ? null : raw;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (us) {
    const [, m, d, y] = us;
    const iso = `${y}-${(m as string).padStart(2, '0')}-${(d as string).padStart(2, '0')}`;
    return Number.isNaN(Date.parse(iso)) ? null : iso;
  }
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Split a multi-value cell. Only on `;` — names contain commas ("Acme, Inc."). */
export function splitCrmMulti(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(';')) {
    const v = part.trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * A CSV cell as a stored value of the given type. Lenient by design, for
 * imports: a cell that does not parse as its type is kept as the original
 * string rather than dropped, and an empty cell is null.
 */
export function coerceCrmValue(type: CrmFieldType, raw: string | null | undefined): CrmValue {
  const value = (raw ?? '').trim();
  if (!value) return null;
  if (CRM_ARRAY_FIELD_TYPES.has(type)) {
    const parts = splitCrmMulti(value);
    return parts.length ? parts : null;
  }
  switch (type) {
    case 'number':
    case 'money':
      return parseNumber(value, type === 'money') ?? value;
    case 'date':
      return parseDate(value) ?? value;
    case 'email':
      return value.toLowerCase();
    default:
      return value;
  }
}

/**
 * Any incoming value (a raw string, or one already typed) as a stored value
 * of the field's type, leniently. Used by the import upsert.
 */
export function normalizeCrmValue(type: CrmFieldType, value: unknown): CrmValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return coerceCrmValue(type, value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    if (type === 'number' || type === 'money') return value;
    return coerceCrmValue(type, String(value));
  }
  if (Array.isArray(value)) {
    const parts = splitCrmMulti(value.filter((v) => typeof v === 'string').join(';'));
    if (!parts.length) return null;
    return CRM_ARRAY_FIELD_TYPES.has(type) ? parts : coerceCrmValue(type, parts.join('; '));
  }
  return null;
}

/**
 * A value a person set in the UI, checked strictly against the field: status
 * and multi values must be among the options (when the field has any),
 * numbers must be numbers, dates must be dates. Null clears the field.
 */
export function validateCrmValue(
  field: CrmField,
  value: unknown,
): { ok: true; value: CrmValue } | { ok: false; message: string } {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  const label = field.name;
  const options = field.options ?? [];
  if (CRM_ARRAY_FIELD_TYPES.has(field.type)) {
    const parts = Array.isArray(value)
      ? splitCrmMulti(value.filter((v) => typeof v === 'string').join(';'))
      : typeof value === 'string'
        ? splitCrmMulti(value)
        : null;
    if (!parts) return { ok: false, message: `${label} takes a list of names.` };
    if (field.type === 'multi' && options.length) {
      const unknown = parts.find((p) => !options.includes(p));
      if (unknown)
        return { ok: false, message: `"${unknown}" is not one of the ${label} options.` };
    }
    return { ok: true, value: parts.length ? parts : null };
  }
  if (field.type === 'number' || field.type === 'money') {
    const n =
      typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? parseNumber(value.trim(), field.type === 'money')
          : null;
    if (n === null || !Number.isFinite(n))
      return { ok: false, message: `${label} takes a number.` };
    return { ok: true, value: n };
  }
  if (typeof value !== 'string') return { ok: false, message: `${label} takes text.` };
  const text = value.trim();
  if (!text) return { ok: true, value: null };
  if (text.length > 5000) return { ok: false, message: `${label} is too long.` };
  switch (field.type) {
    case 'status':
      if (options.length && !options.includes(text)) {
        return { ok: false, message: `"${text}" is not one of the ${label} options.` };
      }
      return { ok: true, value: text };
    case 'date': {
      const date = parseDate(text);
      return date ? { ok: true, value: date } : { ok: false, message: `${label} takes a date.` };
    }
    case 'email':
      return text.includes('@')
        ? { ok: true, value: text.toLowerCase() }
        : { ok: false, message: `${label} takes an email address.` };
    default:
      return { ok: true, value: text };
  }
}

const MONEY = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

/** A stored value as display text ('' for empty). Dates stay as stored; format them in the UI. */
export function displayCrmValue(field: Pick<CrmField, 'type'>, value: CrmValue | undefined) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'number') {
    return field.type === 'money' ? MONEY.format(value) : value.toLocaleString('en-US');
  }
  return value;
}
