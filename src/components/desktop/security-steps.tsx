import { FIRST_SELF_UPDATING_VERSION, type InstallerPlatform } from '@/lib/desktop/shared';

/**
 * The one-time steps an unsigned app needs, with a small drawing of the
 * screen each platform shows. The drawings are decoration (aria-hidden); the
 * steps themselves are text, so a screen reader gets everything.
 */

/** Older versions repeat the steps with each new download. */
const ONCE = `From version ${FIRST_SELF_UPDATING_VERSION} you do this once: later versions install from inside the app, with no extra steps.`;

const STEPS: Record<InstallerPlatform, { title: string; steps: string[]; note: string }> = {
  mac: {
    title: 'First time on a Mac',
    steps: [
      'Open the downloaded file and drag TipTop Kraken into Applications.',
      'Open TipTop Kraken from your Applications folder. Your Mac says “TipTop Kraken” Not Opened: Apple could not verify it is free of malware. That’s expected for an app from outside the App Store. Click Done (or Cancel), never Move to Trash.',
      'Within an hour, open System Settings, then Privacy & Security. Scroll down, click Open Anyway, and enter your Mac password.',
    ],
    note: ONCE,
  },
  windows: {
    title: 'First time on Windows',
    steps: [
      'Open TipTop-Copilot-windows-setup.exe. If your browser asks, choose Keep (in Edge: Keep, then Show more, then Keep anyway).',
      'If a blue box says Windows protected your PC, click More info, then Run anyway.',
      'It installs in a few seconds and opens. Find it later in the Start menu.',
    ],
    note: ONCE,
  },
};

function MacPictures() {
  return (
    <div className="space-y-2">
      <MacWarning />
      <MacSettings />
    </div>
  );
}

/** The warning on first open (step 2), with the button to press. */
function MacWarning() {
  return (
    <div
      aria-hidden="true"
      className="rounded-md border border-[var(--border-strong)] bg-[var(--bg-raised)] px-3 py-2.5 text-center text-xs"
    >
      <p className="font-semibold text-[var(--fg)]">“TipTop Kraken” Not Opened</p>
      <p className="mt-1 text-[var(--fg-muted)]">
        Apple could not verify “TipTop Kraken” is free of malware that may harm your Mac or
        compromise your privacy.
      </p>
      <div className="mt-2 flex justify-center gap-2">
        <span className="rounded-md bg-[var(--bg-sunken)] px-2.5 py-1 font-medium text-[var(--fg)] ring-2 ring-[var(--gold)]">
          Done
        </span>
        <span className="rounded-md bg-[var(--bg-sunken)] px-2.5 py-1 text-[var(--fg-muted)]">
          Move to Trash
        </span>
      </div>
    </div>
  );
}

/** Privacy & Security, where Open Anyway appears (step 3). */
function MacSettings() {
  return (
    <div
      aria-hidden="true"
      className="overflow-hidden rounded-md border border-[var(--border-strong)] bg-[var(--bg-raised)] text-xs"
    >
      <div className="flex items-center gap-1.5 border-b border-[var(--border)] bg-[var(--bg-sunken)] px-2.5 py-1.5">
        <span className="size-2 rounded-full bg-[var(--danger)]" />
        <span className="size-2 rounded-full bg-[var(--warn)]" />
        <span className="size-2 rounded-full bg-[var(--ok)]" />
        <span className="ml-2 font-medium text-[var(--fg-muted)]">Privacy &amp; Security</span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
        <span className="text-[var(--fg)]">“TipTop Kraken” was blocked to protect your Mac.</span>
        <span className="rounded-md bg-[var(--bg-sunken)] px-2.5 py-1 font-medium text-[var(--fg)] ring-2 ring-[var(--gold)]">
          Open Anyway
        </span>
      </div>
    </div>
  );
}

function WindowsPicture() {
  return (
    <div
      aria-hidden="true"
      className="rounded-md border border-[var(--info)]/40 bg-[var(--info-soft)] px-3 py-2.5 text-xs"
    >
      <p className="font-serif text-sm font-semibold text-[var(--info)]">
        Windows protected your PC
      </p>
      <p className="mt-1 text-[var(--fg-muted)]">
        <span className="text-[var(--info)] underline underline-offset-2">More info</span>
      </p>
      <div className="mt-2 flex justify-end gap-2">
        <span className="rounded-sm bg-[var(--bg-raised)] px-2.5 py-1 font-medium text-[var(--fg)] ring-2 ring-[var(--gold)]">
          Run anyway
        </span>
        <span className="rounded-sm bg-[var(--bg-raised)] px-2.5 py-1 text-[var(--fg-muted)]">
          Don’t run
        </span>
      </div>
    </div>
  );
}

export function SecuritySteps({ platform }: { platform: InstallerPlatform }) {
  const { title, steps, note } = STEPS[platform];
  const id = `security-steps-${platform}`;
  return (
    <section aria-labelledby={id} className="mt-5 border-t border-[var(--border)] pt-4">
      <h3 id={id} className="text-sm font-semibold">
        {title}
      </h3>
      <ol className="mt-2 space-y-1.5 text-sm text-[var(--fg-muted)]">
        {steps.map((step, index) => (
          <li key={step} className="flex gap-2.5">
            <span
              aria-hidden="true"
              className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--jewel)] text-[11px] font-semibold text-[var(--jewel-fg)]"
            >
              {index + 1}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      <div className="mt-3">{platform === 'mac' ? <MacPictures /> : <WindowsPicture />}</div>
      <p className="mt-2 text-xs text-[var(--fg-subtle)]">{note}</p>
    </section>
  );
}
