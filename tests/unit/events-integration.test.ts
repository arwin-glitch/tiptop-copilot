import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { AuthContext } from '@/lib/auth/session';
import { RSVP_MOMENT_EVENT } from '@/components/events/effects/rsvp-moment-bus';
import { playRsvpMoment } from '@/components/events/rsvp/rsvp-shared';
import { DEMO_EVENT_IDS, DEMO_EVENT_SLUGS } from '@/lib/demo/events-fixtures';
import { blockRegistry } from '@/lib/events/blocks';
import { GRANT_COOKIE } from '@/lib/events/contracts';
import { grantCookiePaths, resolveGrant } from '@/lib/events/editor-auth';
import { renderRichText, richTextToPlain } from '@/lib/events/richtext';
import { formToken } from '@/lib/events/public-gate';
import { inviteToken } from '@/lib/events/tokens';
import { filterDocForViewer } from '@/lib/events/visibility';
import { PUBLIC_VIEWER } from '@/lib/events/contracts';
import { parseEventDoc } from '@/lib/events/schema';
import { createEditorLink } from '@/lib/services/event-editors';
import { presenceColor, syncStudio } from '@/lib/services/event-presence';
import { ownerActor, presenceColor as syncColor, type EventOwner } from '@/lib/services/events';
import { ok, type Result } from '@/lib/util/result';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * The seams between the five Events workstreams once merged (D-075): the
 * staff link claimed through WS4's route with WS3's grant service, a private
 * event that opens only through personal links, WS4's field gating accepted
 * by WS2's registry, the RSVP moment reaching WS2's effects bus, the email
 * {{rsvp_link}} tag staying literal on a page, and Studio's sync running on
 * WS1's syncDraft. Fictional data; no network.
 */

let h: Harness;
let owner: EventOwner;
let signedIn: () => Result<AuthContext>;

vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  authOrError: async () => signedIn(),
  getAuthContext: async () => null,
}));

const claimRoute = await import('@/app/api/e/checkin/session/route');
const doorRoute = await import('@/app/api/e/checkin/[eventId]/guests/route');
const rsvpRoute = await import('@/app/api/e/[slug]/rsvp/route');
const viewRoute = await import('@/app/api/e/[slug]/view/route');
const icsRoute = await import('@/app/e/[slug]/calendar.ics/route');
const personalIcsRoute = await import('@/app/e/[slug]/i/[token]/calendar.ics/route');

const EVENT = DEMO_EVENT_IDS.annualMeeting;
const SLUG = DEMO_EVENT_SLUGS.annualMeeting;
const ORIGIN = 'http://localhost:3000';

beforeEach(async () => {
  h = await createHarness();
  owner = { userId: h.auth.userId, organizationId: h.auth.organizationId, name: 'Demo Owner' };
  signedIn = () => ok(h.auth);
});

afterEach(async () => {
  await h.dispose();
  vi.unstubAllGlobals();
});

function post(path: string, body: unknown) {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { host: 'localhost:3000', origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function secretFor(role: 'checkin' | 'editor'): Promise<string> {
  const issued = await createEditorLink(h.store, owner, EVENT, {
    label: role === 'checkin' ? 'Door – Riley Example' : 'Morgan – Example Partners',
    role,
  });
  if (!issued.ok) throw new Error(issued.error.message);
  return issued.value.path.split('#k=')[1]!;
}

describe('a staff check-in link (WS3 grant, WS4 route)', () => {
  it('claims with the checkin role and sets the cookie on the door list, its API and the QR paths only', async () => {
    const secret = await secretFor('checkin');
    const res = await claimRoute.POST(post('/api/e/checkin/session', { token: secret }));
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie();
    const paths = cookies.map((c) => /Path=([^;]+)/.exec(c)?.[1]).sort();
    expect(paths).toEqual(
      [`/api/e/${SLUG}/c`, `/api/e/checkin/${EVENT}`, `/e/${SLUG}/c`, `/e/checkin/${EVENT}`].sort(),
    );
    expect(grantCookiePaths('checkin', EVENT, SLUG)).toHaveLength(4);
    for (const c of cookies) {
      expect(c).toMatch(/HttpOnly/);
      expect(c).toMatch(/SameSite=Strict/);
      expect(c.startsWith(`${GRANT_COOKIE}=`)).toBe(true);
    }
    const value = cookies[0]!.split(';')[0]!.slice(GRANT_COOKIE.length + 1);

    // The door list answers that cookie...
    const door = await doorRoute.GET(
      new NextRequest(`${ORIGIN}/api/e/checkin/${EVENT}/guests`, {
        headers: { cookie: `${GRANT_COOKIE}=${value}` },
      }),
      { params: Promise.resolve({ eventId: EVENT }) },
    );
    expect(door.status).toBe(200);
    expect(JSON.stringify(await door.json())).not.toMatch(/@example\.com/);
    // ...and the editor's routes never do.
    const asEditor = await resolveGrant(h.store, { eventId: EVENT, cookieValue: value });
    expect(asEditor.ok).toBe(false);
  });

  it('refuses an editor link at the staff entry with the same 404', async () => {
    const secret = await secretFor('editor');
    const res = await claimRoute.POST(post('/api/e/checkin/session', { token: secret }));
    expect(res.status).toBe(404);
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

describe('a private event opens only through personal links', () => {
  const token = () =>
    inviteToken({
      organizationId: h.auth.organizationId,
      eventId: EVENT,
      guestId: DEMO_EVENT_IDS.guestAvery,
      tokenVersion: 1,
    });

  beforeEach(async () => {
    await h.store.update('events', h.auth.organizationId, EVENT, {
      visibility: 'private',
      access: 'open',
    });
  });

  it('keeps the bare page’s RSVP form and calendar file at 404', async () => {
    const rsvp = await rsvpRoute.POST(
      post(`/api/e/${SLUG}/rsvp`, {
        formToken: formToken(EVENT, Date.now() - 5_000),
        firstName: 'Taylor',
        lastName: 'Example',
        email: 'taylor@example.com',
        sessions: [DEMO_EVENT_IDS.sessionMeeting],
        answers: {},
        plusOnes: [],
        showOnWall: false,
      }),
      { params: Promise.resolve({ slug: SLUG }) },
    );
    expect(rsvp.status).toBe(404);
    const ics = await icsRoute.GET(new NextRequest(`${ORIGIN}/e/${SLUG}/calendar.ics`), {
      params: Promise.resolve({ slug: SLUG }),
    });
    expect(ics.status).toBe(404);
    const anonymousView = await viewRoute.POST(post(`/api/e/${SLUG}/view`, {}), {
      params: Promise.resolve({ slug: SLUG }),
    });
    expect(anonymousView.status).toBe(404);
  });

  it('serves the guest’s own calendar file and view beacon', async () => {
    const t = token();
    const ics = await personalIcsRoute.GET(new Request(`${ORIGIN}/e/${SLUG}/i/${t}/calendar.ics`), {
      params: Promise.resolve({ slug: SLUG, token: t }),
    });
    expect(ics.status).toBe(200);
    expect(await ics.text()).toContain('METHOD:PUBLISH');
    const view = await viewRoute.POST(post(`/api/e/${SLUG}/view`, { token: t }), {
      params: Promise.resolve({ slug: SLUG }),
    });
    expect(view.status).toBe(200);
  });
});

describe('field gating (WS4) in the block registry (WS2)', () => {
  it('accepts a gate on a real field, refuses an unknown one, and is owner-only', () => {
    const gate = { subheadline: { mode: 'going', tags: [] } };
    expect(
      blockRegistry.validateProps('hero', 'centered', {
        headline: 'Welcome',
        subheadline: 'For guests who are coming',
        fieldVisibility: gate,
      }),
    ).toEqual([]);
    expect(
      blockRegistry.validateProps('hero', 'centered', {
        fieldVisibility: { notAField: { mode: 'going', tags: [] } },
      }),
    ).not.toEqual([]);
    expect(
      blockRegistry.validateProps('hero', 'centered', {
        fieldVisibility: { subheadline: { mode: 'sometimes', tags: [] } },
      }),
    ).not.toEqual([]);
    expect(blockRegistry.isOwnerOnlyProp('hero', 'fieldVisibility')).toBe(true);
  });

  it('drops the gated field and the gate itself for a public visitor', async () => {
    const event = await h.store.get('events', h.auth.organizationId, EVENT);
    const parsed = parseEventDoc(event!.draft_doc);
    if (!parsed.ok) throw new Error('doc');
    const doc = structuredClone(parsed.value);
    const hero = doc.sections.find((s) => s.type === 'hero')!;
    hero.props = {
      ...hero.props,
      subheadline: 'Only for guests who are coming',
      fieldVisibility: { subheadline: { mode: 'going', tags: [] } },
    };
    const shown = filterDocForViewer(doc, PUBLIC_VIEWER);
    const publicHero = shown.sections.find((s) => s.id === hero.id)!;
    expect(publicHero.props.subheadline).toBeUndefined();
    expect(publicHero.props.fieldVisibility).toBeUndefined();
  });
});

describe('small seams', () => {
  it('a successful RSVP plays the theme’s moment through WS2’s bus', () => {
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    const heard: unknown[] = [];
    target.addEventListener(RSVP_MOMENT_EVENT, (e) => heard.push((e as CustomEvent).detail));
    playRsvpMoment();
    expect(heard).toEqual([{ status: 'going' }]);
  });

  it('{{rsvp_link}} is an email tag: on a page it stays as typed', () => {
    const html = renderToStaticMarkup(
      renderRichText('Reply here: {{rsvp_link|RSVP}}') as React.ReactElement,
    );
    expect(html).toContain('{{rsvp_link|RSVP}}');
    expect(html).not.toContain('<a');
    expect(richTextToPlain('See {{rsvp_link}}')).toBe('See {{rsvp_link}}');
  });

  it('Studio’s sync is WS1’s syncDraft: others only, and the caller’s own colour', async () => {
    const me = ownerActor(owner);
    expect(presenceColor).toBe(syncColor);
    const first = await syncStudio(h.store, me, EVENT, 0, {
      focusedSectionId: null,
      typing: false,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.presence.some((p) => p.actorKey === `u:${owner.userId}`)).toBe(false);
    expect(first.value.selfColor).toBe(presenceColor(`u:${owner.userId}`));
  });
});
