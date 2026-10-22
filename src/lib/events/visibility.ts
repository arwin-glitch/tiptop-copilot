import type { EventViewer } from '@/lib/events/contracts';
import type { EventDoc, EventSection } from '@/lib/events/schema';

/**
 * CONTRACT STUB — owned by WS4 (Guests). Working minimal rules; WS4 extends
 * (field-level gating, session-tag rules) and keeps the exports:
 * `sectionVisibleTo`, `filterDocForViewer`.
 *
 * The SERVER calls filterDocForViewer before a document reaches the
 * renderer, so a gated section is never sent to a viewer who does not
 * qualify (never hidden with CSS). Studio's "Preview as" calls the same
 * function with a guest viewer. Pure and isomorphic.
 */

/**
 * Whether one section is shown to this viewer. Owners and links see the whole
 * draft. Conservative default for 'tags': the viewer must be going AND carry
 * one of the tags (AGM pre-reads go to going LPs; waitlisted guests never see
 * gated details). WS4 may relax it per the spec.
 */
export function sectionVisibleTo(section: EventSection, viewer: EventViewer): boolean {
  if (viewer.kind === 'owner' || viewer.kind === 'editor' || viewer.kind === 'viewer') return true;
  const { mode, tags } = section.visibility;
  switch (mode) {
    case 'everyone':
      return true;
    case 'hidden':
      return false;
    case 'registered':
      return viewer.registered;
    case 'going':
      return viewer.going;
    case 'tags':
      return viewer.going && tags.some((t) => viewer.tags.includes(t));
  }
}

/** The document with only what this viewer may see. Never mutates its input. */
export function filterDocForViewer(doc: EventDoc, viewer: EventViewer): EventDoc {
  return { ...doc, sections: doc.sections.filter((s) => sectionVisibleTo(s, viewer)) };
}
