'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { FormatBar } from '@/components/inbox/compose-window';
import { TURN_ON_FILTERS_HREF } from '@/components/inbox/inbox-filters';

type Access = 'on' | 'off' | 'demo' | 'not_connected';

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return j?.error?.message ?? fallback;
}

/** The step shown instead of Save until mail settings are turned on. */
export function TurnOnSettings({ access, what }: { access: Access; what: string }) {
  if (access === 'not_connected') {
    return (
      <p className="text-sm text-[var(--fg-muted)]">
        No mailbox is connected. Connect Google in Settings › Integrations first.
      </p>
    );
  }
  return (
    <div className="space-y-2 rounded-md border border-[var(--border)] bg-[var(--bg-sunken)] p-3 text-sm">
      <p className="font-medium">Turn on filters and settings</p>
      <p className="text-[var(--fg-muted)]">
        Changing your {what} from Kraken needs the same Google permission as filters: managing your
        basic mail settings. Google asks you to approve it once. Kraken only changes a setting when
        you click Save, never on its own, and the permission cannot set up forwarding.
      </p>
      <a
        href={TURN_ON_FILTERS_HREF}
        className="inline-flex h-9 items-center rounded-md bg-[var(--primary)] px-3.5 text-sm font-medium text-[var(--primary-fg)] hover:bg-[var(--primary-hover)]"
      >
        Turn on filters and settings
      </a>
    </div>
  );
}

const BOX =
  'min-h-28 rounded-md border border-[var(--border-control)] bg-[var(--bg-raised)] p-2 text-sm leading-relaxed break-words text-[var(--fg)] focus-visible:border-[var(--accent)] focus-visible:outline-none [&_a]:text-[var(--accent)] [&_a]:underline [&_img]:inline-block [&_img]:max-w-full [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6';

/**
 * Gmail's Signature setting: the default address's signature, shown as
 * Gmail keeps it (sanitized) and changed only when Save is clicked. Drafts
 * never carry it; Send adds it, read from Gmail at that moment.
 */
export function SignatureDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent
          title="Signature"
          description="Your Gmail signature. Send adds it under every email; drafts never hold it."
          className="max-w-xl"
        >
          <SignatureBody onDone={() => onOpenChange(false)} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function SignatureBody({ onDone }: { onDone: () => void }) {
  const [read, setRead] = React.useState<
    { access: Access; email: string | null; html: string } | { error: string } | null
  >(null);
  const [dirty, setDirty] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const editor = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    let live = true;
    fetch('/api/inbox/signature', { cache: 'no-store' })
      .then(async (r) =>
        r.ok
          ? ((await r.json()) as { access: Access; email: string | null; html: string })
          : { error: await errorMessage(r, 'Gmail did not answer.') },
      )
      .catch(() => ({ error: 'Could not reach Kraken. Try again.' }))
      .then((v) => {
        if (live) setRead(v);
      });
    return () => {
      live = false;
    };
  }, []);

  const html = read && 'html' in read ? read.html : '';
  const editable = Boolean(
    read && 'access' in read && (read.access === 'on' || read.access === 'demo'),
  );
  React.useEffect(() => {
    if (editor.current) editor.current.innerHTML = html;
  }, [html, editable]);

  const save = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/inbox/signature', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html: editor.current?.innerHTML ?? '' }),
      });
      if (!res.ok) {
        toast.error(await errorMessage(res, 'Gmail did not save the signature. Try again.'));
        return;
      }
      toast.success('Signature saved in Gmail');
      onDone();
    } catch {
      toast.error('Could not reach Kraken. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (!read) {
    return (
      <p className="flex items-center gap-2 text-sm text-[var(--fg-muted)]">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Reading Gmail…
      </p>
    );
  }
  if ('error' in read) return <p className="text-sm text-[var(--danger)]">{read.error}</p>;

  return (
    <div className="space-y-3">
      {read.email ? (
        <p className="text-xs text-[var(--fg-muted)]">
          For <span className="font-medium text-[var(--fg)]">{read.email}</span>
          {read.access === 'demo' ? ' (demo: nothing reaches Gmail)' : ''}
        </p>
      ) : null}
      {editable ? (
        <>
          <div className="rounded-md border border-[var(--border)]">
            <div className="border-b border-[var(--border)] px-1 py-0.5">
              <FormatBar editor={editor} disabled={busy} onChange={() => setDirty(true)} />
            </div>
            <div
              ref={editor}
              role="textbox"
              aria-multiline="true"
              aria-label="Signature"
              contentEditable={!busy}
              suppressContentEditableWarning
              onInput={() => setDirty(true)}
              className={`${BOX} rounded-t-none border-0`}
            />
          </div>
          <p className="text-[11px] text-[var(--fg-subtle)]">
            Kept: text, links, images by web address and basic formatting. Colours, fonts and
            scripts are left out when it saves.
          </p>
        </>
      ) : (
        <>
          <div ref={editor} aria-label="Current signature" className={BOX} />
          {!html ? <p className="text-xs text-[var(--fg-muted)]">No signature in Gmail.</p> : null}
          <TurnOnSettings access={read.access} what="signature" />
        </>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          {editable ? 'Cancel' : 'Close'}
        </Button>
        {editable ? (
          <Button
            type="button"
            variant="primary"
            disabled={!dirty || busy}
            onClick={() => void save()}
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            Save changes
          </Button>
        ) : null}
      </DialogFooter>
    </div>
  );
}
