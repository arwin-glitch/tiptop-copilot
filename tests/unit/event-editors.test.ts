import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SharingPanel } from '@/components/events/sharing/sharing-panel';
import { ownerCapabilities } from '@/lib/events/capabilities';
import { DEMO_EVENT_IDS } from '@/lib/demo/events-fixtures';
import type { EventActor } from '@/lib/events/contracts';
import { claimGrant } from '@/lib/events/editor-auth';
import { parseEventDoc, type EventDoc } from '@/lib/events/schema';
import {
  createEditorLink,
  expiryFor,
  listEditorLinks,
  listEditorNotices,
  markReadyForReview,
  noticeSentence,
  regenerateEditorLink,
  revokeAllEditorLinks,
  revokeEditorLink,
  setEditingPaused,
  updateEditorLink,
} from '@/lib/services/event-editors';
import { listActivity, listPresence, syncStudio } from '@/lib/services/event-presence';
import { applyDraftOps, ownerActor, type EventOwner } from '@/lib/services/events';
import { computeEditorAlerts } from '@/lib/services/push-alerts';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * Outside links, the owners' side, plus what a grant may do to the draft,
 * presence and the sync read (D-075). Fictional people only.
 */

let h: Harness;
let owner: EventOwner;
const EVENT = DEMO_EVENT_IDS.annualMeeting;
const IP = '203.0.113.20';

beforeEach(async () => {
  h = await createHarness();
  owner = { userId: h.auth.userId, organizationId: h.auth.organizationId, name: 'Demo Owner' };
});

afterEach(async () => {
  await h.dispose();
});

async function draft(): Promise<{ doc: EventDoc; version: number }> {
  const event = await h.store.get('events', owner.organizationId, EVENT);
  const parsed = parseEventDoc(event!.draft_doc);
  if (!parsed.ok) throw new Error('bad doc');
  return { doc: parsed.value, version: event!.draft_version };
}

async function grantActor(
  input: Parameters<typeof createEditorLink>[3],
): Promise<{ actor: EventActor; linkId: string }> {
  const issued = await createEditorLink(h.store, owner, EVENT, input);
  if (!issued.ok) throw new Error(issued.error.message);
  const secret = issued.value.path.split('#k=')[1]!;
  const claimed = await claimGrant(h.store, { token: secret, ip: IP, userAgent: 'test' });
  if (!claimed.ok) throw new Error('claim');
  return {
    actor: { kind: 'grant', grant: claimed.value.grant, name: claimed.value.grant.label },
    linkId: issued.value.link.id,
  };
}

describe('creating and listing links', () => {
  it('lists links without hashes and with a status', async () => {
    await createEditorLink(h.store, owner, EVENT, {
      label: 'Morgan – Example Partners',
      role: 'editor',
    });
    const listed = await listEditorLinks(h.store, owner.organizationId, EVENT);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const morgan = listed.value.find((l) => l.label === 'Morgan – Example Partners');
    expect(morgan).toMatchObject({ role: 'editor', status: 'unused', useCount: 0 });
    expect(JSON.stringify(listed.value)).not.toMatch(/token_hash|[0-9a-f]{64}/);
  });

  it('cleans scopes: viewers never edit, sections must exist, editors need something to do', async () => {
    const { doc } = await draft();
    const viewer = await createEditorLink(h.store, owner, EVENT, {
      label: 'Partner preview',
      role: 'viewer',
      scope: { design: true, content: true },
    });
    expect(viewer.ok && viewer.value.link.scope).toMatchObject({ design: false, content: false });
    const chosen = await createEditorLink(h.store, owner, EVENT, {
      label: 'Agenda only',
      role: 'editor',
      scope: {
        content: true,
        sections: [doc.sections[2]!.id, '0f000000-0000-4000-8000-00000000dead'],
      },
    });
    expect(chosen.ok && chosen.value.link.scope.sections).toEqual([doc.sections[2]!.id]);
    const none = await createEditorLink(h.store, owner, EVENT, {
      label: 'Nothing',
      role: 'editor',
      scope: { content: true, sections: ['0f000000-0000-4000-8000-00000000dead'] },
    });
    expect(none.ok).toBe(false);
    const idle = await createEditorLink(h.store, owner, EVENT, {
      label: 'Idle',
      role: 'editor',
      scope: { content: false, design: false },
    });
    expect(idle.ok).toBe(false);
    const noLabel = await createEditorLink(h.store, owner, EVENT, { label: '  ', role: 'editor' });
    expect(noLabel.ok).toBe(false);
  });

  it('expires in 3/7/14/30/90 days or two days after the event, never past 90', () => {
    const now = Date.parse('2030-01-01T12:00:00Z');
    const day = 86_400_000;
    expect(expiryFor(undefined, { starts_at: null, ends_at: null }, now)).toEqual({
      ok: true,
      value: new Date(now + 14 * day).toISOString(),
    });
    expect(expiryFor({ days: 5 }, { starts_at: null, ends_at: null }, now).ok).toBe(false);
    expect(
      expiryFor({ eventEnd: true }, { starts_at: null, ends_at: '2030-01-10T00:00:00Z' }, now),
    ).toEqual({
      ok: true,
      value: '2030-01-12T00:00:00.000Z',
    });
    const far = expiryFor(
      { eventEnd: true },
      { starts_at: null, ends_at: '2031-01-01T00:00:00Z' },
      now,
    );
    expect(far.ok && far.value).toBe(new Date(now + 90 * day).toISOString());
    expect(expiryFor({ eventEnd: true }, { starts_at: null, ends_at: null }, now).ok).toBe(false);
    expect(
      expiryFor({ eventEnd: true }, { starts_at: null, ends_at: '2029-12-01T00:00:00Z' }, now).ok,
    ).toBe(false);
  });
});

describe('changing links', () => {
  it('extends, renames and rescopes; refuses changes to a revoked link', async () => {
    const issued = await createEditorLink(h.store, owner, EVENT, {
      label: 'Morgan',
      role: 'editor',
    });
    if (!issued.ok) throw new Error('create');
    const id = issued.value.link.id;
    const updated = await updateEditorLink(h.store, owner, EVENT, id, {
      label: 'Morgan – Example Partners',
      scope: { design: true },
      expiry: { days: 30 },
    });
    expect(updated.ok && updated.value).toMatchObject({
      label: 'Morgan – Example Partners',
      scope: { design: true, content: true, sections: 'all', brand_locked: true },
    });
    await revokeEditorLink(h.store, owner, EVENT, id);
    const late = await updateEditorLink(h.store, owner, EVENT, id, { label: 'Again' });
    expect(late.ok).toBe(false);
    const regen = await regenerateEditorLink(h.store, owner, EVENT, id);
    expect(regen.ok).toBe(false);
  });

  it('regenerates with a bumped token version and a new hint', async () => {
    const issued = await createEditorLink(h.store, owner, EVENT, {
      label: 'Morgan',
      role: 'editor',
    });
    if (!issued.ok) throw new Error('create');
    const regen = await regenerateEditorLink(h.store, owner, EVENT, issued.value.link.id);
    expect(regen.ok).toBe(true);
    if (!regen.ok) return;
    expect(regen.value.path).not.toBe(issued.value.path);
    const row = await h.store.get('event_editors', owner.organizationId, issued.value.link.id);
    expect(row?.token_version).toBe(2);
    const audit = await h.store.list('audit_events', owner.organizationId, {
      eq: { action: 'event.editor_link_regenerated' },
    });
    expect(audit).toHaveLength(1);
  });

  it('revokes all links of the chosen roles only', async () => {
    await createEditorLink(h.store, owner, EVENT, { label: 'Editor one', role: 'editor' });
    await createEditorLink(h.store, owner, EVENT, { label: 'Viewer one', role: 'viewer' });
    await createEditorLink(h.store, owner, EVENT, { label: 'Door one', role: 'checkin' });
    const result = await revokeAllEditorLinks(h.store, owner, EVENT, ['editor', 'viewer']);
    expect(result.ok).toBe(true);
    const listed = await listEditorLinks(h.store, owner.organizationId, EVENT);
    const byLabel = Object.fromEntries(
      (listed.ok ? listed.value : []).map((l) => [l.label, l.status]),
    );
    expect(byLabel['Editor one']).toBe('revoked');
    expect(byLabel['Viewer one']).toBe('revoked');
    expect(byLabel['Door one']).toBe('unused');
  });

  it('pauses and resumes editing with an audit row each way', async () => {
    expect(await setEditingPaused(h.store, owner, EVENT, true)).toEqual({
      ok: true,
      value: { editingPaused: true },
    });
    await setEditingPaused(h.store, owner, EVENT, false);
    const actions = (
      await h.store.list('audit_events', owner.organizationId, { eq: { entity_id: EVENT } })
    ).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(['event.editing_paused', 'event.editing_resumed']),
    );
  });
});

describe('what a grant may do to the draft', () => {
  it('content-only editors change words in scope, never style, visibility or other sections', async () => {
    const { doc } = await draft();
    const agenda = doc.sections[2]!;
    const faq = doc.sections[5]!;
    const { actor } = await grantActor({
      label: 'Agenda helper',
      role: 'editor',
      scope: { content: true, design: false, sections: [agenda.id] },
    });
    const result = await applyDraftOps(h.store, actor, EVENT, {
      baseVersion: 0,
      ops: [
        {
          kind: 'section.update',
          opId: 'ok',
          id: agenda.id,
          baseRev: agenda.rev,
          set: { 'props.heading': 'Our day' },
        },
        {
          kind: 'section.update',
          opId: 'style',
          id: agenda.id,
          baseRev: agenda.rev,
          set: { style: { ...agenda.style, padding: 'xl' } },
        },
        {
          kind: 'section.update',
          opId: 'gate',
          id: agenda.id,
          baseRev: agenda.rev,
          set: { visibility: { mode: 'going', tags: [] } },
        },
        {
          kind: 'section.update',
          opId: 'other',
          id: faq.id,
          baseRev: faq.rev,
          set: { 'props.heading': 'Nope' },
        },
        { kind: 'section.delete', opId: 'del', id: agenda.id, baseRev: agenda.rev },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied).toEqual(['ok']);
    expect(Object.fromEntries(result.value.conflicts.map((c) => [c.opId, c.message]))).toEqual({
      style: 'Outside your scope',
      gate: 'Only TipTop can change this',
      other: 'Outside your scope',
      del: 'Outside your scope',
    });
    const activity = await listActivity(h.store, owner.organizationId, EVENT, {
      sectionId: agenda.id,
    });
    expect(activity.ok && activity.value[0]).toMatchObject({
      authorName: 'Agenda helper',
      outside: true,
    });
  });

  it('refuses every op while editing is paused', async () => {
    const { doc } = await draft();
    const { actor } = await grantActor({ label: 'Writer', role: 'editor' });
    await setEditingPaused(h.store, owner, EVENT, true);
    const s = doc.sections[0]!;
    const r = await applyDraftOps(h.store, actor, EVENT, {
      baseVersion: 0,
      ops: [
        {
          kind: 'section.update',
          opId: 'x',
          id: s.id,
          baseRev: s.rev,
          set: { 'props.headline': 'Hi' },
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
  });

  it('viewer links read the draft and change nothing', async () => {
    const { doc } = await draft();
    const { actor } = await grantActor({ label: 'Partner preview', role: 'viewer' });
    const s = doc.sections[0]!;
    const r = await applyDraftOps(h.store, actor, EVENT, {
      baseVersion: 0,
      ops: [
        {
          kind: 'section.update',
          opId: 'x',
          id: s.id,
          baseRev: s.rev,
          set: { 'props.headline': 'Hi' },
        },
      ],
    });
    expect(r.ok && r.value.applied).toEqual([]);
  });
});

describe('presence and sync', () => {
  it('upserts presence on each poll and returns changes, deletions and who is here', async () => {
    const { doc, version } = await draft();
    const me = ownerActor(owner);
    const { actor: morgan } = await grantActor({
      label: 'Morgan – Example Partners',
      role: 'editor',
      scope: { design: true, content: true },
    });
    const first = await syncStudio(h.store, me, EVENT, 0, {
      focusedSectionId: doc.sections[0]!.id,
      typing: false,
    });
    // Studio starts from the page's own snapshot, so nothing is resent.
    expect(first.ok && first.value.full).toBeNull();
    const ahead = await syncStudio(h.store, me, EVENT, version + 5, null);
    expect(ahead.ok && ahead.value.full).not.toBeNull();
    await syncStudio(h.store, morgan, EVENT, version, {
      focusedSectionId: doc.sections[1]!.id,
      typing: true,
    });

    const hero = doc.sections[0]!;
    await applyDraftOps(h.store, morgan, EVENT, {
      baseVersion: version,
      ops: [
        {
          kind: 'section.update',
          opId: 'h',
          id: hero.id,
          baseRev: hero.rev,
          set: { 'props.headline': 'Welcome' },
        },
        {
          kind: 'section.delete',
          opId: 'd',
          id: doc.sections[5]!.id,
          baseRev: doc.sections[5]!.rev,
        },
      ],
    });
    const next = await syncStudio(h.store, me, EVENT, version, {
      focusedSectionId: null,
      typing: false,
    });
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.value.full).toBeNull();
    expect(next.value.version).toBe(version + 1);
    expect(next.value.changes.sections.map((s) => s.id)).toEqual([hero.id]);
    expect(next.value.changes.deletedSectionIds).toEqual([doc.sections[5]!.id]);
    const morganHere = next.value.presence.find((p) => p.outside);
    expect(morganHere).toMatchObject({
      name: 'Morgan – Example Partners',
      focusedSectionId: doc.sections[1]!.id,
      typing: true,
      active: true,
    });
    const stale = await listPresence(h.store, owner.organizationId, EVENT, Date.now() + 61_000);
    expect(stale).toEqual([]);
  });

  it('a revoked link stops syncing on its next poll', async () => {
    const { actor, linkId } = await grantActor({ label: 'Temp', role: 'editor' });
    await revokeEditorLink(h.store, owner, EVENT, linkId);
    // The route re-resolves the cookie first; the service also refuses a grant for another event.
    const other = await syncStudio(h.store, actor, DEMO_EVENT_IDS.puttingNight, 0, null);
    expect(other.ok).toBe(false);
  });
});

describe('notices for owners', () => {
  it('records first opens, new devices and ready-for-review, and alerts once each', async () => {
    const issued = await createEditorLink(h.store, owner, EVENT, {
      label: 'Morgan – Example Partners',
      role: 'editor',
    });
    if (!issued.ok) throw new Error('create');
    const secret = issued.value.path.split('#k=')[1]!;
    const claimed = await claimGrant(h.store, { token: secret, ip: IP, userAgent: 'a' });
    await claimGrant(h.store, { token: secret, ip: '198.51.100.30', userAgent: 'a' });
    if (!claimed.ok) throw new Error('claim');
    const review = await markReadyForReview(h.store, claimed.value.grant, 'Sponsors are in');
    expect(review.ok).toBe(true);
    const notices = await listEditorNotices(h.store, owner.organizationId, { eventId: EVENT });
    expect(notices.ok).toBe(true);
    if (!notices.ok) return;
    expect(notices.value.map((n) => n.kind).sort()).toEqual([
      'first_claim',
      'new_device',
      'ready_for_review',
    ]);
    const ready = notices.value.find((n) => n.kind === 'ready_for_review')!;
    expect(noticeSentence(ready)).toBe(
      'Morgan – Example Partners marked Harborview Annual Meeting ready for review',
    );
    expect(ready.note).toBe('Sponsors are in');

    // Midday in the principal's zone, so not in quiet hours.
    const noon = new Date(Date.parse(ready.at));
    noon.setUTCHours(18, 0, 0, 0);
    const shifted = notices.value.map((n) => ({
      ...n,
      at: new Date(noon.getTime() - 60_000).toISOString(),
    }));
    const alerts = computeEditorAlerts(shifted, new Set(), noon, 'America/Chicago');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ tag: 'event-editors', url: `/events/${EVENT}?tab=sharing` });
    expect(alerts[0]!.keys).toHaveLength(3);
    expect(computeEditorAlerts(shifted, new Set(alerts[0]!.keys), noon, 'America/Chicago')).toEqual(
      [],
    );
  });
});

describe('the Sharing panel', () => {
  it('renders links, staff links, notices and the share kit without any hash or secret', async () => {
    const issued = await createEditorLink(h.store, owner, EVENT, {
      label: 'Morgan – Example Partners',
      role: 'editor',
    });
    await createEditorLink(h.store, owner, EVENT, { label: 'Door volunteer', role: 'checkin' });
    if (!issued.ok) throw new Error('create');
    const secret = issued.value.path.split('#k=')[1]!;
    await claimGrant(h.store, { token: secret, ip: IP, userAgent: 'a' });
    const event = (await h.store.get('events', owner.organizationId, EVENT))!;
    const tree = await SharingPanel({
      event,
      sessions: [],
      viewer: {
        userId: owner.userId,
        organizationId: owner.organizationId,
        name: owner.name,
        timeZone: 'America/Chicago',
        capabilities: ownerCapabilities(),
      },
    });
    const html = renderToStaticMarkup(createElement('div', null, tree));
    expect(html).toContain('Outside editors');
    expect(html).toContain('Morgan – Example Partners');
    expect(html).toContain('Door volunteer');
    expect(html).toContain('opened their edit link');
    expect(html).toContain('/e/harborview-annual-meeting');
    const rows = await h.store.list('event_editors', owner.organizationId, {
      eq: { event_id: EVENT },
    });
    for (const row of rows) expect(html).not.toContain(row.token_hash);
    expect(html).not.toContain(secret);
  });
});
