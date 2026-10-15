import { describe, expect, it } from 'vitest';
import {
  collectLinks,
  firstNameOf,
  isTrackableHref,
  mergeFieldsUsed,
  missingMergeFields,
  parseTemplate,
  renderHtml,
  renderSubject,
  renderText,
  subjectIssues,
} from '@/lib/campaigns/template';

/** Campaign templates: merge fields, fallbacks, light Markdown, and what may never get through. */

const render = (template: string, merge = {}, trackHref?: (h: string) => string) => {
  const { blocks, issues } = parseTemplate(template);
  return {
    html: renderHtml(blocks, { merge, trackHref }),
    text: renderText(blocks, { merge }),
    issues,
    blocks,
  };
};

describe('merge fields', () => {
  it('fills first name, name and company', () => {
    const out = render('Hi {{first_name}} at {{company}}. Dear {{name}}.', {
      name: 'Maren Solberg',
      company: 'Oakhaven Capital',
    });
    expect(out.text).toBe('Hi Maren at Oakhaven Capital. Dear Maren Solberg.');
    expect(out.issues).toEqual([]);
  });

  it('uses the tag fallback, else the default, when a value is missing', () => {
    expect(render('Hi {{first_name|friend}},').text).toBe('Hi friend,');
    expect(render('Hi {{first_name}},').text).toBe('Hi there,');
    expect(render('At {{ company | your firm }}.').text).toBe('At your firm.');
    expect(render('At {{company}}.').text).toBe('At your company.');
  });

  it('takes the first name from the name, but never from an email address', () => {
    expect(firstNameOf('Ada Brennan')).toBe('Ada');
    expect(firstNameOf('ada@brindle.example')).toBe('');
    expect(render('Hi {{first_name}}', { name: 'ada@x.example' }).text).toBe('Hi there');
    expect(render('Hi {{name}}', { name: 'ada@x.example' }).text).toBe('Hi there');
  });

  it('is case-insensitive about the field name', () => {
    expect(render('Hi {{First_Name}}', { first_name: 'Sam' }).text).toBe('Hi Sam');
  });

  it('flags an unknown field and a missing closing brace', () => {
    expect(render('Hi {{firstname}}').issues[0]).toMatch(/not a merge field/);
    expect(render('Hi {{first_name').issues[0]).toMatch(/closing/);
  });

  it('reports which fields a template uses and who lacks them', () => {
    const used = mergeFieldsUsed('Q3 for {{company}}', 'Hi {{first_name|there}}');
    expect(used).toEqual(['first_name', 'company']);
    expect(missingMergeFields(used, { name: 'Sam Lee' })).toEqual(['company']);
  });
});

describe('a merge value is only ever text', () => {
  it('escapes HTML in a value', () => {
    const out = render('Hi {{name}}', { name: '<script>alert(1)</script> & Co' });
    expect(out.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co');
    expect(out.html).not.toContain('<script>');
  });

  it('cannot add a link or formatting', () => {
    const out = render('Hi {{name}}', { name: '[click](https://evil.example) **bold**' });
    expect(out.html).not.toContain('<a ');
    expect(out.html).not.toContain('<b>');
    expect(collectLinks(out.blocks)).toEqual([]);
  });

  it('cannot go inside a link address', () => {
    const out = render('[Your page](https://example.com/{{name}})');
    expect(out.issues.join(' ')).toMatch(/cannot go inside a link/);
    expect(collectLinks(out.blocks)).toEqual([]);
  });
});

describe('light Markdown', () => {
  it('makes paragraphs, line breaks, bold, italic and lists', () => {
    const out = render(
      'Hello\nthere\n\n**Big** and *small*\n\n- one\n- two\n\n1. first\n2. second',
    );
    expect(out.html).toBe(
      '<div>Hello<br>there</div><div><br></div><div><b>Big</b> and <i>small</i></div><div><br></div>' +
        '<ul style="margin:0 0 0 1.2em;padding:0"><li>one</li><li>two</li></ul><div><br></div>' +
        '<ol style="margin:0 0 0 1.2em;padding:0"><li>first</li><li>second</li></ol>',
    );
    expect(out.text).toBe('Hello\nthere\n\nBig and small\n\n- one\n- two\n\n1. first\n2. second');
  });

  it('leaves arithmetic asterisks alone', () => {
    expect(render('2*3*4 = 24').text).toBe('2*3*4 = 24');
  });

  it('links [text](url) and bare URLs, without trailing punctuation', () => {
    const out = render(
      'Read [the letter](https://tiptop.example/q3). Or https://tiptop.example/deck.',
    );
    expect(collectLinks(out.blocks)).toEqual([
      'https://tiptop.example/q3',
      'https://tiptop.example/deck',
    ]);
    expect(out.text).toBe(
      'Read the letter (https://tiptop.example/q3). Or https://tiptop.example/deck.',
    );
  });

  it('refuses a javascript: or relative link', () => {
    const out = render('[x](javascript:alert(1)) [y](/relative)');
    expect(collectLinks(out.blocks)).toEqual([]);
    expect(out.issues.length).toBeGreaterThan(0);
    expect(out.html).not.toContain('href="javascript');
  });

  it('keeps mailto links but does not track them', () => {
    const out = render('[Email me](mailto:nick@tiptop.example)', {}, (h) => `T(${h})`);
    expect(out.html).toContain('href="mailto:nick@tiptop.example"');
    expect(isTrackableHref('mailto:nick@tiptop.example')).toBe(false);
  });

  it('rewrites only http(s) links when tracking', () => {
    const out = render(
      '[a](https://a.example/x?y=1&z=2)',
      {},
      (h) => `https://t.example/c?u=${encodeURIComponent(h)}`,
    );
    expect(out.html).toContain(
      'href="https://t.example/c?u=https%3A%2F%2Fa.example%2Fx%3Fy%3D1%26z%3D2"',
    );
  });
});

describe('subject', () => {
  it('fills merge fields and stays one line', () => {
    expect(renderSubject('Q3 for {{company|you}}\nnow', { company: 'Pinecrest' })).toBe(
      'Q3 for Pinecrest now',
    );
    expect(renderSubject('Hello {{first_name}}', {})).toBe('Hello there');
  });

  it('flags an unknown field', () => {
    expect(subjectIssues('Hi {{nickname}}')).toHaveLength(1);
    expect(subjectIssues('Hi {{first_name}}')).toEqual([]);
  });
});
