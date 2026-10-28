import type { RecorderCapabilities, RecorderError } from './types';

/**
 * Getting the audio (D-076): the microphone, and the meeting's audio from a
 * shared tab or screen. Client-safe; every browser call is behind a check.
 *
 * Track M, the microphone, with Chrome's strongest echo cancellation
 * ('all', Chrome 141) so remote voices played on speakers do not leak into
 * the owner's lines. Older browsers read the string as plain `true`.
 *
 * Track S, the meeting audio: getDisplayMedia must ask for video (we stop the
 * video track at once and keep only the audio) and needs a click every time.
 * The meeting audio is taken raw: echo cancellation on it would fight the
 * very audio we want.
 *  - Google Meet: share the Meet tab with "Also share tab audio".
 *  - Zoom or Teams desktop on Windows: "Entire screen" + "Share system audio".
 *  - Zoom desktop on a Mac: Chrome cannot hear other apps there; join Zoom's
 *    web client in a Chrome tab, or record in "Mic only" mode.
 */

export const MIC_CONSTRAINTS: MediaTrackConstraints = {
  // 'all' is newer than the DOM types; at runtime older browsers coerce it to true.
  echoCancellation: 'all' as unknown as boolean,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};

export const DISPLAY_OPTIONS = {
  video: true,
  audio: {
    suppressLocalAudioPlayback: false,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
  systemAudio: 'include',
  windowAudio: 'system',
  restrictOwnAudio: true,
  selfBrowserSurface: 'exclude',
  surfaceSwitching: 'include',
} as const;

type Nav = Pick<Navigator, 'mediaDevices' | 'userAgent' | 'maxTouchPoints'> & {
  userAgentData?: { platform?: string; mobile?: boolean };
  wakeLock?: unknown;
  standalone?: boolean;
};

export function detectCapabilities(
  nav: Nav | undefined = typeof navigator === 'undefined' ? undefined : navigator,
  win:
    | (Pick<Window, 'matchMedia' | 'isSecureContext'> & { AudioWorkletNode?: unknown })
    | undefined = typeof window === 'undefined' ? undefined : window,
): RecorderCapabilities {
  const ua = nav?.userAgent ?? '';
  const uaPlatform = nav?.userAgentData?.platform ?? '';
  // iPadOS reports itself as a Mac; touch gives it away.
  const ios =
    /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && (nav?.maxTouchPoints ?? 0) > 1);
  const android = /Android/i.test(ua);
  const platform: RecorderCapabilities['platform'] = ios
    ? 'ios'
    : android
      ? 'android'
      : /Windows/i.test(uaPlatform || ua)
        ? 'windows'
        : /CrOS|Chrome OS/i.test(uaPlatform || ua)
          ? 'chromeos'
          : /Mac/i.test(uaPlatform || ua)
            ? 'mac'
            : /Linux/i.test(uaPlatform || ua)
              ? 'linux'
              : 'other';
  const mobile = ios || android || nav?.userAgentData?.mobile === true;
  const secure = win?.isSecureContext !== false;
  const md = nav?.mediaDevices as
    (MediaDevices & { getDisplayMedia?: unknown; getUserMedia?: unknown }) | undefined;
  let standalone = nav?.standalone === true;
  try {
    standalone = standalone || Boolean(win?.matchMedia?.('(display-mode: standalone)').matches);
  } catch {
    // matchMedia missing: not standalone.
  }
  return {
    microphone: secure && typeof md?.getUserMedia === 'function',
    meetingAudio: secure && !mobile && typeof md?.getDisplayMedia === 'function',
    audioWorklet: typeof win?.AudioWorkletNode === 'function',
    wakeLock: Boolean(nav?.wakeLock),
    ios,
    standalone,
    mobile,
    platform,
  };
}

/** What to share, in words for this computer. */
export function shareGuidance(platform: RecorderCapabilities['platform']): string[] {
  const meet = 'Google Meet: pick the Meet tab and keep "Also share tab audio" on.';
  switch (platform) {
    case 'windows':
    case 'chromeos':
      return [meet, 'Zoom or Teams app: pick "Entire screen" and tick "Share system audio".'];
    case 'mac':
      return [
        meet,
        'Zoom or Teams app: Chrome cannot hear other apps on a Mac. Join from the web version in a Chrome tab and share that tab, or record in "Mic only" mode.',
      ];
    case 'linux':
      return [meet, 'Other apps: join from their web version in a Chrome tab and share that tab.'];
    default:
      return ['This device records the microphone only: use "Mic only" mode.'];
  }
}

/** A browser refusal, in words. */
export function mediaError(error: unknown, what: 'mic' | 'meeting'): RecorderError {
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
  if (what === 'meeting') {
    if (name === 'NotAllowedError' || name === 'AbortError') {
      return {
        code: 'share_cancelled',
        message: 'Sharing was cancelled, so Kraken cannot hear the meeting.',
        stillUsable:
          'Start again and pick the meeting tab or screen, or record in "Mic only" mode.',
      };
    }
    if (name === 'SecurityError') return blockedByPolicy();
    if (name === 'NotSupportedError' || name === 'TypeError') {
      return {
        code: 'meeting_audio_unsupported',
        message: 'This browser cannot share meeting audio.',
        stillUsable: 'Use Chrome or Edge on a computer, or record in "Mic only" mode.',
      };
    }
    return {
      code: 'share_failed',
      message: 'The meeting audio could not be shared.',
      stillUsable: 'Try again, or record in "Mic only" mode.',
    };
  }
  if (name === 'NotAllowedError') {
    return {
      code: 'mic_denied',
      message: 'Kraken is not allowed to use the microphone.',
      stillUsable:
        'Allow the microphone for this site in the browser (the icon at the left of the address bar), then start again.',
    };
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return {
      code: 'no_microphone',
      message: 'No microphone was found.',
      stillUsable: 'Plug one in or pick one in your computer settings, then start again.',
    };
  }
  if (name === 'NotReadableError') {
    return {
      code: 'mic_busy',
      message: 'The microphone is busy or blocked by your computer.',
      stillUsable: 'Close other apps that use it, check your privacy settings, then start again.',
    };
  }
  if (name === 'SecurityError') return blockedByPolicy();
  return {
    code: 'mic_failed',
    message: 'The microphone could not be started.',
    stillUsable: 'Try again, or use Chrome.',
  };
}

function blockedByPolicy(): RecorderError {
  return {
    code: 'blocked_by_policy',
    message: 'This page is not allowed to record.',
    stillUsable: 'Open the meeting from Kraken itself (not inside another site), then start again.',
  };
}

export async function acquireMicrophone(
  md: Pick<MediaDevices, 'getUserMedia'> = navigator.mediaDevices,
): Promise<MediaStream> {
  try {
    return await md.getUserMedia({ audio: MIC_CONSTRAINTS, video: false });
  } catch (error) {
    // A browser that rejects the constraints themselves gets a plain request.
    if (
      error &&
      typeof error === 'object' &&
      'name' in error &&
      error.name === 'OverconstrainedError'
    ) {
      return md.getUserMedia({ audio: true, video: false });
    }
    throw error;
  }
}

/**
 * Ask for the meeting's tab or screen. Must run straight from a click. Keeps
 * the audio only; a share without audio is refused with what to tick.
 */
export async function acquireMeetingAudio(
  md: MediaDevices = navigator.mediaDevices,
): Promise<MediaStream> {
  const stream = await (md.getDisplayMedia as (options: unknown) => Promise<MediaStream>).call(
    md,
    DISPLAY_OPTIONS,
  );
  for (const video of stream.getVideoTracks()) video.stop();
  if (stream.getAudioTracks().length === 0) {
    for (const t of stream.getTracks()) t.stop();
    throw new NoMeetingAudioError();
  }
  return new MediaStream(stream.getAudioTracks());
}

export class NoMeetingAudioError extends Error {
  readonly recorderError: RecorderError = {
    code: 'no_meeting_audio_shared',
    message: 'That share has no sound, so Kraken cannot hear the meeting.',
    stillUsable:
      'Start again and tick "Also share tab audio" (a tab) or "Share system audio" (Entire screen on Windows).',
  };

  constructor() {
    super('The shared tab or screen has no audio.');
    this.name = 'NoMeetingAudioError';
  }
}

export function stopStream(stream: MediaStream | null | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Already stopped.
    }
  }
}
