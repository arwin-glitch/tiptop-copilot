'use client';

import * as React from 'react';
import { checkPalette, fixContrast } from '@/lib/events/editor/contrast';
import { DEFAULT_THEME_PRESET_ID, getThemePreset } from '@/lib/events/themes';
import {
  CONTENT_WIDTHS,
  DIVIDER_STYLES,
  FONT_IDS,
  HEX_COLOR_RE,
  PALETTE_TOKENS,
  type EventTheme,
  type JsonValue,
  type Palette,
} from '@/lib/events/schema';
import { cn } from '@/lib/util/cn';
import { Button } from '@/components/ui/button';
import { Input, Switch } from '@/components/ui/form';
import { FieldInput } from './field-input';
import { Choice, Denied, Range } from './inspector';
import { useStudio } from './studio-context';

const TOKEN_LABEL: Record<keyof Palette, string> = {
  bg: 'Page',
  surface: 'Cards',
  surfaceAlt: 'Alternate band',
  text: 'Text',
  muted: 'Muted text',
  accent: 'Accent',
  accentFg: 'Text on accent',
  border: 'Borders',
  highlight: 'Highlight (gold)',
};

function fontName(id: string): string {
  return id
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Brand: light/dark mode, the nine palette tokens with live AA/AAA badges and
 * a Fix that changes a colour only when clicked, typography, shape and
 * buttons, layout, the brand kit and (owners only) the locks that keep
 * outside editors off the logo, palette, fonts and intro.
 */
export function BrandPanel() {
  const studio = useStudio();
  const theme = studio.doc.theme;
  const [editDark, setEditDark] = React.useState(false);
  const paletteKey = editDark ? 'paletteDark' : 'palette';
  const palette = theme[paletteKey];
  const paletteDenied = studio.themeDenied(paletteKey);
  const fontsDenied = studio.themeDenied('typography');
  const shapeDenied = studio.themeDenied('shape');
  const layoutDenied = studio.themeDenied('layout');
  const modeDenied = studio.themeDenied('mode');
  const brandDenied = studio.themeDenied('brand');
  const results = checkPalette(palette);

  const setPalette = (token: keyof Palette, hex: string) =>
    studio.updateTheme(
      { [paletteKey]: { ...palette, [token]: hex.toUpperCase() } },
      'Change colour',
    );
  const setTypography = (patch: Partial<EventTheme['typography']>) =>
    studio.updateTheme({ typography: { ...theme.typography, ...patch } }, 'Change typography');
  const setShape = (patch: Partial<EventTheme['shape']>) =>
    studio.updateTheme({ shape: { ...theme.shape, ...patch } }, 'Change shape');
  const setLayout = (patch: Partial<EventTheme['layout']>) =>
    studio.updateTheme({ layout: { ...theme.layout, ...patch } }, 'Change layout');
  const setBrand = (patch: Partial<EventTheme['brand']>) =>
    studio.updateTheme({ brand: { ...theme.brand, ...patch } }, 'Change brand');

  function applyKit() {
    const kit = getThemePreset(DEFAULT_THEME_PRESET_ID).theme;
    studio.updateTheme(
      {
        palette: kit.palette,
        paletteDark: kit.paletteDark,
        typography: kit.typography,
        ...(brandDenied ? {} : { brand: { ...theme.brand, kitId: 'tiptop' } }),
      },
      'Apply the TipTop kit',
    );
  }

  return (
    <div className="space-y-5 p-3">
      <section aria-label="Mode" className="space-y-2">
        <h2 className="text-sm font-semibold">Brand</h2>
        <div className="flex items-center gap-1" role="group" aria-label="Light or dark">
          {(['light', 'dark', 'auto'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={theme.mode === mode}
              disabled={Boolean(modeDenied)}
              onClick={() => studio.updateTheme({ mode }, 'Change mode')}
              className={cn(
                'flex-1 rounded-md border px-2 py-1.5 text-xs capitalize disabled:opacity-50',
                theme.mode === mode
                  ? 'border-[var(--primary)] bg-[var(--accent-soft)] font-semibold'
                  : 'border-[var(--border)]',
              )}
            >
              {mode === 'auto' ? 'Auto' : mode}
            </button>
          ))}
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={Boolean(paletteDenied || fontsDenied)}
          onClick={applyKit}
        >
          Apply the TipTop kit
        </Button>
      </section>

      <section aria-label="Colours" className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold">Colours</h3>
          <label className="flex items-center gap-1.5 text-[11px] text-[var(--fg-muted)]">
            Dark palette
            <Switch
              checked={editDark}
              onCheckedChange={setEditDark}
              aria-label="Edit the dark palette"
            />
          </label>
        </div>
        {paletteDenied ? <Denied text={paletteDenied} /> : null}
        <ul className="space-y-1.5">
          {PALETTE_TOKENS.map((token) => (
            <li key={token} className="flex items-center gap-2">
              <input
                type="color"
                aria-label={`${TOKEN_LABEL[token]} colour`}
                value={palette[token].toLowerCase()}
                disabled={Boolean(paletteDenied)}
                onChange={(e) => setPalette(token, e.target.value)}
                className="h-8 w-9 shrink-0 cursor-pointer rounded border border-[var(--border)] bg-transparent p-0.5 disabled:cursor-not-allowed"
              />
              <span className="min-w-0 flex-1 truncate text-xs">{TOKEN_LABEL[token]}</span>
              <HexInput
                key={palette[token]}
                value={palette[token]}
                label={`${TOKEN_LABEL[token]} hex`}
                disabled={Boolean(paletteDenied)}
                onCommit={(hex) => setPalette(token, hex)}
              />
            </li>
          ))}
        </ul>
        <ul aria-label="Contrast checks" className="space-y-1 pt-1">
          {results.map((r) => (
            <li key={r.label} className="flex items-center gap-2 text-[11px]">
              <span
                className={cn(
                  'w-14 shrink-0 rounded px-1 py-0.5 text-center font-semibold',
                  r.ratio >= 4.5 ? 'bg-[var(--ok-soft)]' : 'bg-[var(--danger-soft)]',
                )}
              >
                {r.grade}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {r.label} · {r.ratio.toFixed(1)}:1
              </span>
              {r.ratio < 4.5 && !paletteDenied ? (
                <button
                  type="button"
                  className="rounded px-1.5 py-0.5 text-[var(--accent)] underline-offset-2 hover:underline"
                  onClick={() => setPalette(r.fg, fixContrast(palette[r.fg], palette[r.bg]))}
                >
                  Fix
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Typography" className="space-y-2">
        <h3 className="flex items-center gap-1 text-xs font-semibold">
          Typography {fontsDenied ? <Denied text={fontsDenied} /> : null}
        </h3>
        {(['display', 'body', 'mono'] as const).map((slot) => (
          <Choice
            key={slot}
            label={slot === 'display' ? 'Headlines' : slot === 'body' ? 'Body' : 'Numbers and code'}
            value={theme.typography[slot]}
            options={FONT_IDS}
            disabled={Boolean(fontsDenied)}
            onChange={(v) => setTypography({ [slot]: v } as Partial<EventTheme['typography']>)}
          />
        ))}
        <Range
          label="Scale"
          min={1.125}
          max={1.5}
          step={0.025}
          value={theme.typography.scale}
          disabled={Boolean(fontsDenied)}
          onChange={(v) => setTypography({ scale: v })}
        />
        <Range
          label="Headline weight"
          min={100}
          max={900}
          step={100}
          value={theme.typography.displayWeight}
          disabled={Boolean(fontsDenied)}
          onChange={(v) => setTypography({ displayWeight: Math.round(v) })}
        />
        <Choice
          label="Headline case"
          value={theme.typography.displayCase}
          options={['none', 'title', 'upper', 'lower']}
          disabled={Boolean(fontsDenied)}
          onChange={(v) =>
            setTypography({ displayCase: v as EventTheme['typography']['displayCase'] })
          }
        />
        <Range
          label="Body size (px)"
          min={16}
          max={22}
          step={1}
          value={theme.typography.bodySize}
          disabled={Boolean(fontsDenied)}
          onChange={(v) => setTypography({ bodySize: v })}
        />
        <p className="text-[11px] text-[var(--fg-muted)]">
          Now: {fontName(theme.typography.display)} with {fontName(theme.typography.body)}.
        </p>
      </section>

      <section aria-label="Shape and buttons" className="space-y-2">
        <h3 className="flex items-center gap-1 text-xs font-semibold">
          Shape and buttons {shapeDenied ? <Denied text={shapeDenied} /> : null}
        </h3>
        <Range
          label="Corner radius"
          min={0}
          max={32}
          step={1}
          value={theme.shape.radius}
          disabled={Boolean(shapeDenied)}
          onChange={(v) => setShape({ radius: Math.round(v) })}
        />
        <Choice
          label="Button shape"
          value={theme.shape.buttonShape}
          options={['pill', 'rounded', 'square', 'ticket', 'stamp']}
          disabled={Boolean(shapeDenied)}
          onChange={(v) => setShape({ buttonShape: v as EventTheme['shape']['buttonShape'] })}
        />
        <Choice
          label="Button fill"
          value={theme.shape.buttonFill}
          options={['solid', 'outline', 'glass', 'gradient', 'shimmer', 'rainbow']}
          disabled={Boolean(shapeDenied)}
          onChange={(v) => setShape({ buttonFill: v as EventTheme['shape']['buttonFill'] })}
        />
        <Choice
          label="Button hover"
          value={theme.shape.buttonHover}
          options={['none', 'lift', 'glow', 'magnetic']}
          disabled={Boolean(shapeDenied)}
          onChange={(v) => setShape({ buttonHover: v as EventTheme['shape']['buttonHover'] })}
        />
      </section>

      <section aria-label="Layout" className="space-y-2">
        <h3 className="flex items-center gap-1 text-xs font-semibold">
          Layout {layoutDenied ? <Denied text={layoutDenied} /> : null}
        </h3>
        <Choice
          label="Content width"
          value={theme.layout.width}
          options={CONTENT_WIDTHS}
          disabled={Boolean(layoutDenied)}
          onChange={(v) => setLayout({ width: v as EventTheme['layout']['width'] })}
        />
        <Choice
          label="Density"
          value={theme.layout.density}
          options={['compact', 'comfortable', 'airy']}
          disabled={Boolean(layoutDenied)}
          onChange={(v) => setLayout({ density: v as EventTheme['layout']['density'] })}
        />
        <Choice
          label="Alignment"
          value={theme.layout.align}
          options={['left', 'center']}
          disabled={Boolean(layoutDenied)}
          onChange={(v) => setLayout({ align: v as EventTheme['layout']['align'] })}
        />
        <Choice
          label="Dividers"
          value={theme.layout.divider}
          options={DIVIDER_STYLES}
          disabled={Boolean(layoutDenied)}
          onChange={(v) => setLayout({ divider: v as EventTheme['layout']['divider'] })}
        />
        <Choice
          label="Rule colour"
          value={theme.layout.rule}
          options={['gold', 'ink', 'accent']}
          disabled={Boolean(layoutDenied)}
          onChange={(v) => setLayout({ rule: v as EventTheme['layout']['rule'] })}
        />
      </section>

      <section
        aria-label="Brand kit and locks"
        className="space-y-2 border-t border-[var(--border)] pt-3"
      >
        <h3 className="flex items-center gap-1 text-xs font-semibold">
          Logo and locks {brandDenied ? <Denied text={brandDenied} /> : null}
        </h3>
        <FieldInput
          field={{ key: 'logo', label: 'Logo (light pages)', kind: 'media' }}
          value={theme.brand.logo as unknown as JsonValue}
          denied={brandDenied}
          idPrefix="brand"
          media={studio.mediaItems}
          onChange={(v) => setBrand({ logo: (v as EventTheme['brand']['logo']) ?? null })}
        />
        <FieldInput
          field={{ key: 'logoDark', label: 'Logo (dark pages)', kind: 'media' }}
          value={theme.brand.logoDark as unknown as JsonValue}
          denied={brandDenied}
          idPrefix="brand"
          media={studio.mediaItems}
          onChange={(v) => setBrand({ logoDark: (v as EventTheme['brand']['logoDark']) ?? null })}
        />
        <p className="text-[11px] text-[var(--fg-muted)]">
          Locks keep outside editors (with brand lock on their link) away from these:
        </p>
        {(['logo', 'palette', 'fonts', 'intro'] as const).map((lock) => (
          <label key={lock} className="flex items-center justify-between gap-2 text-xs capitalize">
            Lock {lock}
            <Switch
              checked={theme.brand.locks[lock]}
              disabled={Boolean(brandDenied)}
              onCheckedChange={(checked) =>
                setBrand({ locks: { ...theme.brand.locks, [lock]: checked } })
              }
            />
          </label>
        ))}
      </section>
    </div>
  );
}

function HexInput({
  value,
  label,
  disabled,
  onCommit,
}: {
  value: string;
  label: string;
  disabled: boolean;
  onCommit: (hex: string) => void;
}) {
  const [draft, setDraft] = React.useState(value);
  const valid = HEX_COLOR_RE.test(draft.trim());
  return (
    <Input
      aria-label={label}
      value={draft}
      maxLength={7}
      disabled={disabled}
      aria-invalid={!valid || undefined}
      className="h-8 w-24 font-mono text-xs"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const next = draft.trim().startsWith('#') ? draft.trim() : `#${draft.trim()}`;
        if (HEX_COLOR_RE.test(next) && next.toUpperCase() !== value.toUpperCase()) onCommit(next);
        else setDraft(value);
      }}
    />
  );
}
