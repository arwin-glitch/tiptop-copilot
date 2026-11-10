import { describe, expect, it } from 'vitest';
import { someoneElsesTimeOff, travelSign } from '@/lib/booking/travel';

/**
 * An all-day "Sam OOO" on the host's calendar is someone else's time off: it
 * must not close in-person times as if the host were travelling. Fictional
 * names throughout.
 */

const home = {
  city: 'Harbor City',
  aliases: [],
  places: [],
  hostName: 'Dana Reyes',
};

const allDay = (title: string) => ({
  title,
  allDay: true,
  place: null,
  eventType: 'default',
  timeZone: null,
  ownEntry: true,
  startsAt: null,
  meeting: false,
});

describe("someone else's time off", () => {
  it('reads another person’s OOO, PTO or vacation as theirs', () => {
    expect(someoneElsesTimeOff('Sam OOO', home.hostName)).toBe(true);
    expect(someoneElsesTimeOff('OOO - Maya', home.hostName)).toBe(true);
    expect(someoneElsesTimeOff("Lee's vacation", home.hostName)).toBe(true);
    expect(someoneElsesTimeOff('Priya on PTO', home.hostName)).toBe(true);
  });

  it('keeps the host’s own time off and any trip as away', () => {
    expect(someoneElsesTimeOff('OOO', home.hostName)).toBe(false);
    expect(someoneElsesTimeOff('Dana OOO', home.hostName)).toBe(false);
    expect(someoneElsesTimeOff('Sam OOO trip', home.hostName)).toBe(false);
    expect(someoneElsesTimeOff('OOO in Denver', home.hostName)).toBe(false);
    expect(someoneElsesTimeOff('Sam OOO', undefined)).toBe(false);
  });

  it('no longer marks the host away for another person’s all-day OOO', () => {
    expect(travelSign(allDay('Sam OOO'), home, 'America/Chicago')).toBe(false);
    expect(travelSign(allDay('Vacation'), home, 'America/Chicago')).toBe(true);
    expect(travelSign(allDay('Offsite'), home, 'America/Chicago')).toBe(true);
  });
});
