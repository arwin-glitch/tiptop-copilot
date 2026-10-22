'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { Ban, FileText, Lock, Mic, NotebookPen, Users } from 'lucide-react';
import { formatOffset, NOTES_API } from '@/lib/notes/api';
import {
  NEVER_RECORD_MESSAGE,
  NOTES_LIMITS,
  type ActionItem,
  type AddActionItemTaskResponse,
  type ConsentMethod,
  type CopilotNoteView,
  type EditSegmentResponse,
  type FolderView,
  type GenerateNotesResponse,
  type ListSegmentsResponse,
  type MeetingDetailResponse,
  type MeetingResponse,
  type MeetingView,
  type MergeSpeakersResponse,
  type RecipeView,
  type RelabelSpeakerResponse,
  type SegmentView,
  type ShareLinkView,
  type SpeakerPersonInput,
  type SpeakerView,
  type SplitSpeakerResponse,
  type TemplateView,
} from '@/lib/types/notes';
import { formatTime } from '@/lib/util/time';
import { cn } from '@/lib/util/cn';
import { RecorderControls } from '@/components/capture/recorder-controls';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Notice } from '@/components/ui/feedback';
import { Select } from '@/components/ui/form';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { notesCall } from './api-client';
import { ActionItemsCard } from './action-items-card';
import { ChatPanel, type ChatPreset } from './chat-panel';
import { ConsentBanner } from './consent-banner';
import { EnhancedNotes } from './enhanced-notes';
import { initials, mergeSegments, segmentAt, speakerLookup, type WorkspaceTab } from './helpers';
import { LiveTranscript } from './live-transcript';
import { NotepadEditor, type SaveState } from './notepad-editor';
import { NotesTour } from './notes-tour';
import { PeoplePanel } from './people-panel';
import { RecordingPill } from './recording-pill';
import { SharePanel } from './share-dialog';
import { TemplatePicker } from './template-picker';
import { useRecorder, type CaptureEngine } from './use-recorder';
import { WhoIsThisSheet } from './who-is-this-sheet';

const CONSENT_WORDS: Record<ConsentMethod, string> = {
  verbal: 'said out loud',
  chat_notice: 'notice posted in the chat',
  invite_notice: 'in the invite',
  in_person_notice: 'told the room',
  other: 'confirmed',
};

const LIVE = new Set(['recording', 'paused', 'processing']);

const REMEMBER_WORDS: Record<'requested' | 'no_consent' | 'not_live' | 'not_supported', string> = {
  requested: 'Remembering this voice…',
  no_consent:
    'Voice not remembered: there is no consent on file for them (Notes settings, Voices).',
  not_live: 'Voices are remembered while the meeting is recording.',
  not_supported:
    'Not remembered: only a guest’s own voice can be (not the microphone, not a split line).',
};

/**
 * The meeting page (D-076): subtabs instead of one long page. Notes holds the
 * consent step and Start, then the notepad beside the live transcript while
 * recording (one or the other on a phone), then the enhanced notes and the
 * action items. Transcript, Chat, People and Share are the other tabs.
 *
 * Every change goes through the /api/notes routes; names come from the voices
 * by cluster key, so one rename shows on every line at once.
 */
export function MeetingWorkspace({
  initial,
  templates,
  recipes,
  folders,
  timeZone,
  demo,
  mockSpeed,
  engine,
  initialTab,
  initialAtMs,
  openConsent,
}: {
  initial: Omit<MeetingDetailResponse, 'ok'>;
  templates: TemplateView[];
  recipes: RecipeView[];
  folders: FolderView[];
  timeZone: string;
  demo: boolean;
  mockSpeed: number;
  /** 'live': the browser recorder; 'scripted': the demo's scripted call (demo mode only). */
  engine: CaptureEngine;
  initialTab: WorkspaceTab;
  initialAtMs: number | null;
  /** Arrived from "Take notes" / "Start notes": the consent step opens at once. */
  openConsent: boolean;
}) {
  const id = initial.meeting.id;
  const [meeting, setMeeting] = React.useState<MeetingView>(initial.meeting);
  const participants = initial.participants;
  const [speakers, setSpeakers] = React.useState<SpeakerView[]>(initial.speakers);
  const [segments, setSegments] = React.useState<SegmentView[]>(initial.segments);
  const [note, setNote] = React.useState<CopilotNoteView | null>(initial.note);
  const [links, setLinks] = React.useState<ShareLinkView[]>(initial.shareLinks);
  const [tab, setTab] = React.useState<WorkspaceTab>(initialTab);
  const [highlightSeq, setHighlightSeq] = React.useState<number | null>(() =>
    initialAtMs !== null ? (segmentAt(initial.segments, initialAtMs)?.seq ?? null) : null,
  );
  const [userNotes, setUserNotes] = React.useState(initial.note?.userNotes ?? '');
  const [saveState, setSaveState] = React.useState<SaveState>('idle');
  const [editingNotes, setEditingNotes] = React.useState(false);
  const [consentOpen, setConsentOpen] = React.useState(
    openConsent && initial.meeting.status === 'scheduled' && initial.meeting.isRecorder,
  );
  const [sheet, setSheet] = React.useState<{ clusterKey: string; seq: number | null } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [regenerating, setRegenerating] = React.useState(false);
  const [chatPreset, setChatPreset] = React.useState<ChatPreset | null>(null);
  const [phonePane, setPhonePane] = React.useState<'notepad' | 'transcript'>('transcript');

  const resolve = React.useMemo(() => speakerLookup(speakers), [speakers]);
  const lastSeqRef = React.useRef(initial.segments.at(-1)?.seq ?? -1);
  React.useEffect(() => {
    lastSeqRef.current = segments.at(-1)?.seq ?? -1;
  }, [segments]);

  /* ------------------------------------------------------------ reads == */

  const reload = React.useCallback(async () => {
    const res = await notesCall<Omit<MeetingDetailResponse, 'ok'>>('GET', NOTES_API.meeting(id));
    if (!res.ok) {
      toast.error(res.message);
      return;
    }
    setMeeting(res.meeting);
    setSpeakers(res.speakers);
    setSegments(res.segments);
    setNote(res.note);
    setLinks(res.shareLinks);
    if (res.note?.userNotes != null) setUserNotes(res.note.userNotes);
  }, [id]);

  const pulling = React.useRef(false);
  const pull = React.useCallback(async () => {
    if (pulling.current) return;
    pulling.current = true;
    try {
      const after = lastSeqRef.current;
      const res = await notesCall<Omit<ListSegmentsResponse, 'ok'>>(
        'GET',
        `${NOTES_API.segments(id)}?after=${after}`,
      );
      if (!res.ok) return;
      if (res.segments.length) setSegments((current) => mergeSegments(current, res.segments));
      setSpeakers(res.speakers);
      setMeeting((m) => (m.status === res.status ? m : { ...m, status: res.status }));
    } finally {
      pulling.current = false;
    }
  }, [id]);

  // The first page holds up to 1,000 lines: a longer meeting reads the rest.
  React.useEffect(() => {
    if (initial.segments.length < NOTES_LIMITS.maxSegmentsPerPage) return;
    let live = true;
    void (async () => {
      for (let i = 0; i < 20 && live; i++) {
        const res = await notesCall<Omit<ListSegmentsResponse, 'ok'>>(
          'GET',
          `${NOTES_API.segments(id)}?after=${lastSeqRef.current}`,
        );
        if (!res.ok || res.segments.length === 0 || !live) break;
        setSegments((current) => mergeSegments(current, res.segments));
        lastSeqRef.current = res.segments.at(-1)?.seq ?? lastSeqRef.current;
        if (res.segments.length < NOTES_LIMITS.maxSegmentsPerPage) break;
      }
    })();
    return () => {
      live = false;
    };
  }, [id, initial.segments.length]);

  /* ------------------------------------------------------------ notepad == */

  const saveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingNotes = React.useRef<string | null>(null);

  // A failed save retries itself through this ref (a callback cannot name itself).
  const saveAgain = React.useRef<() => Promise<void>>(async () => {});
  const saveNotesNow = React.useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const text = pendingNotes.current;
    if (text === null) return;
    pendingNotes.current = null;
    setSaveState('saving');
    const res = await notesCall<Omit<MeetingResponse, 'ok'>>('PATCH', NOTES_API.meeting(id), {
      userNotes: text,
    });
    if (res.ok) {
      setSaveState('saved');
    } else {
      setSaveState('error');
      // Try again shortly with whatever is newest.
      if (pendingNotes.current === null) pendingNotes.current = text;
      saveTimer.current = setTimeout(() => void saveAgain.current(), 3_000);
    }
  }, [id]);

  React.useEffect(() => {
    saveAgain.current = saveNotesNow;
  }, [saveNotesNow]);

  const changeNotes = (text: string) => {
    setUserNotes(text);
    pendingNotes.current = text;
    setSaveState('saving');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void saveNotesNow(), 800);
  };

  React.useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  /* ------------------------------------------------------------ recorder == */

  const lastLineEndMs = segments.at(-1)?.endMs ?? 0;
  const autoStopped = React.useRef<(reason: string) => void>(() => {});
  const recorder = useRecorder({
    meetingId: id,
    meeting,
    lastLineEndMs,
    demo,
    mockSpeed,
    engine,
    onMeeting: setMeeting,
    onUploaded: () => void pull(),
    beforeStop: saveNotesNow,
    onAutoStopped: (reason) => autoStopped.current(reason),
  });

  const recording = ['recording', 'paused', 'interrupted', 'stopping'].includes(recorder.phase);

  // Viewers (and the recorder between uploads) follow the live transcript.
  React.useEffect(() => {
    if (!LIVE.has(meeting.status)) return;
    const timer = setInterval(() => void pull(), 2_500);
    return () => clearInterval(timer);
  }, [meeting.status, pull]);

  // The notes are written on the server after Stop and after a rename (a
  // model call can take a while): follow along until they are fresh.
  const following = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const followNotes = React.useCallback(() => {
    if (following.current) clearTimeout(following.current);
    let tries = 0;
    const tick = async () => {
      following.current = null;
      tries += 1;
      const res = await notesCall<Omit<MeetingDetailResponse, 'ok'>>('GET', NOTES_API.meeting(id));
      if (res.ok) {
        setMeeting(res.meeting);
        setSpeakers(res.speakers);
        setNote(res.note);
      }
      const settled = res.ok && res.meeting.status !== 'processing' && !(res.note?.stale ?? false);
      if (!settled && tries < 45) following.current = setTimeout(() => void tick(), 2_000);
    };
    following.current = setTimeout(() => void tick(), 600);
  }, [id]);
  React.useEffect(
    () => () => {
      if (following.current) clearTimeout(following.current);
    },
    [],
  );

  // The meeting turned 'ready' while this page polled: read the notes it now has.
  const lastStatus = React.useRef(meeting.status);
  React.useEffect(() => {
    const was = lastStatus.current;
    lastStatus.current = meeting.status;
    if (was === 'processing' && meeting.status === 'ready' && !note?.generatedAt) void reload();
  }, [meeting.status, note?.generatedAt, reload]);

  /* ------------------------------------------------------------ tabs == */

  const changeTab = React.useCallback((next: WorkspaceTab, atMs?: number | null) => {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.delete('start');
    if (next === 'notes') url.searchParams.delete('tab');
    else url.searchParams.set('tab', next);
    if (atMs != null) url.searchParams.set('t', String(Math.floor(atMs)));
    else url.searchParams.delete('t');
    window.history.replaceState(window.history.state, '', url);
  }, []);

  const jumpTo = React.useCallback(
    (seq: number) => {
      const line = segments.find((s) => s.seq === seq);
      setHighlightSeq(seq);
      changeTab('transcript', line?.startMs ?? null);
    },
    [changeTab, segments],
  );

  /* ------------------------------------------------------------ actions == */

  const regenerate = React.useCallback(
    async (templateId?: string | null) => {
      setRegenerating(true);
      const res = await notesCall<Omit<GenerateNotesResponse, 'ok'>>(
        'POST',
        NOTES_API.generate(id),
        templateId === undefined ? {} : { templateId },
      );
      setRegenerating(false);
      if (!res.ok) {
        toast.error(res.message);
        return false;
      }
      setNote(res.note);
      setMeeting((m) => ({
        ...m,
        templateId: res.note.templateId,
        status: m.status === 'processing' || m.status === 'failed' ? 'ready' : m.status,
      }));
      return true;
    },
    [id],
  );

  const changeTemplate = async (templateId: string | null) => {
    const name = templates.find((t) => t.id === templateId)?.name ?? 'Automatic';
    if (note && (meeting.status === 'ready' || meeting.status === 'failed')) {
      if (await regenerate(templateId)) toast.success(`Notes rewritten with ${name}.`);
      return;
    }
    const res = await notesCall<Omit<MeetingResponse, 'ok'>>('PATCH', NOTES_API.meeting(id), {
      templateId,
    });
    if (!res.ok) {
      toast.error(res.message);
      return;
    }
    setMeeting(res.meeting);
    toast.success(`Template: ${name}.`);
  };

  const relabel = async (person: SpeakerPersonInput | null, rememberVoice: boolean) => {
    if (!sheet) return;
    const clusterKey = sheet.clusterKey;
    setBusy(true);
    const res = await notesCall<Omit<RelabelSpeakerResponse, 'ok'>>(
      'PATCH',
      NOTES_API.speaker(id, sheet.clusterKey),
      person === null ? { person: null } : { person, rememberVoice: rememberVoice || undefined },
    );
    setBusy(false);
    if (!res.ok) {
      toast.error(res.message);
      return;
    }
    setSpeakers(res.speakers);
    setSheet(null);
    toast.success(
      `Updated ${res.updatedLines} ${res.updatedLines === 1 ? 'line' : 'lines'}${
        res.notesRefreshing ? ' · notes refreshing' : ''
      }`,
    );
    if (res.notesRefreshing) followNotes();
    const remember = res.rememberVoice;
    if (!remember) return;
    if (remember.status !== 'requested' || !remember.vendorLabel || !remember.email) {
      toast.message(REMEMBER_WORDS[remember.status]);
      return;
    }
    const outcome = await recorder.rememberVoice(clusterKey, remember.vendorLabel, remember.email);
    const who = res.speaker.displayName;
    if (outcome === 'saved') toast.success(`Voice remembered: Copilot will know ${who} next time.`);
    else if (outcome === 'unavailable')
      toast.message(`Not remembered yet: try again while ${who} is talking on this recording.`);
    else toast.error(`${who}'s voice could not be saved. Nothing was kept.`);
  };

  const split = async (mode: 'line' | 'from_here') => {
    if (!sheet || sheet.seq === null) return;
    setBusy(true);
    const res = await notesCall<Omit<SplitSpeakerResponse, 'ok'>>(
      'POST',
      NOTES_API.splitSpeaker(id),
      { clusterKey: sheet.clusterKey, fromSeq: sheet.seq, mode },
    );
    setBusy(false);
    if (!res.ok) {
      toast.error(res.message);
      return;
    }
    await reload();
    toast.success(
      `Moved ${res.movedLines} ${res.movedLines === 1 ? 'line' : 'lines'} to a new voice. Say who it is.`,
    );
    setSheet({ clusterKey: res.newClusterKey, seq: null });
    if (res.notesRefreshing) followNotes();
  };

  const merge = async (into: string) => {
    if (!sheet) return;
    setBusy(true);
    const res = await notesCall<Omit<MergeSpeakersResponse, 'ok'>>(
      'POST',
      NOTES_API.mergeSpeakers(id),
      { from: sheet.clusterKey, into },
    );
    setBusy(false);
    if (!res.ok) {
      toast.error(res.message);
      return;
    }
    await reload();
    setSheet(null);
    toast.success(`Merged: ${res.movedLines} ${res.movedLines === 1 ? 'line' : 'lines'} moved.`);
    if (res.notesRefreshing) followNotes();
  };

  const editLine = async (seq: number, text: string) => {
    const res = await notesCall<Omit<EditSegmentResponse, 'ok'>>(
      'PATCH',
      NOTES_API.segment(id, seq),
      { text },
    );
    if (!res.ok) {
      toast.error(res.message);
      return false;
    }
    setSegments((current) => mergeSegments(current, [res.segment]));
    toast.success('Line saved. The original is kept.');
    return true;
  };

  const addTask = async (itemId: string) => {
    const res = await notesCall<Omit<AddActionItemTaskResponse, 'ok'>>(
      'POST',
      NOTES_API.actionItems(id),
      { itemId },
    );
    if (!res.ok) {
      toast.error(res.message);
      return false;
    }
    setNote((n) =>
      n
        ? {
            ...n,
            actionItems: n.actionItems.map((a: ActionItem) =>
              a.id === itemId ? { ...a, taskId: res.taskId } : a,
            ),
          }
        : n,
    );
    toast.success(res.created ? 'Added to Tasks.' : 'Already in Tasks.');
    return true;
  };

  const afterStop = async (ready: boolean, queued: boolean) => {
    await reload();
    changeTab('notes');
    if (ready) toast.success('Stopped. Your notes are ready.');
    else if (queued) {
      toast.success('Stopped. Writing your notes…');
      followNotes();
    } else toast.error('Stopped. The notes could not be written yet: press Regenerate.');
  };

  const stop = async () => {
    const res = await recorder.stop();
    if (!res) return;
    await afterStop(res.meeting.status === 'ready', res.finalize.queued);
  };

  React.useEffect(() => {
    autoStopped.current = (reason) => {
      toast.message(
        reason === 'call_ended'
          ? 'The call ended, so the recording stopped.'
          : 'Nobody spoke for a while, so the recording stopped.',
      );
      void afterStop(false, true);
    };
  });

  const shareSettings = async (patch: {
    visibility?: 'private' | 'team';
    folderId?: string | null;
  }) => {
    const res = await notesCall<Omit<MeetingResponse, 'ok'>>('PATCH', NOTES_API.meeting(id), patch);
    if (!res.ok) {
      toast.error(res.message);
      return;
    }
    setMeeting(res.meeting);
    toast.success('Saved.');
  };

  /* ------------------------------------------------------------ render == */

  const sheetSpeaker = sheet ? resolve(sheet.clusterKey) : null;
  const sheetLine =
    sheet && sheet.seq !== null ? (segments.find((s) => s.seq === sheet.seq) ?? null) : null;
  const owner = speakers.find((s) => s.isOwner);
  const promiseLabel = meeting.isRecorder
    ? 'Your promise'
    : `${owner?.displayName ?? 'The recorder'}'s promise`;
  const guests = participants.filter((p) => p.role !== 'self');
  const notStarted = meeting.status === 'scheduled' && !recording;
  const notesReady = Boolean(note?.generatedAt);
  const cannotRecord = recorder.canRecord ? null : recorder.cannotRecordReason;

  const transcriptPane = (
    <LiveTranscript
      segments={segments}
      speakers={speakers}
      partial={recorder.partial}
      live={recorder.phase === 'recording'}
      highlightSeq={highlightSeq}
      onOpenSpeaker={(s, line) => setSheet({ clusterKey: s.clusterKey, seq: line?.seq ?? null })}
      onEditLine={editLine}
      className="h-[min(60vh,36rem)] pr-1"
      label="Live transcript"
    />
  );
  const notepad = (
    <NotepadEditor
      value={userNotes}
      onChange={changeNotes}
      saveState={saveState}
      templates={templates}
      recipes={recipes}
      onTemplate={(t) => void changeTemplate(t)}
      onRecipe={(r) => {
        changeTab('chat');
        setChatPreset({
          scope: r.scope === 'many' ? 'all' : 'meeting',
          question: r.prompt,
          nonce: Date.now(),
        });
      }}
      className="h-[min(60vh,36rem)]"
    />
  );

  return (
    <div className="space-y-4" data-meeting-workspace="" data-status={meeting.status}>
      {/* The bar under the title: who, the recording state, consent, template. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        {guests.length > 0 ? (
          <div className="flex items-center" aria-label={`${guests.length} guests`} role="group">
            {guests.slice(0, 4).map((g, i) => (
              <span
                key={`${g.email ?? ''}-${g.name ?? ''}`}
                title={g.name ?? g.email ?? 'Guest'}
                className={cn(
                  'flex size-8 items-center justify-center rounded-full border-2 border-[var(--bg)] bg-[var(--accent-soft)] text-[11px] font-semibold text-[var(--accent)]',
                  i > 0 && '-ml-2',
                )}
              >
                {initials(g.name ?? g.email)}
              </span>
            ))}
            {guests.length > 4 ? (
              <span className="ml-1 text-xs text-[var(--fg-muted)]">+{guests.length - 4}</span>
            ) : null}
          </div>
        ) : null}

        <RecordingPill
          phase={recorder.phase}
          elapsedMs={recorder.elapsedMs}
          canControl={meeting.isRecorder}
          onPause={() => void recorder.pause()}
          onResume={() => void recorder.resume()}
          onStop={() => void stop()}
        />

        <ConsentStatus meeting={meeting} timeZone={timeZone} />

        {meeting.visibility === 'private' ? (
          <Badge tone="outline" className="gap-1">
            <Lock className="size-3" aria-hidden /> Private to you
          </Badge>
        ) : (
          <Badge tone="outline" className="gap-1">
            <Users className="size-3" aria-hidden /> Team can see
          </Badge>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {!notesReady ? (
            <TemplatePicker
              templates={templates}
              value={meeting.templateId}
              onChange={(t) => void changeTemplate(t)}
            />
          ) : null}
          <NotesTour />
        </div>
      </div>

      {recorder.error ? (
        <Notice tone="warn">
          <p>{recorder.error}</p>
        </Notice>
      ) : null}
      {meeting.injectionFlagged ? (
        <Notice tone="warn">
          <p className="font-medium">
            Something said in this meeting reads like an instruction to an AI.
          </p>
          <p className="mt-1 text-[var(--fg-muted)]">
            It was treated as words that were said, nothing more. Nothing was done because of it.
          </p>
        </Notice>
      ) : null}

      <Tabs value={tab} onValueChange={(v) => changeTab(v as WorkspaceTab)}>
        <TabsList aria-label="Meeting sections">
          <TabsTrigger value="notes">Notes</TabsTrigger>
          <TabsTrigger value="transcript">
            Transcript{' '}
            <span className="tabular ml-1 text-[var(--fg-subtle)]">{segments.length}</span>
          </TabsTrigger>
          <TabsTrigger value="chat">Chat</TabsTrigger>
          <TabsTrigger value="people">People</TabsTrigger>
          <TabsTrigger value="share">Share</TabsTrigger>
        </TabsList>

        <TabsContent value="notes">
          {notStarted ? (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <StartCard
                meeting={meeting}
                canRecord={recorder.canRecord}
                cannotRecord={cannotRecord}
                onStart={() => setConsentOpen(true)}
              />
              <Card>
                <CardContent className="pt-4">
                  <p className="mb-1 text-sm font-medium">Prep notes</p>
                  {notepad}
                </CardContent>
              </Card>
            </div>
          ) : recording ? (
            <>
              {recorder.capture && meeting.isRecorder ? (
                <Card className="mb-3">
                  <CardContent className="pt-4">
                    <RecorderControls rec={recorder.capture} controls={false} errors={false} />
                  </CardContent>
                </Card>
              ) : null}
              <div className="mb-3 flex gap-1 lg:hidden" role="group" aria-label="Show">
                {(
                  [
                    ['transcript', 'Transcript'],
                    ['notepad', 'Notepad'],
                  ] as const
                ).map(([value, label]) => (
                  <Button
                    key={value}
                    size="sm"
                    variant={phonePane === value ? 'primary' : 'secondary'}
                    aria-pressed={phonePane === value}
                    onClick={() => setPhonePane(value)}
                    className="flex-1"
                  >
                    {label}
                  </Button>
                ))}
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <Card className={cn(phonePane === 'notepad' ? 'block' : 'hidden', 'lg:block')}>
                  <CardContent className="pt-4">{notepad}</CardContent>
                </Card>
                <Card className={cn(phonePane === 'transcript' ? 'block' : 'hidden', 'lg:block')}>
                  <CardContent className="pt-4">
                    {transcriptPane}
                    {recorder.callEnded && recorder.phase === 'recording' ? (
                      <p className="mt-2 text-xs text-[var(--fg-muted)]">
                        The call has gone quiet. Press Stop when it is over.
                      </p>
                    ) : null}
                  </CardContent>
                </Card>
              </div>
            </>
          ) : meeting.status === 'processing' && !note?.generatedAt ? (
            <Card>
              <CardContent className="py-8 text-center">
                <p className="text-sm font-medium">Writing your notes…</p>
                <p className="mt-1 text-sm text-[var(--fg-muted)]">
                  The transcript is on its tab meanwhile.
                </p>
                <Button size="sm" className="mt-3" onClick={() => void regenerate()}>
                  Write them now
                </Button>
              </CardContent>
            </Card>
          ) : note && !editingNotes ? (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
              <Card>
                <CardContent className="pt-4">
                  {note.generatedAt ? (
                    <EnhancedNotes
                      note={note}
                      segments={segments}
                      speakers={speakers}
                      templates={templates}
                      regenerating={regenerating}
                      onRegenerate={() => void regenerate(note.templateId)}
                      onTemplate={(t) => void changeTemplate(t)}
                      onEdit={() => setEditingNotes(true)}
                      onJump={jumpTo}
                    />
                  ) : (
                    <div className="py-6 text-center">
                      <p className="text-sm text-[var(--fg-muted)]">No notes written yet.</p>
                      <Button
                        size="sm"
                        className="mt-3"
                        loading={regenerating}
                        onClick={() => void regenerate()}
                      >
                        Write the notes
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
              <ActionItemsCard
                items={note.actionItems}
                promiseLabel={promiseLabel}
                segments={segments}
                speakers={speakers}
                onAdd={addTask}
                onJump={jumpTo}
              />
            </div>
          ) : (
            <Card>
              <CardContent className="pt-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">Your notes</p>
                  {editingNotes ? (
                    <Button
                      size="sm"
                      variant="primary"
                      loading={regenerating}
                      onClick={async () => {
                        await saveNotesNow();
                        if (await regenerate(note?.templateId)) setEditingNotes(false);
                      }}
                    >
                      Done: rewrite the notes
                    </Button>
                  ) : (
                    <Button size="sm" loading={regenerating} onClick={() => void regenerate()}>
                      Write the notes
                    </Button>
                  )}
                </div>
                {notepad}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="transcript">
          <Card>
            <CardContent className="pt-4">
              <LiveTranscript
                segments={segments}
                speakers={speakers}
                partial={recorder.partial}
                live={recorder.phase === 'recording'}
                highlightSeq={highlightSeq}
                onOpenSpeaker={(s, line) =>
                  setSheet({ clusterKey: s.clusterKey, seq: line?.seq ?? null })
                }
                onEditLine={editLine}
                className="max-h-[70vh] pr-1"
              />
              {highlightSeq !== null ? (
                <p className="mt-2 text-xs text-[var(--fg-muted)]">
                  Showing the moment at{' '}
                  {formatOffset(segments.find((s) => s.seq === highlightSeq)?.startMs ?? 0)}.
                </p>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Kept mounted, so the conversation survives a look at another tab. */}
        <TabsContent value="chat" forceMount className="data-[state=inactive]:hidden">
          <Card>
            <CardContent className="pt-4">
              <ChatPanel
                meetingId={id}
                participants={participants}
                recipes={recipes}
                preset={chatPreset}
                onJump={jumpTo}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="people">
          <Card>
            <CardContent className="pt-4">
              <PeoplePanel
                participants={participants}
                speakers={speakers}
                onOpenSpeaker={(s) => setSheet({ clusterKey: s.clusterKey, seq: null })}
                onChatAbout={(email) => {
                  setChatPreset({ scope: 'person', personEmail: email, nonce: Date.now() });
                  changeTab('chat');
                }}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="share">
          <Card>
            <CardContent className="space-y-6 pt-4">
              <SharePanel
                meetingId={id}
                links={links}
                notesReady={notesReady}
                timeZone={timeZone}
                onLinks={setLinks}
              />
              {meeting.isRecorder ? (
                <WhoSees
                  meeting={meeting}
                  folders={folders}
                  onChange={(patch) => void shareSettings(patch)}
                />
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <ConsentBanner
        open={consentOpen}
        onOpenChange={setConsentOpen}
        meetingId={id}
        neverRecord={meeting.consent.neverRecord}
        inPerson={meeting.kind === 'in_person'}
        canRecord={recorder.canRecord}
        cannotRecordReason={cannotRecord}
        callAudioAvailable={recorder.callAudioAvailable}
        liveCapture={engine === 'live'}
        error={recorder.phase === 'idle' ? recorder.error : null}
        onStart={async (input) => {
          const started = await recorder.start(input);
          if (started) changeTab('notes');
          return started;
        }}
      />
      <WhoIsThisSheet
        open={sheet !== null}
        onOpenChange={(open) => {
          if (!open) setSheet(null);
        }}
        speaker={sheetSpeaker}
        line={sheetLine}
        participants={participants}
        speakers={speakers}
        busy={busy}
        onRelabel={(person, remember) => void relabel(person, remember)}
        onSplit={(mode) => void split(mode)}
        onMerge={(into) => void merge(into)}
      />
    </div>
  );
}

function ConsentStatus({ meeting, timeZone }: { meeting: MeetingView; timeZone: string }) {
  const c = meeting.consent;
  if (c.state === 'blocked' || c.neverRecord) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-[var(--danger)]">
        <Ban className="size-3.5" aria-hidden /> Never-record list
      </span>
    );
  }
  if (c.state === 'confirmed') {
    return (
      <span className="text-xs text-[var(--fg-muted)]" data-consent-status="confirmed">
        Consent: {c.method ? CONSENT_WORDS[c.method] : 'confirmed'}
        {c.at ? `, ${formatTime(c.at, timeZone)}` : ''}
      </span>
    );
  }
  return (
    <span className="text-xs text-[var(--fg-muted)]" data-consent-status="pending">
      Consent not confirmed yet
    </span>
  );
}

function StartCard({
  meeting,
  canRecord,
  cannotRecord,
  onStart,
}: {
  meeting: MeetingView;
  canRecord: boolean;
  cannotRecord: string | null;
  onStart: () => void;
}) {
  const blocked = meeting.consent.neverRecord;
  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <div className="flex items-center gap-2">
          <NotebookPen className="size-5 text-[var(--gold)]" aria-hidden />
          <p className="font-serif text-base font-semibold">Take notes on this meeting</p>
        </div>
        <ol className="space-y-2 text-sm text-[var(--fg-muted)]">
          <li className="flex gap-2">
            <FileText className="mt-0.5 size-4 shrink-0" aria-hidden /> Tell everyone it is being
            transcribed (Copilot gives you the words to paste).
          </li>
          <li className="flex gap-2">
            <Mic className="mt-0.5 size-4 shrink-0" aria-hidden /> Start. The transcript fills in
            live with names; type your own notes alongside.
          </li>
          <li className="flex gap-2">
            <Users className="mt-0.5 size-4 shrink-0" aria-hidden /> Stop. Notes, action items and a
            summary to share are written from both.
          </li>
        </ol>
        {blocked ? (
          <div
            role="alert"
            className="rounded-md border border-[var(--danger)]/30 bg-[var(--danger-soft)] px-3 py-2.5 text-sm"
          >
            <p className="font-semibold text-[var(--danger)]">{NEVER_RECORD_MESSAGE}</p>
            <p className="mt-0.5 text-[var(--fg-muted)]">
              The {blocked.label} rule: {blocked.reason}.
            </p>
          </div>
        ) : !meeting.isRecorder ? (
          <p className="text-sm text-[var(--fg-muted)]">
            Only the person who opened these notes can record them.
          </p>
        ) : (
          <>
            <Button variant="primary" size="lg" onClick={onStart} disabled={!canRecord}>
              <Mic aria-hidden /> Start recording
            </Button>
            {cannotRecord ? <p className="text-xs text-[var(--fg-muted)]">{cannotRecord}</p> : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function WhoSees({
  meeting,
  folders,
  onChange,
}: {
  meeting: MeetingView;
  folders: readonly FolderView[];
  onChange: (patch: { visibility?: 'private' | 'team'; folderId?: string | null }) => void;
}) {
  const visibilityId = React.useId();
  const folderId = React.useId();
  const folder = folders.find((f) => f.id === meeting.folderId);
  return (
    <section aria-label="Who in Copilot sees it" className="border-t border-[var(--border)] pt-4">
      <h2 className="font-serif text-base font-semibold">Inside Copilot</h2>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={visibilityId} className="text-sm font-medium">
            Who can see it
          </label>
          <Select
            id={visibilityId}
            value={meeting.visibility}
            disabled={Boolean(folder?.isPrivate)}
            onChange={(e) => onChange({ visibility: e.target.value as 'private' | 'team' })}
            className="mt-1"
          >
            <option value="private">Only you</option>
            <option value="team">Your team</option>
          </Select>
          {folder?.isPrivate ? (
            <p className="mt-1 text-xs text-[var(--fg-muted)]">
              It is in {folder.name}, a private folder, so it stays private.
            </p>
          ) : null}
        </div>
        <div>
          <label htmlFor={folderId} className="text-sm font-medium">
            Folder
          </label>
          <Select
            id={folderId}
            value={meeting.folderId ?? ''}
            onChange={(e) => onChange({ folderId: e.target.value || null })}
            className="mt-1"
          >
            <option value="">No folder</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
                {f.isPrivate ? ' (private)' : ''}
              </option>
            ))}
          </Select>
        </div>
      </div>
    </section>
  );
}
