'use client';

import * as React from 'react';
import {
  BACKGROUND_ENGINES,
  BACKGROUND_PATTERNS,
  COUNTDOWN_STYLES,
  CURSORS,
  ENTRANCES,
  ENVELOPE_LINERS,
  HEADLINE_EFFECTS,
  HEX_COLOR_RE,
  INTRO_KINDS,
  MOTION_MASTERS,
  OVERLAY_KINDS,
  PARTICLE_KINDS,
  RSVP_MOMENTS,
  type EventTheme,
} from '@/lib/events/schema';
import { Input, Switch } from '@/components/ui/form';
import { Choice, Denied, Range } from './inspector';
import { useStudio } from './studio-context';

type Theme = EventTheme;

function defaultEnvelope(theme: Theme): NonNullable<Theme['intro']['envelope']> {
  return {
    color: '#F3EBDD',
    liner: 'stripes',
    linerColor: theme.palette.accent,
    postmark: '',
    sealColor: '#7A1F1F',
    greeting: 'Dear {{first_name|friend}},',
  };
}

/**
 * Effects: the background engine, the overlay layer, the finish, the
 * arrival intro (with the personal envelope), the motion master and the
 * smaller moments (RSVP moment, cursor, countdown style, people photos).
 * Every animation is scaled by the motion master and honours reduced motion
 * on the guest page; Studio's top bar previews Full / Reduced / Off.
 */
export function EffectsPanel() {
  const studio = useStudio();
  const theme = studio.doc.theme;
  const bgDenied = studio.themeDenied('background');
  const overlayDenied = studio.themeDenied('overlay');
  const finishDenied = studio.themeDenied('finish');
  const introDenied = studio.themeDenied('intro');
  const motionDenied = studio.themeDenied('motion');
  const photosDenied = studio.themeDenied('peoplePhotos');

  const setBg = (patch: Partial<Theme['background']>) =>
    studio.updateTheme({ background: { ...theme.background, ...patch } }, 'Change background');
  const setOverlay = (patch: Partial<Theme['overlay']>) =>
    studio.updateTheme({ overlay: { ...theme.overlay, ...patch } }, 'Change overlay');
  const setFinish = (patch: Partial<Theme['finish']>) =>
    studio.updateTheme({ finish: { ...theme.finish, ...patch } }, 'Change finish');
  const setIntro = (patch: Partial<Theme['intro']>) =>
    studio.updateTheme({ intro: { ...theme.intro, ...patch } }, 'Change intro');
  const setMotion = (patch: Partial<Theme['motion']>) =>
    studio.updateTheme({ motion: { ...theme.motion, ...patch } }, 'Change motion');

  const envelope = theme.intro.envelope ?? defaultEnvelope(theme);
  const setEnvelope = (patch: Partial<typeof envelope>) =>
    setIntro({ envelope: { ...envelope, ...patch } });

  return (
    <div className="space-y-5 p-3">
      <h2 className="text-sm font-semibold">Effects</h2>

      <section aria-label="Background" className="space-y-2">
        <h3 className="flex items-center gap-1 text-xs font-semibold">
          Background {bgDenied ? <Denied text={bgDenied} /> : null}
        </h3>
        <Choice
          label="Engine"
          value={theme.background.engine}
          options={BACKGROUND_ENGINES}
          disabled={Boolean(bgDenied)}
          onChange={(v) => setBg({ engine: v as Theme['background']['engine'] })}
        />
        {theme.background.engine === 'pattern' ? (
          <Choice
            label="Pattern"
            value={theme.background.pattern ?? 'dots'}
            options={BACKGROUND_PATTERNS}
            disabled={Boolean(bgDenied)}
            onChange={(v) => setBg({ pattern: v as Theme['background']['pattern'] })}
          />
        ) : null}
        {theme.background.engine === 'particles' ? (
          <Choice
            label="Particles"
            value={theme.background.particles ?? 'dust'}
            options={PARTICLE_KINDS}
            disabled={Boolean(bgDenied)}
            onChange={(v) => setBg({ particles: v as Theme['background']['particles'] })}
          />
        ) : null}
        <Range
          label="Intensity"
          min={0}
          max={1}
          step={0.05}
          value={theme.background.intensity}
          disabled={Boolean(bgDenied)}
          onChange={(v) => setBg({ intensity: v })}
        />
        <Range
          label="Speed"
          min={0}
          max={2}
          step={0.05}
          value={theme.background.speed}
          disabled={Boolean(bgDenied)}
          onChange={(v) => setBg({ speed: v })}
        />
        <Range
          label="Scale"
          min={0.25}
          max={4}
          step={0.05}
          value={theme.background.scale}
          disabled={Boolean(bgDenied)}
          onChange={(v) => setBg({ scale: v })}
        />
        <Choice
          label="Where"
          value={theme.background.scope}
          options={['hero', 'page']}
          disabled={Boolean(bgDenied)}
          onChange={(v) => setBg({ scope: v as Theme['background']['scope'] })}
        />
        <label className="flex items-center justify-between gap-2 text-xs font-medium">
          Follows the cursor
          <Switch
            checked={theme.background.cursorReactive}
            disabled={Boolean(bgDenied)}
            onCheckedChange={(checked) => setBg({ cursorReactive: checked })}
          />
        </label>
      </section>

      <section aria-label="Overlay" className="space-y-2">
        <h3 className="flex items-center gap-1 text-xs font-semibold">
          Overlay {overlayDenied ? <Denied text={overlayDenied} /> : null}
        </h3>
        <Choice
          label="Kind"
          value={theme.overlay.kind}
          options={OVERLAY_KINDS}
          disabled={Boolean(overlayDenied)}
          onChange={(v) => setOverlay({ kind: v as Theme['overlay']['kind'] })}
        />
        <Range
          label="Density"
          min={0}
          max={1}
          step={0.05}
          value={theme.overlay.density}
          disabled={Boolean(overlayDenied)}
          onChange={(v) => setOverlay({ density: v })}
        />
        <Range
          label="Speed"
          min={0}
          max={2}
          step={0.05}
          value={theme.overlay.speed}
          disabled={Boolean(overlayDenied)}
          onChange={(v) => setOverlay({ speed: v })}
        />
        <Choice
          label="Where"
          value={theme.overlay.area}
          options={['hero', 'page']}
          disabled={Boolean(overlayDenied)}
          onChange={(v) => setOverlay({ area: v as Theme['overlay']['area'] })}
        />
        <Choice
          label="Mode"
          value={theme.overlay.mode}
          options={['ambient', 'burst']}
          disabled={Boolean(overlayDenied)}
          onChange={(v) => setOverlay({ mode: v as Theme['overlay']['mode'] })}
        />
      </section>

      <section aria-label="Finish" className="space-y-2">
        <h3 className="flex items-center gap-1 text-xs font-semibold">
          Finish {finishDenied ? <Denied text={finishDenied} /> : null}
        </h3>
        {(['grain', 'paper', 'halftone', 'scanlines', 'vignette'] as const).map((k) => (
          <Range
            key={k}
            label={k.charAt(0).toUpperCase() + k.slice(1)}
            min={0}
            max={1}
            step={0.05}
            value={theme.finish[k]}
            disabled={Boolean(finishDenied)}
            onChange={(v) => setFinish({ [k]: v })}
          />
        ))}
        <label className="flex items-center justify-between gap-2 text-xs font-medium">
          Foil shimmer on headings
          <Switch
            checked={theme.finish.foil}
            disabled={Boolean(finishDenied)}
            onCheckedChange={(checked) => setFinish({ foil: checked })}
          />
        </label>
        <label className="flex items-center justify-between gap-2 text-xs font-medium">
          Pressed (emboss) shadow
          <Switch
            checked={theme.finish.emboss}
            disabled={Boolean(finishDenied)}
            onCheckedChange={(checked) => setFinish({ emboss: checked })}
          />
        </label>
      </section>

      <section aria-label="Intro" className="space-y-2">
        <h3 className="flex items-center gap-1 text-xs font-semibold">
          Arrival intro {introDenied ? <Denied text={introDenied} /> : null}
        </h3>
        <Choice
          label="Intro"
          value={theme.intro.kind}
          options={INTRO_KINDS}
          disabled={Boolean(introDenied)}
          onChange={(v) =>
            setIntro({
              kind: v as Theme['intro']['kind'],
              ...(v === 'envelope' && !theme.intro.envelope
                ? { envelope: defaultEnvelope(theme) }
                : {}),
            })
          }
        />
        {theme.intro.kind === 'envelope' ? (
          <div className="space-y-2 rounded-md border border-[var(--border)] p-2">
            <ColorRow
              label="Envelope"
              value={envelope.color}
              disabled={Boolean(introDenied)}
              onChange={(c) => setEnvelope({ color: c })}
            />
            <Choice
              label="Liner"
              value={envelope.liner}
              options={ENVELOPE_LINERS}
              disabled={Boolean(introDenied)}
              onChange={(v) => setEnvelope({ liner: v as typeof envelope.liner })}
            />
            <ColorRow
              label="Liner colour"
              value={envelope.linerColor}
              disabled={Boolean(introDenied)}
              onChange={(c) => setEnvelope({ linerColor: c })}
            />
            <ColorRow
              label="Wax seal"
              value={envelope.sealColor}
              disabled={Boolean(introDenied)}
              onChange={(c) => setEnvelope({ sealColor: c })}
            />
            <TextRow
              label="Postmark"
              value={envelope.postmark}
              max={40}
              disabled={Boolean(introDenied)}
              onChange={(t) => setEnvelope({ postmark: t })}
            />
            <TextRow
              label="Greeting"
              value={envelope.greeting}
              max={80}
              disabled={Boolean(introDenied)}
              onChange={(t) => setEnvelope({ greeting: t })}
            />
            <p className="text-[11px] text-[var(--fg-muted)]">
              {'{{first_name|friend}}'} becomes each invited guest&apos;s first name.
            </p>
          </div>
        ) : null}
        <label className="flex items-center justify-between gap-2 text-xs font-medium">
          Show once per visitor
          <Switch
            checked={theme.intro.oncePerVisitor}
            disabled={Boolean(introDenied)}
            onCheckedChange={(checked) => setIntro({ oncePerVisitor: checked })}
          />
        </label>
      </section>

      <section aria-label="Motion" className="space-y-2">
        <h3 className="flex items-center gap-1 text-xs font-semibold">
          Motion {motionDenied ? <Denied text={motionDenied} /> : null}
        </h3>
        <Choice
          label="Motion master"
          value={theme.motion.master}
          options={MOTION_MASTERS}
          disabled={Boolean(motionDenied)}
          onChange={(v) => setMotion({ master: v as Theme['motion']['master'] })}
        />
        <Choice
          label="Headline effect"
          value={theme.motion.headlineEffect}
          options={HEADLINE_EFFECTS}
          disabled={Boolean(motionDenied)}
          onChange={(v) => setMotion({ headlineEffect: v as Theme['motion']['headlineEffect'] })}
        />
        <Range
          label="Headline speed"
          min={0.5}
          max={2}
          step={0.1}
          value={theme.motion.headlineSpeed}
          disabled={Boolean(motionDenied)}
          onChange={(v) => setMotion({ headlineSpeed: v })}
        />
        <Choice
          label="Section entrance"
          value={theme.motion.entrance}
          options={ENTRANCES}
          disabled={Boolean(motionDenied)}
          onChange={(v) => setMotion({ entrance: v as Theme['motion']['entrance'] })}
        />
        <Range
          label="Stagger (ms)"
          min={0}
          max={300}
          step={10}
          value={theme.motion.staggerMs}
          disabled={Boolean(motionDenied)}
          onChange={(v) => setMotion({ staggerMs: Math.round(v) })}
        />
        <Range
          label="Parallax"
          min={0}
          max={1}
          step={0.05}
          value={theme.motion.parallax}
          disabled={Boolean(motionDenied)}
          onChange={(v) => setMotion({ parallax: v })}
        />
        <label className="flex items-center justify-between gap-2 text-xs font-medium">
          Scroll-zoom hero
          <Switch
            checked={theme.motion.scrollZoomHero}
            disabled={Boolean(motionDenied)}
            onCheckedChange={(checked) => setMotion({ scrollZoomHero: checked })}
          />
        </label>
        <label className="flex items-center justify-between gap-2 text-xs font-medium">
          Sticky headings
          <Switch
            checked={theme.motion.stickyHeadings}
            disabled={Boolean(motionDenied)}
            onCheckedChange={(checked) => setMotion({ stickyHeadings: checked })}
          />
        </label>
        <Choice
          label="RSVP moment"
          value={theme.motion.rsvpMoment}
          options={RSVP_MOMENTS}
          disabled={Boolean(motionDenied)}
          onChange={(v) => setMotion({ rsvpMoment: v as Theme['motion']['rsvpMoment'] })}
        />
        <Choice
          label="Cursor (desktop)"
          value={theme.motion.cursor}
          options={CURSORS}
          disabled={Boolean(motionDenied)}
          onChange={(v) => setMotion({ cursor: v as Theme['motion']['cursor'] })}
        />
        <Choice
          label="Countdown style"
          value={theme.motion.countdownStyle}
          options={COUNTDOWN_STYLES}
          disabled={Boolean(motionDenied)}
          onChange={(v) => setMotion({ countdownStyle: v as Theme['motion']['countdownStyle'] })}
        />
        <Choice
          label="Pause button"
          value={theme.motion.pausePosition}
          options={['bottom-left', 'bottom-right']}
          disabled={Boolean(motionDenied)}
          onChange={(v) => setMotion({ pausePosition: v as Theme['motion']['pausePosition'] })}
        />
      </section>

      <section aria-label="People photos" className="space-y-2">
        <h3 className="flex items-center gap-1 text-xs font-semibold">
          People photos {photosDenied ? <Denied text={photosDenied} /> : null}
        </h3>
        <Choice
          label="Treatment"
          value={theme.peoplePhotos.treatment}
          options={['none', 'grayscale', 'duotone', 'dither', 'halftone']}
          disabled={Boolean(photosDenied)}
          onChange={(v) =>
            studio.updateTheme(
              { peoplePhotos: { ...theme.peoplePhotos, treatment: v } },
              'Change photo treatment',
            )
          }
        />
        <Choice
          label="Mask"
          value={theme.peoplePhotos.mask}
          options={['none', 'circle', 'arch', 'squircle', 'rounded']}
          disabled={Boolean(photosDenied)}
          onChange={(v) =>
            studio.updateTheme(
              { peoplePhotos: { ...theme.peoplePhotos, mask: v } },
              'Change photo mask',
            )
          }
        />
      </section>
    </div>
  );
}

function ColorRow({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (hex: string) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 text-xs">
      {label}
      <input
        type="color"
        value={value.toLowerCase()}
        disabled={disabled}
        onChange={(e) => {
          const hex = e.target.value.toUpperCase();
          if (HEX_COLOR_RE.test(hex)) onChange(hex);
        }}
        className="h-7 w-9 cursor-pointer rounded border border-[var(--border)] bg-transparent p-0.5"
      />
    </label>
  );
}

function TextRow({
  label,
  value,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  max: number;
  disabled: boolean;
  onChange: (text: string) => void;
}) {
  const id = React.useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-xs font-medium">
        {label}
      </label>
      <Input
        id={id}
        value={value}
        maxLength={max}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
