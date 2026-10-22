import { describe, expect, it } from 'vitest';
import { demoTuning } from '@/lib/capture/demo-tuning';
import { LevelMeter, SilenceTracker, noMeetingAudio } from '@/lib/capture/levels';
import { SilenceAutoStop, autoStopDecision } from '@/lib/capture/silence-autostop';
import { DEFAULT_TUNING } from '@/lib/capture/types';

/**
 * Meters, silence and the auto-stop (D-076, WS3): the "no meeting audio"
 * warning after 20 s, and the stop after 15 minutes of silence on every track.
 */

describe('the level meter', () => {
  it('rises fast and falls slowly', () => {
    const m = new LevelMeter();
    const up = m.update(0.3);
    expect(up).toBeGreaterThan(0.4);
    const down = m.update(0);
    expect(down).toBeGreaterThan(up * 0.7);
    for (let i = 0; i < 60; i += 1) m.update(0);
    expect(m.value).toBe(0);
  });
});

describe('silence', () => {
  it('counts quiet audio, and any sound starts it over', () => {
    const s = new SilenceTracker(0.004);
    expect(s.hear(0.001, 100)).toBe(100);
    expect(s.hear(0, 100)).toBe(200);
    expect(s.everHeard).toBe(false);
    expect(s.hear(0.05, 100)).toBe(0);
    expect(s.everHeard).toBe(true);
  });

  it('warns about missing meeting audio after 20 s of it', () => {
    expect(noMeetingAudio(19_900, DEFAULT_TUNING.noMeetingAudioWarningMs)).toBe(false);
    expect(noMeetingAudio(20_000, DEFAULT_TUNING.noMeetingAudioWarningMs)).toBe(true);
  });
});

describe('the auto-stop', () => {
  const minutes = (n: number) => n * 60_000;
  const input = (silent: number[], ended = false, micSinceEnd = 0) => ({
    silentMs: silent,
    meetingAudioEnded: ended,
    micSilentSinceEndMs: micSinceEnd,
  });

  it('stops after 15 minutes of silence on every track, warning a minute before', () => {
    expect(autoStopDecision(input([minutes(14), minutes(20)]), DEFAULT_TUNING)).toEqual({
      kind: 'warn',
      remainingMs: minutes(1),
    });
    expect(autoStopDecision(input([minutes(15), minutes(15)]), DEFAULT_TUNING)).toEqual({
      kind: 'stop',
      reason: 'silence',
    });
    // One track still has sound: no stop.
    expect(autoStopDecision(input([0, minutes(30)]), DEFAULT_TUNING)).toEqual({ kind: 'none' });
  });

  it('stops when the call window went away and the mic has been quiet since', () => {
    expect(autoStopDecision(input([0], true, minutes(1)), DEFAULT_TUNING).kind).toBe('none');
    expect(autoStopDecision(input([0], true, minutes(2)), DEFAULT_TUNING)).toEqual({
      kind: 'stop',
      reason: 'call_ended',
    });
  });

  it('fires each outcome once, and sound clears the warning', () => {
    const events: string[] = [];
    const auto = new SilenceAutoStop(DEFAULT_TUNING, {
      onWarn: () => events.push('warn'),
      onClear: () => events.push('clear'),
      onStop: (reason) => events.push(`stop:${reason}`),
    });
    auto.update(input([minutes(14.5)]));
    auto.update(input([0]));
    auto.update(input([minutes(15)]));
    auto.update(input([minutes(16)]));
    expect(events).toEqual(['warn', 'clear', 'stop:silence']);
  });
});

describe('demo tuning from the address bar', () => {
  it('reads the test knobs within bounds', () => {
    expect(
      demoTuning({
        speed: '8',
        silence: '4000',
        threshold: '0.99',
        upload: '500',
        nomeeting: '2000',
      }),
    ).toEqual({
      mockSpeed: 8,
      silenceAutoStopMs: 4000,
      silenceAutoStopWarningMs: 1000,
      silenceThreshold: 0.99,
      uploadIntervalMs: 500,
      noMeetingAudioWarningMs: 2000,
    });
    expect(demoTuning({ speed: '9999', silence: '10' })).toMatchObject({
      mockSpeed: 50,
      silenceAutoStopMs: 1000,
    });
    expect(demoTuning({ speed: 'fast' })).toEqual({});
  });
});
