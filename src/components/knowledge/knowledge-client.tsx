'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Trash2, Upload } from 'lucide-react';
import { deleteDocumentAction, importNetworkCsvAction, uploadDocumentAction } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import type { KnowledgeDocType } from '@/lib/types/domain';

const DOC_TYPES: { value: KnowledgeDocType; label: string }[] = [
  { value: 'thesis', label: 'Investment thesis' },
  { value: 'memo', label: 'Investment memo' },
  { value: 'pass_note', label: 'Pass note' },
  { value: 'ic_note', label: 'IC note' },
  { value: 'portfolio_doc', label: 'Portfolio document' },
  { value: 'market_map', label: 'Market map' },
  { value: 'playbook', label: 'Operating playbook' },
  { value: 'network_csv', label: 'Network / contacts CSV' },
  { value: 'other', label: 'Other' },
];

export function UploadDocumentButton() {
  const [open, setOpen] = React.useState(false);
  const [docType, setDocType] = React.useState<KnowledgeDocType>('memo');
  const [title, setTitle] = React.useState('');
  const [pending, startTransition] = React.useTransition();
  const formRef = React.useRef<HTMLFormElement>(null);
  const router = useRouter();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="primary" size="sm">
          <Upload aria-hidden="true" />
          Upload
        </Button>
      </DialogTrigger>
      <DialogContent
        title="Upload a document"
        description="Text is extracted with page boundaries preserved, so answers can cite a page. Files are stored privately."
      >
        <form
          ref={formRef}
          onSubmit={(e) => {
            e.preventDefault();
            const formData = new FormData(e.currentTarget);
            startTransition(async () => {
              const result = await uploadDocumentAction(formData);
              if (result.ok && result.data) {
                toast.success(
                  `Uploaded — ${result.data.chunks} searchable passage${result.data.chunks === 1 ? '' : 's'}`,
                  {
                    description:
                      result.data.contactsImported > 0
                        ? `${result.data.contactsImported} network contact(s) imported.`
                        : undefined,
                  },
                );
                setOpen(false);
                setTitle('');
                router.refresh();
              } else {
                toast.error(result.error?.message ?? 'Upload failed');
              }
            });
          }}
        >
          <div className="space-y-4">
            <Field label="Type" htmlFor="doc-type">
              <Select
                id="doc-type"
                name="doc_type"
                value={docType}
                onChange={(e) => setDocType(e.target.value as KnowledgeDocType)}
              >
                {DOC_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Title" htmlFor="doc-title" hint="Optional. Defaults to the filename.">
              <Input
                id="doc-title"
                name="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </Field>
            <Field
              label="File"
              htmlFor="doc-file"
              hint="PDF, DOCX, PPTX, TXT, Markdown, CSV, HTML or an image."
            >
              <Input
                id="doc-file"
                name="file"
                type="file"
                required
                accept=".pdf,.docx,.pptx,.txt,.md,.csv,.html,.png,.jpg,.jpeg,.gif,.webp"
                className="py-1.5 file:mr-2 file:rounded file:border-0 file:bg-[var(--bg-hover)] file:px-2 file:py-1 file:text-xs"
              />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={pending}>
              Upload
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ImportNetworkButton() {
  const [open, setOpen] = React.useState(false);
  const [csv, setCsv] = React.useState('');
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm">
          Import contacts
        </Button>
      </DialogTrigger>
      <DialogContent
        title="Import network contacts"
        description="Introduction suggestions can only name someone who exists in this list. Nothing is inferred."
      >
        <Field
          label="CSV"
          htmlFor="net-csv"
          hint="Recognised columns: full_name, email, company, title, relationship, expertise, geography, notes."
        >
          <Textarea
            id="net-csv"
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            rows={10}
            className="font-mono text-xs"
            placeholder={
              'full_name,email,company,title,relationship,expertise\nJane Doe,jane@acme.demo,Acme,VP Eng,Operator,"hiring,engineering"'
            }
          />
        </Field>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={!csv.trim()}
            onClick={() =>
              startTransition(async () => {
                const result = await importNetworkCsvAction(csv);
                if (result.ok && result.data) {
                  toast.success(
                    `Imported ${result.data.imported}, skipped ${result.data.skipped} duplicate(s)`,
                  );
                  setOpen(false);
                  setCsv('');
                  router.refresh();
                } else {
                  toast.error(result.error?.message ?? 'Import failed');
                }
              })
            }
          >
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteDocumentButton({ documentId, title }: { documentId: string; title: string }) {
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={`Delete ${title}`}>
          <Trash2 aria-hidden="true" />
        </Button>
      </DialogTrigger>
      <DialogContent
        title="Delete this document?"
        description="The file, its extracted text and its searchable passages are removed. This cannot be undone."
      >
        <p className="text-sm">{title}</p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await deleteDocumentAction(documentId);
                if (result.ok) {
                  toast.success('Document deleted');
                  setOpen(false);
                  router.refresh();
                } else {
                  toast.error(result.error?.message ?? 'Could not delete');
                }
              })
            }
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
