import { describe, expect, it } from 'vitest';
import {
  certaintyWords,
  groupLines,
  initials,
  lengthWords,
  linesInRanges,
  mergeSegments,
  platformOf,
  segmentAt,
  slashQuery,
  speakerLookup,
  splitCitations,
  toggleLinePrefix,
  wrapSelection,
} from '@/components/notes/helpers';
import type { ChatCitation, SegmentView, SpeakerView } from '@/lib/types/notes';

/** The Notes screens' pure helpers (D-076). Fictional people only. */

function line(seq: number, clusterKey: string, startMs: number, text = `line ${seq}`): SegmentView {
  return {
    seq,
    track: clusterKey === 'mic' ? 'mic' : 'system',
    clusterKey,
    startMs,
    endMs: startMs + 1000,
    text,
    edited: false,
    originalText: null,
    isFinal: true,
    confidence: null,
  };
}

function voice(
  clusterKey: string,
  displayName: string,
  extra: Partial<SpeakerView> = {},
): SpeakerView {
  return {
    clusterKey,
    track: clusterKey === 'mic' ? 'mic' : 'system',
    displayName,
    personEmail: null,
    crmPersonId: null,
    resolved: !displayName.startsWith('Guest'),
    isOwner: clusterKey === 'mic',
    source: null,
    certainty: 'unknown',
    confidence: null,
    locked: false,
    suggestions: [],
    mergedInto: null,
    lineCount: 0,
    canRememberVoice: false,
    ...extra,
  };
}

describe('voices', () => {
  it('reads a merged voice as the one it joined, and an unknown key as a guest', () => {
    const resolve = speakerLookup([
      voice('sys:S1', 'Dana Reyes'),
      voice('sys:S3', 'Guest 2', { mergedInto: 'sys:S1' }),
    ]);
    expect(resolve('sys:S3').displayName).toBe('Dana Reyes');
    expect(resolve('sys:S9')).toMatchObject({ displayName: 'Guest', resolved: false });
  });

  it('groups consecutive lines of one voice, merged voices together', () => {
    const resolve = speakerLookup([
      voice('mic', 'Alex Morgan'),
      voice('sys:S1', 'Dana Reyes'),
      voice('sys:S3', 'Guest 2', { mergedInto: 'sys:S1' }),
    ]);
    const groups = groupLines(
      [line(0, 'mic', 0), line(1, 'sys:S1', 1000), line(2, 'sys:S3', 2000), line(3, 'mic', 3000)],
      resolve,
    );
    expect(groups.map((g) => [g.clusterKey, g.lines.length])).toEqual([
      ['mic', 1],
      ['sys:S1', 2],
      ['mic', 1],
    ]);
  });

  it('says how sure a name is in plain words, and makes initials', () => {
    expect(certaintyWords('channel')).toBe('Their own mic');
    expect(certaintyWords('confirmed')).toBe('You confirmed');
    expect(initials('Priya Shah')).toBe('PS');
    expect(initials('dana@acmerobotics.example')).toBe('D');
    expect(initials(null)).toBe('?');
  });
});

describe('transcript', () => {
  it('merges lines by seq, a newer copy winning', () => {
    const merged = mergeSegments(
      [line(0, 'mic', 0), line(2, 'mic', 2000)],
      [line(1, 'sys:S1', 1000), { ...line(2, 'mic', 2000), text: 'fixed', edited: true }],
    );
    expect(merged.map((s) => s.seq)).toEqual([0, 1, 2]);
    expect(merged[2]?.text).toBe('fixed');
  });

  it('finds the line said at a moment, and the lines behind a note point', () => {
    const lines = [line(0, 'mic', 0), line(1, 'sys:S1', 5000), line(2, 'sys:S2', 9000)];
    expect(segmentAt(lines, 6000)?.seq).toBe(1);
    expect(segmentAt(lines, 0)?.seq).toBe(0);
    expect(linesInRanges(lines, [{ fromSeq: 1, toSeq: 2 }]).map((s) => s.seq)).toEqual([1, 2]);
    expect(linesInRanges(lines, [])).toEqual([]);
  });
});

describe('notepad', () => {
  it('spots a slash command at the start of a word, not inside one', () => {
    expect(slashQuery('Hello\n/act', 10)).toEqual({ start: 6, query: 'act' });
    expect(slashQuery('see /tem', 8)).toEqual({ start: 4, query: 'tem' });
    expect(slashQuery('and/or', 6)).toBeNull();
  });

  it('toggles a prefix on every selected line, and wraps a selection', () => {
    const on = toggleLinePrefix('one\ntwo', 0, 7, '- ');
    expect(on.text).toBe('- one\n- two');
    expect(toggleLinePrefix(on.text, 0, on.text.length, '- ').text).toBe('one\ntwo');
    expect(wrapSelection('make bold', 5, 9, '**').text).toBe('make **bold**');
  });
});

describe('chat and meetings', () => {
  it('splits an answer around the lines it cites', () => {
    const cite: ChatCitation = {
      meetingId: 'm1',
      seq: 4,
      startMs: 28_500,
      speaker: 'Dana Reyes',
      label: '[0:28 Dana Reyes]',
    };
    const parts = splitCitations('Revenue: [0:28 Dana Reyes] "1.2 million".', [cite]);
    expect(parts).toEqual([
      { kind: 'text', text: 'Revenue: ' },
      { kind: 'cite', citation: cite },
      { kind: 'text', text: ' "1.2 million".' },
    ]);
    expect(splitCitations('Nothing cited.', [cite])).toEqual([
      { kind: 'text', text: 'Nothing cited.' },
    ]);
  });

  it('names the meeting app and the recorded length', () => {
    expect(platformOf('https://meet.google.com/abc-defg-hij')).toBe('meet');
    expect(platformOf('https://example.zoom.us/j/1')).toBe('zoom');
    expect(platformOf(null)).toBeNull();
    expect(lengthWords(134_000)).toBe('2 min');
    expect(lengthWords(4_500_000)).toBe('1 h 15 min');
    expect(lengthWords(0)).toBeNull();
  });
});
