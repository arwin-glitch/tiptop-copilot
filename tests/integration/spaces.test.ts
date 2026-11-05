import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { DEMO_IDS, demoSpaceId } from '@/lib/demo/ids';
import { askSpace, resetSpaceAskCache } from '@/lib/services/space-ask';
import {
  actionLines,
  actionSuggestions,
  addSpaceTask,
  resetSpaceContentCache,
  spaceCards,
  spaceEmailPage,
  spaceItems,
  spaceTasks,
  suggestSpaces,
} from '@/lib/services/space-content';
import {
  answerInvite,
  createSpace,
  getSpaceAccess,
  inviteMember,
  listMySpaces,
  removeMember,
  setItemHidden,
  spacesReady,
  type SpaceViewer,
} from '@/lib/services/spaces';
import { searchEverything } from '@/lib/services/search';
import { resetInboxLiveCache } from '@/lib/services/inbox-live';

/** Spaces end to end on the demo store: fictional fixtures only (the demo's Ledgerly). */

let harness: Harness;
const LEDGERLY = demoSpaceId('space', 0);
const owner = (): SpaceViewer => ({
  organizationId: DEMO_IDS.org,
  userId: DEMO_IDS.user,
  role: 'owner',
  isDemo: true,
});
const teammate = (): SpaceViewer => ({
  organizationId: DEMO_IDS.org,
  userId: DEMO_IDS.userTeammate,
  role: 'member',
  isDemo: true,
});
const outsider = (): SpaceViewer => ({
  organizationId: DEMO_IDS.org,
  userId: '00000000-0000-4000-8000-0000000fffff',
  role: 'admin',
  isDemo: true,
});

beforeEach(async () => {
  harness = await createHarness();
  resetSpaceContentCache();
  resetSpaceAskCache();
  resetInboxLiveCache();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await harness.dispose();
});

async function access(viewer = owner()) {
  const a = await getSpaceAccess(harness.store, viewer, LEDGERLY);
  if (!a.ok) throw new Error(a.error.message);
  return a.value;
}

describe('who sees a Space', () => {
  it('is members only: the owner and the invited, never the rest of the workspace', async () => {
    expect(await spacesReady(harness.store, DEMO_IDS.org)).toBe(true);
    const mine = await listMySpaces(harness.store, owner());
    expect(mine.ok && mine.value.map((a) => a.space.name)).toEqual(['Ledgerly']);
    const invited = await listMySpaces(harness.store, teammate());
    expect(invited.ok && invited.value[0]?.invited).toBe(true);
    expect(invited.ok && invited.value[0]?.canView).toBe(false);
    const other = await listMySpaces(harness.store, outsider());
    expect(other.ok && other.value).toEqual([]);
    const denied = await getSpaceAccess(harness.store, outsider(), LEDGERLY);
    expect(!denied.ok && denied.error.code).toBe('not_found');
  });

  it('shows up in search for members only', async () => {
    const asOwner = await searchEverything(harness.store, DEMO_IDS.org, 'ledg', harness.auth);
    expect(asOwner.some((r) => r.kind === 'space' && r.href === `/spaces/${LEDGERLY}`)).toBe(true);
    const asOther = await searchEverything(harness.store, DEMO_IDS.org, 'ledg', {
      ...harness.auth,
      userId: outsider().userId,
    });
    expect(asOther.some((r) => r.kind === 'space')).toBe(false);
  });
});

describe('what is in a Space', () => {
  it('counts its synced mail, meetings and notes', async () => {
    const cards = await spaceCards(harness.store, owner());
    expect(cards.ok).toBe(true);
    if (!cards.ok) return;
    const card = cards.value[0]!;
    expect(card.counts?.emails).toBeGreaterThan(0);
    expect(card.counts?.meetings).toBeGreaterThan(0);
    expect(card.others).toBe(0);
    const items = await spaceItems(harness.store, await access());
    expect(items.notes.some((n) => /pre-board sync/.test(n.title))).toBe(true);
  });

  it('searches the mailbox read-only for the Emails tab', async () => {
    const page = await spaceEmailPage(harness.store, await access());
    expect(page.state).toBe('ok');
    expect(page.rows.length).toBeGreaterThan(0);
    expect(page.rows.every((r) => r.primary)).toBe(true);
  });

  it('leaves out what a member hid, everywhere', async () => {
    const a = await access();
    const before = await spaceItems(harness.store, a);
    const note = before.notes[0]!;
    const hid = await setItemHidden(
      harness.store,
      owner(),
      a,
      { kind: 'note', id: note.id, owner: note.owner },
      true,
    );
    expect(hid.ok).toBe(true);
    const after = await spaceItems(harness.store, await access());
    expect(after.notes.some((n) => n.id === note.id)).toBe(false);
    expect(after.hiddenCount).toBe(before.hiddenCount + 1);
    const answer = await askSpace(harness.store, harness.auth, await access(), 'board VP Sales');
    expect(answer.ok && answer.value.sources.some((s) => s.id === note.id)).toBe(false);
  });

  it('refuses to hide an item that is someone else’s', async () => {
    await answerInvite(harness.store, teammate(), LEDGERLY, 'accept');
    const a = await access(teammate());
    const res = await setItemHidden(
      harness.store,
      teammate(),
      a,
      { kind: 'meeting', id: 'x', owner: DEMO_IDS.user },
      true,
    );
    expect(!res.ok && res.error.code).toBe('forbidden');
  });
});

describe('making and sharing', () => {
  it('needs rules, refuses personal mail domains, and makes the owner a member', async () => {
    const none = await createSpace(harness.store, owner(), { name: 'Empty', rules: [] });
    expect(!none.ok && none.error.code).toBe('invalid_input');
    const personal = await createSpace(harness.store, owner(), {
      name: 'Too wide',
      rules: [{ kind: 'domain', value: 'gmail.com' }],
    });
    expect(!personal.ok && personal.error.message).toMatch(/personal mail domain/);
    const made = await createSpace(harness.store, owner(), {
      name: 'Northwind Labs',
      rules: [{ kind: 'domain', value: 'northwind.demo' }],
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const a = await getSpaceAccess(harness.store, owner(), made.value.id);
    expect(a.ok && a.value.members.map((m) => [m.role, m.status])).toEqual([['owner', 'accepted']]);
  });

  it('lets an invitee accept, and removing them drops what they hid', async () => {
    const accepted = await answerInvite(harness.store, teammate(), LEDGERLY, 'accept');
    expect(accepted.ok && accepted.value.status).toBe('accepted');
    const a = await access(teammate());
    expect(a.canView).toBe(true);
    await setItemHidden(
      harness.store,
      teammate(),
      a,
      { kind: 'suggestion', id: 'abc', owner: null },
      true,
    );
    expect((await access()).hidden).toHaveLength(1);
    expect((await removeMember(harness.store, owner(), LEDGERLY, DEMO_IDS.userTeammate)).ok).toBe(
      true,
    );
    expect((await access()).hidden).toHaveLength(0);
    const gone = await getSpaceAccess(harness.store, teammate(), LEDGERLY);
    expect(gone.ok).toBe(false);
    // Invited again, they answer again.
    const again = await inviteMember(harness.store, owner(), LEDGERLY, DEMO_IDS.userTeammate);
    expect(again.ok && again.value.status).toBe('invited');
  });

  it('only invites people in the workspace', async () => {
    const res = await inviteMember(harness.store, owner(), LEDGERLY, outsider().userId);
    expect(!res.ok && res.error.code).toBe('invalid_input');
  });
});

describe('action items', () => {
  it('reads action items from notes', () => {
    const lines = actionLines(
      'Talked pricing.\n\nAction items:\nDana: send the revised deck\n- Book the follow-up call\n\nWe will send the model by Friday.',
    );
    expect(lines.map((l) => l.text)).toEqual([
      'Dana: send the revised deck',
      'Book the follow-up call',
      'We will send the model by Friday.',
    ]);
    expect(lines[0]?.owner).toBe('Dana');
  });

  it('suggests add-only items, and an added one is not suggested again', async () => {
    const a = await access();
    const suggestions = await actionSuggestions(harness.store, a);
    expect(suggestions.length).toBeGreaterThan(0);
    const first = suggestions[0]!;
    const added = await addSpaceTask(harness.store, owner(), a, {
      title: first.title,
      detail: first.detail,
      suggested: true,
    });
    expect(added.ok && added.value.space_id).toBe(LEDGERLY);
    const tasks = await spaceTasks(harness.store, a);
    expect(tasks.map((t) => t.title)).toContain(first.title);
    const next = await actionSuggestions(harness.store, a);
    expect(next.some((s) => s.title === first.title)).toBe(false);
    const cards = await spaceCards(harness.store, owner());
    expect(cards.ok && cards.value[0]?.counts?.openItems).toBe(1);
  });

  it('keeps a dismissed suggestion dismissed', async () => {
    const a = await access();
    const [first] = await actionSuggestions(harness.store, a);
    await setItemHidden(
      harness.store,
      owner(),
      a,
      { kind: 'suggestion', id: first!.id, owner: null },
      true,
    );
    const next = await actionSuggestions(harness.store, await access());
    expect(next.some((s) => s.id === first!.id)).toBe(false);
  });
});

describe('Ask and suggestions', () => {
  it('answers in the demo from the Space alone, with no model', async () => {
    const res = await askSpace(harness.store, harness.auth, await access(), 'What about VP Sales?');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.demo).toBe(true);
    expect(res.value.answer).toMatch(/^\[Demo answer\]/);
    expect(res.value.sources.length).toBeGreaterThan(0);
  });

  it('refuses an invitee who has not accepted', async () => {
    const res = await askSpace(harness.store, harness.auth, await access(teammate()), 'Anything?');
    expect(!res.ok && res.error.code).toBe('forbidden');
  });

  it('suggests companies with many threads that no Space covers', async () => {
    const suggestions = await suggestSpaces(harness.store, owner());
    expect(suggestions.every((s) => s.domain !== 'ledgerly.demo')).toBe(true);
    for (const s of suggestions) expect(s.emails + s.meetings).toBeGreaterThanOrEqual(3);
  });
});

describe('before the migration', () => {
  it('says so and stores nothing', async () => {
    const original = harness.store.list.bind(harness.store);
    vi.spyOn(harness.store, 'list').mockImplementation((async (
      table: string,
      ...rest: unknown[]
    ) => {
      if (table.startsWith('space')) {
        throw Object.assign(new Error(`relation "${table}" does not exist`), { code: '42P01' });
      }
      return (original as (...a: unknown[]) => Promise<unknown>)(table, ...rest);
    }) as never);
    const insert = vi.spyOn(harness.store, 'insert');
    expect(await spacesReady(harness.store, DEMO_IDS.org)).toBe(false);
    const list = await listMySpaces(harness.store, owner());
    expect(!list.ok && list.error.details).toMatchObject({ needsMigration: true });
    const made = await createSpace(harness.store, owner(), {
      name: 'X',
      rules: [{ kind: 'domain', value: 'northwind.demo' }],
    });
    expect(made.ok).toBe(false);
    expect(insert).not.toHaveBeenCalled();
  });
});
