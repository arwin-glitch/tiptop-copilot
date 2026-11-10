import 'server-only';
import type { AuthContext } from '@/lib/auth/session';
import type { DataStore } from '@/lib/db/store';
import { isPerson } from '@/lib/network/evidence';
import { personPagePath } from '@/lib/network/person-path';
import type { Deal, EmailMessage, EmailThread, PortfolioCompany, Task } from '@/lib/types/domain';
import { err, ok, type Result } from '@/lib/util/result';
import { getPrimaryIntegration } from './inbox';
import { buildPersonProfile, type PersonMeeting, type PersonThread } from './person-profile';
import { getRelationshipIndex, relationshipScope } from './relationships';
import { mailPeopleMatching } from './search';

/**
 * One task opened on a page of its own (/tasks/<id>): what it is, and every
 * place it came from or points at, so nobody has to dig. The email it was
 * made from, links written in it (DocSend, a deck, a doc), the deal or
 * company it is filed under, and for each person or company it names their
 * matching threads and the meetings with notes where it was likely promised.
 *
 * Read-only, from what Kraken already holds (no Gmail call), through the
 * same readers as the person page, so visibility rules stay theirs.
 */

export interface TaskLink {
  kind: 'docsend' | 'doc' | 'deck' | 'link';
  url: string;
  label: string;
}

export interface TaskPerson {
  email: string;
  name: string | null;
  href: string;
  /** Threads with them, the ones sharing words with the task first. */
  threads: PersonThread[];
  /** Meetings with them that have notes first, newest first. */
  meetings: PersonMeeting[];
}

export interface TaskContext {
  task: Task;
  /** The email the task was made from, when it was. */
  thread: { gmailId: string | null; subject: string | null; at: string | null } | null;
  links: TaskLink[];
  deal: { id: string; name: string } | null;
  company: { id: string; name: string } | null;
  people: TaskPerson[];
  mailbox: string | null;
  /** Open and past its due date. */
  overdue: boolean;
}

const PEOPLE_MAX = 3;
const THREADS_EACH = 4;
const MEETINGS_EACH = 3;

const URL_RE = /\bhttps?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?]/gi;

/** Links written in the task, named for what they are. */
export function linksIn(text: string): TaskLink[] {
  const out: TaskLink[] = [];
  const seen = new Set<string>();
  for (const raw of text.match(URL_RE) ?? []) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    const key = url.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    const host = url.hostname.replace(/^www\./, '');
    const kind: TaskLink['kind'] = host.endsWith('docsend.com')
      ? 'docsend'
      : host === 'docs.google.com' || host === 'drive.google.com' || host.endsWith('notion.so')
        ? 'doc'
        : /pitch\.com$|\.pdf$/i.test(host + url.pathname)
          ? 'deck'
          : 'link';
    const label =
      kind === 'docsend'
        ? 'DocSend'
        : kind === 'doc'
          ? 'Document'
          : kind === 'deck'
            ? 'Deck'
            : host;
    out.push({ kind, url: key, label });
  }
  return out;
}

const NOT_NAMES = new Set(
  [
    'reply',
    'review',
    'confirm',
    'send',
    'follow',
    'check',
    'pay',
    'or',
    'the',
    'to',
    'on',
    'for',
    'with',
    'and',
    'a',
    'an',
    'nick',
    'arwin',
    'tiptop',
    'kraken',
    'vc',
    'sep',
    'oct',
    'nov',
    'dec',
    'jan',
    'feb',
    'mar',
    'apr',
    'may',
    'jun',
    'jul',
    'aug',
    'mon',
    'tue',
    'wed',
    'thu',
    'fri',
    'no',
    'still',
    'owed',
    'asked',
    'only',
  ].map((w) => w.toLowerCase()),
);

/**
 * The people and companies a task names: runs of capitalised words ("Jon
 * Broscious", "Paige Faye", "ModernVivo", "Carta"), title first.
 */
export function namesIn(title: string, detail: string | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const text of [title, detail ?? '']) {
    const tokens = text.replace(/https?:\/\/\S+/g, ' ').split(/[^\p{L}\p{N}'’-]+/u);
    let run: string[] = [];
    const flush = () => {
      if (run.length) {
        const name = run.join(' ');
        const key = name.toLowerCase();
        if (!seen.has(key) && name.replace(/[^\p{L}]/gu, '').length >= 3) {
          seen.add(key);
          out.push(name);
        }
      }
      run = [];
    };
    for (const t of tokens) {
      const clean = t.replace(/['’]s$/i, '');
      if (
        /^\p{Lu}/u.test(clean) &&
        !NOT_NAMES.has(clean.toLowerCase()) &&
        !/^\p{Lu}+\d/u.test(clean)
      ) {
        run.push(clean);
        if (run.length === 3) flush();
      } else flush();
    }
    flush();
  }
  return out;
}

const words = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !NOT_NAMES.has(w)),
  );

function overlap(a: Set<string>, text: string): number {
  let n = 0;
  for (const w of words(text)) if (a.has(w)) n++;
  return n;
}

export async function buildTaskContext(
  store: DataStore,
  auth: AuthContext,
  taskId: string,
  options: { now?: Date } = {},
): Promise<Result<TaskContext>> {
  const org = auth.organizationId;
  const task = (await store.get('tasks', org, taskId).catch(() => null)) as Task | null;
  if (!task) return err('not_found', 'That task is not here any more.');
  const now = options.now ?? new Date();
  const integration = await getPrimaryIntegration(store, org).catch(() => null);
  const mailbox = integration?.account_email ?? null;
  const text = `${task.title}\n${task.detail ?? ''}`;
  const topic = words(text);

  /* ---------------------------------------------------- the email it came from */
  let thread: TaskContext['thread'] = null;
  if (task.email_message_id) {
    const message = (await store
      .get('email_messages', org, task.email_message_id)
      .catch(() => null)) as EmailMessage | null;
    if (message) {
      const row = (await store
        .get('email_threads', org, message.thread_id)
        .catch(() => null)) as EmailThread | null;
      thread = {
        gmailId: row?.provider_thread_id ?? null,
        subject: message.subject ?? row?.subject ?? null,
        at: message.sent_at,
      };
    }
  }

  // A thread written into the task ("/inbox?thread=<id>"), as the list links it.
  if (!thread) {
    const id = /(?:^|\s)\/inbox\?thread=([0-9a-f]{10,24})(?=\s|$)/i.exec(task.detail ?? '')?.[1];
    if (id) thread = { gmailId: id, subject: null, at: null };
  }

  /* ------------------------------------------------------ deal and company */
  const deal = task.deal_id
    ? ((await store.get('deals', org, task.deal_id).catch(() => null)) as Deal | null)
    : null;
  const company = task.portfolio_company_id
    ? ((await store
        .get('portfolio_companies', org, task.portfolio_company_id)
        .catch(() => null)) as PortfolioCompany | null)
    : null;

  /* ------------------------------------------- the people and companies named */
  const people: TaskPerson[] = [];
  const scope = { ...relationshipScope(auth.profile.email, integration), now };
  const loaded = await getRelationshipIndex(store, org, scope).catch(() => null);
  if (loaded?.ok) {
    const index = loaded.value;
    const emails: string[] = [];
    for (const name of namesIn(task.title, task.detail)) {
      for (const hit of mailPeopleMatching(index, name, 2)) {
        if (emails.length >= PEOPLE_MAX) break;
        if (!emails.includes(hit.email) && isPerson(index, hit.email)) emails.push(hit.email);
      }
      if (emails.length >= PEOPLE_MAX) break;
    }
    const profiles = await Promise.all(
      emails.map((email) => buildPersonProfile(store, auth, email, { now }).catch(() => null)),
    );
    for (const p of profiles) {
      if (!p?.ok) continue;
      const v = p.value;
      const threads = [...v.threads]
        .map((t, i) => ({ t, i, score: overlap(topic, `${t.subject} ${t.snippet ?? ''}`) }))
        .sort((a, b) => b.score - a.score || a.i - b.i)
        .slice(0, THREADS_EACH)
        .map((x) => x.t);
      const meetings = [...v.meetings]
        .filter((m) => !m.upcoming)
        .map((m, i) => ({
          m,
          i,
          score:
            (m.notes.length ? 2 : 0) +
            overlap(topic, `${m.title} ${m.notes.map((n) => n.summary).join(' ')}`),
        }))
        .sort((a, b) => b.score - a.score || a.i - b.i)
        .slice(0, MEETINGS_EACH)
        .map((x) => x.m);
      people.push({
        email: v.email,
        name: v.name,
        href: personPagePath(v.email),
        threads,
        meetings,
      });
    }
  }

  return ok({
    task,
    thread,
    links: linksIn(text),
    deal: deal ? { id: deal.id, name: deal.company_name } : null,
    company: company ? { id: company.id, name: company.name } : null,
    people,
    mailbox,
    overdue: task.status === 'open' && !!task.due_at && Date.parse(task.due_at) < now.getTime(),
  });
}
