import type * as React from 'react';
import { GoldFiligree } from '@/components/brand/gold-filigree';
import { Wordmark } from '@/components/brand/wordmark';
import { Card, CardContent } from '@/components/ui/card';

/**
 * The login page's frame, for the desktop sign-in pages a browser lands on:
 * the forest band with the wordmark, and one card overlapping its edge.
 * Copied rather than shared, so the login page keeps its own markup.
 */
export function AuthShell({
  title,
  children,
  footer,
}: {
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <main
      id="main"
      className="relative isolate flex min-h-[calc(100dvh-var(--titlebar-h))] items-center justify-center overflow-hidden bg-[var(--bg)] bg-[image:var(--spotlight)] px-4 py-10"
    >
      <div
        aria-hidden="true"
        className="dark absolute inset-x-0 top-0 isolate -z-10 h-[calc(50%-2.5rem)] bg-[var(--bg-band)] after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-[var(--gold-rule)]"
      >
        <GoldFiligree variant="band" />
      </div>
      <div className="w-full max-w-md">
        <div className="dark mb-7 flex justify-center text-[var(--fg)]">
          <Wordmark />
        </div>

        <Card>
          <CardContent className="pt-5">
            <h1 className="font-serif text-xl font-semibold">{title}</h1>
            {children}
          </CardContent>
        </Card>

        {footer ? (
          <p className="mt-5 text-center text-xs text-[var(--fg-subtle)]">{footer}</p>
        ) : null}
      </div>
    </main>
  );
}
