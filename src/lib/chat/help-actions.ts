import type { Citation } from '@/lib/types/domain';

/**
 * The buttons an Ask answer about Kraken itself carries: one per page or tab
 * it names ('help' citations, from the Help registry), and "Show me" for the
 * first one whose guided tour can start. Every other citation stays a source
 * chip. Pure, so the split is tested without rendering.
 */

export interface HelpLink {
  key: string;
  label: string;
  href: string;
}

export interface HelpActions {
  links: HelpLink[];
  showMe: HelpLink | null;
  /** The citations that are records, for the Sources drawer and chips. */
  sources: Citation[];
}

/** Only links inside the app: a stored answer can never send a click elsewhere. */
function internal(href: string | null | undefined): string | null {
  if (!href || !href.startsWith('/') || href.startsWith('//')) return null;
  return href;
}

export function helpActions(citations: readonly Citation[]): HelpActions {
  const links: HelpLink[] = [];
  let showMe: HelpLink | null = null;
  const sources: Citation[] = [];
  for (const c of citations) {
    if (c.kind !== 'help') {
      sources.push(c);
      continue;
    }
    const href = internal(c.url);
    if (href && !links.some((l) => l.href === href)) {
      links.push({ key: c.id, label: c.label, href });
    }
    const tour = internal(c.tour_url);
    if (tour && !showMe) showMe = { key: `${c.id}:tour`, label: 'Show me', href: tour };
  }
  return { links, showMe, sources };
}
