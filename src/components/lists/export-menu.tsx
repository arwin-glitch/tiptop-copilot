'use client';

import * as React from 'react';
import { Archive, Download, FileSpreadsheet } from 'lucide-react';
import { DownloadLink } from '@/components/lists/download-link';
import { Button } from '@/components/ui/button';
import { FieldLabel } from '@/components/ui/card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

const ITEM =
  'flex items-start gap-2 rounded-md px-1.5 py-1.5 text-sm hover:bg-[var(--bg-hover)] data-[busy]:cursor-progress data-[busy]:opacity-60';

/**
 * "Export": the view on screen as a CSV — every entry its filters match, not
 * just this page, in its columns and sort — and, for owners, the whole CRM
 * as a ZIP. Offered to members and above only, the roles the export routes
 * serve. Download links that show a refused or failed export as a toast
 * rather than saving its error as a file (DownloadLink).
 */
export function ExportMenu({
  viewHref,
  viewLabel,
  everythingHref,
}: {
  viewHref: string;
  /** The view's name, for the link text. */
  viewLabel: string;
  /** The whole-CRM export, offered to owners only; null hides it. */
  everythingHref: string | null;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="secondary" size="sm">
          <Download aria-hidden="true" />
          Export
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label="Export" className="w-72">
        <FieldLabel as="p" className="px-1.5 pt-0.5 pb-2">
          Export
        </FieldLabel>
        <ul className="space-y-0.5">
          <li>
            <DownloadLink href={viewHref} className={ITEM}>
              <FileSpreadsheet
                className="mt-0.5 size-4 shrink-0 text-[var(--accent)]"
                aria-hidden="true"
              />
              <span>
                <span className="block font-medium">Export CSV</span>
                <span className="text-mini block text-[var(--fg-muted)]">
                  {viewLabel}: every matching entry, these columns
                </span>
              </span>
            </DownloadLink>
          </li>
          {everythingHref ? (
            <li>
              <DownloadLink href={everythingHref} className={ITEM}>
                <Archive
                  className="mt-0.5 size-4 shrink-0 text-[var(--accent)]"
                  aria-hidden="true"
                />
                <span>
                  <span className="block font-medium">Export everything</span>
                  <span className="text-mini block text-[var(--fg-muted)]">
                    All lists, companies, people and notes as a ZIP of CSVs
                  </span>
                </span>
              </DownloadLink>
            </li>
          ) : null}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
