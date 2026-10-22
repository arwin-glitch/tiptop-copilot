/**
 * How the RSVP form (WS4's RsvpSlot) tells the page an RSVP succeeded, so
 * the theme's RSVP moment plays (confetti, gold dust, ball-to-cup, wax
 * stamp…). A window CustomEvent keeps the two workstreams decoupled: the
 * slot calls `announceRsvp({ status })` after a successful response; the
 * page's RsvpMoments island listens. Only 'going' plays a moment.
 *
 * Studio uses `announceRsvp({ status: 'going', preview: true })` for its
 * "Preview the RSVP moment" button.
 */

export const RSVP_MOMENT_EVENT = 'tiptop-event:rsvp';

export type RsvpMomentStatus =
  'going' | 'maybe' | 'not_going' | 'pending' | 'waitlist' | 'declined';

export interface RsvpMomentDetail {
  status: RsvpMomentStatus;
  /** Studio preview: plays even in studio mode. */
  preview?: boolean;
}

export function announceRsvp(detail: RsvpMomentDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<RsvpMomentDetail>(RSVP_MOMENT_EVENT, { detail }));
}
