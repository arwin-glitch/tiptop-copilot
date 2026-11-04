import { describe, expect, it } from 'vitest';
import { readDraggedThreads } from '@/lib/email/inbox-actions';

describe('drag a conversation onto the nav', () => {
  it('reads only conversation ids from the drag data, capped', () => {
    expect(readDraggedThreads('["18c0a1b2c3d4e5f6","nope",3]')).toEqual(['18c0a1b2c3d4e5f6']);
    expect(readDraggedThreads('not json')).toEqual([]);
    expect(readDraggedThreads('{"a":1}')).toEqual([]);
    const many = JSON.stringify(
      Array.from({ length: 150 }, (_, i) => `18c0a1b2c3d4${String(i).padStart(4, '0')}`),
    );
    expect(readDraggedThreads(many)).toHaveLength(100);
  });
});
