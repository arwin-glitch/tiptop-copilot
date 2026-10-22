'use client';

import * as React from 'react';
import { Lock } from 'lucide-react';
import { blockRegistry } from '@/lib/events/blocks';
import { studioFetch } from '@/lib/events/editor/api';
import { fieldsFor } from '@/lib/events/editor/fields';
import { PresenceTracker, softLockFor, presenceName } from '@/lib/events/editor/presence';
import { fieldName } from '@/lib/events/editor/publish';
import {
  BACKGROUND_ENGINES,
  BLOCK_VARIANTS,
  CONTENT_WIDTHS,
  DIVIDER_STYLES,
  ENTRANCES,
  HEADLINE_EFFECTS,
  INTRO_KINDS,
  MOTION_MASTERS,
  OVERLAY_KINDS,
  SECTION_BACKGROUNDS,
  TAG_RE,
  VISIBILITY_MODES,
  type EventSection,
  type JsonValue,
  type SectionMotion,
  type SectionStyle,
  type SectionVisibility,
} from '@/lib/events/schema';
import { cn } from '@/lib/util/cn';
import { Input, Select, Switch, Textarea } from '@/components/ui/form';
import { FieldInput } from './field-input';
import { useStudio } from './studio-context';

type SectionTab = 'content' | 'style' | 'motion' | 'visibility' | 'activity';

function words(value: string): string {
  const w = value.replace(/_/g, ' ');
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/**
 * The right-hand inspector: page settings when nothing is selected, else the
 * selected section in tabs (Content from the block's field descriptors,
 * Style, Motion, Visibility, and owners' Activity). Locked fields show why.
 */
export function Inspector() {
  const studio = useStudio();
  const section = studio.selectedId
    ? studio.doc.sections.find((s) => s.id === studio.selectedId)
    : undefined;
  return (
    <div className="min-h-0 flex-1 scrollbar-thin overflow-y-auto">
      {section ? <SectionInspector key={section.id} section={section} /> : <PageSettings />}
    </div>
  );
}

function SectionInspector({ section }: { section: EventSection }) {
  const studio = useStudio();
  const [tab, setTab] = React.useState<SectionTab>('content');
  const [tracker] = React.useState(() => new PresenceTracker());
  const [now, setNow] = React.useState(0);
  const presence = studio.sessionState.presence;

  React.useEffect(() => {
    const onTab = (event: Event) => {
      const next = (event as CustomEvent<SectionTab>).detail;
      if (next) setTab(next);
    };
    window.addEventListener('studio:inspector', onTab);
    return () => window.removeEventListener('studio:inspector', onTab);
  }, []);
  React.useEffect(() => {
    tracker.observe(presence);
    const id = window.setTimeout(() => setNow(Date.now()), 0);
    return () => window.clearTimeout(id);
  }, [presence, tracker]);
  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, []);

  const lock = softLockFor(
    section.id,
    presence,
    { actorKey: studio.boot.actor.key, owner: studio.boot.actor.owner },
    tracker,
    studio.overridden,
    now,
  );
  const lockText = lock ? `${presenceName(lock.by)} is editing` : null;
  const tabs: { id: SectionTab; label: string }[] = [
    { id: 'content', label: 'Content' },
    { id: 'style', label: 'Style' },
    { id: 'motion', label: 'Motion' },
    { id: 'visibility', label: 'Visibility' },
    ...(studio.boot.endpoints.activity ? [{ id: 'activity' as const, label: 'Activity' }] : []),
  ];
  const label = studio.labelOf(section);
  const typing = (focused: boolean) => studio.session.setTyping(focused);

  return (
    <div className="p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="min-w-0 truncate text-sm font-semibold">{label}</h2>
        <button
          type="button"
          className="text-xs text-[var(--fg-muted)] underline-offset-2 hover:underline"
          onClick={() => studio.select(null)}
        >
          Page settings
        </button>
      </div>
      {lock ? (
        <div
          role="status"
          className="mb-3 flex flex-wrap items-center gap-2 rounded-md px-2 py-1.5 text-xs text-white"
          style={{ backgroundColor: lock.by.color }}
        >
          <span className="flex-1">{lockText}</span>
          <button
            type="button"
            className="rounded bg-white/20 px-1.5 py-0.5 font-medium hover:bg-white/30 disabled:opacity-60"
            disabled={!lock.canOverride}
            onClick={() => studio.override(section.id)}
          >
            {lock.canOverride ? 'Edit anyway' : `Edit anyway in ${lock.overrideInSeconds}s`}
          </button>
        </div>
      ) : null}
      <div role="tablist" aria-label={`${label} settings`} className="mb-3 flex flex-wrap gap-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs font-medium',
              tab === t.id
                ? 'bg-[var(--primary)] text-[var(--primary-fg)]'
                : 'text-[var(--fg-muted)] hover:bg-[var(--bg-hover)]',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={tabs.find((t) => t.id === tab)?.label}>
        {tab === 'content' ? (
          <ContentTab section={section} lockText={lockText} onTyping={typing} />
        ) : null}
        {tab === 'style' ? <StyleTab section={section} lockText={lockText} /> : null}
        {tab === 'motion' ? <MotionTab section={section} lockText={lockText} /> : null}
        {tab === 'visibility' ? <VisibilityTab section={section} lockText={lockText} /> : null}
        {tab === 'activity' ? <ActivityTab section={section} /> : null}
      </div>
    </div>
  );
}

function ContentTab({
  section,
  lockText,
  onTyping,
}: {
  section: EventSection;
  lockText: string | null;
  onTyping: (focused: boolean) => void;
}) {
  const studio = useStudio();
  const definition = blockRegistry.get(section.type);
  const { fields } = fieldsFor(definition, section);
  const nameDenied = lockText ?? studio.sectionDenied(section.id, 'name');
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <label htmlFor={`sec-${section.id}-name`} className="text-xs font-medium">
          Name in the outline
        </label>
        <Input
          id={`sec-${section.id}-name`}
          value={section.name}
          maxLength={60}
          placeholder={definition?.label ?? words(section.type)}
          disabled={Boolean(nameDenied)}
          onChange={(e) =>
            studio.updateSection(
              section.id,
              { name: e.target.value },
              `Rename ${studio.labelOf(section)}`,
            )
          }
          onFocus={() => onTyping(true)}
          onBlur={() => onTyping(false)}
        />
      </div>
      {fields.length === 0 ? (
        <p className="text-xs text-[var(--fg-muted)]">
          This block takes its content from the event&apos;s settings (date, venue, sessions).
        </p>
      ) : null}
      {fields.map((field) => {
        const key = `props.${field.key}` as const;
        const denied =
          lockText ??
          (field.ownerOnly && !studio.boot.capabilities.editOwnerOnlyProps
            ? 'Only TipTop can change this'
            : studio.sectionDenied(section.id, key, section.type));
        return (
          <FieldInput
            key={field.key}
            field={field}
            value={section.props[field.key]}
            denied={denied}
            idPrefix={`sec-${section.id}`}
            media={studio.mediaItems}
            onFocusChange={onTyping}
            onChange={(value: JsonValue) =>
              studio.updateSection(section.id, { [key]: value }, `Edit ${field.label}`)
            }
          />
        );
      })}
    </div>
  );
}

function StyleTab({ section, lockText }: { section: EventSection; lockText: string | null }) {
  const studio = useStudio();
  const variantDenied = lockText ?? studio.sectionDenied(section.id, 'variant');
  const styleDenied = lockText ?? studio.sectionDenied(section.id, 'style');
  const style = section.style;
  const set = (patch: Partial<SectionStyle>) =>
    studio.updateSection(section.id, { style: { ...style, ...patch } }, 'Change section style');
  const variants = BLOCK_VARIANTS[section.type] as readonly string[];
  return (
    <div className="space-y-3">
      <fieldset className="space-y-1">
        <legend className="mb-1 flex items-center gap-1 text-xs font-medium">
          Layout {variantDenied ? <Denied text={variantDenied} /> : null}
        </legend>
        <div className="grid grid-cols-2 gap-1.5">
          {variants.map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={section.variant === v}
              disabled={Boolean(variantDenied)}
              onClick={() => studio.updateSection(section.id, { variant: v }, 'Change layout')}
              className={cn(
                'rounded-md border px-2 py-2 text-xs disabled:opacity-50',
                section.variant === v
                  ? 'border-[var(--primary)] bg-[var(--accent-soft)] font-semibold'
                  : 'border-[var(--border)] hover:border-[var(--border-strong)]',
              )}
            >
              {words(v)}
            </button>
          ))}
        </div>
      </fieldset>
      {styleDenied ? <Denied text={styleDenied} /> : null}
      <Choice
        label="Background"
        value={style.background}
        options={SECTION_BACKGROUNDS}
        disabled={Boolean(styleDenied)}
        onChange={(v) => set({ background: v as SectionStyle['background'] })}
      />
      {style.background === 'image' || style.background === 'video' ? (
        <FieldInput
          field={{ key: 'backgroundMedia', label: 'Background media', kind: 'media' }}
          value={style.backgroundMedia as unknown as JsonValue}
          denied={styleDenied}
          idPrefix={`style-${section.id}`}
          media={studio.mediaItems}
          onChange={(v) => set({ backgroundMedia: (v as SectionStyle['backgroundMedia']) ?? null })}
        />
      ) : null}
      <Choice
        label="Padding"
        value={style.padding}
        options={['none', 's', 'm', 'l', 'xl']}
        disabled={Boolean(styleDenied)}
        onChange={(v) => set({ padding: v as SectionStyle['padding'] })}
      />
      <Choice
        label="Alignment"
        value={style.align}
        options={['inherit', 'left', 'center']}
        disabled={Boolean(styleDenied)}
        onChange={(v) => set({ align: v as SectionStyle['align'] })}
      />
      <Choice
        label="Width"
        value={style.width}
        options={['inherit', ...CONTENT_WIDTHS]}
        disabled={Boolean(styleDenied)}
        onChange={(v) => set({ width: v as SectionStyle['width'] })}
      />
      <Choice
        label="Divider"
        value={style.divider}
        options={['inherit', ...DIVIDER_STYLES]}
        disabled={Boolean(styleDenied)}
        onChange={(v) => set({ divider: v as SectionStyle['divider'] })}
      />
    </div>
  );
}

function MotionTab({ section, lockText }: { section: EventSection; lockText: string | null }) {
  const studio = useStudio();
  const denied = lockText ?? studio.sectionDenied(section.id, 'motion');
  const motion = section.motion;
  const set = (patch: Partial<SectionMotion>) =>
    studio.updateSection(section.id, { motion: { ...motion, ...patch } }, 'Change section motion');
  return (
    <div className="space-y-3">
      {denied ? <Denied text={denied} /> : null}
      <label className="flex items-center justify-between gap-2 text-xs font-medium">
        Override the page&apos;s motion
        <Switch
          checked={motion.override}
          disabled={Boolean(denied)}
          onCheckedChange={(checked) => set({ override: checked })}
        />
      </label>
      <Choice
        label="Entrance"
        value={motion.entrance}
        options={ENTRANCES}
        disabled={Boolean(denied) || !motion.override}
        onChange={(v) => set({ entrance: v as SectionMotion['entrance'] })}
      />
      <Range
        label="Stagger (ms)"
        min={0}
        max={300}
        step={10}
        value={motion.staggerMs}
        disabled={Boolean(denied) || !motion.override}
        onChange={(v) => set({ staggerMs: Math.round(v) })}
      />
      <Range
        label="Parallax"
        min={0}
        max={1}
        step={0.05}
        value={motion.parallax}
        disabled={Boolean(denied) || !motion.override}
        onChange={(v) => set({ parallax: v })}
      />
      <Choice
        label="Headline effect"
        value={motion.headlineEffect}
        options={HEADLINE_EFFECTS}
        disabled={Boolean(denied) || !motion.override}
        onChange={(v) => set({ headlineEffect: v as SectionMotion['headlineEffect'] })}
      />
    </div>
  );
}

function VisibilityTab({ section, lockText }: { section: EventSection; lockText: string | null }) {
  const studio = useStudio();
  const denied = lockText ?? studio.sectionDenied(section.id, 'visibility');
  const visibility = section.visibility;
  const [tagsDraft, setTagsDraft] = React.useState(visibility.tags.join(', '));
  const set = (next: SectionVisibility) =>
    studio.updateSection(section.id, { visibility: next }, 'Change who sees this');
  const describe: Record<string, string> = {
    everyone: 'Everyone who can open the page',
    registered: 'Guests who registered (any reply but "can\'t go")',
    going: 'Guests who are going',
    tags: 'Going guests with one of these tags',
    hidden: 'Nobody (kept in the draft)',
  };
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 flex items-center gap-1 text-xs font-medium">
        Who sees this section {denied ? <Denied text={denied} /> : null}
      </legend>
      {VISIBILITY_MODES.map((mode) => (
        <label key={mode} className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name={`vis-${section.id}`}
            value={mode}
            checked={visibility.mode === mode}
            disabled={Boolean(denied)}
            onChange={() => set({ mode, tags: visibility.tags })}
            className="mt-1"
          />
          <span>
            <span className="font-medium">{words(mode)}</span>
            <span className="block text-xs text-[var(--fg-muted)]">{describe[mode]}</span>
          </span>
        </label>
      ))}
      {visibility.mode === 'tags' ? (
        <div className="space-y-1">
          <label htmlFor={`tags-${section.id}`} className="text-xs font-medium">
            Tags (comma separated)
          </label>
          <Input
            id={`tags-${section.id}`}
            value={tagsDraft}
            disabled={Boolean(denied)}
            placeholder="LP, Founder"
            onChange={(e) => setTagsDraft(e.target.value)}
            onBlur={() => {
              const tags = [
                ...new Set(
                  tagsDraft
                    .split(',')
                    .map((t) => t.trim())
                    .filter((t) => TAG_RE.test(t)),
                ),
              ].slice(0, 20);
              set({ mode: 'tags', tags });
              setTagsDraft(tags.join(', '));
            }}
          />
        </div>
      ) : null}
      <p className="text-[11px] text-[var(--fg-muted)]">
        Enforced on the server: a section a guest does not qualify for is never sent to them. Check
        it with “Preview as”.
      </p>
    </fieldset>
  );
}

interface ActivityRow {
  draftVersion: number;
  op: string;
  keys: string[];
  authorName: string;
  outside: boolean;
  at: string;
}

function ActivityTab({ section }: { section: EventSection }) {
  const studio = useStudio();
  const [rows, setRows] = React.useState<ActivityRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const endpoint = studio.boot.endpoints.activity;
  React.useEffect(() => {
    if (!endpoint) return;
    let live = true;
    void studioFetch<{ entries: ActivityRow[] }>(
      `${endpoint}?section=${encodeURIComponent(section.id)}`,
    ).then((response) => {
      if (!live) return;
      if (response.ok) setRows(response.value.entries);
      else setError(response.error.message);
    });
    return () => {
      live = false;
    };
  }, [endpoint, section.id, section.rev]);
  if (error) return <p className="text-xs text-[var(--fg-muted)]">{error}</p>;
  if (!rows) return <p className="text-xs text-[var(--fg-muted)]">Loading…</p>;
  if (!rows.length)
    return <p className="text-xs text-[var(--fg-muted)]">No changes recorded yet.</p>;
  return (
    <ol aria-label="Changes to this section" className="space-y-2">
      {rows.map((row, i) => (
        <li key={i} className="text-xs">
          <span className="font-medium">
            {row.authorName}
            {row.outside ? ' (outside)' : ''}
          </span>{' '}
          {row.op === 'update'
            ? `changed ${row.keys.map(fieldName).join(', ')}`
            : row.op === 'insert'
              ? 'added this section'
              : row.op === 'move'
                ? 'moved it'
                : row.op}
          <span className="block text-[var(--fg-muted)]">
            {new Date(row.at).toLocaleString(undefined, {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}
          </span>
        </li>
      ))}
    </ol>
  );
}

/* ------------------------------------------------------------ page settings */

function PageSettings() {
  const studio = useStudio();
  const { doc } = studio;
  const theme = doc.theme;
  const meta = doc.meta;
  const metaDenied = studio.metaDenied();
  return (
    <div className="space-y-4 p-3">
      <div>
        <h2 className="text-sm font-semibold">Page settings</h2>
        <p className="text-xs text-[var(--fg-muted)]">
          Select a section on the page to edit it. The left rail holds the full theme, brand,
          effects and media.
        </p>
      </div>
      <section aria-label="Look" className="space-y-3">
        <Choice
          label="Background"
          value={theme.background.engine}
          options={BACKGROUND_ENGINES}
          disabled={Boolean(studio.themeDenied('background'))}
          denied={studio.themeDenied('background')}
          onChange={(v) =>
            studio.updateTheme(
              { background: { ...theme.background, engine: v } },
              'Change background',
            )
          }
        />
        <Choice
          label="Overlay"
          value={theme.overlay.kind}
          options={OVERLAY_KINDS}
          disabled={Boolean(studio.themeDenied('overlay'))}
          denied={studio.themeDenied('overlay')}
          onChange={(v) =>
            studio.updateTheme({ overlay: { ...theme.overlay, kind: v } }, 'Change overlay')
          }
        />
        <Choice
          label="Intro"
          value={theme.intro.kind}
          options={INTRO_KINDS}
          disabled={Boolean(studio.themeDenied('intro'))}
          denied={studio.themeDenied('intro')}
          onChange={(v) =>
            studio.updateTheme({ intro: { ...theme.intro, kind: v } }, 'Change intro')
          }
        />
        <Choice
          label="Motion"
          value={theme.motion.master}
          options={MOTION_MASTERS}
          disabled={Boolean(studio.themeDenied('motion'))}
          denied={studio.themeDenied('motion')}
          onChange={(v) =>
            studio.updateTheme({ motion: { ...theme.motion, master: v } }, 'Change motion')
          }
        />
      </section>
      <section
        aria-label="Search and sharing"
        className="space-y-3 border-t border-[var(--border)] pt-3"
      >
        <h3 className="flex items-center gap-1 text-xs font-semibold">
          Search and sharing {metaDenied ? <Denied text={metaDenied} /> : null}
        </h3>
        <div className="space-y-1">
          <label htmlFor="seo-title" className="text-xs font-medium">
            Page title (search and share card)
          </label>
          <Input
            id="seo-title"
            value={meta.seoTitle}
            maxLength={70}
            placeholder={studio.boot.title}
            disabled={Boolean(metaDenied)}
            onChange={(e) => studio.updatePage({ seoTitle: e.target.value }, 'Edit page title')}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="seo-desc" className="text-xs font-medium">
            Description
          </label>
          <Textarea
            id="seo-desc"
            value={meta.seoDescription}
            maxLength={200}
            rows={3}
            disabled={Boolean(metaDenied)}
            onChange={(e) =>
              studio.updatePage({ seoDescription: e.target.value }, 'Edit description')
            }
          />
        </div>
        <Choice
          label="Share card layout"
          value={meta.ogLayout}
          options={['cover', 'type', 'ticket']}
          disabled={Boolean(metaDenied)}
          onChange={(v) => studio.updatePage({ ogLayout: v }, 'Change share card')}
        />
        <label className="flex items-center justify-between gap-2 text-xs font-medium">
          Favicon from the logo
          <Switch
            checked={meta.faviconFromLogo}
            disabled={Boolean(metaDenied)}
            onCheckedChange={(checked) =>
              studio.updatePage({ faviconFromLogo: checked }, 'Change favicon')
            }
          />
        </label>
      </section>
    </div>
  );
}

/* ---------------------------------------------------------------- controls */

export function Denied({ text }: { text: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-normal text-[var(--fg-muted)]">
      <Lock aria-hidden="true" className="size-3" />
      {text}
    </span>
  );
}

export function Choice({
  label,
  value,
  options,
  disabled,
  denied,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  disabled?: boolean;
  denied?: string | null;
  onChange: (value: string) => void;
}) {
  const id = React.useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="flex items-center gap-1 text-xs font-medium">
        {label} {denied ? <Denied text={denied} /> : null}
      </label>
      <Select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {words(o)}
          </option>
        ))}
      </Select>
    </div>
  );
}

export function Range({
  label,
  min,
  max,
  step,
  value,
  disabled,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const id = React.useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="flex items-center justify-between text-xs font-medium">
        <span>{label}</span>
        <span className="font-normal text-[var(--fg-muted)] tabular-nums">{value}</span>
      </label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[var(--primary)]"
      />
    </div>
  );
}
