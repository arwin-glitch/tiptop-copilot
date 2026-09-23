import {
  CalendarRange,
  ClipboardList,
  Handshake,
  Layers,
  Mailbox,
  MessageSquare,
  Radar,
  Rocket,
  type LucideIcon,
} from 'lucide-react';
import type { BadgeProps } from '@/components/ui/badge';
import { cn } from '@/lib/util/cn';
import type {
  UpdatePost,
  UpdateSource,
  UpdateSourceIcon,
  UpdateSourceView,
} from '@/lib/updates/types';

/**
 * Icon, colour and badge per kind — the Today briefing cards' pattern (a top
 * rail, a round icon chip, a kind badge). Warn and danger tones are kept for
 * states, never kinds, so a yellow badge always means "something to fix".
 */

export const SOURCE_ICON: Record<UpdateSourceIcon, LucideIcon> = {
  rocket: Rocket,
  radar: Radar,
  handshake: Handshake,
  mailbox: Mailbox,
};

export interface KindStyle {
  icon: LucideIcon;
  rail: string;
  chip: string;
  badgeTone: NonNullable<BadgeProps['tone']>;
  badgeLabel: string;
}

const ACCENT = { rail: 'bg-[var(--accent)]', chip: 'bg-[var(--accent-soft)] text-[var(--accent)]' };
const INFO = { rail: 'bg-[var(--info)]', chip: 'bg-[var(--info-soft)] text-[var(--info)]' };
const NEUTRAL = {
  rail: 'bg-[var(--fg-subtle)]/40',
  chip: 'bg-[var(--neutral-soft)] text-[var(--fg-muted)]',
};

export function postStyle(post: UpdatePost, source: UpdateSource): KindStyle {
  switch (post.type) {
    case 'dealflow':
      return {
        icon: SOURCE_ICON[source.icon],
        ...ACCENT,
        badgeTone: 'outline',
        badgeLabel: 'Dealflow',
      };
    case 'digest':
      if (post.kind === 'weekly') {
        return { icon: Mailbox, ...INFO, badgeTone: 'info', badgeLabel: 'Weekly digest' };
      }
      if (post.kind === 'month-start' || post.kind === 'month-end') {
        return {
          icon: CalendarRange,
          ...INFO,
          badgeTone: 'info',
          badgeLabel: post.kind === 'month-start' ? 'Month-start' : 'Month-end',
        };
      }
      return { icon: Layers, ...NEUTRAL, badgeTone: 'neutral', badgeLabel: post.kindLabel };
    case 'roster':
      return { icon: ClipboardList, ...NEUTRAL, badgeTone: 'outline', badgeLabel: 'Roster' };
    default:
      return { icon: MessageSquare, ...NEUTRAL, badgeTone: 'neutral', badgeLabel: 'Post' };
  }
}

export function sourceStyle(source: UpdateSource): { icon: LucideIcon; chip: string } {
  return {
    icon: SOURCE_ICON[source.icon],
    chip: source.group === 'digest' ? INFO.chip : ACCENT.chip,
  };
}

export function IconChip({
  icon: Icon,
  className,
  size = 'md',
}: {
  icon: LucideIcon;
  className: string;
  size?: 'sm' | 'md';
}) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full',
        size === 'md' ? 'size-9' : 'size-7',
        className,
      )}
      aria-hidden="true"
    >
      <Icon className={size === 'md' ? 'size-4.5' : 'size-3.5'} />
    </span>
  );
}

/** One badge that says whether this source can be read, and if not, what kind of problem. */
export function statusBadge(view: UpdateSourceView): {
  tone: NonNullable<BadgeProps['tone']>;
  label: string;
} {
  const a = view.access;
  switch (a.state) {
    case 'ok':
      return view.overdue ? { tone: 'warn', label: 'Overdue' } : { tone: 'ok', label: 'Live' };
    case 'not_invited':
      return { tone: 'warn', label: 'Invite needed' };
    case 'missing_scope':
      return { tone: 'warn', label: 'Scope needed' };
    case 'token_rejected':
      return { tone: 'danger', label: 'Token problem' };
    case 'no_token':
      return { tone: 'warn', label: 'Not connected' };
    case 'rate_limited':
    case 'unreachable':
      return view.stale
        ? { tone: 'neutral', label: 'Cached' }
        : { tone: 'warn', label: 'Unreachable' };
    case 'error':
      return { tone: 'warn', label: a.code };
  }
}
