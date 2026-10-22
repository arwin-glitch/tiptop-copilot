import type { EventCapabilities } from '@/lib/events/capabilities';
import type { EventPublicFacts, MediaMap } from '@/lib/events/contracts';
import type { StudioEndpoints } from '@/lib/events/editor/api';
import type { PreviewGuest } from '@/lib/events/editor/preview';
import type { StudioMediaItem } from '@/lib/events/editor/publish';
import type { EventDoc } from '@/lib/events/schema';
import type { EventStatus } from '@/lib/types/domain';

/**
 * Everything one Studio needs, built on the server (load-studio.ts) for an
 * owner or an outside link and handed to the client component. Never the
 * raw event row: no settings, no password hash, and for outsiders no guest
 * names, published snapshot or activity.
 */
export interface StudioBootstrap {
  eventId: string;
  title: string;
  slug: string;
  status: EventStatus;
  timeZone: string;
  facts: EventPublicFacts;
  doc: EventDoc;
  version: number;
  /** Owners only: the live page, for the publish diff. */
  publishedDoc: EventDoc | null;
  publishedVersion: number;
  publishedDraftVersion: number;
  publishedAt: string | null;
  editingPaused: boolean;
  registrationOpen: boolean;
  media: MediaMap;
  mediaItems: StudioMediaItem[];
  /** Why the media library is empty, when it is not set up yet. */
  mediaNote: string | null;
  actor: {
    key: string;
    name: string;
    color: string;
    owner: boolean;
    outside: boolean;
    role: 'owner' | 'editor' | 'viewer';
  };
  capabilities: EventCapabilities;
  /** Owners only: guests to "Preview as" (names and tags, never emails). */
  guests: PreviewGuest[];
  tags: string[];
  endpoints: StudioEndpoints;
  /** Where "← Events" goes (owners), or null. */
  backHref: string | null;
  /** Where Share goes (owners), or null. */
  shareHref: string | null;
}
