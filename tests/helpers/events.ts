import { capabilitiesForGrant } from '@/lib/events/capabilities';
import type { EventActor, EventGrant } from '@/lib/events/contracts';
import { newEventDoc, sectionTemplate } from '@/lib/events/doc';
import type { EventDoc } from '@/lib/events/schema';
import { getThemePreset } from '@/lib/events/themes';
import type { EventEditorScope } from '@/lib/types/domain';

/**
 * Small builders for the Events tests (D-075). Fictional names only.
 */

let grantCounter = 0;

/** An outside editor's actor for one event, as WS3's resolveGrant would hand it over. */
export function outsideActor(
  eventId: string,
  organizationId: string,
  options: {
    name?: string;
    scope?: Partial<EventEditorScope>;
    role?: 'editor' | 'viewer' | 'checkin';
    editingPaused?: boolean;
  } = {},
): EventActor {
  const scope: EventEditorScope = {
    design: true,
    content: true,
    sections: 'all',
    brand_locked: true,
    ...options.scope,
  };
  const role = options.role ?? 'editor';
  const grant: EventGrant = {
    grantId: `00000000-0000-4000-8000-${(0xa000 + ++grantCounter).toString(16).padStart(12, '0')}`,
    eventId,
    organizationId,
    role,
    scope,
    label: `${options.name ?? 'Morgan'} – Example Club`,
    tokenVersion: 1,
    expiresAt: '2099-01-01T00:00:00.000Z',
    capabilities: capabilitiesForGrant(
      { role, scope, editingPaused: options.editingPaused },
      { logo: true, palette: true, fonts: true, intro: true },
    ),
  };
  return { kind: 'grant', grant, name: options.name ?? 'Morgan Example' };
}

/** Deterministic ids for hand-built documents. */
export function idSeq(prefix = 'd0c'): () => string {
  let n = 0;
  return () => `00000000-0000-4000-8000-${prefix}${(++n).toString(16).padStart(9, '0')}`;
}

/** A small valid document: hero, agenda, text, RSVP. */
export function sampleDoc(makeId = idSeq()): EventDoc {
  return newEventDoc(
    getThemePreset('tiptop-signature').theme,
    [
      sectionTemplate('hero', { headline: 'A fictional gathering', subheadline: '' }),
      sectionTemplate('agenda', { items: [{ time: '1:00 PM', title: 'Welcome' }] }),
      sectionTemplate('text', { heading: 'About', body: 'Plain words.' }),
      sectionTemplate('rsvp', { cta: 'RSVP' }),
    ],
    makeId,
  );
}
