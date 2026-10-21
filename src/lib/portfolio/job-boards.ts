/**
 * Job boards with a public postings API, and how to ask one whether a
 * posting is still up. Pure, for the liveness check in
 * `src/lib/services/job-liveness.ts`.
 *
 * Only exact board hosts are recognised, and the API address is rebuilt from
 * the posting's validated path segments; nothing in the link itself is ever
 * fetched. A company's own careers page is never checked: there is no way to
 * tell "gone" from "moved" there without crawling it.
 */

export type JobBoard = 'Greenhouse' | 'Lever' | 'Ashby';

export interface JobBoardCheck {
  board: JobBoard;
  /** The board's public API for this posting (Greenhouse, Lever) or its whole board (Ashby). */
  apiUrl: string;
  /** The posting's id on the board. */
  postingId: string;
  /** `posting`: a 404 means gone. `board`: gone when the id is missing from the list. */
  kind: 'posting' | 'board';
}

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const DIGITS = /^\d{1,20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GREENHOUSE_HOSTS = new Set(['boards.greenhouse.io', 'job-boards.greenhouse.io']);

/** The board check for a job link, or null when it is not a posting on a known board. */
export function jobBoardCheck(link: string | null | undefined): JobBoardCheck | null {
  if (!link) return null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.split('/').filter(Boolean);

  // boards.greenhouse.io/<board>/jobs/<id>
  if (GREENHOUSE_HOSTS.has(host)) {
    const [board, jobs, id] = path;
    if (!board || jobs !== 'jobs' || !id || !SLUG.test(board) || !DIGITS.test(id)) return null;
    return {
      board: 'Greenhouse',
      apiUrl: `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`,
      postingId: id,
      kind: 'posting',
    };
  }
  // jobs.lever.co/<site>/<uuid>[/apply]
  if (host === 'jobs.lever.co') {
    const [site, id, rest] = path;
    if (!site || !id || !SLUG.test(site) || !UUID.test(id)) return null;
    if (rest !== undefined && rest !== 'apply') return null;
    return {
      board: 'Lever',
      apiUrl: `https://api.lever.co/v0/postings/${site}/${id.toLowerCase()}`,
      postingId: id.toLowerCase(),
      kind: 'posting',
    };
  }
  // jobs.ashbyhq.com/<board>/<uuid>[/application]
  if (host === 'jobs.ashbyhq.com') {
    const [board, id, rest] = path;
    if (!board || !id || !SLUG.test(board) || !UUID.test(id)) return null;
    if (rest !== undefined && rest !== 'application') return null;
    return {
      board: 'Ashby',
      apiUrl: `https://api.ashbyhq.com/posting-api/job-board/${board}`,
      postingId: id.toLowerCase(),
      kind: 'board',
    };
  }
  return null;
}

/** What a board's answer says: the posting is up, gone, or the answer says nothing. */
export type BoardVerdict = 'live' | 'gone' | 'unknown';

const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * The posting ids one entry of a board's list carries: its `id`, and the id
 * in its `jobUrl` / `applyUrl`. Ashby documents only the two links (its `id`
 * is there today but undocumented), so either is enough.
 */
function boardEntryIds(entry: unknown): string[] {
  if (!entry || typeof entry !== 'object') return [];
  const { id, jobUrl, applyUrl } = entry as Record<string, unknown>;
  const out: string[] = [];
  if (typeof id === 'string' && id) out.push(id.toLowerCase());
  for (const url of [jobUrl, applyUrl]) {
    if (typeof url === 'string')
      out.push(...(url.match(UUID_IN_TEXT) ?? []).map((u) => u.toLowerCase()));
  }
  return out;
}

/**
 * Read a board's answer. Only a definite answer counts: a 404 for a posting
 * (or a whole board), or a board list without the posting. A timeout, a 5xx,
 * a rate limit, a body that will not parse, or a list whose entries carry no
 * id this can read is `unknown`, and changes nothing.
 */
export function readBoardAnswer(check: JobBoardCheck, status: number, body: unknown): BoardVerdict {
  if (status === 404 || status === 410) return 'gone';
  if (status !== 200) return 'unknown';
  if (check.kind === 'posting') return 'live';
  const jobs = (body as { jobs?: unknown } | null)?.jobs;
  if (!Array.isArray(jobs)) return 'unknown';
  // A board with nothing published: every posting on it is gone.
  if (jobs.length === 0) return 'gone';
  const ids = new Set(jobs.flatMap(boardEntryIds));
  // Entries without a readable id say nothing (a changed answer shape).
  if (ids.size === 0) return 'unknown';
  return ids.has(check.postingId) ? 'live' : 'gone';
}
