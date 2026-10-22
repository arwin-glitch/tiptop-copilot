'use client';

import * as React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/form';
import {
  KIND_LABEL,
  KIND_START_BOUNDS,
  type MeetingKind,
  type Place,
  type TimeWindow,
} from '@/lib/booking/config';

/**
 * The Booking tab's form pieces, moved from Settings > Booking link with the
 * same behaviour: a row with a switch, a labelled text or number field, a
 * window of host time held to its hard bounds, a kind's start windows, and a
 * place.
 */

export function Row({
  title,
  body,
  lead,
  children,
}: {
  title: string;
  body: string;
  lead?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-[var(--border)] p-3">
      {lead}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-[var(--fg-muted)]">{body}</p>
      </div>
      {children}
    </div>
  );
}

export function TextField({
  id,
  label,
  hint,
  value,
  max,
  disabled,
  type = 'text',
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  max: number;
  disabled: boolean;
  type?: 'text' | 'url';
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        maxLength={max}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint ? <p className="text-xs text-[var(--fg-muted)]">{hint}</p> : null}
    </div>
  );
}

export function NumberField({
  id,
  label,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={Number.isFinite(value) ? value : ''}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

export function WindowRow({
  label,
  window,
  bounds,
  disabled,
  onChange,
  onRemove,
}: {
  label: string;
  window: TimeWindow;
  /** The hard bounds the window must keep inside (config.ts). */
  bounds: TimeWindow;
  disabled: boolean;
  onChange: (window: TimeWindow) => void;
  onRemove?: () => void;
}) {
  const uid = React.useId();
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1.5">
        <Label htmlFor={`${uid}-from`}>{label}</Label>
        <Input
          id={`${uid}-from`}
          type="time"
          min={bounds.from}
          max={bounds.to}
          value={window.from}
          disabled={disabled}
          className="w-32"
          onChange={(e) => onChange({ ...window, from: e.target.value })}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${uid}-to`}>and</Label>
        <Input
          id={`${uid}-to`}
          type="time"
          min={bounds.from}
          max={bounds.to}
          value={window.to}
          disabled={disabled}
          className="w-32"
          onChange={(e) => onChange({ ...window, to: e.target.value })}
        />
      </div>
      {onRemove ? (
        <Button
          size="icon"
          variant="ghost"
          disabled={disabled}
          onClick={onRemove}
          aria-label="Remove these hours"
        >
          <Trash2 aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}

export function KindWindows({
  kind,
  windows,
  disabled,
  onChange,
}: {
  kind: MeetingKind;
  windows: TimeWindow[];
  disabled: boolean;
  onChange: (windows: TimeWindow[]) => void;
}) {
  return (
    <fieldset className="space-y-2 rounded-md border border-[var(--border)] p-3">
      <legend className="px-1 text-sm font-medium">{KIND_LABEL[kind]}: starts between</legend>
      {windows.length === 0 ? <p className="text-sm text-[var(--fg-muted)]">Not offered.</p> : null}
      {windows.map((w, i) => (
        <WindowRow
          key={i}
          label="From"
          window={w}
          bounds={KIND_START_BOUNDS[kind]}
          disabled={disabled}
          onChange={(next) => onChange(windows.map((x, j) => (j === i ? next : x)))}
          onRemove={() => onChange(windows.filter((_, j) => j !== i))}
        />
      ))}
      {windows.length < 4 ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() =>
            onChange([
              ...windows,
              kind === 'dinner' ? { ...KIND_START_BOUNDS.dinner } : { from: '09:00', to: '10:00' },
            ])
          }
        >
          <Plus aria-hidden="true" />
          Add hours
        </Button>
      ) : null}
    </fieldset>
  );
}

/** A place's id from its name, unique among the ids already taken. */
export function placeId(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'place';
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

export function PlaceRow({
  place,
  index,
  disabled,
  onChange,
  onRemove,
}: {
  place: Place;
  index: number;
  disabled: boolean;
  onChange: (place: Place) => void;
  onRemove: () => void;
}) {
  const uid = React.useId();
  return (
    <div className="grid gap-2 rounded-md border border-[var(--border)] p-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
      <div className="space-y-1.5">
        <Label htmlFor={`${uid}-n`}>Place {index + 1}</Label>
        <Input
          id={`${uid}-n`}
          value={place.name}
          maxLength={80}
          disabled={disabled}
          placeholder="Name"
          onChange={(e) => onChange({ ...place, name: e.target.value })}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${uid}-a`}>Area</Label>
        <Input
          id={`${uid}-a`}
          value={place.area}
          maxLength={80}
          disabled={disabled}
          placeholder="Neighbourhood"
          onChange={(e) => onChange({ ...place, area: e.target.value })}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${uid}-m`}>Map link (optional)</Label>
        <Input
          id={`${uid}-m`}
          type="url"
          value={place.mapUrl ?? ''}
          maxLength={500}
          disabled={disabled}
          placeholder="https://"
          onChange={(e) =>
            onChange({ ...place, mapUrl: e.target.value.trim() ? e.target.value : null })
          }
        />
      </div>
      <Button
        size="icon"
        variant="ghost"
        disabled={disabled}
        onClick={onRemove}
        aria-label={`Remove place ${index + 1}`}
      >
        <Trash2 aria-hidden="true" />
      </Button>
    </div>
  );
}
