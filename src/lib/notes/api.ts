/**
 * The /api/notes routes (D-076), as paths. Client-safe: the Notes UI and the
 * web recorder build every URL with these, so a route that moves moves here.
 * Bodies and answers are typed in lib/types/notes.ts.
 */

const base = '/api/notes';
const m = (id: string) => `${base}/meetings/${encodeURIComponent(id)}`;

export const NOTES_API = {
  /** GET/POST: this person's "Copilot Notes (beta)" switch and the feature's mode. */
  beta: `${base}/beta`,
  /** GET (list and search, see ListMeetingsQuery) / POST (create). */
  meetings: `${base}/meetings`,
  /** GET (detail) / PATCH / DELETE (to the trash). */
  meeting: m,
  /** POST: StartRecordingRequest. */
  start: (id: string) => `${m(id)}/start`,
  /** POST: PauseRecordingRequest. */
  pause: (id: string) => `${m(id)}/pause`,
  /** POST: StopRecordingRequest. */
  stop: (id: string) => `${m(id)}/stop`,
  /** POST: LogConsentRequest (the notice was copied). */
  consent: (id: string) => `${m(id)}/consent`,
  /** POST: SttTokenRequest. Recorder only. */
  sttToken: (id: string) => `${m(id)}/stt-token`,
  /** POST: UploadSegmentsRequest (recorder only). GET ?after=&limit= for polling. */
  segments: (id: string) => `${m(id)}/segments`,
  /** PATCH: EditSegmentRequest. */
  segment: (id: string, seq: number) => `${m(id)}/segments/${seq}`,
  /** PATCH: RelabelSpeakerRequest. */
  speaker: (id: string, clusterKey: string) =>
    `${m(id)}/speakers/${encodeURIComponent(clusterKey)}`,
  /** POST: SplitSpeakerRequest. */
  splitSpeaker: (id: string) => `${m(id)}/speakers/split`,
  /** POST: MergeSpeakersRequest. */
  mergeSpeakers: (id: string) => `${m(id)}/speakers/merge`,
  /** POST: GenerateNotesRequest. */
  generate: (id: string) => `${m(id)}/generate`,
  /** POST: NotesChatRequest. */
  chat: (id: string) => `${m(id)}/chat`,
  /** GET (links) / POST (CreateShareLinkRequest). */
  share: (id: string) => `${m(id)}/share`,
  /** DELETE: revoke. */
  shareLink: (id: string, linkId: string) => `${m(id)}/share/${encodeURIComponent(linkId)}`,
  /** POST: AddActionItemTaskRequest ("Add to Tasks"). */
  actionItems: (id: string) => `${m(id)}/action-items`,
  /** GET / POST (CreateTemplateRequest). */
  templates: `${base}/templates`,
  /** GET / POST (CreateFolderRequest). */
  folders: `${base}/folders`,
  /** GET / POST (CreateRecipeRequest). */
  recipes: `${base}/recipes`,
  /** GET / POST (VoiceConsentRequest). */
  voiceProfiles: `${base}/voice-profiles`,
} as const;

/** The public page a share link opens: /n/<token>. */
export function sharedNotePath(token: string): string {
  return `/n/${encodeURIComponent(token)}`;
}

/** The meeting page, optionally at a moment in its transcript. */
export function meetingPagePath(meetingId: string, atMs?: number | null): string {
  const path = `/meetings/${encodeURIComponent(meetingId)}`;
  return atMs != null && atMs >= 0 ? `${path}?tab=transcript&t=${Math.floor(atMs)}` : path;
}

/** "12:31" for a transcript offset; hours appear past the first one. */
export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(mm)}:${two(ss)}` : `${mm}:${two(ss)}`;
}
