import type { CSSProperties, ElementType } from 'react';
import type { EventTheme } from '@/lib/events/schema';
import { forcesFullMotion } from '@/lib/events/theme/motion';
import { HeadlineIsland } from '@/components/events/effects/headline-island';
import type { RenderContext } from './context';

/**
 * A headline with the theme's text effect. CSS does blur-in, letter/word
 * reveal, foil sweep, gradient fill, outline, neon and weight-breathe; a
 * small island does split-flap, scramble and typewriter. The heading's
 * accessible name is always the plain text. Studio gets plain text (inline
 * editing needs one text node); the static look (foil, gradient, outline,
 * neon) still applies there.
 */

type Effect = EventTheme['motion']['headlineEffect'];

const SCRIPTED = new Set<Effect>(['split_flap', 'scramble', 'typewriter']);
const SPLIT_LETTERS = new Set<Effect>(['letter_reveal']);
const SPLIT_WORDS = new Set<Effect>(['word_reveal']);

export function Headline({
  ctx,
  text,
  effect,
  as: Tag = 'h1',
  className,
  field,
}: {
  ctx: RenderContext;
  text: string;
  effect: Effect;
  as?: ElementType;
  className?: string;
  /** The props key for Studio's inline editing. */
  field?: string;
}) {
  const fieldAttr = ctx.studio && field ? { 'data-field': `props.${field}` } : {};
  const animated = ctx.motion === 'full' && !ctx.studio && ctx.mode !== 'og';
  const base = { className: `ev-headline ${className ?? ''}`, 'data-hl': effect, ...fieldAttr };
  // The longest word scales the headline down on a narrow screen so one long
  // word ("Infrastructure") never runs off the edge (event.css .ev-hl-fit).
  const longest = Math.max(1, ...text.split(/\s+/).map((w) => Array.from(w).length));
  const fit = {
    className: 'ev-hl-fit',
    style: { '--ev-hl-longest': String(longest) } as CSSProperties,
  };

  if (ctx.studio) {
    // Studio's inline editing needs the heading to be one text node.
    return <Tag {...base}>{text}</Tag>;
  }
  if (!animated || effect === 'none') {
    return (
      <Tag {...base}>
        <span {...fit}>{text}</span>
      </Tag>
    );
  }
  if (SCRIPTED.has(effect)) {
    return (
      <Tag {...base} aria-label={text}>
        <span {...fit}>
          <HeadlineIsland
            text={text}
            effect={effect as 'split_flap'}
            speed={ctx.theme.motion.headlineSpeed}
            motion={{
              master: ctx.theme.motion.master,
              level: ctx.motion,
              forced: forcesFullMotion(ctx.motionPreview),
            }}
          />
        </span>
      </Tag>
    );
  }
  if (SPLIT_LETTERS.has(effect) || SPLIT_WORDS.has(effect)) {
    // Words stay whole (a line never breaks inside a word); letters animate inside them.
    const words = text.split(/(\s+)/);
    const letters = SPLIT_LETTERS.has(effect);
    const count = letters
      ? Array.from(text.replace(/\s+/g, '')).length || 1
      : words.filter((w) => w.trim()).length || 1;
    // The whole reveal stays under ~0.9 s however long the headline is.
    const step = Math.min(letters ? 38 : 90, Math.round(900 / count));
    let i = 0;
    return (
      <Tag {...base} aria-label={text}>
        <span aria-hidden="true" {...fit}>
          {words.map((word, k) => {
            if (!word.trim()) return <span key={k}>{word}</span>;
            if (!letters) {
              return (
                <span
                  key={k}
                  className="ev-hl-piece"
                  style={{ '--d': `${i++ * step}ms` } as CSSProperties}
                >
                  {word}
                </span>
              );
            }
            return (
              <span key={k} className="ev-hl-word">
                {Array.from(word).map((ch, c) => (
                  <span
                    key={c}
                    className="ev-hl-piece"
                    style={{ '--d': `${i++ * step}ms` } as CSSProperties}
                  >
                    {ch}
                  </span>
                ))}
              </span>
            );
          })}
        </span>
      </Tag>
    );
  }
  if (effect === 'weight_breathe') {
    // The box is sized by the text at its heaviest (hidden, in the flow); the
    // breathing copy sits over it, so the page below never jumps as the
    // weight changes (design review: CLS 0.2, every 2.5 s, forever).
    return (
      <Tag {...base} aria-label={text}>
        <span {...fit}>
          <span className="ev-breathe" aria-hidden="true">
            <span className="ev-breathe__size">{text}</span>
            <span className="ev-breathe__live">{text}</span>
          </span>
        </span>
      </Tag>
    );
  }
  if (effect === 'neon' && text.length > 2) {
    // One letter flickers, rarely and briefly (never above 3 flashes a second).
    const at = Math.min(text.length - 1, Math.max(1, Math.floor(text.length * 0.6)));
    return (
      <Tag {...base} aria-label={text}>
        <span aria-hidden="true" {...fit}>
          {text.slice(0, at)}
          <span className="ev-hl-flicker">{text.charAt(at)}</span>
          {text.slice(at + 1)}
        </span>
      </Tag>
    );
  }
  return (
    <Tag {...base}>
      <span {...fit}>{text}</span>
    </Tag>
  );
}
