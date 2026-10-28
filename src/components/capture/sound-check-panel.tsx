'use client';

import * as React from 'react';
import { Check, Mic, MonitorUp, Square } from 'lucide-react';
import { shareGuidance } from '@/lib/capture/media';
import type { SoundCheckSource, SoundCheckSourceState } from '@/lib/capture/sound-check';
import { useSoundCheck } from '@/lib/capture/use-sound-check';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LevelMeter } from './level-meter';

/**
 * Sound check (D-076): test the microphone and the meeting audio before a
 * call. Local only: nothing leaves this computer, no meeting is made.
 */
export function SoundCheckPanel() {
  const { state, test, end } = useSoundCheck();
  const caps = state.capabilities;
  const guidance = shareGuidance(caps.platform);

  return (
    <Card data-testid="sound-check">
      <CardHeader>
        <div>
          <CardTitle>Sound check</CardTitle>
          <CardDescription>
            Check that Kraken can hear you and the meeting before a call. Nothing is sent or saved:
            this stays on your computer.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <SourceRow
          source="mic"
          title="Your microphone"
          icon={<Mic aria-hidden="true" />}
          state={state.mic}
          available={caps.microphone}
          unavailable="This browser cannot use the microphone here."
          onTest={() => void test('mic')}
          onEnd={() => end('mic')}
          prompt="Say something: the bar should move."
        />
        <SourceRow
          source="meeting"
          title="Meeting audio"
          icon={<MonitorUp aria-hidden="true" />}
          state={state.meeting}
          available={caps.meetingAudio}
          unavailable="This device cannot share meeting audio. Record in-person meetings in “Mic only” mode."
          onTest={() => void test('meeting')}
          onEnd={() => end('meeting')}
          prompt="Play something in the meeting tab (or ask someone to talk): the bar should move."
        />
        <div className="rounded-md bg-[var(--bg-sunken)] px-3 py-2.5">
          <p className="text-mini mb-1 font-medium tracking-wide text-[var(--label-gold)] uppercase">
            What to share
          </p>
          <ul className="list-disc space-y-1 pl-4 text-sm text-[var(--fg-muted)]">
            {guidance.map((line) => (
              <li key={line}>{line}</li>
            ))}
            <li>Headphones keep the meeting out of your microphone.</li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

function SourceRow({
  source,
  title,
  icon,
  state,
  available,
  unavailable,
  onTest,
  onEnd,
  prompt,
}: {
  source: SoundCheckSource;
  title: string;
  icon: React.ReactNode;
  state: SoundCheckSourceState;
  available: boolean;
  unavailable: string;
  onTest: () => void;
  onEnd: () => void;
  prompt: string;
}) {
  return (
    <div className="space-y-2" data-testid={`sound-check-${source}`}>
      <div className="flex flex-wrap items-center gap-2">
        {state.running ? (
          <Button size="sm" onClick={onEnd}>
            <Square aria-hidden="true" /> Stop test
          </Button>
        ) : (
          <Button size="sm" variant="primary" onClick={onTest} disabled={!available}>
            {icon} Test {title.toLowerCase()}
          </Button>
        )}
        {state.heard ? (
          <span className="text-note inline-flex items-center gap-1 text-[var(--ok)]">
            <Check className="size-4" aria-hidden="true" /> Heard it
          </span>
        ) : state.running ? (
          <span className="text-note text-[var(--fg-muted)]">{prompt}</span>
        ) : null}
      </div>
      {!available ? <p className="text-note text-[var(--fg-muted)]">{unavailable}</p> : null}
      {state.running || state.heard ? (
        <LevelMeter
          label={title}
          level={state.level}
          tone={source === 'mic' ? 'mic' : 'meeting'}
          live={state.running}
          testId={`sound-check-meter-${source}`}
        />
      ) : null}
      {state.error ? (
        <p role="alert" className="text-sm text-[var(--danger)]">
          {state.error.message} {state.error.stillUsable}
        </p>
      ) : null}
    </div>
  );
}
