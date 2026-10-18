import type * as React from 'react';

/**
 * Windows 11's caption glyphs, drawn as 10px inline SVG with 1px strokes:
 * the shape Segoe Fluent Icons draws, without depending on that font being
 * installed (Windows 10 has only Segoe MDL2) or on how a test machine renders
 * it. desktop/fallback/index.html and the shell's safety-net strip use the
 * same paths, the menu button's included.
 */
function Glyph({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 10 10"
      width={10}
      height={10}
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/**
 * The menu button's three lines: 16px, 1px strokes centred on whole pixels,
 * so each is one crisp row at 100% (an icon font's or a 24px icon's scaled
 * down would smear the middle one across two).
 */
export function MenuGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2 3.5h12M2 7.5h12M2 11.5h12" />
    </svg>
  );
}

export function MinimiseGlyph() {
  return (
    <Glyph>
      <path d="M0 5.5h10" />
    </Glyph>
  );
}

export function MaximiseGlyph() {
  return (
    <Glyph>
      <rect x="0.5" y="0.5" width="9" height="9" rx="1" />
    </Glyph>
  );
}

/** Two overlapping windows: the maximised window's "restore". */
export function RestoreGlyph() {
  return (
    <Glyph>
      <rect x="0.5" y="2.5" width="7" height="7" rx="1" />
      <path d="M2.5 2.5V0.5h7v7h-2" />
    </Glyph>
  );
}

export function CloseGlyph() {
  return (
    <Glyph>
      <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" shapeRendering="geometricPrecision" />
    </Glyph>
  );
}

export function ExitFullScreenGlyph() {
  return (
    <Glyph>
      <path d="M3.5 0.5v3h-3M6.5 0.5v3h3M3.5 9.5v-3h-3M6.5 9.5v-3h3" />
    </Glyph>
  );
}
