import type {
  MeetingChatOutput,
  MeetingCuesOutput,
  MeetingNotesOutput,
} from '@/lib/ai/prompts/meeting-notes';
import { findCues, type CueCandidate } from '@/lib/speakers/transcript-cues';
import { draftPicks, dueFromText } from './draft';

/**
 * The offline model's answers to Copilot Notes' three calls (D-076), for
 * demo mode and the tests. Like the rest of MockAIProvider it reads the same
 * <context> and fenced sources the real model gets and derives its answer
 * from them: the rules draft (lib/notes/draft.ts) for the notes, the
 * rule-based cue finder for the cue pass, and the best-matching lines for
 * chat. Its answers then go through the same checks a real answer does.
 */

interface Source {
  kind: string;
  text: string;
}

interface TranscriptRow {
  meeting: number;
  seq: number;
  startMs: number;
  name: string;
  text: string;
}

const ROW_RE = /^(?:M(\d+)\.)?L(\d+) \[(\d+):(\d{2})(?::(\d{2}))?\] ([^:]+): (.*)$/;

function rows(sources: readonly Source[]): TranscriptRow[] {
  const out: TranscriptRow[] = [];
  for (const s of sources) {
    if (s.kind !== 'transcript') continue;
    for (const line of s.text.split('\n')) {
      const m = ROW_RE.exec(line.trim());
      if (!m) continue;
      const [a, b, c] = m[5] !== undefined ? [m[3], m[4], m[5]] : ['0', m[3], m[4]];
      out.push({
        meeting: Number(m[1] ?? 0),
        seq: Number(m[2]),
        startMs: (Number(a) * 3600 + Number(b) * 60 + Number(c)) * 1000,
        name: (m[6] ?? '').trim(),
        text: (m[7] ?? '').trim(),
      });
    }
  }
  return out;
}

interface Voice {
  cluster_key: string;
  name: string;
  is_recorder?: boolean;
}

function voicesOf(context: Record<string, unknown>): Voice[] {
  return Array.isArray(context.voices) ? (context.voices as Voice[]) : [];
}

function notes(context: Record<string, unknown>, sources: readonly Source[]): MeetingNotesOutput {
  const voices = voicesOf(context);
  const keyOf = new Map(voices.map((v) => [v.name, v.cluster_key]));
  const lines = rows(sources);
  const typedCount = Number(context.typed_line_count ?? 0) || 0;
  const meeting = (context.meeting ?? {}) as { date?: string };
  const template = (context.template ?? null) as { sections?: { heading: string }[] } | null;
  const sections = template?.sections ?? [];
  const firstHeading = sections[0]?.heading ?? 'Summary';
  const nextHeading =
    sections.find((s) => /next steps|action items/i.test(s.heading))?.heading ?? 'Next steps';
  const { keyPoints, promises } = draftPicks(
    lines.map((l) => ({
      seq: l.seq,
      cluster_key: keyOf.get(l.name) ?? 'unknown',
      text: l.text,
      edited_text: null,
    })),
  );
  const nameOf = new Map(lines.map((l) => [l.seq, l.name]));
  const blocks: MeetingNotesOutput['blocks'] = [
    { kind: 'heading', text: firstHeading, depth: 0, typed_index: null, sources: [] },
    ...Array.from({ length: typedCount }, (_, i) => ({
      kind: 'bullet' as const,
      text: '',
      depth: 0,
      typed_index: i,
      sources: [],
    })),
    ...keyPoints.map((p) => ({
      kind: 'bullet' as const,
      text: `${nameOf.get(p.seq) ?? 'Someone'}: ${p.text}`,
      depth: 0,
      typed_index: null,
      sources: [{ from_seq: p.seq, to_seq: p.seq }],
    })),
  ];
  if (promises.length) {
    blocks.push({ kind: 'heading', text: nextHeading, depth: 0, typed_index: null, sources: [] });
    for (const p of promises) {
      blocks.push({
        kind: 'bullet',
        text: `${nameOf.get(p.seq) ?? 'Someone'}: ${p.text}`,
        depth: 0,
        typed_index: null,
        sources: [{ from_seq: p.seq, to_seq: p.seq }],
      });
    }
  }
  return {
    blocks,
    action_items: promises.map((p) => ({
      text: p.text,
      owner_cluster_key: keyOf.get(nameOf.get(p.seq) ?? '') ?? null,
      due: meeting.date ? dueFromText(p.text, meeting.date) : null,
      sources: [{ from_seq: p.seq, to_seq: p.seq }],
    })),
    injection_observed: sources.some((s) => /SECURITY NOTE/.test(s.text)),
  };
}

function cues(context: Record<string, unknown>, sources: readonly Source[]): MeetingCuesOutput {
  const voices = voicesOf(context);
  const keyOf = new Map(voices.map((v) => [v.name, v.cluster_key]));
  const candidates: CueCandidate[] = Array.isArray(context.candidates)
    ? (context.candidates as { key: string; name: string }[]).map((c) => ({
        key: c.key,
        name: c.name,
        email: null,
        crmPersonId: null,
      }))
    : [];
  const owners = new Set(voices.filter((v) => v.is_recorder).map((v) => v.cluster_key));
  const evidence = findCues(
    rows(sources).map((l) => ({
      seq: l.seq,
      clusterKey: keyOf.get(l.name) ?? 'unknown',
      startMs: l.startMs,
      text: l.text,
    })),
    candidates,
    owners,
  );
  return {
    cues: evidence.map((e) => ({
      cluster_key: e.clusterKey,
      candidate_key: e.candidateKey,
      seq: e.seq,
      reason: e.reason,
    })),
  };
}

const STOP = new Set(
  'a an and are as at be by do does did for from how i in is it its me my of on or our so that the their them they this to us was we what when where which who why will with you your about'.split(
    ' ',
  ),
);
const words = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));

function chat(context: Record<string, unknown>, sources: readonly Source[]): MeetingChatOutput {
  const question = String(context.question ?? '');
  const want = new Set(words(question));
  const scored = rows(sources)
    .map((r) => ({ r, score: words(r.text).filter((w) => want.has(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.r.meeting - b.r.meeting || a.r.seq - b.r.seq)
    .slice(0, 3);
  if (scored.length === 0) {
    return {
      answer: "I couldn't find anything about that in these meetings.",
      injection_observed: false,
    };
  }
  const quotes = scored.map(
    ({ r }) =>
      `${r.name} said "${r.text.length > 200 ? `${r.text.slice(0, 199)}…` : r.text}" [[M${r.meeting}.L${r.seq}]]`,
  );
  return { answer: `Here's what I found. ${quotes.join(' ')}`, injection_observed: false };
}

/** The offline answer for a Copilot Notes operation, or undefined for any other. */
export function mockMeetingOutput(
  operation: string,
  context: Record<string, unknown>,
  sources: readonly Source[],
): unknown {
  switch (operation) {
    case 'meeting.notes':
      return notes(context, sources);
    case 'meeting.cues':
      return cues(context, sources);
    case 'meeting.chat':
      return chat(context, sources);
    default:
      return undefined;
  }
}
