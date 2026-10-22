import { describe, expect, it } from 'vitest';
import { createSaveQueue } from '@/lib/util/save-queue';

/** A save that finishes when the test says so. */
function held() {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));
  return { done, finish };
}

describe('createSaveQueue', () => {
  it('runs a save queued during another after it, never alongside it', async () => {
    const queue = createSaveQueue(() => {});
    const order: string[] = [];
    const list = held();
    const first = queue.add(async () => {
      order.push('list starts');
      await list.done;
      order.push('list ends');
    });
    // The click that lands while the list is still saving.
    const second = queue.add(() => {
      order.push('choice');
    });
    await Promise.resolve();
    expect(order).toEqual(['list starts']);
    expect(queue.pending).toBe(2);
    list.finish();
    await Promise.all([first, second]);
    expect(order).toEqual(['list starts', 'list ends', 'choice']);
    expect(queue.pending).toBe(0);
  });

  it('lets a save work out its body when its turn comes, so the last choice wins', async () => {
    // Choices made while a list is saving, the way the campaign's BCC buttons queue them.
    async function choose(choices: string[]) {
      const queue = createSaveQueue(() => {});
      const list = held();
      let saved = 'every';
      let wanted = 'every';
      const sent: string[] = [];
      void queue.add(() => list.done);
      for (const choice of choices) {
        wanted = choice;
        void queue.add(() => {
          if (wanted === saved) return;
          sent.push(wanted);
          saved = wanted;
        });
      }
      list.finish();
      await queue.add(() => {});
      return sent;
    }
    expect(await choose(['first'])).toEqual(['first']);
    expect(await choose(['first', 'every', 'first'])).toEqual(['first']);
    expect(await choose(['first', 'every'])).toEqual([]);
  });

  it('is busy from the first save queued until the last has finished, once each', async () => {
    const busy: boolean[] = [];
    const queue = createSaveQueue((on) => busy.push(on));
    const list = held();
    const a = queue.add(() => list.done);
    const b = queue.add(() => {});
    expect(busy).toEqual([true]);
    list.finish();
    await Promise.all([a, b]);
    expect(busy).toEqual([true, false]);
    // And again for the next batch.
    await queue.add(() => {});
    expect(busy).toEqual([true, false, true, false]);
  });

  it('goes on after a save that throws', async () => {
    const busy: boolean[] = [];
    const queue = createSaveQueue((on) => busy.push(on));
    const ran: string[] = [];
    const failing = queue.add(() => {
      throw new Error('refused');
    });
    const next = queue.add(() => {
      ran.push('next');
    });
    await expect(failing).resolves.toBeUndefined();
    await next;
    expect(ran).toEqual(['next']);
    expect(busy).toEqual([true, false]);
  });
});
