'use client';

import * as React from 'react';
import Link from 'next/link';
import { Copy, Mic, Play, Users } from 'lucide-react';
import { NOTES_API, formatOffset, meetingPagePath } from '@/lib/notes/api';
import { whisperEngineFactory } from '@/lib/capture/engine-factory';
import type { RecorderMode, RecorderTuning } from '@/lib/capture/types';
import { useMeetingRecorder } from '@/lib/capture/use-meeting-recorder';
import type { SpeechPreferences } from '@/lib/capture/speech-preferences';
import type { AdapterKind } from '@/lib/capture/speech-protocol';
import {
  CONSENT_BANNER_TEXT,
  CONSENT_CHECKBOX_LABEL,
  CONSENT_NOTICE_TEXT,
  type CreateMeetingResponse,
  type NotesApiError,
  type SpeakerView,
} from '@/lib/types/notes';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/util/cn';
import { RecorderControls } from './recorder-controls';

/**
 * The on-device engine to try instead of the scripted call: the fake model
 * (the end-to-end tests) or the real Whisper (checking a computer by hand).
 */
export interface DemoEngine {
  adapter: AdapterKind;
  preferences?: SpeechPreferences;
}

/**
 * Demo mode only (D-076): record the made-up demo call end to end, from the
 * consent step to saved transcript lines, with the demo speech engine in
 * place of a model (or, with `engine`, the on-device Whisper engine itself).
 * It makes a real (demo) meeting, so the meeting page, the notes job and the
 * end-to-end tests all see what a recording leaves.
 */
export function DemoRecording({
  tuning,
  engine,
}: {
  tuning?: Partial<RecorderTuning>;
  engine?: DemoEngine;
}) {
  const [mode, setMode] = React.useState<RecorderMode>('call');
  const [meetingId, setMeetingId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function prepare() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(NOTES_API.meetings, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'adhoc',
          title:
            mode === 'call' ? 'Demo call (sound check)' : 'Demo in-person meeting (sound check)',
          kind: mode === 'call' ? 'video' : 'in_person',
        }),
      });
      const body = (await response.json()) as CreateMeetingResponse | NotesApiError;
      if (!body.ok) {
        setError(body.error.message);
        return;
      }
      setMeetingId(body.meeting.id);
    } catch {
      setError('Kraken could not be reached. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-testid="demo-recording">
      <CardHeader>
        <div>
          <CardTitle>Try a recording (demo)</CardTitle>
          <CardDescription>
            {engine
              ? 'Records with the on-device speech engine: your microphone and a shared tab are transcribed on this computer.'
              : 'Records a made-up call with the demo speech engine: your microphone and a shared tab feed the meters, and the transcript plays a scripted conversation.'}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {meetingId ? (
          <DemoRecorder meetingId={meetingId} mode={mode} tuning={tuning} engine={engine} />
        ) : (
          <>
            <fieldset className="space-y-2">
              <legend className="text-note mb-1 font-medium">What are you recording?</legend>
              <div className="flex flex-wrap gap-2">
                <ModeButton
                  active={mode === 'call'}
                  onClick={() => setMode('call')}
                  icon={<Users aria-hidden="true" />}
                  label="Video call"
                  detail="Your mic + the meeting tab"
                />
                <ModeButton
                  active={mode === 'mic_only'}
                  onClick={() => setMode('mic_only')}
                  icon={<Mic aria-hidden="true" />}
                  label="Mic only"
                  detail="In person, or a phone"
                />
              </div>
            </fieldset>
            <Button variant="primary" onClick={() => void prepare()} loading={busy} disabled={busy}>
              Prepare a demo meeting
            </Button>
            {error ? (
              <p role="alert" className="text-sm text-[var(--danger)]">
                {error}
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ModeButton({
  active,
  onClick,
  icon,
  label,
  detail,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  detail: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'flex min-w-0 items-start gap-2 rounded-md border px-3 py-2 text-left text-sm [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0',
        active
          ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--fg)]'
          : 'border-[var(--border-strong)] bg-[var(--bg-raised)] text-[var(--fg-muted)] hover:bg-[var(--bg-hover)]',
      )}
    >
      {icon}
      <span className="min-w-0">
        <span className="block font-medium text-[var(--fg)]">{label}</span>
        <span className="text-mini block">{detail}</span>
      </span>
    </button>
  );
}

function DemoRecorder({
  meetingId,
  mode,
  tuning,
  engine,
}: {
  meetingId: string;
  mode: RecorderMode;
  tuning?: Partial<RecorderTuning>;
  engine?: DemoEngine;
}) {
  const [deps] = React.useState(() =>
    engine
      ? {
          engineFactory: whisperEngineFactory({
            adapter: engine.adapter,
            ...(engine.preferences ? { preferences: engine.preferences } : {}),
          }),
        }
      : undefined,
  );
  const rec = useMeetingRecorder({ meetingId, mode, tuning, deps });
  const { state } = rec;
  const [consented, setConsented] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const idle = state.status === 'idle' || state.status === 'error';

  async function copyNotice() {
    try {
      await navigator.clipboard.writeText(CONSENT_NOTICE_TEXT);
      setCopied(true);
    } catch {
      setCopied(false);
    }
    void fetch(NOTES_API.consent(meetingId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'notice_copied' }),
    }).catch(() => undefined);
  }

  const speakers = React.useMemo(() => {
    const map = new Map<string, SpeakerView>();
    for (const s of state.speakers) map.set(s.clusterKey, s);
    return map;
  }, [state.speakers]);
  const nameFor = (clusterKey: string) =>
    speakers.get(clusterKey)?.displayName ?? (clusterKey === 'mic' ? 'You' : 'Someone');

  const partials = Object.values(state.partials);

  return (
    <div className="space-y-4" data-testid="demo-recorder" data-meeting-id={meetingId}>
      {idle && state.status !== 'error' ? (
        <div className="space-y-3 rounded-md border border-[var(--border-strong)] p-3">
          <p className="font-medium">{CONSENT_BANNER_TEXT}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => void copyNotice()}>
              <Copy aria-hidden="true" /> {copied ? 'Notice copied' : 'Copy notice'}
            </Button>
            <span className="text-mini text-[var(--fg-muted)]">
              Paste it into the meeting chat.
            </span>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-[var(--accent)]"
              checked={consented}
              onChange={(e) => setConsented(e.target.checked)}
            />
            {CONSENT_CHECKBOX_LABEL}
          </label>
        </div>
      ) : null}

      {idle ? (
        <Button
          variant="primary"
          disabled={!consented}
          onClick={() =>
            void rec.start({
              consent: { confirmed: true, method: 'chat_notice' },
            })
          }
        >
          <Play aria-hidden="true" /> Start recording
        </Button>
      ) : null}

      <RecorderControls rec={rec} />

      {state.lines.length > 0 || partials.length > 0 ? (
        <ol
          aria-label="Live transcript"
          data-testid="live-transcript"
          className="max-h-80 space-y-1.5 overflow-y-auto rounded-md bg-[var(--bg-sunken)] p-3 text-sm"
        >
          {state.lines.map((line) => (
            <li
              key={line.key}
              data-testid="live-line"
              data-seq={line.seq ?? ''}
              data-track={line.track}
              data-cluster={line.clusterKey}
              className="flex gap-2"
            >
              <span className="w-12 shrink-0 font-mono text-[var(--fg-subtle)] tabular-nums">
                {formatOffset(line.startMs)}
              </span>
              <span className="min-w-0">
                <span
                  className={cn(
                    'font-medium',
                    line.track === 'system' ? 'text-[var(--accent)]' : 'text-[var(--gold)]',
                  )}
                >
                  {nameFor(line.clusterKey)}:
                </span>{' '}
                {line.text}
              </span>
            </li>
          ))}
          {partials.map((line) => (
            <li key={line.key} className="flex gap-2 text-[var(--fg-muted)] italic">
              <span className="w-12 shrink-0 font-mono tabular-nums">
                {formatOffset(line.startMs)}
              </span>
              <span className="min-w-0">{line.text}…</span>
            </li>
          ))}
        </ol>
      ) : null}

      {state.status === 'stopped' ? (
        <p className="text-sm" data-testid="demo-stopped" data-reason={state.stopReason ?? ''}>
          Stopped{state.stopReason === 'silence' ? ' after a long silence' : ''}.{' '}
          <Link className="underline" href={meetingPagePath(meetingId)}>
            Open the meeting
          </Link>
        </p>
      ) : null}
    </div>
  );
}
