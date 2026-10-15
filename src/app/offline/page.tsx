import type { Metadata } from 'next';
import { GoldFiligree } from '@/components/brand/gold-filigree';
import { Wordmark } from '@/components/brand/wordmark';

export const metadata: Metadata = { title: 'Offline' };

export default function OfflinePage() {
  return (
    <main
      id="main"
      className="relative isolate flex min-h-dvh items-center justify-center overflow-hidden px-4"
    >
      <GoldFiligree variant="login" />
      <div className="max-w-sm text-center">
        <div className="mb-6 flex justify-center">
          <Wordmark />
        </div>
        <h1 className="font-serif text-xl font-semibold">You are offline</h1>
        <p className="mt-2 text-sm text-[var(--fg-muted)]">
          TipTop Copilot works against live data and does not cache your deals, email or documents
          on the device. Reconnect and the page will load.
        </p>
      </div>
    </main>
  );
}
