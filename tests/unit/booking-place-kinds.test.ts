import { describe, expect, it } from 'vitest';
import { PLACE, placesForKind } from '@/lib/booking/config';

/** Places tagged by meal: coffee spots only under Coffee. Fictional places. */

const places = [
  { id: 'bean', name: 'Bean Bar', area: 'East', mapUrl: null, kinds: ['coffee' as const] },
  {
    id: 'grill',
    name: 'Harbor Grill',
    area: 'Downtown',
    mapUrl: null,
    kinds: ['lunch' as const, 'dinner' as const],
  },
  { id: 'any', name: 'Old Favourite', area: '', mapUrl: null, kinds: [] },
];

describe('places by meal', () => {
  it('shows only the places tagged for the chosen meal, plus untagged ones', () => {
    expect(placesForKind(places, 'coffee').map((p) => p.id)).toEqual(['bean', 'any']);
    expect(placesForKind(places, 'dinner').map((p) => p.id)).toEqual(['grill', 'any']);
    expect(placesForKind(places, null).map((p) => p.id)).toEqual(['bean', 'grill', 'any']);
  });

  it('reads a place saved before meal tags as every meal', () => {
    const old = PLACE.parse({ id: 'old', name: 'Old Spot', area: 'South', mapUrl: null });
    expect(old.kinds).toEqual([]);
    expect(placesForKind([old], 'lunch')).toHaveLength(1);
  });
});
