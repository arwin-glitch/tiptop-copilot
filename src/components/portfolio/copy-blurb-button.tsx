'use client';

import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

/**
 * Puts a role's blurb (title and company, where, the job page) on the
 * clipboard for sharing. The text is built on the server; this only copies it.
 */
export function CopyBlurbButton({ text, label }: { text: string; label: string }) {
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast.success('Copied. Paste it wherever you are sharing the role.');
        } catch {
          toast.error("Couldn't copy here. Select the role's text and copy it by hand.");
        }
      }}
    >
      <Copy aria-hidden="true" />
      Copy blurb
    </Button>
  );
}
