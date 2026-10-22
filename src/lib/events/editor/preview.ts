import {
  PUBLIC_VIEWER,
  SAMPLE_GUEST_VIEWER,
  type EventPublicFacts,
  type EventViewer,
} from '@/lib/events/contracts';

/**
 * Studio's "Preview as": the canvas renders the draft as one kind of guest
 * would see it, through the same visibility filter the public page uses
 * (lib/events/visibility.ts), so gated sections and the venue reveal can be
 * checked before publishing. Pure.
 */

/** A guest an owner can preview as: names and tags only, never an email. */
export interface PreviewGuest {
  id: string;
  firstName: string | null;
  name: string | null;
  company: string | null;
  tags: string[];
  registered: boolean;
  going: boolean;
}

export type PreviewChoice =
  | { kind: 'studio' }
  | { kind: 'public' }
  | { kind: 'sample' }
  | { kind: 'going' }
  | { kind: 'tag'; tag: string }
  | { kind: 'guest'; guestId: string };

export const DEFAULT_PREVIEW_TAGS = ['LP', 'Founder', 'Sponsor'] as const;

export function previewLabel(choice: PreviewChoice, guests: readonly PreviewGuest[]): string {
  switch (choice.kind) {
    case 'studio':
      return 'Everything (editing)';
    case 'public':
      return 'Public visitor';
    case 'sample':
      return 'Invited guest (Sarah)';
    case 'going':
      return 'Going guest';
    case 'tag':
      return `Going · ${choice.tag}`;
    case 'guest': {
      const g = guests.find((x) => x.id === choice.guestId);
      return g ? `Invited guest (${g.name ?? g.firstName ?? 'guest'})` : 'Invited guest';
    }
  }
}

/** The viewer the canvas renders for; 'studio' shows every section (editing). */
export function viewerFor(choice: PreviewChoice, guests: readonly PreviewGuest[]): EventViewer {
  switch (choice.kind) {
    case 'studio':
      return { ...PUBLIC_VIEWER, kind: 'owner' };
    case 'public':
      return PUBLIC_VIEWER;
    case 'sample':
      return SAMPLE_GUEST_VIEWER;
    case 'going':
      return { ...SAMPLE_GUEST_VIEWER, registered: true, going: true };
    case 'tag':
      return { ...SAMPLE_GUEST_VIEWER, registered: true, going: true, tags: [choice.tag] };
    case 'guest': {
      const g = guests.find((x) => x.id === choice.guestId);
      if (!g) return SAMPLE_GUEST_VIEWER;
      return {
        kind: 'guest',
        guestId: g.id,
        firstName: g.firstName,
        name: g.name,
        company: g.company,
        tags: g.tags,
        registered: g.registered,
        going: g.going,
        rsvp: null,
      };
    }
  }
}

/** The venue as this viewer would see it (the reveal rule applied). */
export function factsForViewer(facts: EventPublicFacts, viewer: EventViewer): EventPublicFacts {
  const venue = facts.venue;
  if (!venue || viewer.kind === 'owner' || viewer.kind === 'editor' || viewer.kind === 'viewer') {
    return facts;
  }
  const revealed =
    venue.revealRule === 'public' ||
    (venue.revealRule === 'registered' && viewer.registered) ||
    (venue.revealRule === 'going' && viewer.going);
  if (revealed) return facts;
  return {
    ...facts,
    venue: { ...venue, address: null, lat: null, lng: null, mapsUrl: null, revealed: false },
  };
}
