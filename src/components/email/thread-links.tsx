import type { ReactNode } from 'react';
import Link from 'next/link';
import { ExternalLink, Inbox } from 'lucide-react';
import { parseGmailThreadUrl, threadLinks } from '@/lib/email/thread-links';
import { cn } from '@/lib/util/cn';

/**
 * The two places to read an email, side by side: "Copilot" opens the thread
 * in the Inbox's reading pane (`/inbox?thread=<id>`, in this tab), "Gmail"
 * opens it in Gmail in a new tab. Arwin's rule: every email or thread link in
 * the app offers both, and a link never brings the email's text with it.
 *
 * Works in server and client components alike (no hooks, no state). Takes a
 * Gmail thread or message id, or Copilot's own id for a synced email (which
 * the Inbox looks up), and renders nothing for anything else, so a caller can
 * pass whatever it holds. Accessible names are "Open in Copilot" and "Open in
 * Gmail", with the `label` after a colon when one is given, so a list of them
 * stays telling apart for a screen reader; the visible words are always just
 * the place.
 */

export interface ThreadLinksProps {
  /** A Gmail thread or message id (hex), or a synced email's UUID. Anything else renders nothing. */
  id: string | null | undefined;
  /**
   * The mailbox the thread is in, for Gmail's `authuser` (DEFAULT_MAILBOX on
   * the server). Null where it is not known: Gmail then goes by way of the
   * Inbox, which knows the connected mailbox.
   */
  mailbox: string | null | undefined;
  /** What the email is (its subject, or who it is from), added to both accessible names. */
  label?: string;
  /**
   * `buttons` (default): two compact outlined buttons, phone-sized taps.
   * `text`: two small text links, for a dense line. `icons`: two icon-only
   * links, for a row with no room for words.
   */
  variant?: 'buttons' | 'text' | 'icons';
  className?: string;
}

const NAME = { copilot: 'Open in Copilot', gmail: 'Open in Gmail' } as const;

export function ThreadLinks({
  id,
  mailbox,
  label,
  variant = 'buttons',
  className,
}: ThreadLinksProps) {
  const links = threadLinks(id, mailbox);
  if (!links) return null;
  const named = (place: keyof typeof NAME) => (label ? `${NAME[place]}: ${label}` : NAME[place]);

  const item = {
    buttons:
      // 32 px tall on a phone, 28 px from sm up; the outline is the control edge.
      'inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--border-strong)] bg-[var(--bg-raised)] px-2.5 text-xs font-medium text-[var(--fg)] transition-colors hover:border-[var(--border-control)] hover:bg-[var(--bg-hover)] sm:h-7 sm:px-2',
    // Underlined at rest: colour alone would not mark the words as links.
    text: 'relative inline-flex items-center gap-1 py-1 text-xs text-[var(--accent)] underline decoration-[color:var(--link-underline)] underline-offset-2 hover:decoration-current max-sm:after:absolute max-sm:after:-inset-y-2 max-sm:after:-inset-x-1.5',
    icons:
      'relative inline-flex size-7 items-center justify-center rounded-md text-[var(--accent)] hover:bg-[var(--bg-hover)] max-sm:after:absolute max-sm:after:-inset-1.5',
  }[variant];
  const icon = variant === 'icons' ? 'size-4' : 'size-3.5';

  return (
    <span
      className={cn(
        'inline-flex shrink-0 flex-wrap items-center',
        variant === 'text' ? 'gap-3' : 'gap-1.5',
        className,
      )}
    >
      <Link
        href={links.copilot}
        prefetch={false}
        aria-label={named('copilot')}
        title={variant === 'icons' ? NAME.copilot : undefined}
        className={item}
      >
        <Inbox className={cn(icon, 'shrink-0')} aria-hidden="true" />
        {variant === 'icons' ? null : 'Copilot'}
      </Link>
      <a
        href={links.gmail}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={named('gmail')}
        title={variant === 'icons' ? NAME.gmail : undefined}
        className={item}
      >
        <ExternalLink className={cn(icon, 'shrink-0')} aria-hidden="true" />
        {variant === 'icons' ? null : 'Gmail'}
      </a>
    </span>
  );
}

/**
 * The two links for a link that was built earlier as a Gmail URL (a task's
 * "Seen sent" proof, a routine's link in a post, a warm path's sample
 * thread): when it points at one Gmail email, both places to read it, after
 * `text` when given; otherwise `fallback`, unchanged. A Gmail search, a
 * label, Gmail's newer opaque ids and every other site keep their own link.
 */
export function ThreadLinksForHref({
  href,
  text,
  fallback,
  ...rest
}: Omit<ThreadLinksProps, 'id' | 'mailbox'> & {
  href: string | null | undefined;
  /** Words shown before the two links (what the email is). */
  text?: ReactNode;
  /** What to render when the href is not one Gmail email (often the plain link). */
  fallback: ReactNode;
}) {
  const ref = parseGmailThreadUrl(href);
  if (!ref) return <>{fallback}</>;
  const links = <ThreadLinks id={ref.id} mailbox={ref.mailbox} {...rest} />;
  if (text === undefined) return links;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className="min-w-0 break-words">{text}</span>
      {links}
    </span>
  );
}
