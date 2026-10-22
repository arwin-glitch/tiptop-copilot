/**
 * Reading a host's robots.txt, so the board's sync and its careers-page
 * check ask only for what the host allows. Pure: the fetching and caching
 * are in `lib/services/jobs-board-sync.ts`.
 *
 * The usual rules: the group for this user agent's own token wins, else the
 * `*` group; within it the longest matching `Allow` or `Disallow` decides,
 * `Allow` on a tie; `*` and a closing `$` match as they do for Google. An
 * empty or missing file allows everything.
 */

export const SYNC_USER_AGENT_TOKEN = 'TipTopJobsBot';
export const SYNC_USER_AGENT = `${SYNC_USER_AGENT_TOKEN}/1.0 (+https://www.tiptop.vc)`;

interface Rule {
  allow: boolean;
  pattern: string;
}

interface Group {
  agents: string[];
  rules: Rule[];
}

function parseGroups(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.slice(0, 500_000).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === 'allow' || field === 'disallow') {
      // An empty Disallow allows everything; it adds no rule.
      if (value) current.rules.push({ allow: field === 'allow', pattern: value });
    }
  }
  return groups;
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const regex = new RegExp(
    `^${body
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}${anchored ? '$' : ''}`,
  );
  return regex.test(path);
}

/** Whether robots.txt lets this user agent fetch this path (with its query). */
export function robotsAllows(
  robotsTxt: string | null | undefined,
  path: string,
  agentToken: string = SYNC_USER_AGENT_TOKEN,
): boolean {
  if (!robotsTxt) return true;
  const groups = parseGroups(robotsTxt);
  const token = agentToken.toLowerCase();
  const own = groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  const chosen = own.length > 0 ? own : groups.filter((g) => g.agents.includes('*'));
  const rules = chosen.flatMap((g) => g.rules);
  let best: Rule | null = null;
  for (const rule of rules) {
    if (!matches(rule.pattern, path)) continue;
    if (
      !best ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow)
    ) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}

/** The crawl delay robots.txt asks this user agent to keep, in seconds (0 when none, at most 10). */
export function robotsCrawlDelaySeconds(
  robotsTxt: string | null | undefined,
  agentToken: string = SYNC_USER_AGENT_TOKEN,
): number {
  if (!robotsTxt) return 0;
  const token = agentToken.toLowerCase();
  let ownDelay: number | null = null;
  let anyDelay: number | null = null;
  let agents: string[] = [];
  let lastWasAgent = false;
  for (const rawLine of robotsTxt.slice(0, 500_000).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const colon = line.indexOf(':');
    if (!line || colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === 'user-agent') {
      agents = lastWasAgent ? [...agents, value.toLowerCase()] : [value.toLowerCase()];
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (field !== 'crawl-delay') continue;
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) continue;
    if (agents.some((a) => a !== '*' && token.includes(a))) ownDelay = seconds;
    else if (agents.includes('*')) anyDelay = seconds;
  }
  return Math.min(10, ownDelay ?? anyDelay ?? 0);
}
