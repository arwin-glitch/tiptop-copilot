import { describe, expect, it } from 'vitest';
import { decodeEntities } from '@/lib/services/inbox-live';

describe('decodeEntities (row previews)', () => {
  it('decodes entities and drops markup a sender left in the text', () => {
    expect(decodeEntities('p/&lt;b&gt;gtm&lt;/b&gt;-212-ai')).toBe('p/gtm-212-ai');
    expect(decodeEntities('Tom &amp; Jerry &quot;hi&quot; &#39;there&#39;')).toBe(
      'Tom & Jerry "hi" \'there\'',
    );
  });

  it('keeps text that only looks like a comparison', () => {
    expect(decodeEntities('2 &lt; 3 and 5 &gt; 4')).toBe('2 < 3 and 5 > 4');
  });
});
