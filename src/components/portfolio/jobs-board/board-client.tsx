'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Check, Copy, EyeOff, Pencil, Plus, RefreshCw, Star, Upload } from 'lucide-react';
import {
  featureJobAction,
  hideJobAction,
  publishJobAction,
  refreshJobBoardsAction,
  saveJobAction,
  saveJobBoardTextAction,
  saveJobCompanyAction,
  setJobBoardEnabledAction,
  setJobOpenAction,
} from '@/app/actions/jobs-board';
import type { ActionResult } from '@/app/actions';
import {
  EMPLOYMENT_TYPES,
  EMPLOYMENT_TYPE_LABELS,
  JOB_FUNCTION_LABELS,
  SENIORITIES,
  SENIORITY_LABELS,
} from '@/lib/jobs-board/fields';
import { JOB_FUNCTIONS } from '@/lib/portfolio/job-taxonomy';
import type { JobPosting } from '@/lib/types/domain';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from '@/components/ui/dialog';
import { Field, Input, Select, Switch, Textarea } from '@/components/ui/form';

/**
 * The public job board's controls on Portfolio > Jobs: the board's switch,
 * its link, and each role's and company's buttons. Every change goes through
 * a server action, then the page is refreshed from the server.
 */

function useAction() {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  const run = React.useCallback(
    <T,>(
      work: () => Promise<ActionResult<T>>,
      success: string | ((data: T | undefined) => string),
      after?: () => void,
    ) => {
      start(async () => {
        const result = await work();
        if (result.ok) {
          toast.success(typeof success === 'function' ? success(result.data) : success);
          after?.();
          router.refresh();
        } else {
          toast.error(result.error?.message ?? 'That did not work. Nothing was changed.');
        }
      });
    },
    [router],
  );
  return { pending, run };
}

/* ----------------------------------------------------------- the board -- */

export function BoardSwitch({ enabled }: { enabled: boolean }) {
  const { pending, run } = useAction();
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium">
      <Switch
        checked={enabled}
        disabled={pending}
        aria-label="Public board on"
        onCheckedChange={(on) =>
          run(
            () => setJobBoardEnabledAction(on),
            on
              ? 'The public board is on: visitors see the published roles.'
              : 'The public board is off: visitors see "coming soon".',
          )
        }
      />
      {enabled ? 'On' : 'Off'}
    </label>
  );
}

export function CopyBoardLink({ href }: { href: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={async () => {
        const url = new URL(href, window.location.origin).toString();
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          toast.success('Board link copied');
          window.setTimeout(() => setCopied(false), 2000);
        } catch {
          window.prompt('Copy the board link', url);
        }
      }}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {copied ? 'Copied' : 'Copy link'}
    </Button>
  );
}

export function BoardTextButton({
  title,
  intro,
  accent,
}: {
  title: string;
  intro: string;
  accent: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [t, setT] = React.useState(title);
  const [i, setI] = React.useState(intro);
  const [a, setA] = React.useState(accent);
  const { pending, run } = useAction();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost">
          <Pencil aria-hidden="true" />
          Board text
        </Button>
      </DialogTrigger>
      <DialogContent
        title="The board's text"
        description="What visitors read at the top of the public board."
      >
        <div className="space-y-4">
          <Field label="Title" htmlFor="jb-title">
            <Input id="jb-title" value={t} maxLength={120} onChange={(e) => setT(e.target.value)} />
          </Field>
          <Field
            label="Intro"
            htmlFor="jb-intro"
            hint="One or two sentences. Leave empty for the default."
          >
            <Textarea
              id="jb-intro"
              value={i}
              maxLength={600}
              onChange={(e) => setI(e.target.value)}
            />
          </Field>
          <Field
            label="Accent colour"
            htmlFor="jb-accent"
            hint="A colour like #0FC382 (TipTop green)."
          >
            <Input id="jb-accent" value={a} maxLength={7} onChange={(e) => setA(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button
            variant="primary"
            disabled={pending}
            onClick={() =>
              run(
                () => saveJobBoardTextAction({ title: t, intro: i, accent: a }),
                'Board text saved',
                () => setOpen(false),
              )
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RefreshButton({ companyId, label }: { companyId?: string; label: string }) {
  const { pending, run } = useAction();
  return (
    <Button
      size="sm"
      variant="secondary"
      disabled={pending}
      onClick={() =>
        run(
          () => refreshJobBoardsAction(companyId),
          (data) => {
            const results = data?.results ?? [];
            const added = results.reduce((n, r) => n + r.added, 0);
            const failed = results.filter((r) => r.status === 'failed').length;
            const drafts = data?.imported?.added ?? 0;
            const parts = [
              results.length === 0
                ? 'No company has a job board to read yet'
                : `Read ${results.length} ${results.length === 1 ? 'board' : 'boards'}: ${added} new ${added === 1 ? 'role' : 'roles'}`,
            ];
            if (failed) parts.push(`${failed} could not be read (see Companies)`);
            if (drafts)
              parts.push(`${drafts} emailed ${drafts === 1 ? 'role' : 'roles'} to approve`);
            return parts.join('; ');
          },
        )
      }
    >
      <RefreshCw aria-hidden="true" className={pending ? 'animate-spin' : undefined} />
      {pending ? 'Reading…' : label}
    </Button>
  );
}

/* ------------------------------------------------------------- a role -- */

export function RoleActions({
  id,
  title,
  isPublic,
  hidden,
  closed,
  featured,
  source,
  approveLabel = 'Publish',
}: {
  id: string;
  title: string;
  isPublic: boolean;
  hidden: boolean;
  closed: boolean;
  featured: boolean;
  source: JobPosting['source'];
  approveLabel?: string;
}) {
  const { pending, run } = useAction();
  return (
    <span className="flex flex-wrap items-center gap-2">
      {!isPublic && !closed ? (
        <Button
          size="sm"
          variant="primary"
          disabled={pending}
          aria-label={`${approveLabel}: ${title}`}
          onClick={() => run(() => publishJobAction(id), `${title} is on the public board`)}
        >
          <Upload aria-hidden="true" />
          {approveLabel}
        </Button>
      ) : null}
      {!hidden ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          aria-label={`Hide: ${title}`}
          onClick={() => run(() => hideJobAction(id), `${title} is hidden from the board`)}
        >
          <EyeOff aria-hidden="true" />
          {source === 'email' && !isPublic ? 'Dismiss' : 'Hide'}
        </Button>
      ) : null}
      {isPublic ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          aria-pressed={featured}
          aria-label={`${featured ? 'Unfeature' : 'Feature'}: ${title}`}
          onClick={() =>
            run(
              () => featureJobAction(id, !featured),
              featured ? `${title} is no longer featured` : `${title} is featured`,
            )
          }
        >
          <Star aria-hidden="true" className={featured ? 'fill-current' : undefined} />
          {featured ? 'Featured' : 'Feature'}
        </Button>
      ) : null}
      {source !== 'ats' ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          aria-label={`${closed ? 'Reopen' : 'Mark filled'}: ${title}`}
          onClick={() =>
            run(
              () => setJobOpenAction(id, closed),
              closed ? `${title} is open again` : `${title} is closed`,
            )
          }
        >
          {closed ? 'Reopen' : 'Mark filled'}
        </Button>
      ) : null}
    </span>
  );
}

export interface CompanyOption {
  id: string;
  name: string;
}

function remoteValue(p?: JobPosting | null) {
  return p?.remote ?? '';
}

export function RoleEditorButton({
  companies,
  posting,
}: {
  companies: CompanyOption[];
  /** Editing this role; adding a new one when absent. */
  posting?: JobPosting;
}) {
  const editing = Boolean(posting);
  const [open, setOpen] = React.useState(false);
  const [companyId, setCompanyId] = React.useState(
    posting?.portfolio_company_id ?? companies[0]?.id ?? '',
  );
  const [title, setTitle] = React.useState(posting?.title ?? '');
  const [team, setTeam] = React.useState(posting?.team ?? '');
  const [fn, setFn] = React.useState(posting?.job_function ?? '');
  const [locations, setLocations] = React.useState((posting?.locations ?? []).join(', '));
  const [remote, setRemote] = React.useState<string>(remoteValue(posting));
  const [type, setType] = React.useState<string>(posting?.employment_type ?? 'full_time');
  const [level, setLevel] = React.useState<string>(posting?.seniority ?? '');
  const [comp, setComp] = React.useState(posting?.comp ?? '');
  const [applyUrl, setApplyUrl] = React.useState(posting?.apply_url ?? '');
  const [description, setDescription] = React.useState(posting?.description ?? '');
  const { pending, run } = useAction();
  const prefix = posting ? `edit-${posting.id.slice(0, 8)}` : 'add';

  const save = (publish: boolean) =>
    run(
      () =>
        saveJobAction(
          {
            portfolioCompanyId: companyId,
            title,
            team,
            fn,
            locations,
            remote,
            employmentType: type,
            seniority: level,
            comp,
            applyUrl,
            description,
            publish,
          },
          posting?.id,
        ),
      editing
        ? 'Role saved'
        : publish
          ? `${title} is on the public board`
          : `${title} saved, not public yet`,
      () => setOpen(false),
    );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {editing ? (
          <Button size="sm" variant="ghost" aria-label={`Edit: ${posting?.title}`}>
            <Pencil aria-hidden="true" />
            Edit
          </Button>
        ) : (
          <Button size="sm" variant="primary">
            <Plus aria-hidden="true" />
            Add a role
          </Button>
        )}
      </DialogTrigger>
      <DialogContent
        title={editing ? 'Edit the role' : 'Add a role'}
        description="Everything here can appear on the public board. No contact details or private notes."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {!editing ? (
            <Field label="Company" htmlFor={`${prefix}-company`} className="sm:col-span-2">
              <Select
                id={`${prefix}-company`}
                value={companyId}
                onChange={(e) => setCompanyId(e.target.value)}
              >
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field label="Title" htmlFor={`${prefix}-title`} className="sm:col-span-2">
            <Input
              id={`${prefix}-title`}
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Field
            label="Apply link"
            htmlFor={`${prefix}-apply`}
            className="sm:col-span-2"
            hint="Where people apply: the company's own job page."
          >
            <Input
              id={`${prefix}-apply`}
              value={applyUrl}
              placeholder="https://"
              onChange={(e) => setApplyUrl(e.target.value)}
            />
          </Field>
          <Field label="Team" htmlFor={`${prefix}-fn`}>
            <Select id={`${prefix}-fn`} value={fn} onChange={(e) => setFn(e.target.value)}>
              <option value="">Read from the title</option>
              {JOB_FUNCTIONS.map((f) => (
                <option key={f} value={f}>
                  {JOB_FUNCTION_LABELS[f]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Team name (optional)" htmlFor={`${prefix}-team`}>
            <Input
              id={`${prefix}-team`}
              value={team}
              maxLength={120}
              onChange={(e) => setTeam(e.target.value)}
            />
          </Field>
          <Field
            label="Places"
            htmlFor={`${prefix}-places`}
            hint="Separate places with ; e.g. Austin, TX; Remote"
          >
            <Input
              id={`${prefix}-places`}
              value={locations}
              onChange={(e) => setLocations(e.target.value)}
            />
          </Field>
          <Field label="Remote or on-site" htmlFor={`${prefix}-remote`}>
            <Select
              id={`${prefix}-remote`}
              value={remote}
              onChange={(e) => setRemote(e.target.value)}
            >
              <option value="">Not said</option>
              <option value="remote">Remote</option>
              <option value="hybrid">Hybrid</option>
              <option value="onsite">On-site</option>
            </Select>
          </Field>
          <Field label="Type" htmlFor={`${prefix}-type`}>
            <Select id={`${prefix}-type`} value={type} onChange={(e) => setType(e.target.value)}>
              {EMPLOYMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {EMPLOYMENT_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Level" htmlFor={`${prefix}-level`}>
            <Select id={`${prefix}-level`} value={level} onChange={(e) => setLevel(e.target.value)}>
              <option value="">Read from the title</option>
              {SENIORITIES.map((s) => (
                <option key={s} value={s}>
                  {SENIORITY_LABELS[s]}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Pay (optional)"
            htmlFor={`${prefix}-comp`}
            className="sm:col-span-2"
            hint="Only if the company shares it publicly."
          >
            <Input
              id={`${prefix}-comp`}
              value={comp}
              maxLength={160}
              onChange={(e) => setComp(e.target.value)}
            />
          </Field>
          <Field
            label="Description (optional)"
            htmlFor={`${prefix}-desc`}
            className="sm:col-span-2"
            hint='Plain text. Start a line with "## " for a heading and "- " for a bullet.'
          >
            <Textarea
              id={`${prefix}-desc`}
              value={description}
              rows={6}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>
        <DialogFooter>
          {editing ? (
            <Button
              variant="primary"
              disabled={pending || !title.trim()}
              onClick={() => save(false)}
            >
              Save
            </Button>
          ) : (
            <>
              <Button
                variant="secondary"
                disabled={pending || !title.trim()}
                onClick={() => save(false)}
              >
                Save, not public yet
              </Button>
              <Button
                variant="primary"
                disabled={pending || !title.trim()}
                onClick={() => save(true)}
              >
                Save and publish
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------------------------------------------------- a company -- */

export function CompanyJobsForm({
  companyId,
  companyName,
  careersUrl,
  hasBoard,
  syncEnabled,
  autoPublish,
  listed,
  logoUrl,
  about,
  aboutFallback,
}: {
  companyId: string;
  companyName: string;
  careersUrl: string;
  hasBoard: boolean;
  syncEnabled: boolean;
  autoPublish: boolean;
  listed: boolean;
  logoUrl: string;
  about: string;
  aboutFallback: string;
}) {
  const [url, setUrl] = React.useState(careersUrl);
  const [logo, setLogo] = React.useState(logoUrl);
  const [text, setText] = React.useState(about);
  const { pending, run } = useAction();
  const id = companyId.slice(0, 8);

  const save = (input: Parameters<typeof saveJobCompanyAction>[1], message: string) =>
    run(
      () => saveJobCompanyAction(companyId, input),
      (data) =>
        data?.note ??
        (data?.changedRoles ? `${message} (${data.changedRoles} roles changed)` : message),
    );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Careers page" htmlFor={`co-${id}-url`} className="min-w-0 flex-1">
          <Input
            id={`co-${id}-url`}
            value={url}
            placeholder="https://jobs.lever.co/company or the company's /careers page"
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        <Button
          size="sm"
          variant="secondary"
          disabled={pending || url.trim() === careersUrl}
          aria-label={`Save the careers page for ${companyName}`}
          onClick={() => save({ careersUrl: url }, 'Careers page saved')}
        >
          Save
        </Button>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <label className="inline-flex items-center gap-2">
          <Switch
            checked={syncEnabled}
            disabled={pending || !hasBoard}
            aria-label={`Read ${companyName}'s job board every day`}
            onCheckedChange={(on) =>
              save({ syncEnabled: on }, on ? 'Daily read on' : 'Daily read off')
            }
          />
          Read its job board every day
        </label>
        <label className="inline-flex items-center gap-2">
          <Switch
            checked={autoPublish}
            disabled={pending}
            aria-label={`Publish ${companyName}'s new roles on their own`}
            onCheckedChange={(on) =>
              save(
                { autoPublish: on },
                on
                  ? 'Its board roles now go public on their own'
                  : 'Its board roles wait for a person again',
              )
            }
          />
          Publish its board roles on their own
        </label>
        <label className="inline-flex items-center gap-2">
          <Switch
            checked={listed}
            disabled={pending}
            aria-label={`List ${companyName} on the board with no open roles`}
            onCheckedChange={(on) =>
              save({ listed: on }, on ? 'Listed on the board' : 'Shown only with open roles')
            }
          />
          List it even with no open roles
        </label>
      </div>
      <details>
        <summary className="cursor-pointer text-sm text-[var(--accent)]">
          Public logo and about
        </summary>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <Field
            label="Logo address"
            htmlFor={`co-${id}-logo`}
            hint="An https:// image. Empty: the first letter."
          >
            <Input
              id={`co-${id}-logo`}
              value={logo}
              placeholder="https://"
              onChange={(e) => setLogo(e.target.value)}
            />
          </Field>
          <Field
            label="About (public)"
            htmlFor={`co-${id}-about`}
            hint={
              aboutFallback
                ? `Empty: "${aboutFallback.slice(0, 80)}" from Portfolio.`
                : 'One or two sentences.'
            }
          >
            <Textarea
              id={`co-${id}-about`}
              value={text}
              rows={3}
              maxLength={600}
              onChange={(e) => setText(e.target.value)}
            />
          </Field>
          <div className="sm:col-span-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={pending}
              onClick={() => save({ logoUrl: logo, about: text }, 'Public details saved')}
            >
              Save public details
            </Button>
          </div>
        </div>
      </details>
    </div>
  );
}
