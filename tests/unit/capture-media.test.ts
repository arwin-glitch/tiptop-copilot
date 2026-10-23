import { describe, expect, it } from 'vitest';
import {
  DISPLAY_OPTIONS,
  MIC_CONSTRAINTS,
  NoMeetingAudioError,
  acquireMeetingAudio,
  detectCapabilities,
  mediaError,
  shareGuidance,
} from '@/lib/capture/media';

/** Getting the audio (D-076, WS3): what each browser can do, and refusals in words. */

const UA = {
  chromeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15',
};

const media = { getUserMedia: () => undefined, getDisplayMedia: () => undefined };
const win = (standalone = false) => ({
  isSecureContext: true,
  matchMedia: () => ({ matches: standalone }) as MediaQueryList,
  AudioWorkletNode: function AudioWorkletNode() {},
});

describe('capabilities', () => {
  it('Chrome on Windows: mic and meeting audio', () => {
    const caps = detectCapabilities(
      { userAgent: UA.chromeWindows, maxTouchPoints: 0, mediaDevices: media as never },
      win(),
    );
    expect(caps).toMatchObject({
      microphone: true,
      meetingAudio: true,
      audioWorklet: true,
      platform: 'windows',
      mobile: false,
    });
  });

  it('the iPhone Home Screen app: mic only, foreground', () => {
    const caps = detectCapabilities(
      {
        userAgent: UA.iphone,
        maxTouchPoints: 5,
        mediaDevices: { getUserMedia: () => undefined } as never,
        wakeLock: {},
      },
      win(true),
    );
    expect(caps).toMatchObject({
      microphone: true,
      meetingAudio: false,
      ios: true,
      standalone: true,
      mobile: true,
      wakeLock: true,
    });
  });

  it('an iPad that says it is a Mac is still an iPad', () => {
    const caps = detectCapabilities(
      { userAgent: UA.ipad, maxTouchPoints: 5, mediaDevices: media as never },
      win(),
    );
    expect(caps.ios).toBe(true);
    expect(caps.meetingAudio).toBe(false);
  });

  it('no secure context, no recording; and the server knows nothing', () => {
    const caps = detectCapabilities(
      { userAgent: UA.chromeMac, maxTouchPoints: 0, mediaDevices: media as never },
      { ...win(), isSecureContext: false },
    );
    expect(caps.microphone).toBe(false);
    expect(detectCapabilities(undefined, undefined)).toMatchObject({
      microphone: false,
      meetingAudio: false,
    });
  });
});

describe('what to share', () => {
  it('names the right picker choice for each computer', () => {
    expect(shareGuidance('windows').join(' ')).toContain('Share system audio');
    expect(shareGuidance('mac').join(' ')).toContain('Mic only');
    expect(shareGuidance('ios').join(' ')).toContain('Mic only');
  });
});

describe('the requests', () => {
  it('asks for echo cancellation on the mic and raw audio from the share', () => {
    expect(MIC_CONSTRAINTS.echoCancellation).toBe('all');
    expect(DISPLAY_OPTIONS).toMatchObject({
      video: true,
      systemAudio: 'include',
      windowAudio: 'system',
      restrictOwnAudio: true,
      selfBrowserSurface: 'exclude',
      audio: { suppressLocalAudioPlayback: false, echoCancellation: false },
    });
  });

  it('keeps the audio of a share and stops its video; refuses a share without sound', async () => {
    const stopped: string[] = [];
    const track = (kind: string) => ({ kind, stop: () => stopped.push(kind) });
    class FakeStream {
      constructor(private readonly tracks: ReturnType<typeof track>[]) {}
      getVideoTracks = () => this.tracks.filter((t) => t.kind === 'video');
      getAudioTracks = () => this.tracks.filter((t) => t.kind === 'audio');
      getTracks = () => this.tracks;
    }
    const g = globalThis as unknown as { MediaStream?: unknown };
    const saved = g.MediaStream;
    g.MediaStream = FakeStream;
    try {
      const withAudio = {
        getDisplayMedia: async () => new FakeStream([track('video'), track('audio')]),
      } as unknown as MediaDevices;
      const stream = await acquireMeetingAudio(withAudio);
      expect(stream.getAudioTracks()).toHaveLength(1);
      expect(stopped).toEqual(['video']);

      const silent = {
        getDisplayMedia: async () => new FakeStream([track('video')]),
      } as unknown as MediaDevices;
      await expect(acquireMeetingAudio(silent)).rejects.toBeInstanceOf(NoMeetingAudioError);
    } finally {
      g.MediaStream = saved;
    }
  });
});

describe('refusals in words', () => {
  it('says what to do', () => {
    expect(mediaError({ name: 'NotAllowedError' }, 'mic').code).toBe('mic_denied');
    expect(mediaError({ name: 'NotFoundError' }, 'mic').code).toBe('no_microphone');
    expect(mediaError({ name: 'NotReadableError' }, 'mic').code).toBe('mic_busy');
    expect(mediaError({ name: 'SecurityError' }, 'mic').code).toBe('blocked_by_policy');
    expect(mediaError({ name: 'NotAllowedError' }, 'meeting').code).toBe('share_cancelled');
    expect(mediaError(new Error('?'), 'meeting').stillUsable).toContain('Mic only');
    expect(new NoMeetingAudioError().recorderError.stillUsable).toContain('Also share tab audio');
  });
});
