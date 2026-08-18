'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/form';

/**
 * Search over the relationship list.
 *
 * Submitted rather than debounced-as-you-type: the list is derived on every
 * request, so a keystroke-per-query would re-scan the mailbox on each letter.
 */
export function NetworkFilterBar({ q }: { q: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const [query, setQuery] = React.useState(q);

  return (
    <form
      className="relative max-w-sm"
      onSubmit={(e) => {
        e.preventDefault();
        const next = new URLSearchParams(params.toString());
        if (query.trim()) next.set('q', query.trim());
        else next.delete('q');
        router.push(`/network?${next.toString()}`);
      }}
    >
      <Search
        className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-[var(--fg-subtle)]"
        aria-hidden="true"
      />
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search name, address or company"
        aria-label="Search network"
        className="pl-8"
      />
    </form>
  );
}
