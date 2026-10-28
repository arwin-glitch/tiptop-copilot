import { describe, expect, it } from 'vitest';
import {
  NOTES_REQUEST_MARKER,
  NOTES_RESULT_MARKER,
  assembleRoutineNotes,
  buildNotesRequest,
  collectParts,
  condenseLines,
  fitRows,
  mergeFragments,
  noBackticks,
  parseNotesResultMessage,
  plainText,
  renameInBlocks,
  type CondenseLine,
  type NotesRequestInput,
  type RoutineSpeaker,
} from '@/lib/notes/bridge-protocol';
import type { ActionItem, EnhancedBlock } from '@/lib/types/notes';

/**
 * Kraken Notes through Arwin's Claude routine (D-076, zero spend): what the
 * app sends (condensed to a budget, ids kept), and what it accepts back
 * (validated, plain text, cited ids checked, parts put together). Fictional
 * people and numbers only.
 */

const REQUEST_ID = '6f1c1d9e-3b1a-4c55-9a0e-1b2c3d4e5f60';

const L = (seq: number, speaker: string, text: string, startMs = seq * 5_000): CondenseLine => ({
  seq,
  speaker,
  startMs,
  text,
});

function input(lines: CondenseLine[], typedNotes: string | null = null): NotesRequestInput {
  return {
    requestId: REQUEST_ID,
    meetingId: '0a1b2c3d-0000-4000-8000-000000000001',
    title: 'Acme Robotics intro',
    when: '2026-10-20T15:00:00.000Z',
    timezone: 'America/Chicago',
    attendees: [
      { name: 'Dana Reyes', role: 'guest' },
      { name: 'Morgan Lee', role: 'principal' },
    ],
    template: {
      name: 'Founder pitch',
      sections: [{ heading: 'Round', prompt: 'Amount, instrument, lead.' }],
      instructions: 'First meeting with a founder. Length: standard.',
    },
    typedNotes,
    lines,
    relayChannel: 'C0TESTRELAY',
  };
}

const payloadOf = (text: string) => {
  expect(text.startsWith(`${NOTES_REQUEST_MARKER}\n\``)).toBe(true);
  return JSON.parse(text.slice(text.indexOf('`') + 1, text.lastIndexOf('`'))) as {
    request_id: string;
    attendees: { name: string; role: string }[];
    transcript: [number | null, string, string, string][];
    typed_notes: string;
    template: { name: string } | null;
    relay_channel: string;
  };
};

describe('the request: condensed, every kept line keeps its id', () => {
  it('drops fillers and back-channels, then merges a speaker’s consecutive lines', () => {
    const { merged, dropped } = condenseLines([
      L(0, 'Morgan Lee', 'So, um, what does retention look like?'),
      L(1, 'Dana Reyes', 'Mm-hmm.'),
      L(2, 'Dana Reyes', 'Uh, net revenue retention is 130 percent.'),
      L(3, 'Dana Reyes', 'Across 19 customers.'),
      L(4, 'Morgan Lee', 'Right.'),
      L(5, 'Morgan Lee', 'Yes.'),
    ]);
    expect(dropped).toBe(2);
    expect(merged.map((m) => [m.fromSeq, m.toSeq, m.speaker])).toEqual([
      [0, 0, 'Morgan Lee'],
      [2, 3, 'Dana Reyes'],
      [5, 5, 'Morgan Lee'],
    ]);
    expect(merged[0]?.text).toBe('So, what does retention look like?');
    expect(merged[1]?.text).toBe('net revenue retention is 130 percent. Across 19 customers.');
  });

  it('sends names and roles only, the template, the typed notes and the relay channel', () => {
    const built = buildNotesRequest(
      input([L(0, 'Dana Reyes', 'We are raising a $4 million seed.')], '## Take\n- Strong team'),
      60_000,
    );
    const payload = payloadOf(built.text);
    expect(payload.request_id).toBe(REQUEST_ID);
    expect(payload.attendees).toEqual([
      { name: 'Dana Reyes', role: 'guest' },
      { name: 'Morgan Lee', role: 'principal' },
    ]);
    expect(built.text).not.toMatch(/@/);
    expect(payload.template?.name).toBe('Founder pitch');
    expect(payload.typed_notes).toContain('Strong team');
    expect(payload.relay_channel).toBe('C0TESTRELAY');
    expect(payload.transcript).toEqual([
      [0, 'Dana Reyes', '0:00', 'We are raising a $4 million seed.'],
    ]);
    expect(built.lineMap).toEqual({ '0': { fromSeq: 0, toSeq: 0 } });
  });

  it('never lets a backtick through, so the JSON stays one code span', () => {
    const built = buildNotesRequest(
      input([L(0, 'Dana `the founder` Reyes', 'Run `rm -rf` on the old plan')], 'a `b` c'),
      60_000,
    );
    const inner = built.text.slice(built.text.indexOf('`') + 1, built.text.lastIndexOf('`'));
    expect(inner).not.toContain('`');
    expect(noBackticks('a`b')).toBe("a'b");
  });

  it('fits a long meeting into the budget by trimming the middle evenly, with a marker', () => {
    const lines = Array.from({ length: 600 }, (_, i) =>
      L(i, i % 2 ? 'Dana Reyes' : 'Morgan Lee', `Line number ${i} about the pilot and the round.`),
    );
    const built = buildNotesRequest(input(lines), 8_000);
    expect(built.text.length).toBeLessThanOrEqual(8_000);
    const rows = payloadOf(built.text).transcript;
    const marker = rows.findIndex((r) => r[0] === null);
    expect(marker).toBeGreaterThan(0);
    expect(rows[marker]?.[3]).toBe(`[... ${built.omitted} lines omitted ...]`);
    // The start and the end are both kept, about evenly.
    expect(rows[0]?.[0]).toBe(0);
    expect(rows[rows.length - 1]?.[0]).toBe(599);
    expect(Math.abs(marker - (rows.length - 1 - marker))).toBeLessThanOrEqual(1);
    // Every kept id is in the map; nothing omitted is.
    const kept = rows.filter((r) => r[0] !== null).map((r) => String(r[0]));
    expect(Object.keys(built.lineMap).sort()).toEqual(kept.sort());
    expect(built.sent + built.omitted).toBe(600);
  });

  it('keeps everything when it fits', () => {
    const lines = [L(0, 'A', 'one two three'), L(1, 'B', 'four five six')];
    const merged = condenseLines(lines).merged;
    expect(fitRows(merged, 10_000).omitted).toBe(0);
  });
});

/* ===================================================================== */

const part = (body: Record<string, unknown>) =>
  `${NOTES_RESULT_MARKER}\n\`${JSON.stringify({ request_id: REQUEST_ID, ...body })}\``;

describe('the result: validated, parts put together', () => {
  it('reads a part, undoing Slack’s escaping and link markup', () => {
    // As Slack hands it back: a bare domain auto-linked, an ampersand escaped.
    const text = part({ part: 1, of: 1, notes: { summary: 'acme.example & co' } })
      .replace('acme.example', '<http://acme.example|acme.example>')
      .replace('&', '&amp;');
    const parsed = parseNotesResultMessage(text);
    expect(parsed?.request_id).toBe(REQUEST_ID);
    expect(parsed?.notes?.summary).toBe('acme.example & co');
    expect(parseNotesResultMessage('ASK_ANSWER_V1\n`{}`')).toBeNull();
    expect(parseNotesResultMessage(`${NOTES_RESULT_MARKER}\n\`{not json\``)).toBeNull();
    expect(parseNotesResultMessage(`${NOTES_RESULT_MARKER}\n\`{"request_id":"nope"}\``)).toBeNull();
    expect(parseNotesResultMessage(part({ part: 3, of: 2, notes: {} }))).toBeNull();
  });

  it('tolerates a fenced block and loose shapes: a bullet as a string, one source as a number', () => {
    const fenced = `${NOTES_RESULT_MARKER}\n\`\`\`json\n${JSON.stringify({
      request_id: REQUEST_ID,
      notes: {
        sections: [{ heading: 'Round', bullets: ['Raising $4M', { text: 'Lead', sources: 7 }] }],
      },
    })}\n\`\`\``;
    const parsed = parseNotesResultMessage(fenced);
    expect(parsed?.part).toBe(1);
    expect(parsed?.notes?.sections?.[0]?.bullets).toEqual([
      { text: 'Raising $4M' },
      { text: 'Lead', sources: ['7'] },
    ]);
  });

  it('waits for every part, in any order, then merges them; a repeated part is the same part', () => {
    const p2 = parseNotesResultMessage(
      part({
        part: 2,
        of: 2,
        notes: {
          sections: [
            { heading: 'Round', bullets: [{ text: 'Closing in November', sources: [3] }] },
          ],
        },
      }),
    )!;
    const p1 = parseNotesResultMessage(
      part({
        part: 1,
        of: 2,
        notes: {
          summary: 'A seed round with a lead.',
          sections: [{ heading: 'Round', bullets: [{ text: 'Raising $4M', sources: [1] }] }],
        },
      }),
    )!;
    const first = collectParts(null, [p2]);
    expect(first.complete).toBe(false);
    const both = collectParts(first.parts, [p1, p2]);
    expect(both.complete).toBe(true);
    const merged = mergeFragments(both.parts);
    expect(merged.summary).toBe('A seed round with a lead.');
    expect(merged.sections).toHaveLength(1);
    expect(merged.sections?.[0]?.bullets.map((b) => b.text)).toEqual([
      'Raising $4M',
      'Closing in November',
    ]);
  });

  it('a part that says the routine could not write them completes the result as an error', () => {
    const failed = parseNotesResultMessage(part({ error: 'The transcript was empty.' }))!;
    const { parts, complete } = collectParts(null, [failed]);
    expect(complete).toBe(true);
    expect(parts.error).toBe('The transcript was empty.');
  });
});

/* ===================================================================== */

const SPEAKERS: RoutineSpeaker[] = [
  { clusterKey: 'mic', name: 'Morgan Lee', email: 'morgan@tiptop.example', isPrincipal: true },
  {
    clusterKey: 'sys:S1',
    name: 'Dana Reyes',
    email: 'dana@acmerobotics.example',
    isPrincipal: false,
  },
];
const LINE_MAP = {
  '1': { fromSeq: 1, toSeq: 2 },
  '4': { fromSeq: 4, toSeq: 4 },
  '9': { fromSeq: 9, toSeq: 11 },
};

describe('assembly: what may be stored', () => {
  it('keeps typed lines word for word at the top, then the summary, sections, decisions and questions', () => {
    const { blocks, points } = assembleRoutineNotes({
      notes: {
        summary: '**Strong** first meeting.',
        sections: [
          { heading: '## Round', bullets: [{ text: '- Raising $4M seed [4]', sources: ['1'] }] },
          { heading: 'Empty', bullets: [] },
        ],
        decisions: [{ text: 'Second meeting with the team', sources: [9] as unknown as string[] }],
        // A bare string, as a routine might write it: a point with no sources.
        open_questions: ['Who leads?'] as unknown as { text: string }[],
      },
      lineMap: LINE_MAP,
      typedNotes: '## Our take\n- Retention is the story',
      speakers: SPEAKERS,
      principalName: 'Morgan Lee',
      meetingDay: '2026-10-20',
    });
    expect(blocks.slice(0, 2).map((b) => [b.source, b.text])).toEqual([
      ['typed', 'Our take'],
      ['typed', 'Retention is the story'],
    ]);
    const ai = blocks.filter((b) => b.source === 'ai');
    expect(ai.map((b) => b.text)).toEqual([
      'Summary',
      'Strong first meeting.',
      'Round',
      'Raising $4M seed',
      'Decisions',
      'Second meeting with the team',
      'Open questions',
      'Who leads?',
    ]);
    // "[4]" in the words became a source; "1" stands for lines 1 to 2.
    expect(ai.find((b) => b.text === 'Raising $4M seed')?.sources).toEqual([
      { fromSeq: 1, toSeq: 2 },
      { fromSeq: 4, toSeq: 4 },
    ]);
    expect(points).toBe(4);
  });

  it('drops cited ids that were never sent, and counts them', () => {
    const { blocks, unknownIds } = assembleRoutineNotes({
      notes: {
        sections: [{ heading: 'Team', bullets: [{ text: 'Two founders', sources: ['77', '4'] }] }],
      },
      lineMap: LINE_MAP,
      typedNotes: null,
      speakers: SPEAKERS,
      principalName: null,
      meetingDay: '2026-10-20',
    });
    expect(blocks.find((b) => b.text === 'Two founders')?.sources).toEqual([
      { fromSeq: 4, toSeq: 4 },
    ]);
    expect(unknownIds).toBe(1);
  });

  it('owns action items by the voices, flags the principal’s promises, reads due dates, keeps tasks', () => {
    const previous: ActionItem[] = [
      {
        id: 'old',
        text: 'Send the data room',
        ownerEmail: null,
        ownerName: 'Dana Reyes',
        ownerClusterKey: 'sys:S1',
        due: null,
        isPrincipalPromise: false,
        taskId: 'task-1',
        sources: [],
      },
    ];
    const { actionItems, blocks } = assembleRoutineNotes({
      notes: {
        action_items: [
          {
            text: 'Intro to our operations lead',
            owner_name: 'Morgan',
            due: 'by Friday',
            is_nick_promise: true,
            sources: ['9'],
          },
          {
            text: 'Send the data room',
            owner_name: 'Dana Reyes',
            due: '2026-10-23',
            sources: ['4'],
          },
          { text: '   ', owner_name: 'Nobody' },
        ],
      },
      lineMap: LINE_MAP,
      typedNotes: null,
      speakers: SPEAKERS,
      principalName: 'Morgan Lee',
      meetingDay: '2026-10-20',
      previous,
    });
    expect(actionItems).toHaveLength(2);
    expect(actionItems[0]).toMatchObject({
      ownerName: 'Morgan Lee',
      ownerClusterKey: 'mic',
      isPrincipalPromise: true,
      due: '2026-10-23',
      sources: [{ fromSeq: 9, toSeq: 11 }],
    });
    expect(actionItems[1]).toMatchObject({
      ownerEmail: 'dana@acmerobotics.example',
      isPrincipalPromise: false,
      due: '2026-10-23',
      taskId: 'task-1',
    });
    expect(blocks.filter((b) => b.kind === 'checkbox').map((b) => b.text)).toEqual([
      'Morgan Lee: Intro to our operations lead',
      'Dana Reyes: Send the data room',
    ]);
  });

  it('makes every text plain and capped', () => {
    expect(plainText('  # **Big** `news`\n\n  here  ', 100)).toBe("Big 'news' here");
    expect(plainText('x'.repeat(50), 10).length).toBeLessThanOrEqual(10);
    expect(plainText({ not: 'text' }, 10)).toBe('');
  });
});

describe('renaming in place', () => {
  it('renames what Arwin wrote, whole words only, never a typed line', () => {
    const blocks: EnhancedBlock[] = [
      { id: 't', kind: 'bullet', text: 'Guest 1 is great', depth: 0, source: 'typed', sources: [] },
      {
        id: 'a',
        kind: 'bullet',
        text: 'Guest 1 said 130 percent',
        depth: 0,
        source: 'ai',
        sources: [],
      },
      {
        id: 'b',
        kind: 'bullet',
        text: 'Guest 10 joined late',
        depth: 0,
        source: 'ai',
        sources: [],
      },
    ];
    const { blocks: out, changed } = renameInBlocks(blocks, new Map([['Guest 1', 'Sam $1 Lee']]));
    expect(out.map((b) => b.text)).toEqual([
      'Guest 1 is great',
      'Sam $1 Lee said 130 percent',
      'Guest 10 joined late',
    ]);
    expect(changed).toBe(1);
  });
});
