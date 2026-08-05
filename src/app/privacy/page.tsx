import type { Metadata } from 'next';
import Link from 'next/link';
import { Wordmark } from '@/components/brand/wordmark';

export const metadata: Metadata = { title: 'Privacy notice' };

export default function PrivacyPage() {
  return (
    <main id="main" className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">
      <div className="mb-8">
        <Wordmark />
      </div>

      <h1 className="font-serif text-2xl font-semibold">Privacy notice</h1>
      <p className="mt-2 text-sm text-[var(--fg-muted)]">
        TipTop Copilot is an internal tool for TipTop VC. This describes what it stores, what it
        sends where, and how to remove it.
      </p>

      <div className="mt-8 space-y-7 text-sm leading-relaxed">
        <Section title="What is stored">
          <p>
            Email metadata (sender, recipients, subject, date, labels, thread, snippet) for messages
            in the configured lookback window. Full message bodies and attachments are stored only
            after a specific trigger: you open the message, the classifier judges it consequential
            (a deal, portfolio update, LP item or substantive founder correspondence), or automatic
            deep analysis has been switched on in configuration.
          </p>
          <p className="mt-2">
            Calendar events for the days shown in the outlook. Deals, notes, decisions, tasks,
            drafts and uploaded documents that you create. Estimated AI usage per request, and an
            audit record of every consequential action.
          </p>
        </Section>

        <Section title="What is not stored">
          <p>
            Your Google password. Message bodies for mail that was never opened or flagged. Anything
            from mailboxes or calendars you have not connected. Provider tokens in plaintext.
          </p>
        </Section>

        <Section title="Where data goes">
          <p>
            Data stays in your Supabase project except when a request needs a model. In that case
            the relevant excerpts — the email, attachment text or document passages needed for that
            specific request — are sent to Anthropic&rsquo;s API from the server. Your API key never
            reaches the browser.
          </p>
          <p className="mt-2">
            Public web research is off unless configured. When it is on, only the search query is
            sent to the research provider, never your private content, and results are labelled as
            public-web with their publication and retrieval dates.
          </p>
        </Section>

        <Section title="Google access">
          <p>
            Read-only. The app requests{' '}
            <code className="font-mono text-[12px]">gmail.readonly</code>,{' '}
            <code className="font-mono text-[12px]">calendar.readonly</code> and your account email
            address. It does <strong>not</strong> request permission to send email, and has no send
            capability — replies are produced as drafts for you to send yourself.
          </p>
          <p className="mt-2">
            Refresh tokens are encrypted with AES-256-GCM using a key held only in the server
            environment, bound to the specific integration record, and never written to logs.
          </p>
        </Section>

        <Section title="Attachments and documents">
          <p>
            Stored in a private bucket with no public path. Access is granted per request through a
            signed URL that expires after fifteen minutes, and only after an authorization check.
            Filenames are sanitised and file types are verified by content, not by the declared
            header.
          </p>
        </Section>

        <Section title="AI and your data">
          <p>
            Every AI-generated surface is labelled and records the model, prompt version and the
            sources it used. Content from email, attachments, documents and the web is treated as
            untrusted data — instructions found inside it are never followed, and attempts are
            flagged to you rather than hidden.
          </p>
          <p className="mt-2">
            The assistant recommends; it does not decide. It cannot mark a deal invested, send a
            message, or take a financial action.
          </p>
        </Section>

        <Section title="Removing data">
          <p>
            <strong>Disconnect</strong> deletes stored provider tokens and revokes access at Google.{' '}
            <strong>Delete synced email</strong> removes every synchronised message, thread and
            attachment for the organization. Both are in{' '}
            <Link href="/settings" className="text-[var(--accent)] underline underline-offset-2">
              Settings
            </Link>
            . Deleting the Supabase project removes everything else.
          </p>
        </Section>

        <Section title="Retention">
          <p>
            There is no automatic deletion. Data persists until you remove it or delete the project.
            Sessions expire after twelve hours.
          </p>
        </Section>
      </div>

      <p className="mt-10 border-t border-[var(--border)] pt-5 text-xs text-[var(--fg-subtle)]">
        This is an internal tool operated by TipTop VC for its own team. It is not a public service
        and collects nothing from anyone who is not a signed-in member of the organization.
      </p>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="font-serif text-lg font-semibold">{title}</h2>
      <div className="mt-2 text-[var(--fg-muted)]">{children}</div>
    </section>
  );
}
