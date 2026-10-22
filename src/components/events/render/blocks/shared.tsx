import type { ReactNode } from 'react';
import { isAllowedHref } from '@/lib/campaigns/template';
import { mergePlainText, renderRichText } from '@/lib/events/richtext';
import type { RenderContext } from '../context';
import { fieldAttr } from '../context';

/** Small pieces every block view shares: merged text, headings, buttons, rich text. */

/** A plain-text prop with merge fields resolved for this viewer. */
export function txt(ctx: RenderContext, value: unknown): string {
  return typeof value === 'string' ? mergePlainText(value, ctx.merge) : '';
}

/** A link prop, only when it is one a guest may follow. */
export function linkOf(value: unknown): string | null {
  return typeof value === 'string' && value && isAllowedHref(value) ? value : null;
}

export function Rich({
  ctx,
  source,
  className,
}: {
  ctx: RenderContext;
  source: unknown;
  className?: string;
}) {
  if (typeof source !== 'string' || !source.trim()) return null;
  return (
    <div className={`ev-rich ${className ?? ''}`}>
      {renderRichText(source, { merge: ctx.merge, inertLinks: ctx.studio })}
    </div>
  );
}

export function SectionHeading({
  ctx,
  heading,
  eyebrow,
  headingKey = 'heading',
  eyebrowKey = 'eyebrow',
  placeholder,
}: {
  ctx: RenderContext;
  heading: string;
  eyebrow?: string;
  headingKey?: string;
  eyebrowKey?: string;
  /** Studio shows this when the heading is empty, so the slot can be clicked. */
  placeholder?: string;
}) {
  const showHeading = heading || (ctx.studio && placeholder);
  if (!showHeading && !eyebrow) return null;
  return (
    <header className="ev-section-head">
      {eyebrow ? (
        <p className="ev-eyebrow" {...fieldAttr(ctx, eyebrowKey)}>
          {eyebrow}
        </p>
      ) : null}
      {showHeading ? (
        <h2
          className="ev-h2"
          data-empty={heading ? undefined : 'true'}
          {...fieldAttr(ctx, headingKey)}
        >
          {heading || placeholder}
        </h2>
      ) : null}
    </header>
  );
}

export function EvButton({
  ctx,
  href,
  children,
  variant = 'primary',
  external,
  field,
}: {
  ctx: RenderContext;
  href: string | null;
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost';
  external?: boolean;
  field?: string;
}) {
  const className = `ev-btn ev-btn--${variant}`;
  const fields = field ? fieldAttr(ctx, field) : {};
  if (!href || ctx.mode === 'og') {
    return (
      <span className={className} {...fields}>
        {children}
      </span>
    );
  }
  if (ctx.studio) {
    return (
      <a className={className} href={href} data-inert-link="" {...fields}>
        {children}
      </a>
    );
  }
  return (
    <a
      className={className}
      href={href}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      {...fields}
    >
      {children}
    </a>
  );
}

/** Empty-list hint, Studio only ("Add agenda items"). */
export function StudioHint({ ctx, children }: { ctx: RenderContext; children: ReactNode }) {
  if (!ctx.studio) return null;
  return <p className="ev-studio-hint">{children}</p>;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('');
}
