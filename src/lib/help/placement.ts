import type { TourPlacement } from '@/lib/help/registry';

/**
 * Where the tour card goes, given the spotlit element. Pure, so the geometry
 * is tested without a browser.
 *
 * On a wide screen the card floats beside the target, on the preferred side
 * when it fits, else the opposite side, else any side that fits, else over
 * the bottom of the window. On a phone it docks full width to the top or the
 * bottom edge, whichever leaves the target in view: a 340px card beside a
 * 360px-wide target has nowhere to go.
 */

export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export type CardPosition =
  { mode: 'float'; top: number; left: number } | { mode: 'dock'; edge: 'top' | 'bottom' };

/** Below this width the card docks instead of floating. */
export const PHONE_MAX_WIDTH = 640;
/** Space between the target and the card. */
export const CARD_GAP = 14;
/** The closest the card comes to a window edge. */
export const EDGE_MARGIN = 12;
/**
 * What the phone layout keeps at its edges: the header and its safe area on
 * top, the bottom tab bar on the bottom. A docked card covers these anyway;
 * they only decide which edge leaves more of the target showing.
 */
const PHONE_TOP_RESERVE = 60;
const PHONE_BOTTOM_RESERVE = 72;

const OPPOSITE: Record<TourPlacement, TourPlacement> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
};

/** The part of `box` inside the window; a target taller than the screen counts only what shows. */
export function visiblePart(box: Box, viewport: Size): Box {
  const top = Math.max(0, box.top);
  const left = Math.max(0, box.left);
  const bottom = Math.min(viewport.height, box.top + box.height);
  const right = Math.min(viewport.width, box.left + box.width);
  return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function placeCard(
  target: Box | null,
  card: Size,
  viewport: Size,
  preferred: TourPlacement,
): CardPosition {
  if (viewport.width < PHONE_MAX_WIDTH) {
    if (!target) return { mode: 'dock', edge: 'bottom' };
    const seen = visiblePart(target, viewport);
    // A target filling most of the screen is read from its top: keep that clear.
    if (seen.height > viewport.height * 0.5) return { mode: 'dock', edge: 'bottom' };
    const above = seen.top - PHONE_TOP_RESERVE;
    const below = viewport.height - PHONE_BOTTOM_RESERVE - (seen.top + seen.height);
    return { mode: 'dock', edge: below >= above ? 'bottom' : 'top' };
  }

  const maxLeft = viewport.width - card.width - EDGE_MARGIN;
  const maxTop = viewport.height - card.height - EDGE_MARGIN;
  const fallback: CardPosition = {
    mode: 'float',
    top: clamp(maxTop, EDGE_MARGIN, maxTop),
    left: clamp((viewport.width - card.width) / 2, EDGE_MARGIN, maxLeft),
  };
  if (!target) return fallback;

  const t = visiblePart(target, viewport);
  const centreX = t.left + t.width / 2 - card.width / 2;
  const centreY = t.top + t.height / 2 - card.height / 2;
  const candidates: Record<TourPlacement, { top: number; left: number; fits: boolean }> = {
    bottom: {
      top: t.top + t.height + CARD_GAP,
      left: centreX,
      fits: t.top + t.height + CARD_GAP + card.height <= viewport.height - EDGE_MARGIN,
    },
    top: {
      top: t.top - CARD_GAP - card.height,
      left: centreX,
      fits: t.top - CARD_GAP - card.height >= EDGE_MARGIN,
    },
    right: {
      top: centreY,
      left: t.left + t.width + CARD_GAP,
      fits: t.left + t.width + CARD_GAP + card.width <= viewport.width - EDGE_MARGIN,
    },
    left: {
      top: centreY,
      left: t.left - CARD_GAP - card.width,
      fits: t.left - CARD_GAP - card.width >= EDGE_MARGIN,
    },
  };

  const order: TourPlacement[] = [preferred, OPPOSITE[preferred], 'bottom', 'top', 'right', 'left'];
  for (const side of order) {
    const c = candidates[side];
    if (c.fits) {
      return {
        mode: 'float',
        top: clamp(c.top, EDGE_MARGIN, maxTop),
        left: clamp(c.left, EDGE_MARGIN, maxLeft),
      };
    }
  }
  return fallback;
}
