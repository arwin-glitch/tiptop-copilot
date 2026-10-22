import { describe, expect, it } from 'vitest';
import { namesHome } from '@/lib/booking/travel';

// A home city saved the way people type it, "City, State", must still match
// the plain city name in a flight title or an address. Fictional places only.
const home = { city: 'Harbor City, Lakeshire', aliases: [], places: [] };

describe('home city typed as "City, State"', () => {
  it('matches a flight title that names only the city', () => {
    expect(namesHome('Flight to Harbor City (UA 400)', home)).toBe(true);
  });

  it('matches an address whose city part is the home city', () => {
    expect(namesHome('12 Main St, Harbor City, LK 12345', home)).toBe(true);
  });

  it('still matches the full name as typed', () => {
    expect(namesHome('Back in Harbor City, Lakeshire', home)).toBe(true);
  });

  it('does not match another city', () => {
    expect(namesHome('Flight to Lakeport (UA 401)', home)).toBe(false);
  });

  it('does not match the state part on its own', () => {
    expect(namesHome('Lakeshire state fair', home)).toBe(false);
  });
});
