/**
 * The small, shared vocabulary of the guided tours: the URL parameter that
 * starts one, the id of the walk through every page, and how a navigation
 * entry is named as a tour target.
 *
 * Kept apart from the registry so the navigation (a client component on
 * every page) can name its entries without pulling in every tour's copy.
 */

/** `?tour=<id>` on any signed-in page starts that tour. */
export const TOUR_PARAM = 'tour';

/** The id of the "2-minute tour": one stop on each main page, in order. */
export const GRAND_TOUR_ID = 'all';

/** The attribute a tour step points at: `<div data-tour="deals-pipeline">`. */
export const TOUR_ATTR = 'data-tour';

/**
 * The tour target of a navigation entry: `/fund-ii` is `nav-fund-ii`. The
 * sidebar and the phone's bottom bar both carry it, and a tour spotlights
 * whichever of the two is on screen.
 */
export function navTourId(href: string): string {
  return `nav-${href.replace(/^\//, '').replace(/\//g, '-')}`;
}
