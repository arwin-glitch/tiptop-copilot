import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '@/lib/capture/api-client';
import {
  SegmentUploader,
  toSegmentUpload,
  type LineForUpload,
  type SendSegments,
} from '@/lib/capture/segment-uploader';
import type { SegmentUpload, UploadSegmentsResponse } from '@/lib/types/notes';

/**
 * Lines to the server (D-076, WS3): a rising seq that never changes across
 * retries, so a retried batch is stored once, and nothing is lost while the
 * network is away. The fake server below upserts on seq the way
 * POST /segments does.
 */

class FakeServer {
  stored = new Map<number, SegmentUpload>();
  requests: SegmentUpload[][] = [];
  /** Next requests fail like this, in order. */
  failures: ('network' | 'lost_answer' | 503 | 409)[] = [];

  send: SendSegments = async (segments) => {
    this.requests.push(segments);
    const failure = this.failures.shift();
    if (failure === 'network' || failure === 503) {
      return {
        ok: false,
        error: {
          code: 'network',
          message: 'down',
          status: failure === 503 ? 503 : 0,
          retryable: true,
        },
      };
    }
    if (failure === 409) {
      return {
        ok: false,
        error: {
          code: 'conflict',
          message: 'This meeting is not being recorded.',
          status: 409,
          retryable: false,
        },
      };
    }
    let accepted = 0;
    let duplicates = 0;
    for (const s of segments) {
      if (this.stored.has(s.seq)) duplicates += 1;
      else {
        this.stored.set(s.seq, s);
        accepted += 1;
      }
    }
    if (failure === 'lost_answer') {
      // Stored, but the answer never reached the browser.
      return { ok: false, error: { code: 'network', message: 'lost', status: 0, retryable: true } };
    }
    const result: ApiResult<UploadSegmentsResponse> = {
      ok: true,
      value: {
        ok: true,
        accepted,
        duplicates,
        dropped: 0,
        lastSeq: Math.max(...this.stored.keys()),
        speakers: [],
      },
    };
    return result;
  };
}

const line = (i: number, over: Partial<LineForUpload> = {}): LineForUpload => ({
  track: i % 2 === 0 ? 'mic' : 'system',
  speakerLabel: i % 2 === 0 ? null : 'S1',
  startMs: i * 1000,
  endMs: i * 1000 + 800,
  text: `Line ${i}.`,
  confidence: 0.9,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the upload shape', () => {
  it('whole, non-negative milliseconds, the cluster key, trimmed text', () => {
    expect(
      toSegmentUpload(
        {
          track: 'system',
          speakerLabel: 'S2',
          startMs: -3.4,
          endMs: 1200.6,
          text: '  Hi.  ',
          confidence: 1.4,
        },
        7,
      ),
    ).toEqual({
      seq: 7,
      track: 'system',
      clusterKey: 'sys:S2',
      vendorLabel: 'S2',
      startMs: 0,
      endMs: 1201,
      text: 'Hi.',
      confidence: 1,
      isFinal: true,
    });
    expect(toSegmentUpload(line(0), 0).clusterKey).toBe('mic');
    expect(toSegmentUpload({ ...line(1), speakerLabel: 'not a label!' }, 1).clusterKey).toBe(
      'sys:unknown',
    );
    const long = toSegmentUpload({ ...line(0), text: 'x'.repeat(5000) }, 2);
    expect(long.text).toHaveLength(4000);
  });
});

describe('the segment uploader', () => {
  it('numbers lines from the meeting’s last seq, monotonic, in the order they were said', async () => {
    const server = new FakeServer();
    const up = new SegmentUploader({ send: server.send, firstSeq: 5 });
    up.push(line(2));
    up.push(line(1)); // finished later, said earlier
    up.push(line(3));
    await up.flush();
    expect([...server.stored.values()].map((s) => [s.seq, s.startMs])).toEqual([
      [5, 1000],
      [6, 2000],
      [7, 3000],
    ]);
    up.push(line(4));
    await up.flush();
    expect([...server.stored.keys()]).toEqual([5, 6, 7, 8]);
    expect(up.snapshot()).toMatchObject({ pending: 0, lastSeq: 8, retrying: false });
  });

  it('sends at most 200 lines a request', async () => {
    const server = new FakeServer();
    const up = new SegmentUploader({ send: server.send, firstSeq: 0 });
    for (let i = 0; i < 450; i += 1) up.push(line(i));
    await up.drain(10_000);
    expect(server.requests.map((r) => r.length)).toEqual([200, 200, 50]);
    expect(server.stored.size).toBe(450);
  });

  it('retries a failed batch with the same seqs: nothing lost, nothing twice', async () => {
    const server = new FakeServer();
    server.failures = ['network', 503, 'lost_answer'];
    const up = new SegmentUploader({ send: server.send, firstSeq: 0, backoffMs: [100] });
    up.push(line(0));
    up.push(line(1));
    await up.flush(); // network
    expect(up.snapshot().retrying).toBe(true);
    up.push(line(2)); // arrives during the outage
    await up.flush(); // too soon: waits out the backoff
    expect(server.requests).toHaveLength(1);
    const left = up.drain(10_000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await left).toBe(0);
    // Every attempt at the first batch used seqs 0 and 1.
    for (const r of server.requests.slice(0, 3))
      expect(r.map((s) => s.seq).slice(0, 2)).toEqual([0, 1]);
    expect([...server.stored.keys()].sort()).toEqual([0, 1, 2]);
    expect([...server.stored.values()].map((s) => s.text)).toEqual([
      'Line 0.',
      'Line 1.',
      'Line 2.',
    ]);
  });

  it('waits while offline and sends as soon as the network is back', async () => {
    const server = new FakeServer();
    let online = false;
    const up = new SegmentUploader({ send: server.send, firstSeq: 0, isOnline: () => online });
    up.push(line(0));
    await up.flush();
    expect(server.requests).toHaveLength(0);
    expect(up.pending).toBe(1);
    online = true;
    await up.flush();
    expect(server.stored.size).toBe(1);
  });

  it('posts on its interval while lines wait', async () => {
    const server = new FakeServer();
    const up = new SegmentUploader({ send: server.send, firstSeq: 0, intervalMs: 2500 });
    up.start();
    up.push(line(0));
    await vi.advanceTimersByTimeAsync(2400);
    expect(server.requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(server.requests).toHaveLength(1);
    up.stop();
  });

  it('stops on a refusal retrying cannot fix, and keeps the lines', async () => {
    const server = new FakeServer();
    server.failures = [409];
    const changes: unknown[] = [];
    const up = new SegmentUploader({
      send: server.send,
      firstSeq: 0,
      onChange: (s) => changes.push(s),
    });
    up.push(line(0));
    await up.flush();
    expect(up.snapshot().fatal).toMatchObject({ code: 'conflict' });
    expect(up.pending).toBe(1);
    await up.flush();
    expect(server.requests).toHaveLength(1);
    expect(changes.length).toBeGreaterThan(0);
  });

  it('never goes below the server’s seqs when told of them before sending', () => {
    const server = new FakeServer();
    const up = new SegmentUploader({ send: server.send, firstSeq: 0 });
    up.raiseNextSeq(12);
    expect(up.snapshot().lastSeq).toBe(11);
  });

  it('a closing page sends what fits in one keepalive request', () => {
    const sent: { segments: SegmentUpload[]; keepalive?: boolean }[] = [];
    const up = new SegmentUploader({
      send: async (segments, options) => {
        sent.push({ segments, keepalive: options?.keepalive });
        return { ok: false, error: { code: 'x', message: 'x', status: 0, retryable: true } };
      },
      firstSeq: 0,
    });
    for (let i = 0; i < 150; i += 1) up.push(line(i, { text: 'y'.repeat(800) }));
    up.flushOnPageHide();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.keepalive).toBe(true);
    expect(JSON.stringify(sent[0]?.segments).length).toBeLessThan(64_000);
    expect(sent[0]!.segments.length).toBeGreaterThan(10);
  });
});
