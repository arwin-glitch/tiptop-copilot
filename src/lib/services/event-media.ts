import 'server-only';
import type { DataStore } from '@/lib/db/store';
import type { EventActor, EventViewer, MediaMap } from '@/lib/events/contracts';
import type { EventDoc } from '@/lib/events/schema';
import type { EventMedia, EventMediaKind } from '@/lib/types/domain';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * Event media (D-075) — WS1 PART 2. Signatures are final (WS3's media
 * panel, WS4's public route and WS2's renderer code against them); bodies
 * land after the contract commit.
 *
 * Pipeline: the browser asks for a signed upload URL and uploads the
 * original straight to the private event-originals bucket; then asks to
 * process it. Processing (sharp): rotate() (which also strips EXIF/GPS),
 * AVIF + WebP at 640/1080/1920, a thumbhash and the top-5 colours; HEIC is
 * refused (converted in the browser); SVG is refused. Derivatives of
 * ungated media go to the public event-media bucket under content-hashed
 * paths; gated media stays private and is served as 15-minute signed URLs
 * to viewers who qualify. Limits for outside editors: 20 uploads an hour
 * per grant, 200 MB a day per event.
 */

export interface UploadTicket {
  mediaId: string;
  /** Supabase signed upload URL (or the demo store's local equivalent). */
  uploadUrl: string;
  /** The token the upload must carry. */
  token: string;
  path: string;
  maxBytes: number;
}

function notBuilt<T>(operation: string): Result<T> {
  return err('not_configured', 'Media uploads are still being built.', {
    stillUsable: 'Everything else in Studio works.',
    details: { operation },
  });
}

export async function createUploadUrl(
  store: DataStore,
  actor: EventActor,
  eventId: string,
  input: {
    kind: EventMediaKind;
    contentType: string;
    bytes: number;
    name: string;
    gated?: boolean;
  },
): Promise<Result<UploadTicket>> {
  void store;
  void actor;
  void eventId;
  void input;
  return notBuilt('createUploadUrl');
}

export async function processMedia(
  store: DataStore,
  actor: EventActor,
  eventId: string,
  mediaId: string,
): Promise<Result<EventMedia>> {
  void store;
  void actor;
  void eventId;
  void mediaId;
  return notBuilt('processMedia');
}

/** Alt text, decorative, gated (owners only for gated). */
export async function updateMedia(
  store: DataStore,
  actor: EventActor,
  eventId: string,
  mediaId: string,
  patch: { alt?: string | null; decorative?: boolean; gated?: boolean },
): Promise<Result<EventMedia>> {
  void store;
  void actor;
  void eventId;
  void mediaId;
  void patch;
  return notBuilt('updateMedia');
}

export async function listMedia(
  store: DataStore,
  actor: EventActor,
  eventId: string,
): Promise<Result<EventMedia[]>> {
  void store;
  void actor;
  void eventId;
  return notBuilt('listMedia');
}

/** Every media id a document references (hero, backgrounds, galleries, logos…). */
export function mediaIdsIn(doc: EventDoc): string[] {
  const ids = new Set<string>();
  const walk = (value: unknown, key = ''): void => {
    if (Array.isArray(value)) value.forEach((v) => walk(v));
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, k);
    } else if (typeof value === 'string' && /mediaId$/.test(key)) ids.add(value);
  };
  walk(doc);
  return [...ids];
}

/**
 * Resolve the media a (viewer-filtered) document references into URLs the
 * renderer can use. Until part 2 lands this returns an empty map, and the
 * renderer shows its placeholders.
 */
export async function resolveMedia(
  store: DataStore,
  organizationId: string,
  eventId: string,
  doc: EventDoc,
  viewer: EventViewer,
): Promise<Result<MediaMap>> {
  void store;
  void organizationId;
  void eventId;
  void doc;
  void viewer;
  return ok({});
}
