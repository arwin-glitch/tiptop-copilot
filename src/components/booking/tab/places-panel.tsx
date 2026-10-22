'use client';

import * as React from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/feedback';
import { Switch } from '@/components/ui/form';
import { inPersonOffered, type BookingConfig } from '@/lib/booking/config';
import { SaveBar } from './availability-panel';
import { placeId, PlaceRow, Row, TextField } from './fields';
import { useSettingsSave } from './hooks';

type PlacesFields = Pick<BookingConfig, 'homeCity' | 'homeAliases' | 'places' | 'allowCustomPlace'>;

export interface PlacesPanelProps {
  places: PlacesFields;
  canEdit: boolean;
}

/**
 * Places: the home city (in person only on days he is there), other names
 * for it, the places near him the page lists, and whether visitors may
 * suggest one. Moved from Settings > Booking link unchanged.
 */
export function PlacesPanel(props: PlacesPanelProps) {
  const { save, saving, problem } = useSettingsSave();
  const [value, setValue] = React.useState<PlacesFields>(props.places);
  const [aliases, setAliases] = React.useState(props.places.homeAliases.join(', '));
  const [dirty, setDirty] = React.useState(false);
  const uid = React.useId();
  const disabled = !props.canEdit || saving;

  const set = <K extends keyof PlacesFields>(key: K, next: PlacesFields[K]) => {
    setValue((v) => ({ ...v, [key]: next }));
    setDirty(true);
  };

  return (
    <div className="space-y-5" data-tour="booking-places">
      {!props.canEdit ? (
        <Notice>Only an admin or the owner can change the booking link.</Notice>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          id={`${uid}-city`}
          label="Home city"
          hint="In person is offered only on days the host is here."
          value={value.homeCity}
          max={80}
          disabled={disabled}
          onChange={(v) => set('homeCity', v)}
        />
        <TextField
          id={`${uid}-aliases`}
          label="Other names for home"
          hint="Neighbourhoods or suburbs, separated by commas."
          value={aliases}
          max={600}
          disabled={disabled}
          onChange={(v) => {
            setAliases(v);
            set(
              'homeAliases',
              v
                .split(',')
                .map((a) => a.trim())
                .filter(Boolean)
                .slice(0, 10),
            );
          }}
        />
      </div>
      {!inPersonOffered(value) ? (
        <Notice>Set a home city and at least one place to offer in-person meetings.</Notice>
      ) : null}
      <div className="space-y-2">
        <p className="text-sm font-medium">Places near the host</p>
        {value.places.map((p, i) => (
          <PlaceRow
            key={p.id}
            place={p}
            index={i}
            disabled={disabled}
            onChange={(next) =>
              set(
                'places',
                value.places.map((x, j) => (j === i ? next : x)),
              )
            }
            onRemove={() =>
              set(
                'places',
                value.places.filter((_, j) => j !== i),
              )
            }
          />
        ))}
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled || value.places.length >= 20}
          onClick={() =>
            set('places', [
              ...value.places,
              {
                id: placeId(
                  `place-${value.places.length + 1}`,
                  value.places.map((p) => p.id),
                ),
                name: '',
                area: '',
                mapUrl: null,
              },
            ])
          }
        >
          <Plus aria-hidden="true" />
          Add a place
        </Button>
      </div>
      <Row title="Visitors may suggest a place" body="Shown as “Suggest a place” beside the list.">
        <Switch
          checked={value.allowCustomPlace}
          disabled={disabled}
          onCheckedChange={(v) => set('allowCustomPlace', v)}
          aria-label="Visitors may suggest a place"
        />
      </Row>
      <SaveBar
        dirty={dirty}
        saving={saving}
        disabled={disabled}
        problem={problem}
        label="Save places"
        onSave={async () => {
          const saved = await save({ config: value }, 'Places saved');
          if (saved) setDirty(false);
        }}
      />
    </div>
  );
}
