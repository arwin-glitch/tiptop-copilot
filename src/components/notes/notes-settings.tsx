'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import { NOTES_API } from '@/lib/notes/api';
import {
  RECORDING_RULE_KINDS,
  TEMPLATE_LENGTHS,
  TEMPLATE_MEETING_TYPES,
  type CreateTemplateRequest,
  type FolderView,
  type MeetingVisibility,
  type NotesAccessResponse,
  type NotesPreferences,
  type RecipeView,
  type RecordingRuleKind,
  type RecordingRuleView,
  type TemplateLength,
  type TemplateMeetingType,
  type TemplateSection,
  type TemplateView,
  type VoiceConsentEvidence,
  type VoiceProfileView,
} from '@/lib/types/notes';
import { formatDate } from '@/lib/util/time';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Select, Switch, Textarea } from '@/components/ui/form';
import { notesCall, resetNotesAccess } from './api-client';

/**
 * Copilot Notes settings (D-076): the beta switch, templates, never-record
 * rules, voice consent, and folders and recipes. Each section saves through
 * its /api/notes route and shows the server's answer.
 */

/* ======================================================== beta switch == */

type Access = Omit<NotesAccessResponse, 'ok'>;

export function NotesBetaSwitch({ initial }: { initial: Access }) {
  const router = useRouter();
  const [access, setAccess] = React.useState(initial);
  const [saving, setSaving] = React.useState(false);
  const id = React.useId();
  if (access.mode === 'off') return null;
  const on = access.mode === 'on' || access.beta;
  return (
    <div className="flex items-start justify-between gap-4" data-notes-beta="">
      <label htmlFor={id} className="text-sm">
        <span className="font-medium">Copilot Notes (beta)</span>
        <span className="block text-[var(--fg-muted)]">
          {access.mode === 'on'
            ? 'On for everyone on this Copilot.'
            : 'Bot-free meeting notes: a live transcript with names, your own notes, and a summary to share. Off until you turn it on.'}
        </span>
      </label>
      <Switch
        id={id}
        checked={on}
        disabled={access.mode === 'on' || saving}
        onCheckedChange={async (enabled) => {
          setSaving(true);
          const res = await notesCall<Access>('POST', NOTES_API.beta, { enabled });
          setSaving(false);
          if (!res.ok) {
            toast.error(res.message);
            return;
          }
          resetNotesAccess();
          setAccess({ mode: res.mode, beta: res.beta, enabled: res.enabled });
          toast.success(res.enabled ? 'Copilot Notes is on.' : 'Copilot Notes is off.');
          router.refresh();
        }}
      />
    </div>
  );
}

/* ======================================================== preferences == */

/**
 * Who sees a meeting this person records, unless they change it on the
 * meeting: only them (the default), or the whole team. 'Your team' is also
 * what lets the cloud routines read their meetings through Copilot's tools.
 */
export function NotesPreferencesSettings({ initial }: { initial: NotesPreferences }) {
  const [visibility, setVisibility] = React.useState<MeetingVisibility>(initial.defaultVisibility);
  const [saving, setSaving] = React.useState(false);
  const id = React.useId();
  return (
    <div className="flex flex-wrap items-start justify-between gap-3" data-notes-preferences="">
      <label htmlFor={id} className="max-w-xl text-sm">
        <span className="font-medium">Who sees the meetings you record</span>
        <span className="block text-[var(--fg-muted)]">
          You can change it on any meeting. Your team also lets the cloud routines read them (never
          a private folder).
        </span>
      </label>
      <Select
        id={id}
        value={visibility}
        disabled={saving}
        onChange={async (e) => {
          const next = e.target.value as MeetingVisibility;
          const before = visibility;
          setVisibility(next);
          setSaving(true);
          const res = await notesCall<{ preferences: NotesPreferences }>(
            'POST',
            NOTES_API.preferences,
            { defaultVisibility: next },
          );
          setSaving(false);
          if (!res.ok) {
            setVisibility(before);
            toast.error(res.message);
            return;
          }
          setVisibility(res.preferences.defaultVisibility);
          toast.success(
            res.preferences.defaultVisibility === 'team'
              ? 'New meetings: your team can see them.'
              : 'New meetings: only you can see them.',
          );
        }}
        className="w-full sm:w-48"
      >
        <option value="private">Only you</option>
        <option value="team">Your team</option>
      </Select>
    </div>
  );
}

/* ========================================================== templates == */

const TYPE_WORDS: Record<TemplateMeetingType, string> = {
  pitch: 'Founder pitch',
  lp: 'LP call',
  portfolio: 'Portfolio',
  intro: 'Intro',
  internal: 'Internal',
  other: 'Other',
};

export function TemplatesSettings({ initial }: { initial: TemplateView[] }) {
  const [templates, setTemplates] = React.useState(initial);
  const [name, setName] = React.useState('');
  const [meetingType, setMeetingType] = React.useState<TemplateMeetingType>('other');
  const [length, setLength] = React.useState<TemplateLength>('standard');
  const [purpose, setPurpose] = React.useState('');
  const [sections, setSections] = React.useState<TemplateSection[]>([{ heading: '', prompt: '' }]);
  const [saving, setSaving] = React.useState(false);
  /** The custom template being edited; null while the form makes a new one. */
  const [editing, setEditing] = React.useState<string | null>(null);
  const ids = {
    name: React.useId(),
    type: React.useId(),
    length: React.useId(),
    purpose: React.useId(),
  };

  const save = async () => {
    const clean = sections.filter((s) => s.heading.trim());
    if (!name.trim() || clean.length === 0) {
      toast.error('Give the template a name and at least one section.');
      return;
    }
    setSaving(true);
    const body: CreateTemplateRequest = {
      name: name.trim(),
      meetingType,
      length,
      purpose: purpose.trim() || undefined,
      sections: clean.map((s) => ({ heading: s.heading.trim(), prompt: s.prompt.trim() })),
    };
    const res = editing
      ? await notesCall<{ template: TemplateView }>('PATCH', NOTES_API.template(editing), body)
      : await notesCall<{ template: TemplateView }>('POST', NOTES_API.templates, body);
    setSaving(false);
    if (!res.ok) {
      toast.error(res.message);
      return;
    }
    setTemplates((t) =>
      editing ? t.map((x) => (x.id === editing ? res.template : x)) : [...t, res.template],
    );
    clearForm();
    toast.success(`Template "${res.template.name}" saved.`);
  };

  const clearForm = () => {
    setEditing(null);
    setName('');
    setMeetingType('other');
    setLength('standard');
    setPurpose('');
    setSections([{ heading: '', prompt: '' }]);
  };

  const edit = (t: TemplateView) => {
    setEditing(t.id);
    setName(t.name);
    setMeetingType(t.meetingType);
    setLength(t.length);
    setPurpose(t.purpose);
    setSections(
      t.sections.length ? t.sections.map((x) => ({ ...x })) : [{ heading: '', prompt: '' }],
    );
  };

  const archive = async (t: TemplateView) => {
    const res = await notesCall('DELETE', NOTES_API.template(t.id));
    if (!res.ok) {
      toast.error(res.message);
      return;
    }
    setTemplates((all) => all.filter((x) => x.id !== t.id));
    if (editing === t.id) clearForm();
    toast.success(`Template "${t.name}" removed. Notes already written with it are kept.`);
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2" data-templates-settings="">
      <section aria-labelledby="templates-list">
        <h2 id="templates-list" className="font-serif text-base font-semibold">
          Templates
        </h2>
        <ul className="mt-2 divide-y divide-[var(--border)]">
          {templates.map((t) => (
            <li key={t.id} className="py-2.5">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {t.name}
                <Badge tone={t.isBuiltin ? 'outline' : 'accent'}>
                  {t.isBuiltin ? 'Built in' : 'Yours'}
                </Badge>
                <span className="text-xs font-normal text-[var(--fg-subtle)]">
                  {TYPE_WORDS[t.meetingType]} · {t.length}
                </span>
              </p>
              {t.purpose ? <p className="text-xs text-[var(--fg-muted)]">{t.purpose}</p> : null}
              <p className="mt-0.5 text-xs text-[var(--fg-subtle)]">
                {t.sections.map((s) => s.heading).join(' · ')}
              </p>
              {t.isBuiltin ? null : (
                <div className="mt-1.5 flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => edit(t)}
                    aria-label={`Edit ${t.name}`}
                  >
                    <Pencil aria-hidden /> Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void archive(t)}
                    aria-label={`Remove ${t.name}`}
                  >
                    <Trash2 aria-hidden /> Remove
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="templates-new" className="space-y-3">
        <h2 id="templates-new" className="font-serif text-base font-semibold">
          {editing ? 'Edit template' : 'New template'}
        </h2>
        <div>
          <label htmlFor={ids.name} className="text-sm font-medium">
            Name
          </label>
          <Input
            id={ids.name}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1"
            maxLength={120}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={ids.type} className="text-sm font-medium">
              Meeting type
            </label>
            <Select
              id={ids.type}
              value={meetingType}
              onChange={(e) => setMeetingType(e.target.value as TemplateMeetingType)}
              className="mt-1"
            >
              {TEMPLATE_MEETING_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_WORDS[t]}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor={ids.length} className="text-sm font-medium">
              Length
            </label>
            <Select
              id={ids.length}
              value={length}
              onChange={(e) => setLength(e.target.value as TemplateLength)}
              className="mt-1"
            >
              {TEMPLATE_LENGTHS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div>
          <label htmlFor={ids.purpose} className="text-sm font-medium">
            What it is for
          </label>
          <Input
            id={ids.purpose}
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            className="mt-1"
            maxLength={2000}
          />
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Sections</legend>
          {sections.map((s, i) => (
            <div key={i} className="flex flex-wrap gap-2">
              <Input
                aria-label={`Section ${i + 1} heading`}
                placeholder="Heading"
                value={s.heading}
                onChange={(e) =>
                  setSections((all) =>
                    all.map((x, j) => (j === i ? { ...x, heading: e.target.value } : x)),
                  )
                }
                className="min-w-0 flex-1 sm:max-w-[12rem]"
              />
              <Input
                aria-label={`Section ${i + 1}: what goes under it`}
                placeholder="What goes under it"
                value={s.prompt}
                onChange={(e) =>
                  setSections((all) =>
                    all.map((x, j) => (j === i ? { ...x, prompt: e.target.value } : x)),
                  )
                }
                className="min-w-0 flex-[2]"
              />
            </div>
          ))}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSections((all) => [...all, { heading: '', prompt: '' }])}
            disabled={sections.length >= 20}
          >
            <Plus aria-hidden /> Add a section
          </Button>
        </fieldset>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            {editing ? 'Save changes' : 'Save template'}
          </Button>
          {editing ? (
            <Button variant="ghost" onClick={clearForm}>
              Cancel
            </Button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

/* ===================================================== never-record == */

const KIND_WORDS: Record<RecordingRuleKind, { label: string; placeholder: string }> = {
  title: { label: 'A word in the title', placeholder: 'board session' },
  attendee_domain: { label: 'A guest from a domain', placeholder: 'example.com' },
  attendee_email: { label: 'A particular guest', placeholder: 'someone@example.com' },
  calendar_id: { label: 'A calendar', placeholder: 'calendar id' },
};

export function RulesSettings({
  initial,
  serverListCount = 0,
  demo = false,
}: {
  initial: RecordingRuleView[];
  /** Entries in the server's NOTES_NEVER_RECORD list (the names stay on the server). */
  serverListCount?: number;
  demo?: boolean;
}) {
  const [rules, setRules] = React.useState(initial);
  const [kind, setKind] = React.useState<RecordingRuleKind>('title');
  const [pattern, setPattern] = React.useState('');
  const [label, setLabel] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const ids = { kind: React.useId(), pattern: React.useId(), label: React.useId() };
  const own = rules.filter((r) => !r.isDefault);
  const defaults = rules.filter((r) => r.isDefault);

  const add = async () => {
    setSaving(true);
    const res = await notesCall<{ rule: RecordingRuleView }>('POST', NOTES_API.recordingRules, {
      kind,
      pattern: pattern.trim(),
      label: label.trim() || 'private',
    });
    setSaving(false);
    if (!res.ok) {
      toast.error(res.message);
      return;
    }
    setRules((all) => [res.rule, ...all]);
    setPattern('');
    setLabel('');
    toast.success('Rule added. Matching meetings cannot be recorded.');
  };

  const toggle = async (rule: RecordingRuleView, enabled: boolean) => {
    const res = await notesCall<{ rule: RecordingRuleView }>(
      'PATCH',
      NOTES_API.recordingRule(rule.id),
      {
        enabled,
      },
    );
    if (!res.ok) {
      toast.error(res.message);
      return;
    }
    setRules((all) => all.map((r) => (r.id === rule.id ? res.rule : r)));
  };

  const remove = async (rule: RecordingRuleView) => {
    const res = await notesCall('DELETE', NOTES_API.recordingRule(rule.id));
    if (!res.ok) {
      toast.error(res.message);
      return;
    }
    setRules((all) => all.filter((r) => r.id !== rule.id));
    toast.success('Rule deleted.');
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2" data-rules-settings="">
      <section aria-labelledby="rules-own" className="space-y-4">
        <div>
          <h2 id="rules-own" className="font-serif text-base font-semibold">
            Never record
          </h2>
          <p className="mt-1 text-sm text-[var(--fg-muted)]">
            A meeting that matches any rule cannot be recorded: Start is replaced by a note that it
            is on the list. Use these for legal, family and sister-company meetings.
          </p>
        </div>
        {serverListCount > 0 ? (
          <p className="text-sm text-[var(--fg-muted)]" data-server-rules={serverListCount}>
            {serverListCount === 1
              ? 'One more is on the server’s own list, which stays on the server.'
              : `${serverListCount} more are on the server’s own list, which stays on the server.`}
          </p>
        ) : null}
        {own.filter((r) => r.enabled).length === 0 && serverListCount === 0 && !demo ? (
          <p
            role="note"
            data-rules-needed=""
            className="rounded-md border border-[var(--warn)]/30 bg-[var(--warn-soft)] px-3 py-2.5 text-sm"
          >
            Recording does not start until there is at least one rule here (or on the server’s
            list). Add the companies that must never be recorded first.
          </p>
        ) : null}
        {own.length === 0 ? (
          <p className="rounded-md border border-dashed border-[var(--border-strong)] px-3 py-3 text-sm text-[var(--fg-muted)]">
            No rules of your own yet. The built-in ones still apply.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
            {own.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1 text-sm">
                  <p className="font-medium break-all">{r.pattern}</p>
                  <p className="text-xs text-[var(--fg-muted)]">
                    {KIND_WORDS[r.kind].label} · {r.label}
                  </p>
                </div>
                <Switch
                  checked={r.enabled}
                  onCheckedChange={(on) => void toggle(r, on)}
                  aria-label={`${r.enabled ? 'Turn off' : 'Turn on'} the rule for ${r.pattern}`}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Delete the rule for ${r.pattern}`}
                  onClick={() => void remove(r)}
                >
                  <Trash2 aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="space-y-3 rounded-md border border-[var(--border)] p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <p className="text-sm font-medium">Add a rule</p>
          <div>
            <label htmlFor={ids.kind} className="text-xs text-[var(--fg-muted)]">
              Match
            </label>
            <Select
              id={ids.kind}
              value={kind}
              onChange={(e) => setKind(e.target.value as RecordingRuleKind)}
              className="mt-1"
            >
              {RECORDING_RULE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_WORDS[k].label}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={ids.pattern} className="text-xs text-[var(--fg-muted)]">
                Matches
              </label>
              <Input
                id={ids.pattern}
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder={KIND_WORDS[kind].placeholder}
                className="mt-1"
                required
                minLength={2}
                maxLength={200}
              />
            </div>
            <div>
              <label htmlFor={ids.label} className="text-xs text-[var(--fg-muted)]">
                Why (shown when it blocks)
              </label>
              <Input
                id={ids.label}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="legal, family, sister company"
                className="mt-1"
                maxLength={60}
              />
            </div>
          </div>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={saving}
            disabled={pattern.trim().length < 2}
          >
            <Plus aria-hidden /> Add rule
          </Button>
        </form>
      </section>
      <section aria-labelledby="rules-defaults">
        <h2 id="rules-defaults" className="font-serif text-base font-semibold">
          Built in
        </h2>
        <p className="mt-1 text-sm text-[var(--fg-muted)]">
          Always on. Titles with these words are never recorded.
        </p>
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {defaults.map((r) => (
            <li key={r.id}>
              <Badge tone="outline" className="gap-1">
                <Lock className="size-3" aria-hidden /> {r.pattern}
                <span className="text-[var(--fg-subtle)]">({r.label})</span>
              </Badge>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/* ============================================================= voices == */

export function VoicesSettings({
  initial,
  consentText,
  ownEmail,
  ownName,
  timeZone,
}: {
  initial: VoiceProfileView[];
  consentText: string;
  ownEmail: string;
  ownName: string | null;
  timeZone: string;
}) {
  const [profiles, setProfiles] = React.useState(initial);
  const [agree, setAgree] = React.useState(false);
  const [email, setEmail] = React.useState('');
  const [name, setName] = React.useState('');
  const [evidence, setEvidence] =
    React.useState<Exclude<VoiceConsentEvidence, 'self_checkbox'>>('written');
  const [saving, setSaving] = React.useState(false);
  const ids = {
    agree: React.useId(),
    email: React.useId(),
    name: React.useId(),
    evidence: React.useId(),
  };
  const mine = profiles.find((p) => p.email === ownEmail.toLowerCase());
  const mineGranted = mine?.consentStatus === 'granted';

  const send = async (body: {
    action: 'grant' | 'revoke';
    email: string;
    name?: string | null;
    evidence?: VoiceConsentEvidence;
  }) => {
    setSaving(true);
    const res = await notesCall<{ profile: VoiceProfileView }>(
      'POST',
      NOTES_API.voiceProfiles,
      body,
    );
    setSaving(false);
    if (!res.ok) {
      toast.error(res.message);
      return false;
    }
    setProfiles((all) => [res.profile, ...all.filter((p) => p.email !== res.profile.email)]);
    toast.success(
      body.action === 'grant'
        ? 'Consent recorded.'
        : 'Consent withdrawn. Any voice identifier was deleted at once.',
    );
    return true;
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2" data-voices-settings="">
      <section aria-labelledby="voice-own" className="space-y-3">
        <h2 id="voice-own" className="font-serif text-base font-semibold">
          Your voice
        </h2>
        <p className="text-sm text-[var(--fg-muted)]">
          Optional. With your consent, Copilot can recognise your voice when you are not on your own
          mic (in a room, on someone else&rsquo;s laptop). Nothing is enrolled without it.
        </p>
        <blockquote className="rounded-md border-l-2 border-[var(--gold)] bg-[var(--note-soft)] px-3 py-2 text-sm">
          {consentText}
        </blockquote>
        {mineGranted ? (
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone="ok">Consent on file</Badge>
            <span className="text-xs text-[var(--fg-muted)]">
              {mine?.consentAt ? `since ${formatDate(mine.consentAt, timeZone)}` : ''}
              {mine?.enrolled ? ' · voice enrolled' : ' · not enrolled yet'}
            </span>
            <Button
              size="sm"
              variant="secondary"
              loading={saving}
              onClick={() => void send({ action: 'revoke', email: ownEmail })}
            >
              Withdraw consent
            </Button>
          </div>
        ) : (
          <>
            <label htmlFor={ids.agree} className="flex items-start gap-2 text-sm">
              <input
                id={ids.agree}
                type="checkbox"
                checked={agree}
                onChange={(e) => setAgree(e.target.checked)}
                className="mt-0.5 size-4 accent-[var(--accent)]"
              />
              I agree to the above.
            </label>
            <Button
              variant="primary"
              size="sm"
              disabled={!agree}
              loading={saving}
              onClick={async () => {
                if (
                  await send({
                    action: 'grant',
                    email: ownEmail,
                    name: ownName,
                    evidence: 'self_checkbox',
                  })
                )
                  setAgree(false);
              }}
            >
              Give consent
            </Button>
          </>
        )}
        <p className="text-xs text-[var(--fg-muted)]">
          A guest&rsquo;s voice is remembered during a live recording: open their name on their
          lines and tick &ldquo;Remember this voice&rdquo;. Enrolling your own voice from a solo
          clip is not in this version yet; your consent is kept for it. Identifiers are encrypted,
          never shared or exported, and deleted within a year of last use.
        </p>
      </section>

      <section aria-labelledby="voice-others" className="space-y-3">
        <h2 id="voice-others" className="font-serif text-base font-semibold">
          Someone else&rsquo;s voice
        </h2>
        <p className="text-sm text-[var(--fg-muted)]">
          Only with their consent in writing or a recorded yes. Record how they agreed.
        </p>
        <form
          className="space-y-3 rounded-md border border-[var(--border)] p-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              await send({
                action: 'grant',
                email: email.trim(),
                name: name.trim() || null,
                evidence,
              })
            ) {
              setEmail('');
              setName('');
            }
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={ids.name} className="text-xs text-[var(--fg-muted)]">
                Name
              </label>
              <Input
                id={ids.name}
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <label htmlFor={ids.email} className="text-xs text-[var(--fg-muted)]">
                Email
              </label>
              <Input
                id={ids.email}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1"
                required
              />
            </div>
          </div>
          <div>
            <label htmlFor={ids.evidence} className="text-xs text-[var(--fg-muted)]">
              How they agreed
            </label>
            <Select
              id={ids.evidence}
              value={evidence}
              onChange={(e) => setEvidence(e.target.value as 'written' | 'verbal_recorded')}
              className="mt-1"
            >
              <option value="written">In writing (email or a signed form)</option>
              <option value="verbal_recorded">A recorded yes</option>
            </Select>
          </div>
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            loading={saving}
            disabled={!email.trim()}
          >
            Record their consent
          </Button>
        </form>
        <ul className="divide-y divide-[var(--border)]">
          {profiles
            .filter((p) => p.email !== ownEmail.toLowerCase())
            .map((p) => (
              <li key={p.email} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{p.name ?? p.email}</span>
                  <span className="block text-xs text-[var(--fg-muted)]">
                    {p.consentStatus === 'granted' ? 'Consent on file' : 'Consent withdrawn'}
                    {p.enrolled ? ' · enrolled' : ''}
                  </span>
                </span>
                {p.consentStatus === 'granted' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void send({ action: 'revoke', email: p.email })}
                  >
                    Withdraw
                  </Button>
                ) : null}
              </li>
            ))}
        </ul>
      </section>
    </div>
  );
}

/* ================================================= folders, recipes == */

export function FoldersRecipesSettings({
  folders: initialFolders,
  recipes: initialRecipes,
}: {
  folders: FolderView[];
  recipes: RecipeView[];
}) {
  const [folders, setFolders] = React.useState(initialFolders);
  const [recipes, setRecipes] = React.useState(initialRecipes);
  const [folderName, setFolderName] = React.useState('');
  const [folderPrivate, setFolderPrivate] = React.useState(false);
  const [recipeName, setRecipeName] = React.useState('');
  const [recipePrompt, setRecipePrompt] = React.useState('');
  const ids = {
    folder: React.useId(),
    priv: React.useId(),
    recipe: React.useId(),
    prompt: React.useId(),
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section aria-labelledby="folders-heading" className="space-y-3">
        <h2 id="folders-heading" className="font-serif text-base font-semibold">
          Folders
        </h2>
        <ul className="divide-y divide-[var(--border)]">
          {folders.map((f) => (
            <li key={f.id} className="flex items-center gap-2 py-2 text-sm">
              <span className="font-medium">{f.name}</span>
              {f.isPrivate ? (
                <Badge tone="outline" className="gap-1">
                  <Lock className="size-3" aria-hidden /> Private
                </Badge>
              ) : null}
              <span className="ml-auto text-xs text-[var(--fg-subtle)]">
                {f.meetingCount} {f.meetingCount === 1 ? 'meeting' : 'meetings'}
              </span>
            </li>
          ))}
        </ul>
        <form
          className="space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const res = await notesCall<{ folder: FolderView }>('POST', NOTES_API.folders, {
              name: folderName.trim(),
              isPrivate: folderPrivate,
            });
            if (!res.ok) {
              toast.error(res.message);
              return;
            }
            setFolders((all) => [...all, res.folder]);
            setFolderName('');
            setFolderPrivate(false);
          }}
        >
          <label htmlFor={ids.folder} className="text-xs text-[var(--fg-muted)]">
            New folder
          </label>
          <Input
            id={ids.folder}
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
            required
            maxLength={120}
          />
          <label htmlFor={ids.priv} className="flex items-center gap-2 text-sm">
            <input
              id={ids.priv}
              type="checkbox"
              checked={folderPrivate}
              onChange={(e) => setFolderPrivate(e.target.checked)}
              className="size-4 accent-[var(--accent)]"
            />
            Private: its meetings stay private, and routines leave it out
          </label>
          <Button type="submit" size="sm" variant="secondary" disabled={!folderName.trim()}>
            Add folder
          </Button>
        </form>
      </section>
      <section aria-labelledby="recipes-heading" className="space-y-3">
        <h2 id="recipes-heading" className="font-serif text-base font-semibold">
          Recipes
        </h2>
        <p className="text-sm text-[var(--fg-muted)]">Saved questions, offered with / in Chat.</p>
        <ul className="divide-y divide-[var(--border)]">
          {recipes.map((r) => (
            <li key={r.id} className="py-2 text-sm">
              <span className="font-medium">{r.name}</span>
              <span className="block text-xs text-[var(--fg-muted)]">{r.prompt}</span>
            </li>
          ))}
        </ul>
        <form
          className="space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const res = await notesCall<{ recipe: RecipeView }>('POST', NOTES_API.recipes, {
              name: recipeName.trim(),
              prompt: recipePrompt.trim(),
            });
            if (!res.ok) {
              toast.error(res.message);
              return;
            }
            setRecipes((all) => [...all, res.recipe]);
            setRecipeName('');
            setRecipePrompt('');
          }}
        >
          <label htmlFor={ids.recipe} className="text-xs text-[var(--fg-muted)]">
            Name
          </label>
          <Input
            id={ids.recipe}
            value={recipeName}
            onChange={(e) => setRecipeName(e.target.value)}
            required
            maxLength={120}
          />
          <label htmlFor={ids.prompt} className="text-xs text-[var(--fg-muted)]">
            The question
          </label>
          <Textarea
            id={ids.prompt}
            value={recipePrompt}
            onChange={(e) => setRecipePrompt(e.target.value)}
            required
            maxLength={8000}
            className="min-h-20"
          />
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            disabled={!recipeName.trim() || !recipePrompt.trim()}
          >
            Save recipe
          </Button>
        </form>
      </section>
    </div>
  );
}
