import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_EVENT_IDS } from '@/lib/demo/events-fixtures';
import { ownerCapabilities } from '@/lib/events/capabilities';
import {
  CLAIM_LIMIT,
  GRANT_COOKIE,
  claimGrant,
  enforceOpScope,
  grantCookiePaths,
  grantCookies,
  hashGrantSecret,
  previewGrant,
  readGrantCookie,
  resolveGrant,
  resolveGrantSession,
} from '@/lib/events/editor-auth';
import { sectionTemplate } from '@/lib/events/doc';
import { parseEventDoc, type EventDoc } from '@/lib/events/schema';
import { signedValue } from '@/lib/security/crypto';
import { resetLimiters } from '@/lib/security/limits';
import {
  createEditorLink,
  regenerateEditorLink,
  revokeEditorLink,
  setEditingPaused,
} from '@/lib/services/event-editors';
import type { EventOwner } from '@/lib/services/events';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * Outside links (D-075): the claim, the path-scoped signed cookie and the
 * per-request re-check. Fictional people and addresses only.
 */

let h: Harness;
let owner: EventOwner;
const EVENT = DEMO_EVENT_IDS.annualMeeting;
const IP = '203.0.113.10';
const UA = 'Mozilla/5.0 (test)';

function secretOf(path: string): string {
  return path.split('#k=')[1] ?? '';
}

async function newLink(
  overrides: Parameters<typeof createEditorLink>[3] = {
    label: 'Morgan – Example Partners',
    role: 'editor',
  },
) {
  const issued = await createEditorLink(h.store, owner, EVENT, overrides);
  if (!issued.ok) throw new Error(issued.error.message);
  return { ...issued.value, secret: secretOf(issued.value.path) };
}

beforeEach(async () => {
  h = await createHarness();
  owner = { userId: h.auth.userId, organizationId: h.auth.organizationId, name: 'Demo Owner' };
});

afterEach(async () => {
  await h.dispose();
});

describe('the link secret', () => {
  it('is 256 random bits in the fragment, and only its hash is stored', async () => {
    const link = await newLink();
    expect(link.path.startsWith('/e/edit#k=')).toBe(true);
    expect(link.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await h.store.get('event_editors', owner.organizationId, link.link.id);
    expect(row?.token_hash).toBe(hashGrantSecret(link.secret));
    expect(row?.token_hint).toBe(link.secret.slice(-4));
    expect(JSON.stringify(row)).not.toContain(link.secret);
    expect(JSON.stringify(link.link)).not.toContain(row!.token_hash);
  });
});

describe('previewGrant', () => {
  it('says who the link is for without claiming it', async () => {
    const link = await newLink();
    const preview = await previewGrant(h.store, { token: link.secret, ip: IP });
    expect(preview.ok && preview.value).toMatchObject({
      eventId: EVENT,
      label: 'Morgan – Example Partners',
      role: 'editor',
    });
    const row = await h.store.get('event_editors', owner.organizationId, link.link.id);
    expect(row).toMatchObject({ use_count: 0, first_claimed_at: null });
  });

  it('answers a generic not_found for anything that is not a live link', async () => {
    for (const token of ['', 'short', 'x'.repeat(43), 'a'.repeat(44)]) {
      const r = await previewGrant(h.store, { token, ip: IP });
      expect(r.ok).toBe(false);
      if (!r.ok)
        expect(r.error).toMatchObject({ code: 'not_found', message: 'This link is not valid.' });
    }
  });
});

describe('claimGrant', () => {
  it('claims once per click: cookie, first-use bookkeeping and an audit row', async () => {
    const link = await newLink();
    const claimed = await claimGrant(h.store, { token: link.secret, ip: IP, userAgent: UA });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(claimed.value.grant).toMatchObject({ eventId: EVENT, role: 'editor', tokenVersion: 1 });
    expect(claimed.value.grant.capabilities).toMatchObject({
      actor: 'editor',
      editContent: true,
      editDesign: false,
      publish: false,
      manageGuests: false,
      manageSettings: false,
      share: false,
      restoreVersions: false,
    });
    expect(claimed.value.maxAgeSeconds).toBe(12 * 3600);
    const payload = readGrantCookie(claimed.value.cookieValue);
    expect(payload).toMatchObject({ g: link.link.id, e: EVENT, v: 1 });
    const row = await h.store.get('event_editors', owner.organizationId, link.link.id);
    expect(row?.use_count).toBe(1);
    expect(row?.first_claimed_at).not.toBeNull();
    expect(row?.last_ip_hash).not.toBe(IP);
    const audit = await h.store.list('audit_events', owner.organizationId, {
      eq: { action: 'event.editor_link_claimed', entity_id: EVENT },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({ first: true, newDevice: false });
  });

  it('flags use from a new address or browser after the first claim', async () => {
    const link = await newLink();
    await claimGrant(h.store, { token: link.secret, ip: IP, userAgent: UA });
    await claimGrant(h.store, { token: link.secret, ip: '198.51.100.7', userAgent: UA });
    const audit = await h.store.list(
      'audit_events',
      owner.organizationId,
      { eq: { action: 'event.editor_link_claimed' } },
      { orderBy: [{ field: 'created_at', direction: 'asc' }] },
    );
    expect(audit.map((a) => a.metadata.newDevice)).toEqual([false, true]);
  });

  it('never lets a session outlive the link', async () => {
    const link = await newLink({ label: 'Short stay', role: 'editor', expiry: { days: 3 } });
    const nearEnd = Date.parse(link.link.expiresAt) - 2 * 3600_000;
    const claimed = await claimGrant(h.store, {
      token: link.secret,
      ip: IP,
      userAgent: UA,
      now: nearEnd,
    });
    expect(claimed.ok && claimed.value.maxAgeSeconds).toBe(2 * 3600);
  });

  it('refuses revoked, expired and wrong-role links the same way', async () => {
    const revoked = await newLink({ label: 'Revoked', role: 'editor' });
    await revokeEditorLink(h.store, owner, EVENT, revoked.link.id);
    const staff = await newLink({ label: 'Door', role: 'checkin' });
    const expired = await newLink({ label: 'Old', role: 'editor', expiry: { days: 3 } });
    const later = Date.parse(expired.link.expiresAt) + 1000;
    const results = await Promise.all([
      claimGrant(h.store, { token: revoked.secret, ip: IP, userAgent: UA }),
      claimGrant(h.store, { token: staff.secret, ip: IP, userAgent: UA }),
      claimGrant(h.store, { token: expired.secret, ip: IP, userAgent: UA, now: later }),
    ]);
    for (const r of results) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toBe('This link is not valid.');
    }
    // The staff link claims at the staff entry.
    const atDoor = await claimGrant(h.store, {
      token: staff.secret,
      ip: IP,
      userAgent: UA,
      roles: ['checkin'],
    });
    expect(atDoor.ok).toBe(true);
  });

  it('brakes claims per address bucket', async () => {
    resetLimiters();
    const link = await newLink();
    for (let i = 0; i < CLAIM_LIMIT; i++) {
      const r = await claimGrant(h.store, { token: link.secret, ip: '192.0.2.44', userAgent: UA });
      expect(r.ok).toBe(true);
    }
    const blocked = await claimGrant(h.store, {
      token: link.secret,
      ip: '192.0.2.44',
      userAgent: UA,
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe('rate_limited');
    const elsewhere = await claimGrant(h.store, {
      token: link.secret,
      ip: '192.0.2.99',
      userAgent: UA,
    });
    expect(elsewhere.ok).toBe(true);
  });
});

describe('resolveGrant (every request)', () => {
  async function claimed(overrides?: Parameters<typeof createEditorLink>[3]) {
    const link = await newLink(overrides);
    const c = await claimGrant(h.store, { token: link.secret, ip: IP, userAgent: UA });
    if (!c.ok) throw new Error('claim failed');
    return { link, cookie: c.value.cookieValue };
  }

  it('resolves a live cookie for its own event only', async () => {
    const { cookie } = await claimed();
    const ok = await resolveGrant(h.store, { eventId: EVENT, cookieValue: cookie });
    expect(ok.ok).toBe(true);
    const other = await resolveGrant(h.store, {
      eventId: DEMO_EVENT_IDS.puttingNight,
      cookieValue: cookie,
    });
    expect(other.ok).toBe(false);
  });

  it('refuses a forged, tampered or expired cookie', async () => {
    const { cookie, link } = await claimed();
    const payload = readGrantCookie(cookie)!;
    const forged = Buffer.from(JSON.stringify({ ...payload, v: 2 })).toString('base64url');
    const tampered = `${forged}.${cookie.split('.')[1]}`;
    const expired = signedValue(JSON.stringify({ ...payload, x: Date.now() - 1 }));
    for (const value of [tampered, expired, 'garbage', '', undefined]) {
      const r = await resolveGrant(h.store, { eventId: EVENT, cookieValue: value });
      expect(r.ok).toBe(false);
    }
    expect(link.link.id).toBe(payload.g);
  });

  it('ends sessions on revoke and on regenerate (token version)', async () => {
    const { cookie, link } = await claimed();
    const regenerated = await regenerateEditorLink(h.store, owner, EVENT, link.link.id);
    expect(regenerated.ok).toBe(true);
    expect((await resolveGrant(h.store, { eventId: EVENT, cookieValue: cookie })).ok).toBe(false);
    // The old secret is dead, the new one claims.
    expect((await claimGrant(h.store, { token: link.secret, ip: IP, userAgent: UA })).ok).toBe(
      false,
    );
    const fresh = regenerated.ok ? secretOf(regenerated.value.path) : '';
    const again = await claimGrant(h.store, { token: fresh, ip: IP, userAgent: UA });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    await revokeEditorLink(h.store, owner, EVENT, link.link.id);
    expect(
      (await resolveGrant(h.store, { eventId: EVENT, cookieValue: again.value.cookieValue })).ok,
    ).toBe(false);
  });

  it('turns editing off while the event is paused, and brand locks bind', async () => {
    const { cookie } = await claimed({
      label: 'Designer',
      role: 'editor',
      scope: { design: true, content: true, brand_locked: true },
    });
    const live = await resolveGrant(h.store, { eventId: EVENT, cookieValue: cookie });
    expect(live.ok && live.value.capabilities.editDesign).toBe(true);
    expect(live.ok && live.value.capabilities.locks.palette).toBe(true);
    await setEditingPaused(h.store, owner, EVENT, true);
    const paused = await resolveGrant(h.store, { eventId: EVENT, cookieValue: cookie });
    expect(paused.ok && paused.value.capabilities).toMatchObject({
      viewDraft: true,
      editDesign: false,
      editContent: false,
      structure: false,
    });
  });

  it('re-issues the cookie when the sliding window runs low', async () => {
    const { cookie } = await claimed();
    const now = Date.now() + 11.5 * 3600_000;
    const session = await resolveGrantSession(h.store, {
      eventId: EVENT,
      cookieValue: cookie,
      now,
    });
    expect(session.ok && session.value.refresh).not.toBeNull();
    if (session.ok && session.value.refresh) {
      expect(readGrantCookie(session.value.refresh.value, now)!.x).toBeGreaterThan(
        readGrantCookie(cookie)!.x,
      );
    }
  });
});

describe('the cookie', () => {
  it('is httpOnly, SameSite=Strict and scoped by path to one event', () => {
    const cookies = grantCookies('editor', EVENT, 'value', 3600);
    expect(cookies.map((c) => c.options.path)).toEqual([
      `/e/edit/${EVENT}`,
      `/api/e/edit/${EVENT}`,
    ]);
    for (const c of cookies) {
      expect(c.name).toBe(GRANT_COOKIE);
      expect(c.options).toMatchObject({ httpOnly: true, sameSite: 'strict', maxAge: 3600 });
    }
    expect(grantCookiePaths('checkin', EVENT)).toEqual([
      `/e/checkin/${EVENT}`,
      `/api/e/checkin/${EVENT}`,
    ]);
  });
});

describe('enforceOpScope', () => {
  async function doc(): Promise<EventDoc> {
    const event = await h.store.get('events', owner.organizationId, EVENT);
    const parsed = parseEventDoc(event!.draft_doc);
    if (!parsed.ok) throw new Error('bad doc');
    return parsed.value;
  }

  it('lets owners do anything', async () => {
    const authorize = enforceOpScope(ownerCapabilities());
    const d = await doc();
    const s = d.sections[0]!;
    expect(
      authorize(
        {
          kind: 'section.update',
          opId: 'a',
          id: s.id,
          baseRev: 0,
          set: { visibility: { mode: 'going', tags: [] } },
        },
        d,
      ),
    ).toBeNull();
  });

  it('refuses an inserted section that carries owner-only wiring off its defaults', async () => {
    const link = await newLink({
      label: 'All sections',
      role: 'editor',
      scope: { design: true, content: true },
    });
    const c = await claimGrant(h.store, { token: link.secret, ip: IP, userAgent: UA });
    if (!c.ok) throw new Error('claim');
    const authorize = enforceOpScope(c.value.grant.capabilities, {
      isOwnerOnlyProp: (type, key) => type === 'rsvp' && key === 'sessionIds',
      defaultProps: () => ({ sessionIds: [] }),
    });
    const d = await doc();
    const insert = (props: Record<string, unknown>) => ({
      kind: 'section.insert' as const,
      opId: 'ins',
      section: {
        ...sectionTemplate('rsvp', props as never),
        id: '0f000000-0000-4000-8000-000000000001',
        position: 'z9',
        rev: 0,
        keyRevs: {},
      },
      afterId: null,
    });
    expect(authorize(insert({ sessionIds: [] }), d)).toBeNull();
    const refused = authorize(insert({ sessionIds: ['0f000000-0000-4000-8000-000000000002'] }), d);
    expect(refused).toMatchObject({ kind: 'forbidden', keys: ['props.sessionIds'] });
  });
});
