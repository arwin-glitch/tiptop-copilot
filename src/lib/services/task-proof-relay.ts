import { z } from 'zod';
import type { DataStore } from '@/lib/db/store';
import { log } from '@/lib/security/redact';
import { slackTsToIso, type SlackMessage } from '@/lib/slack/relay-history';
import { TASK_PROOF_SCHEMA, type TaskProofRelay } from '@/lib/tasks/proof';
import type { Task } from '@/lib/types/domain';
import { unwrapSlackText } from '@/lib/util/slack-text';
import { dropBlank, evidenceTime, markerOf, snapshotTitle, titleKey } from './task-close';
import { applyProofEvidence, listAwaitingProof, type ProofApplied } from './task-proof';

/**
 * The task-closer's proofs for tasks a person ticked by hand (`TASK_PROOF_V1`).
 *
 * The app can see sent mail itself, but not a Slack DM, and it does not judge
 * a payment receipt or a signature-platform notice. The task-closer can, so
 * for a ticked task still waiting for its proof (listed in the open-task
 * snapshot as "ticked") it posts what it found to #deal-relay, beside its
 * closes. This mirrors `TASK_CLOSE_V1` exactly: the same channel, the same
 * trusted posters (`taskRelayPosterIds`), the first line exactly the marker,
 * the JSON the first backtick-quoted span. It is add-only: a proof marks a
 * ticked task "Seen sent" and nothing else; it never closes, reopens or
 * changes a task, and one for a task still open is ignored. Re-reading the
 * same post every run changes nothing.
 */

export const TASK_PROOF_MARKER = 'TASK_PROOF_V1';
/** What the routine posts in PREVIEW mode. A person checks these; the app never applies them. */
export const TASK_PROOF_PREVIEW_MARKER = 'TASK_PROOF_PREVIEW_V1';

/** Slack's own ceiling on a message; anything longer was not the routine's. */
const MAX_MESSAGE_CHARS = 40_000;

const TASK_PROOF_ENVELOPE = z.object({
  v: z.literal(1),
  source: z.literal('task-closer'),
  batch: z.string().max(40).optional(),
  part: z.number().int().min(1).max(100).optional(),
  parts: z.number().int().min(1).max(100).optional(),
  proofs: z.array(z.unknown()).min(1).max(20),
});

export interface ParsedTaskProofMessage {
  batch: string | null;
  proofs: TaskProofRelay[];
  rejected: number;
}

/** One #deal-relay message -> its proofs, or null. A proof that fails its schema is counted and dropped. */
export function parseTaskProofMessage(text: unknown): ParsedTaskProofMessage | null {
  if (typeof text !== 'string' || text.length > MAX_MESSAGE_CHARS) return null;
  const clean = unwrapSlackText(text).trim();
  if (markerOf(clean) !== TASK_PROOF_MARKER) return null;
  const match = /`([^`]+)`/.exec(clean);
  if (!match?.[1]) return null;
  let json: unknown;
  try {
    json = JSON.parse(match[1]);
  } catch {
    return null;
  }
  const envelope = TASK_PROOF_ENVELOPE.safeParse(json);
  if (!envelope.success) return null;
  const proofs: TaskProofRelay[] = [];
  let rejected = 0;
  for (const raw of envelope.data.proofs) {
    const parsed = TASK_PROOF_SCHEMA.safeParse(dropBlank(raw));
    if (parsed.success) proofs.push(parsed.data);
    else rejected++;
  }
  return { batch: envelope.data.batch ?? null, proofs, rejected };
}

export interface RelayProof {
  proof: TaskProofRelay;
  /** When Slack says it was posted. Evidence can never be later than this. */
  postedAt: string;
  slackTs: string;
}

/**
 * Slack's pages (newest first) -> proofs, oldest first. Only posts from
 * `posterIds` count, and nothing with a subtype, as for the closes.
 */
export function collectTaskProofs(
  messages: readonly SlackMessage[],
  posterIds: readonly string[],
): { proofs: RelayProof[]; rejected: number } {
  const usable = messages
    .filter((m) => m.subtype === undefined || m.subtype === null)
    .filter((m) => typeof m.user === 'string' && posterIds.includes(m.user))
    .map((m) => ({ m, at: typeof m.ts === 'string' ? Number(m.ts) : Number.NaN }))
    .filter(({ at }) => Number.isFinite(at))
    .sort((a, b) => a.at - b.at);
  const out: { proofs: RelayProof[]; rejected: number } = { proofs: [], rejected: 0 };
  for (const { m } of usable) {
    const postedAt = slackTsToIso(m.ts);
    if (!postedAt || typeof m.ts !== 'string') continue;
    let parsed: ParsedTaskProofMessage | null;
    try {
      parsed = parseTaskProofMessage(m.text);
    } catch {
      parsed = null;
    }
    if (!parsed) {
      const text = typeof m.text === 'string' ? markerOf(unwrapSlackText(m.text).trim()) : '';
      if (text === TASK_PROOF_MARKER) out.rejected++;
      continue;
    }
    out.rejected += parsed.rejected;
    for (const proof of parsed.proofs) out.proofs.push({ proof, postedAt, slackTs: m.ts });
  }
  return out;
}

export type TaskProofSkip =
  'id_title_mismatch' | 'no_ticked_match' | 'ambiguous' | Exclude<ProofApplied, 'seen'>;

export interface TaskProofCounts {
  seen: number;
  skipped: Partial<Record<TaskProofSkip, number>>;
  rejected: number;
}

/**
 * Matches each proof to one ticked task still waiting for its proof and marks
 * it seen: by `task_id` when the task exists and its title agrees, else by
 * title among those ticked tasks when exactly one matches. A proof for an
 * open task, a task already seen or confirmed, or evidence older than the
 * task changes nothing.
 */
export async function applyTaskProofs(
  store: DataStore,
  organizationId: string,
  proofs: readonly RelayProof[],
  opts: { now?: Date; rejected?: number } = {},
): Promise<TaskProofCounts> {
  const counts: TaskProofCounts = { seen: 0, skipped: {}, rejected: opts.rejected ?? 0 };
  if (proofs.length === 0) return counts;
  const skip = (reason: TaskProofSkip) => {
    counts.skipped[reason] = (counts.skipped[reason] ?? 0) + 1;
  };
  const awaiting = await listAwaitingProof(store, organizationId, opts.now ?? new Date());
  const sameTitle = (task: Task, title: string) =>
    titleKey(task.title) === title || titleKey(snapshotTitle(task.title)) === title;

  for (const { proof, postedAt, slackTs } of proofs) {
    const title = titleKey(proof.title);
    let waiting = proof.task_id ? awaiting.find((row) => row.task.id === proof.task_id) : undefined;
    if (proof.task_id && !waiting) {
      const byId = (await store.get('tasks', organizationId, proof.task_id)) as Task | null;
      if (byId && !sameTitle(byId, title)) {
        skip('id_title_mismatch');
        continue;
      }
      if (byId) {
        skip('not_awaiting');
        continue;
      }
    }
    if (waiting && !sameTitle(waiting.task, title)) {
      skip('id_title_mismatch');
      continue;
    }
    if (!waiting) {
      const matches = awaiting.filter((row) => sameTitle(row.task, title));
      if (matches.length > 1) {
        skip('ambiguous');
        continue;
      }
      waiting = matches[0];
    }
    if (!waiting) {
      skip('no_ticked_match');
      continue;
    }
    const applied = await applyProofEvidence(
      store,
      organizationId,
      waiting.task,
      {
        source: 'task-closer',
        evidence_type: proof.evidence.type,
        evidence_id: proof.evidence.id,
        evidence_at: new Date(evidenceTime(proof.evidence_at, postedAt)).toISOString(),
        thread_id: proof.evidence.thread_id ?? null,
        channel: proof.evidence.channel ?? null,
        reason: proof.reason,
        slack_ts: slackTs,
      },
      waiting.check,
    );
    if (applied === 'seen') {
      counts.seen++;
      waiting.check.state = 'seen';
    } else {
      skip(applied);
    }
  }
  if (counts.seen > 0 || counts.rejected > 0) {
    log.info('Task proofs applied', { seen: counts.seen, rejected: counts.rejected });
  }
  return counts;
}
