'use client';

import * as React from 'react';
import { AlertTriangle, Mic, MonitorUp, Pause, Play, RefreshCw, Square, X } from 'lucide-react';
import { formatOffset } from '@/lib/notes/api';
import type { MeetingRecorderApi } from '@/lib/capture/use-meeting-recorder';
import type { RecorderWarning, SocketState, TrackSnapshot } from '@/lib/capture/types';
import type { TranscriptTrack } from '@/lib/types/notes';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/util/cn';
import { LevelMeter } from './level-meter';

/**
 * The recorder while it runs (D-076, WS3): a red pill with the time, a meter
 * per track, what the connection is doing, warnings with the button that
 * fixes them, and Pause / Resume / Stop. It does not start a recording: the
 * meeting page's consent step does that, and only once the box is ticked.
 * The meeting page (WS2) can mount this as it is or use the hook directly.
 */

const TRACK_LABEL: Record<TranscriptTrack, string> = {
  mic: 'Your microphone',
  system: 'Meeting audio',
  mixed: 'Microphone (everyone)',
};

const SOCKET_LABEL: Record<SocketState, string> = {
  idle: 'Waiting',
  connecting: 'Connecting',
  open: 'Transcribing',
  reconnecting: 'Reconnecting',
  closed: 'Closed',
  failed: 'Stopped',
};

export function RecorderControls({
  rec,
  className,
  controls = true,
  errors = true,
}: {
  rec: MeetingRecorderApi;
  className?: string;
  /** The pill and Pause / Resume / Stop (off where the page has its own). */
  controls?: boolean;
  /** The error box (off where the page shows the error itself). */
  errors?: boolean;
}) {
  const { state } = rec;
  const [busy, setBusy] = React.useState(false);
  const act = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  const tracks = (['mic', 'system', 'mixed'] as const)
    .map((t) => state.tracks[t])
    .filter((t): t is TrackSnapshot => Boolean(t));
  const recording = state.status === 'recording';
  const paused = state.status === 'paused';
  const stopping = state.status === 'stopping';

  return (
    <section
      aria-label="Recorder"
      data-testid="recorder-controls"
      data-status={state.status}
      className={cn('space-y-4', className)}
    >
      <div className="flex flex-wrap items-center gap-3">
        {controls ? <StatusPill status={state.status} elapsedMs={state.elapsedMs} /> : null}
        {state.provider ? (
          <Badge tone="outline" data-testid="recorder-provider">
            {state.provider === 'mock' ? 'Demo speech' : state.provider}
          </Badge>
        ) : null}
        <span className="text-mini text-[var(--fg-muted)]" data-testid="upload-status">
          {state.upload.pending > 0
            ? `${state.upload.pending} line${state.upload.pending === 1 ? '' : 's'} saving`
            : state.upload.lastSeq !== null
              ? 'All lines saved'
              : ''}
        </span>
        {controls ? (
          <div className="ml-auto flex flex-wrap gap-2">
            {recording ? (
              <Button
                size="sm"
                onClick={act(rec.pause)}
                disabled={busy}
                aria-label="Pause recording"
              >
                <Pause aria-hidden="true" /> Pause
              </Button>
            ) : null}
            {paused ? (
              <Button
                size="sm"
                onClick={act(rec.resume)}
                disabled={busy}
                aria-label="Resume recording"
              >
                <Play aria-hidden="true" /> Resume
              </Button>
            ) : null}
            {recording || paused || stopping ? (
              <Button
                size="sm"
                variant="danger"
                onClick={act(() => rec.stop('user'))}
                disabled={busy || stopping}
                loading={stopping}
                aria-label="Stop recording"
              >
                <Square aria-hidden="true" /> Stop
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {tracks.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {tracks.map((t) => (
            <LevelMeter
              key={t.track}
              testId={`meter-${t.track}`}
              label={TRACK_LABEL[t.track]}
              tone={t.track === 'system' ? 'meeting' : 'mic'}
              level={t.level}
              live={t.live && !paused}
              hint={
                <span data-testid={`socket-${t.track}`} data-socket={t.socket}>
                  {!t.live
                    ? 'Not shared'
                    : t.muted
                      ? 'Paused by the device'
                      : SOCKET_LABEL[t.socket]}
                </span>
              }
            />
          ))}
        </div>
      ) : null}

      {state.warnings.length > 0 ? (
        <ul className="space-y-2" aria-live="polite">
          {state.warnings.map((w) => (
            <WarningRow key={w.code} warning={w} rec={rec} busy={busy} act={act} />
          ))}
        </ul>
      ) : null}

      {errors && state.error ? (
        <div
          role="alert"
          data-testid="recorder-error"
          data-code={state.error.code}
          className="rounded-md border border-[var(--danger)]/30 bg-[var(--danger-soft)] px-3 py-2.5 text-sm"
        >
          <p className="font-medium text-[var(--danger)]">{state.error.message}</p>
          {state.error.stillUsable ? (
            <p className="mt-0.5 text-[var(--fg-muted)]">{state.error.stillUsable}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function StatusPill({ status, elapsedMs }: { status: string; elapsedMs: number }) {
  const label =
    status === 'recording'
      ? 'Recording'
      : status === 'paused'
        ? 'Paused'
        : status === 'starting'
          ? 'Starting'
          : status === 'stopping'
            ? 'Finishing'
            : status === 'stopped'
              ? 'Stopped'
              : status === 'error'
                ? 'Not recording'
                : 'Ready';
  const live = status === 'recording';
  return (
    <span
      data-testid="recording-pill"
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm font-medium',
        live
          ? 'border-transparent bg-[var(--danger)] text-[var(--danger-fg)]'
          : 'border-[var(--border-strong)] bg-[var(--bg-raised)] text-[var(--fg)]',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-2 rounded-full',
          live ? 'bg-[var(--danger-fg)] motion-safe:animate-pulse' : 'bg-[var(--fg-subtle)]',
        )}
      />
      {label}
      {status === 'recording' ||
      status === 'paused' ||
      status === 'stopping' ||
      status === 'stopped' ? (
        <span className="font-mono tabular-nums" data-testid="recording-time">
          {formatOffset(elapsedMs)}
        </span>
      ) : null}
    </span>
  );
}

function WarningRow({
  warning,
  rec,
  busy,
  act,
}: {
  warning: RecorderWarning;
  rec: MeetingRecorderApi;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => () => Promise<void>;
}) {
  return (
    <li
      data-testid={`warning-${warning.code}`}
      className="flex items-start gap-2.5 rounded-md border border-[var(--warn)]/30 bg-[var(--warn-soft)] px-3 py-2 text-sm"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--warn)]" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-[var(--fg)]">{warning.message}</p>
      {warning.action === 'share_again' ? (
        <Button size="sm" onClick={act(rec.shareMeetingAudioAgain)} disabled={busy}>
          <MonitorUp aria-hidden="true" /> Share again
        </Button>
      ) : warning.action === 'retry_mic' ? (
        <Button size="sm" onClick={act(rec.retryMicrophone)} disabled={busy}>
          <Mic aria-hidden="true" /> Try the mic
        </Button>
      ) : warning.action === 'resume' ? (
        <Button size="sm" onClick={act(rec.resume)} disabled={busy}>
          <RefreshCw aria-hidden="true" /> Resume
        </Button>
      ) : null}
      <button
        type="button"
        onClick={() => rec.dismissWarning(warning.code)}
        className="rounded p-0.5 text-[var(--fg-muted)] hover:text-[var(--fg)]"
        aria-label="Dismiss"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </li>
  );
}
