'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Link2, Trash2, Unlink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/form';

/**
 * Connect, disconnect and delete-data controls.
 *
 * Disconnect and delete are consequential and irreversible, so both require an
 * explicit confirmation — deletion requires typing the word, which is the level
 * of friction the action deserves.
 */
export function IntegrationControls({
  connected,
  canConnect,
  showDataDeletion = false,
}: {
  connected: boolean;
  canConnect: boolean;
  showDataDeletion?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [confirmText, setConfirmText] = React.useState('');
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [disconnectOpen, setDisconnectOpen] = React.useState(false);

  const post = (url: string, success: string) =>
    startTransition(async () => {
      try {
        const response = await fetch(url, { method: 'POST' });
        const body = (await response.json()) as { ok?: boolean; error?: { message?: string } };
        if (response.ok && body.ok !== false) {
          toast.success(success);
          setDeleteOpen(false);
          setDisconnectOpen(false);
          setConfirmText('');
          router.refresh();
        } else {
          toast.error(body.error?.message ?? 'That did not work');
        }
      } catch {
        toast.error('Could not reach the server');
      }
    });

  return (
    <div className="flex flex-wrap gap-2">
      {!connected && canConnect ? (
        <Button asChild variant="primary" size="sm">
          <a href="/api/integrations/google/start">
            <Link2 aria-hidden="true" />
            Connect Google Workspace
          </a>
        </Button>
      ) : null}

      {connected ? (
        <Dialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
          <DialogTrigger asChild>
            <Button variant="secondary" size="sm">
              <Unlink aria-hidden="true" />
              Disconnect
            </Button>
          </DialogTrigger>
          <DialogContent
            title="Disconnect Google Workspace?"
            description="Stored tokens are deleted and access is revoked at Google. Already-synced email stays until you delete it separately."
          >
            <DialogFooter>
              <Button variant="ghost" onClick={() => setDisconnectOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                loading={pending}
                onClick={() =>
                  post('/api/integrations/google/disconnect', 'Disconnected and revoked')
                }
              >
                Disconnect
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {showDataDeletion ? (
        <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
          <DialogTrigger asChild>
            <Button variant="secondary" size="sm">
              <Trash2 aria-hidden="true" />
              Delete synced email
            </Button>
          </DialogTrigger>
          <DialogContent
            title="Delete all synchronised email?"
            description="Removes every synced message, thread and attachment for this organization. Deals, notes and decisions are kept — but any deal that relied on a deleted email loses that source."
          >
            <label className="block text-sm" htmlFor="confirm-delete">
              Type <strong>DELETE</strong> to confirm
            </label>
            <Input
              id="confirm-delete"
              className="mt-1.5"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              autoComplete="off"
            />
            <DialogFooter>
              <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                loading={pending}
                disabled={confirmText !== 'DELETE'}
                onClick={() => post('/api/integrations/google/delete-data', 'Synced email deleted')}
              >
                Delete permanently
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
