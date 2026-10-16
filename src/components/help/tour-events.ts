/**
 * Start a guided tour from anywhere in the client. The tour host in the app
 * layout listens; a link needs nothing, since `?tour=<id>` on any page does
 * the same.
 */
export const TOUR_START_EVENT = 'tiptop:tour-start';

/** Where the active tour is kept, so it survives the page changes it makes. */
export const TOUR_STORAGE_KEY = 'tiptop-tour';

export interface StoredTour {
  id: string;
  index: number;
}

export function readStoredTour(): StoredTour | null {
  try {
    const raw = window.sessionStorage.getItem(TOUR_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredTour>;
    if (typeof value.id !== 'string' || typeof value.index !== 'number') return null;
    if (!Number.isInteger(value.index) || value.index < 0) return null;
    return { id: value.id, index: value.index };
  } catch {
    return null;
  }
}

export function writeStoredTour(tour: StoredTour | null): void {
  try {
    if (tour) window.sessionStorage.setItem(TOUR_STORAGE_KEY, JSON.stringify(tour));
    else window.sessionStorage.removeItem(TOUR_STORAGE_KEY);
  } catch {
    // Storage blocked: the tour still runs, it just will not survive a reload.
  }
}

export function startTour(id: string): void {
  // Written first as well: a host that mounts after this call (a page that
  // starts a tour while loading) reads it from storage.
  writeStoredTour({ id, index: 0 });
  window.dispatchEvent(new CustomEvent<{ id: string }>(TOUR_START_EVENT, { detail: { id } }));
}

/**
 * Sent by the tour host whenever a tour starts or ends, with `{ active }`. The
 * Ask Arwin reply pop-up waits while a tour runs: a pop-up in the corner
 * would talk over the step being explained.
 */
export const TOUR_STATE_EVENT = 'tiptop:tour-state';

export interface TourStateDetail {
  active: boolean;
}
