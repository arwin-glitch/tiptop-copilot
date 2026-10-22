import type { EventTheme } from '@/lib/events/schema';

/**
 * The finish layer: film grain, paper, halftone, scanlines and vignette, all
 * cheap CSS over any theme (the --ev-grain etc. strengths come from the
 * theme tokens). Grain flickers only while motion runs; foil and emboss are
 * typographic and live in event.css under data-foil / data-emboss.
 */
export function FinishLayer({ theme }: { theme: EventTheme }) {
  const f = theme.finish;
  const layers: string[] = [];
  if (f.paper > 0) layers.push('paper');
  if (f.halftone > 0) layers.push('halftone');
  if (f.scanlines > 0) layers.push('scanlines');
  if (f.vignette > 0) layers.push('vignette');
  if (f.grain > 0) layers.push('grain');
  if (!layers.length) return null;
  return (
    <div className="ev-finish" aria-hidden="true">
      {layers.map((kind) => (
        <div key={kind} className={`ev-finish__${kind}`} />
      ))}
    </div>
  );
}
