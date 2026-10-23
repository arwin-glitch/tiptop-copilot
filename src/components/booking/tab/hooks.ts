'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { BookingConfig } from '@/lib/booking/config';
import type { PreviewDay } from '@/lib/booking/planner-status';
import type { TabBooking } from './types';

/**
 * The Booking tab's three reads and one write, in the browser: save part of
 * the settings (PATCH /api/booking/settings, only the fields a panel sends),
 * the live preview of open times, and the bookings list.
 */

export interface SavedSettings {
  enabled: boolean;
  slug: string;
  config: BookingConfig;
}

export interface SettingsPatchBody {
  enabled?: boolean;
  slug?: string;
  config?: Partial<BookingConfig>;
}

/** Save part of the settings; a toast says how it went, and the page re-reads. */
export function useSettingsSave() {
  const router = useRouter();
  const [saving, setSaving] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const save = React.useCallback(
    async (
      patch: SettingsPatchBody,
      done = 'Saved',
      /** Puts the change back: the toast offers Undo (a tap saves at once). */
      undo?: () => void,
    ): Promise<SavedSettings | null> => {
      setSaving(true);
      setProblem(null);
      const res = await fetch('/api/booking/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }).catch(() => null);
      setSaving(false);
      const json = (await res?.json().catch(() => null)) as {
        ok?: boolean;
        settings?: SavedSettings;
        error?: { message?: string };
      } | null;
      if (!res?.ok || !json?.ok || !json.settings) {
        const message = json?.error?.message ?? 'That did not save. Try again.';
        setProblem(message);
        toast.error(message);
        return null;
      }
      toast.success(done, undo ? { action: { label: 'Undo', onClick: undo } } : undefined);
      router.refresh();
      return json.settings;
    },
    [router],
  );
  return { save, saving, problem, setProblem };
}

export interface PreviewData {
  state: 'ok' | 'unavailable';
  message: string | null;
  hostZone: string;
  today: string;
  openMonths: string[];
  lastOpenDay: string | null;
  days: PreviewDay[];
}

export type PreviewQuery = { month: string } | { from: string; days: number };

/** The live preview for a month or a run of days; `version` refetches after a save. */
export function usePreview(query: PreviewQuery, version: number) {
  const key = 'month' in query ? `month=${query.month}` : `from=${query.from}&days=${query.days}`;
  const [state, setState] = React.useState<{
    key: string;
    data: PreviewData | null;
    error: string | null;
  } | null>(null);
  React.useEffect(() => {
    let live = true;
    void fetch(`/api/booking/preview?${key}`, { cache: 'no-store' })
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as {
          ok?: boolean;
          preview?: PreviewData;
          error?: { message?: string };
        } | null;
        if (!live) return;
        if (!res.ok || !json?.ok || !json.preview) {
          setState({ key, data: null, error: json?.error?.message ?? 'The preview did not load.' });
        } else {
          setState({ key, data: json.preview, error: null });
        }
      })
      .catch(() => {
        if (live) setState({ key, data: null, error: 'The preview did not load.' });
      });
    return () => {
      live = false;
    };
  }, [key, version]);
  const current = state?.key === key ? state : null;
  return {
    data: current?.data ?? null,
    error: current?.error ?? null,
    loading: current === null,
  };
}

export interface MonthCountsData {
  state: 'ok' | 'unavailable';
  message: string | null;
  today: string;
  months: { month: string; open: boolean; times: number }[];
}

/** Each month of the strip with its open-time count; `version` refetches after a save. */
export function useMonthCounts(version: number) {
  const [state, setState] = React.useState<{
    version: number;
    data: MonthCountsData | null;
  } | null>(null);
  React.useEffect(() => {
    let live = true;
    void fetch('/api/booking/preview?counts=1', { cache: 'no-store' })
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as {
          ok?: boolean;
          counts?: MonthCountsData;
        } | null;
        if (live) setState({ version, data: res.ok && json?.counts ? json.counts : null });
      })
      .catch(() => {
        if (live) setState({ version, data: null });
      });
    return () => {
      live = false;
    };
  }, [version]);
  // The last counts stay up while new ones load, so the chips do not flicker.
  return { data: state?.data ?? null, loading: state?.version !== version };
}

export type BookingsState =
  | { state: 'loading' }
  | { state: 'ok'; bookings: TabBooking[] }
  | { state: 'missing' }
  | { state: 'error'; message: string };

/** The bookings list for one scope (GET /api/booking/bookings?scope=). */
export function useBookings(scope: 'upcoming' | 'past' | 'messages', version: number) {
  const [state, setState] = React.useState<{ scope: string; value: BookingsState } | null>(null);
  React.useEffect(() => {
    let live = true;
    void fetch(`/api/booking/bookings?scope=${scope}`, { cache: 'no-store' })
      .then(async (res) => {
        const json = (await res.json().catch(() => null)) as {
          bookings?: TabBooking[];
          error?: { message?: string };
        } | null;
        if (!live) return;
        if (res.status === 404 && !json?.bookings) {
          setState({ scope, value: { state: 'missing' } });
        } else if (!res.ok || !Array.isArray(json?.bookings)) {
          setState({
            scope,
            value: { state: 'error', message: json?.error?.message ?? 'Bookings did not load.' },
          });
        } else {
          setState({ scope, value: { state: 'ok', bookings: json.bookings } });
        }
      })
      .catch(() => {
        if (live) setState({ scope, value: { state: 'error', message: 'Bookings did not load.' } });
      });
    return () => {
      live = false;
    };
  }, [scope, version]);
  return state?.scope === scope ? state.value : ({ state: 'loading' } as const);
}
