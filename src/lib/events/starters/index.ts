import type { StarterDoc } from '@/lib/events/contracts';
import { sectionTemplate } from '@/lib/events/doc';
import { DEFAULT_THEME_PRESET_ID } from '@/lib/events/themes';

/**
 * CONTRACT STUB — owned by WS2 (Design system). Replace the body, keep the
 * exports: STARTERS, BLANK_STARTER_ID, getStarter.
 *
 * Holds only "Blank" today. WS2 adds the five TipTop starters (AGM Day +
 * Evening, Founder Golf / Pitch & Putt, Dinner Salon, Demo Day, Holiday
 * Party) with FICTIONAL copy only. Empty props are deliberate: an empty
 * hero headline falls back to the event title, an empty media slot shows
 * "Add photo", never lorem ipsum.
 */

export const BLANK_STARTER_ID = 'blank';

const blank: StarterDoc = {
  id: BLANK_STARTER_ID,
  name: 'Blank',
  description: 'A cover, the key details, an RSVP card and a footer.',
  themePresetId: DEFAULT_THEME_PRESET_ID,
  access: 'open',
  visibility: 'unlisted',
  sessions: [],
  sections: [
    sectionTemplate('hero', { headline: '', subheadline: '' }),
    sectionTemplate('details', {}),
    sectionTemplate('rsvp', { cta: 'RSVP', going: 'Going', maybe: 'Maybe', notGoing: "Can't go" }),
    sectionTemplate('footer', {}),
  ],
};

export const STARTERS: readonly StarterDoc[] = [blank];

export function getStarter(id: string | null | undefined): StarterDoc {
  return STARTERS.find((s) => s.id === id) ?? blank;
}
