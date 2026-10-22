'use client';

import * as React from 'react';
import { ChevronDown, ChevronUp, Lock, Plus, Trash2 } from 'lucide-react';
import { isAllowedHref } from '@/lib/campaigns/template';
import type { FieldDescriptor } from '@/lib/events/contracts';
import type { DenyReason } from '@/lib/events/capabilities';
import { emptyFor } from '@/lib/events/editor/fields';
import type { StudioMediaItem } from '@/lib/events/editor/publish';
import { PALETTE_TOKENS, type JsonValue } from '@/lib/events/schema';
import { cn } from '@/lib/util/cn';
import { Input, Select, Switch, Textarea } from '@/components/ui/form';

/**
 * The inspector's form generator: one control per field descriptor (WS2's
 * block registry), so every block's Content tab is built from data. Values
 * are plain JSON; links pass isAllowedHref before they are saved; media is
 * chosen from this event's library by id, never typed as a URL. A locked
 * field shows a lock and the reason ("Brand locked by TipTop", "Outside your
 * scope") and cannot change.
 */

export interface FieldInputProps {
  field: FieldDescriptor;
  value: JsonValue | undefined;
  onChange: (value: JsonValue) => void;
  /** Why it is locked (a capability or a soft lock), or null. */
  denied: DenyReason | string | null;
  idPrefix: string;
  media: readonly StudioMediaItem[];
  onFocusChange?: (focused: boolean) => void;
}

export function FieldInput(props: FieldInputProps) {
  const { field, denied, idPrefix } = props;
  const id = `${idPrefix}-${field.key}`;
  return (
    <div className="space-y-1" data-field-key={field.key}>
      <label
        htmlFor={id}
        className="flex items-center gap-1.5 text-xs font-medium text-[var(--fg)]"
      >
        {field.label}
        {denied ? (
          <span className="inline-flex items-center gap-1 font-normal text-[var(--fg-muted)]">
            <Lock aria-hidden="true" className="size-3" />
            {denied}
          </span>
        ) : null}
      </label>
      <Control {...props} id={id} />
      {field.help ? <p className="text-[11px] text-[var(--fg-muted)]">{field.help}</p> : null}
    </div>
  );
}

function Control({
  field,
  value,
  onChange,
  denied,
  idPrefix,
  media,
  onFocusChange,
  id,
}: FieldInputProps & { id: string }) {
  const disabled = Boolean(denied);
  const focus = {
    onFocus: () => onFocusChange?.(true),
    onBlur: () => onFocusChange?.(false),
  };
  switch (field.kind) {
    case 'text':
      return (
        <Input
          id={id}
          value={typeof value === 'string' ? value : ''}
          maxLength={field.max ?? 400}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          {...focus}
        />
      );
    case 'richtext':
      return (
        <>
          <Textarea
            id={id}
            value={typeof value === 'string' ? value : ''}
            maxLength={field.max ?? 20_000}
            disabled={disabled}
            rows={5}
            onChange={(e) => onChange(e.target.value)}
            {...focus}
          />
          <p className="text-[11px] text-[var(--fg-muted)]">
            **bold**, *italic*, [link](https://…), - lists, ## heading, {'{{first_name|friend}}'}
          </p>
        </>
      );
    case 'link':
      return (
        <LinkInput
          key={typeof value === 'string' ? value : ''}
          id={id}
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onCommit={onChange}
          onFocusChange={onFocusChange}
        />
      );
    case 'number':
      return (
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          value={typeof value === 'number' ? String(value) : ''}
          max={field.max}
          disabled={disabled}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) onChange(field.max !== undefined ? Math.min(field.max, n) : n);
          }}
          {...focus}
        />
      );
    case 'datetime':
      return (
        <Input
          id={id}
          type="datetime-local"
          value={typeof value === 'string' ? value.slice(0, 16) : ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          {...focus}
        />
      );
    case 'toggle':
      return (
        <Switch
          id={id}
          checked={value === true}
          disabled={disabled}
          onCheckedChange={(checked) => onChange(checked)}
        />
      );
    case 'select':
      return (
        <Select
          id={id}
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">Default</option>
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      );
    case 'color_token':
      return (
        <Select
          id={id}
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">Theme default</option>
          {PALETTE_TOKENS.map((token) => (
            <option key={token} value={token}>
              {token}
            </option>
          ))}
        </Select>
      );
    case 'media':
      return (
        <MediaPicker
          id={id}
          field={field}
          value={value}
          media={media}
          disabled={disabled}
          onChange={onChange}
        />
      );
    case 'person':
      return (
        <PersonInput
          id={id}
          value={value}
          disabled={disabled}
          onChange={onChange}
          onFocusChange={onFocusChange}
        />
      );
    case 'list':
      return (
        <ListEditor
          id={id}
          field={field}
          value={Array.isArray(value) ? value : []}
          disabled={disabled}
          onChange={onChange}
          idPrefix={idPrefix}
          media={media}
          onFocusChange={onFocusChange}
        />
      );
  }
}

function LinkInput({
  id,
  value,
  disabled,
  onCommit,
  onFocusChange,
}: {
  id: string;
  value: string;
  disabled: boolean;
  onCommit: (value: string) => void;
  onFocusChange?: (focused: boolean) => void;
}) {
  const [draft, setDraft] = React.useState(value);
  const valid = draft.trim() === '' || isAllowedHref(draft.trim());
  return (
    <>
      <Input
        id={id}
        type="url"
        inputMode="url"
        placeholder="https://…"
        value={draft}
        disabled={disabled}
        aria-invalid={!valid || undefined}
        onFocus={() => onFocusChange?.(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          onFocusChange?.(false);
          const next = draft.trim();
          if (next !== value && (next === '' || isAllowedHref(next))) onCommit(next);
        }}
      />
      {!valid ? (
        <p className="text-[11px] text-[var(--danger)]">
          Links start with https://, http:// or mailto:.
        </p>
      ) : null}
    </>
  );
}

function mediaIdOf(value: JsonValue | undefined): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const id = (value as Record<string, JsonValue>).mediaId;
    return typeof id === 'string' ? id : '';
  }
  return '';
}

function MediaPicker({
  id,
  field,
  value,
  media,
  disabled,
  onChange,
}: {
  id: string;
  field: FieldDescriptor;
  value: JsonValue | undefined;
  media: readonly StudioMediaItem[];
  disabled: boolean;
  onChange: (value: JsonValue) => void;
}) {
  const current = mediaIdOf(value);
  const asId = /mediaId$/i.test(field.key);
  const item = media.find((m) => m.id === current);
  return (
    <div className="flex items-center gap-2">
      {item?.previewUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- an event-media URL, not a page asset
        <img src={item.previewUrl} alt="" className="size-10 shrink-0 rounded object-cover" />
      ) : (
        <span
          aria-hidden="true"
          className="flex size-10 shrink-0 items-center justify-center rounded border border-dashed border-[var(--border-strong)] text-[10px] text-[var(--fg-muted)]"
        >
          Add photo
        </span>
      )}
      <Select
        id={id}
        value={current}
        disabled={disabled}
        onChange={(e) => {
          const next = e.target.value;
          if (!next) onChange(null);
          else if (asId) onChange(next);
          else {
            const focal =
              value && typeof value === 'object' && !Array.isArray(value)
                ? (value as Record<string, JsonValue>).focal
                : undefined;
            onChange(focal ? { mediaId: next, focal } : { mediaId: next });
          }
        }}
      >
        <option value="">{media.length ? 'None' : 'No media yet (Media tab)'}</option>
        {media
          .filter((m) => m.status !== 'failed')
          .map((m) => (
            <option key={m.id} value={m.id}>
              {m.name ?? m.alt ?? `${m.kind} ${m.id.slice(0, 6)}`}
              {m.status === 'uploaded' ? ' (processing)' : ''}
            </option>
          ))}
      </Select>
    </div>
  );
}

function PersonInput({
  id,
  value,
  disabled,
  onChange,
  onFocusChange,
}: {
  id: string;
  value: JsonValue | undefined;
  disabled: boolean;
  onChange: (value: JsonValue) => void;
  onFocusChange?: (focused: boolean) => void;
}) {
  const person =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, JsonValue>)
      : {};
  const text = (k: string) => (typeof person[k] === 'string' ? (person[k] as string) : '');
  const set = (k: string, v: string) => onChange({ ...person, [k]: v });
  return (
    <div className="grid gap-1.5">
      <Input
        id={id}
        placeholder="Name"
        value={text('name')}
        maxLength={120}
        disabled={disabled}
        onChange={(e) => set('name', e.target.value)}
        onFocus={() => onFocusChange?.(true)}
        onBlur={() => onFocusChange?.(false)}
      />
      <Input
        aria-label="Title"
        placeholder="Title"
        value={text('title')}
        maxLength={120}
        disabled={disabled}
        onChange={(e) => set('title', e.target.value)}
      />
      <Input
        aria-label="Company"
        placeholder="Company"
        value={text('company')}
        maxLength={120}
        disabled={disabled}
        onChange={(e) => set('company', e.target.value)}
      />
    </div>
  );
}

function ListEditor({
  id,
  field,
  value,
  disabled,
  onChange,
  idPrefix,
  media,
  onFocusChange,
}: {
  id: string;
  field: FieldDescriptor;
  value: JsonValue[];
  disabled: boolean;
  onChange: (value: JsonValue) => void;
  idPrefix: string;
  media: readonly StudioMediaItem[];
  onFocusChange?: (focused: boolean) => void;
}) {
  const itemFields = field.itemFields ?? [];
  const max = field.maxItems ?? 60;
  const replace = (index: number, item: JsonValue) =>
    onChange(value.map((v, i) => (i === index ? item : v)));
  const move = (index: number, step: -1 | 1) => {
    const to = index + step;
    if (to < 0 || to >= value.length) return;
    const next = [...value];
    [next[index], next[to]] = [next[to]!, next[index]!];
    onChange(next);
  };
  const newItem = (): JsonValue =>
    Object.fromEntries(itemFields.map((f) => [f.key, emptyFor(f)])) as JsonValue;
  return (
    <div id={id} className="space-y-2" role="group" aria-label={field.label}>
      {value.length === 0 ? (
        <p className="text-xs text-[var(--fg-muted)]">Nothing here yet.</p>
      ) : null}
      <ol className="space-y-2">
        {value.map((item, index) => {
          const record =
            item && typeof item === 'object' && !Array.isArray(item)
              ? (item as Record<string, JsonValue>)
              : {};
          return (
            <li
              key={index}
              className="rounded-md border border-[var(--border)] bg-[var(--bg)] p-2"
              aria-label={`${field.label} ${index + 1}`}
            >
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[11px] font-medium text-[var(--fg-muted)]">
                  {index + 1} of {value.length}
                </span>
                <span className="flex items-center">
                  <IconButton
                    label="Move up"
                    disabled={disabled || index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ChevronUp />
                  </IconButton>
                  <IconButton
                    label="Move down"
                    disabled={disabled || index === value.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ChevronDown />
                  </IconButton>
                  <IconButton
                    label={`Remove item ${index + 1}`}
                    disabled={disabled}
                    onClick={() => onChange(value.filter((_, i) => i !== index))}
                  >
                    <Trash2 />
                  </IconButton>
                </span>
              </div>
              <div className="space-y-2">
                {itemFields.map((f) => (
                  <FieldInput
                    key={f.key}
                    field={f}
                    value={record[f.key]}
                    denied={disabled ? 'Outside your scope' : null}
                    idPrefix={`${idPrefix}-${field.key}-${index}`}
                    media={media}
                    onFocusChange={onFocusChange}
                    onChange={(v) => replace(index, { ...record, [f.key]: v })}
                  />
                ))}
              </div>
            </li>
          );
        })}
      </ol>
      <button
        type="button"
        disabled={disabled || value.length >= max}
        onClick={() => onChange([...value, newItem()])}
        className="flex min-h-9 w-full items-center justify-center gap-1 rounded-md border border-dashed border-[var(--border-strong)] text-xs font-medium text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] disabled:opacity-40"
      >
        <Plus aria-hidden="true" className="size-3.5" />
        Add {field.label.toLowerCase().replace(/s$/, '')}
      </button>
    </div>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex size-7 items-center justify-center rounded text-[var(--fg-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg)] disabled:opacity-30 [&_svg]:size-3.5',
      )}
    >
      {children}
    </button>
  );
}
