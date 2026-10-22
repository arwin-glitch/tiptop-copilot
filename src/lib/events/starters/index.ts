import type { StarterDoc } from '@/lib/events/contracts';
import { sectionTemplate } from '@/lib/events/doc';
import { DEFAULT_THEME_PRESET_ID } from '@/lib/events/themes';
import { agmStarter } from './agm';
import {
  demoDayStarter,
  dinnerSalonStarter,
  founderGolfStarter,
  holidayPartyStarter,
} from './more';

/**
 * Starter pages (D-075, WS2). Exports kept from the contract: STARTERS,
 * BLANK_STARTER_ID, getStarter.
 *
 * Five TipTop starters (AGM Day + Evening, Founder Golf / Pitch & Putt,
 * Dinner Salon, Demo Day, Holiday Party) plus Blank. Every name, company
 * and place in them is FICTIONAL placeholder copy (the repo is public); the
 * host replaces it in Studio. Sessions are offsets from the event start;
 * the new-event dialog's times win.
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

export const STARTERS: readonly StarterDoc[] = [
  agmStarter,
  founderGolfStarter,
  dinnerSalonStarter,
  demoDayStarter,
  holidayPartyStarter,
  blank,
];

export function getStarter(id: string | null | undefined): StarterDoc {
  return STARTERS.find((s) => s.id === id) ?? blank;
}
