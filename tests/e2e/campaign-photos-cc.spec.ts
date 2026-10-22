import path from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * Campaign photos and copies, over the invented demo workspace (whose sender
 * sends nothing): two photos uploaded, one matched to its person by file
 * name and one picked by hand, a CC, a first-email-only BCC and one person's
 * own CC, then the review's "Who gets what" and its CSV, and the send.
 */

const SIGNED_IN = path.resolve('test-results', 'campaign-photos-state.json');

// A PNG signature is all the server looks for; the rest is invented bytes.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('an invented photo for the e2e run'),
]);

// And a JPEG's: what the page and the server read a photo's kind from.
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from('an invented portrait for the e2e run'),
]);

test.beforeAll(async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByRole('button', { name: 'Enter demo workspace' }).click();
  await page.waitForURL(/\/today/);
  await context.storageState({ path: SIGNED_IN });
  await context.close();
});

test.use({ storageState: SIGNED_IN });

test('photos match by name or by hand, copies are set, and the review shows who gets what', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/fund-ii?tab=campaigns');
  await page.getByRole('button', { name: 'New campaign' }).first().click();
  await page.waitForURL(/\/fund-ii\/campaigns\/[0-9a-f-]{36}$/);

  await page
    .getByLabel('Email addresses')
    .fill('Jane Doe <jane@acme.example>\nSam Lee <sam@lee.example>');
  await page.getByRole('button', { name: 'Add 2 pasted' }).click();
  await expect(page.getByText('Added 2 people.')).toBeVisible();

  // Two photos: one named for Jane, one that fits nobody.
  await page.getByLabel('Add photos').setInputFiles([
    { name: 'jane_doe.png', mimeType: 'image/png', buffer: PNG },
    { name: 'group-shot.png', mimeType: 'image/png', buffer: PNG },
  ]);
  await expect(
    page.getByText(/^2 photos added: 1 matched \(Jane Doe\), 1 not matched/),
  ).toBeVisible();
  const photos = page.getByRole('list', { name: 'Photos' });
  await expect(photos.getByRole('listitem')).toHaveCount(2);
  await expect(photos.getByRole('listitem').filter({ hasText: 'jane_doe.png' })).toContainText(
    'For Jane Doe',
  );
  await expect(photos.getByRole('listitem').filter({ hasText: 'group-shot.png' })).toContainText(
    'Not matched. No one on the list has this name or address.',
  );
  await expect(
    page.getByRole('button', { name: 'Photo for Jane Doe: jane_doe.png' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Photo for Sam Lee: No photo' })).toBeVisible();

  // The unmatched one, given to Sam by hand.
  await page.getByLabel('Who gets group-shot.png').selectOption({ label: 'Sam Lee' });
  await expect(photos.getByRole('listitem').filter({ hasText: 'group-shot.png' })).toContainText(
    'For Sam Lee',
  );
  await expect(
    page.getByRole('button', { name: 'Photo for Sam Lee: group-shot.png' }),
  ).toBeVisible();

  // Copies: CC on every email, BCC on the first only, and Jane's own CC.
  const cc = page.getByLabel('CC on every email');
  await cc.fill('Partner@Fund.example');
  await cc.press('Enter');
  await expect(cc).toHaveValue('partner@fund.example');
  const bcc = page.getByLabel('BCC', { exact: true });
  await bcc.fill('archive@fund.example');
  await bcc.press('Enter');
  await expect(page.locator('#campaign-bcc-hint')).not.toHaveText('Saving…');
  await page.getByRole('button', { name: 'The first email only' }).click();
  await expect(page.getByRole('button', { name: 'The first email only' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'CC for Jane Doe: none' }).click();
  await page.getByLabel('CC addresses for Jane Doe').fill('pa@acme.example');
  await page.getByRole('button', { name: 'Save CC' }).click();
  await expect(
    page.getByRole('button', { name: 'CC for Jane Doe: pa@acme.example' }),
  ).toBeVisible();
  // A typo is caught before it is saved.
  await cc.fill('partner@fund.example, not-an-address');
  await cc.press('Enter');
  await expect(page.getByText('Not an email address: not-an-address')).toBeVisible();
  await cc.fill('partner@fund.example');
  await cc.press('Enter');

  // The message, previewed as Jane: a test carries her photo and copies nobody.
  await page.getByRole('button', { name: 'Next: the message' }).click();
  await page.getByLabel('Subject').fill('Your portrait, {{first_name|friend}}');
  await page
    .getByLabel('Email', { exact: true })
    .fill('Hi {{first_name|there}},\n\nYour portrait from the offsite is attached.');
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await expect(page.getByTestId('test-would-copy')).toHaveText(
    'Attaches jane_doe.png, as it will for them. Not copied on a test: the real email would CC partner@fund.example, pa@acme.example and would BCC archive@fund.example (first email only).',
  );
  await page.getByRole('button', { name: 'Send test to me' }).click();
  await expect(
    page.getByText(/Demo: a test to nick@tiptop\.demo was made.*It carries jane_doe\.png\./),
  ).toBeVisible();

  // Review: who gets what, in send order.
  await page.getByRole('button', { name: 'Next: review' }).click();
  const review = page.getByRole('region', { name: 'Send to 2 people?' });
  const who = review.getByRole('region', { name: 'Who gets what' });
  await expect(who.getByTestId('who-gets-what-summary')).toHaveText(
    '2 with photo, 0 without, 0 problems; CC: partner@fund.example; BCC: archive@fund.example (one sample, on the first email that actually goes out); 1 person has their own CC.',
  );
  await expect(who).toContainText('With 4 CC and BCC copies, this counts as 6 emails');
  await expect(who).toContainText('count as the recipient’s');
  const table = who.getByRole('table', { name: 'Who gets what' });
  const jane = table.getByRole('row', { name: /Jane Doe/ });
  await expect(jane).toContainText('jane_doe.png');
  await expect(jane).toContainText('partner@fund.example');
  await expect(jane).toContainText('pa@acme.example (theirs)');
  await expect(jane).toContainText('archive@fund.example');
  await expect(jane).toContainText(
    'BCC sample: goes on the first email actually sent (normally this one)',
  );
  const sam = table.getByRole('row', { name: /Sam Lee/ });
  await expect(sam).toContainText('group-shot.png');
  await expect(sam).toContainText('partner@fund.example');
  await expect(sam).not.toContainText('archive@fund.example');

  // The same as a CSV.
  const href = await who.getByRole('link', { name: 'Download CSV' }).getAttribute('href');
  const csv = await page.evaluate(async (url) => (await fetch(url!)).text(), href);
  expect(csv).toContain('To,Name,Photo,Shared attachments,CC,BCC,Flags');
  expect(csv).toContain(
    'jane@acme.example,Jane Doe,jane_doe.png,,partner@fund.example; pa@acme.example,archive@fund.example (BCC sample: goes on the first email actually sent (normally this one)),',
  );
  expect(csv).toContain('sam@lee.example,Sam Lee,group-shot.png,,partner@fund.example,,');

  // And the one tap sends it.
  await review.getByRole('button', { name: 'Send to 2 people' }).click();
  await expect(page.getByText('Campaign sent: 2 of 2, no issues.')).toBeVisible({
    timeout: 60_000,
  });
});

test('an unsubscribed CC stops the send; removing a photo takes it off its person', async ({
  page,
}) => {
  await page.goto('/fund-ii?tab=campaigns');
  await page.getByRole('button', { name: 'New campaign' }).first().click();
  await page.waitForURL(/\/fund-ii\/campaigns\/[0-9a-f-]{36}$/);
  await page.getByLabel('Email addresses').fill('Wei Chen <wei@harbor.example>');
  await page.getByRole('button', { name: 'Add 1 pasted' }).click();
  await expect(page.getByText('Added 1 person.')).toBeVisible();
  await page
    .getByLabel('Add photos')
    .setInputFiles([{ name: 'Wei Chen.png', mimeType: 'image/png', buffer: PNG }]);
  await expect(
    page.getByRole('button', { name: 'Photo for Wei Chen: Wei Chen.png' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Remove Wei Chen.png' }).click();
  await expect(page.getByRole('button', { name: 'Photo for Wei Chen: No photo' })).toBeVisible();

  // hana@riverlight.example unsubscribed in the demo workspace.
  const cc = page.getByLabel('CC on every email');
  await cc.fill('hana@riverlight.example');
  await cc.press('Enter');
  await expect(cc).toHaveValue('hana@riverlight.example');
  await expect(page.locator('#campaign-cc-hint')).not.toHaveText('Saving…');

  await page.getByRole('button', { name: 'Next: the message' }).click();
  await page.getByLabel('Subject').fill('Hello');
  await page.getByLabel('Email', { exact: true }).fill('Hi {{first_name|there}},\n\nHello.');
  // Tracking off and the unsubscribe line on: the copy still carries that link.
  await page.getByRole('switch', { name: 'Track opens and clicks' }).click();
  await page.getByRole('switch', { name: 'Add an unsubscribe link' }).click();
  await expect(page.getByRole('switch', { name: 'Track opens and clicks' })).not.toBeChecked();
  await expect(page.getByRole('switch', { name: 'Add an unsubscribe link' })).toBeChecked();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next: review' }).click();
  const review = page.getByRole('region', { name: 'Send to 1 person?' });
  await expect(review.getByTestId('who-gets-what-copy-note')).toHaveText(
    'A copy is the same email, so its unsubscribe link unsubscribes the recipient, whoever taps it.',
  );
  await expect(review).toContainText('Fix these before sending:');
  await expect(review).toContainText(
    'hana@riverlight.example unsubscribed, so it cannot be copied: take it off CC.',
  );
  await expect(review.getByRole('button', { name: 'Send to 1 person' })).toBeDisabled();
  await expect(review.getByTestId('who-gets-what-summary')).toHaveText(
    '0 with photo, 1 without, 0 problems; CC: hana@riverlight.example; BCC: none; 0 people have their own CC.',
  );
});

test('a BCC choice clicked while the address is still saving is kept, after a reload and on the review', async ({
  page,
}) => {
  await page.goto('/fund-ii?tab=campaigns');
  await page.getByRole('button', { name: 'New campaign' }).first().click();
  await page.waitForURL(/\/fund-ii\/campaigns\/[0-9a-f-]{36}$/);
  await page.getByLabel('Email addresses').fill('Leo Grant <leo@grantworks.example>');
  await page.getByRole('button', { name: 'Add 1 pasted' }).click();
  await expect(page.getByText('Added 1 person.')).toBeVisible();

  // The BCC save is held on its way, as a slow connection would hold it, so
  // the click surely lands while it is pending; every save is counted.
  const saves: Record<string, string>[] = [];
  let release!: () => void;
  const bccHeld = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/campaigns/*/copies', async (route) => {
    const body = (route.request().postDataJSON() ?? {}) as Record<string, string>;
    saves.push(body);
    if ('bcc' in body) await bccHeld;
    await route.continue();
  });

  const bcc = page.getByLabel('BCC', { exact: true });
  const first = page.getByRole('button', { name: 'The first email only' });
  const every = page.getByRole('button', { name: 'Every email' });
  await bcc.fill('archive@fund.example');
  // Leaving the field by clicking the choice: the address starts saving on
  // this click's mousedown, and the click itself still counts.
  await first.click();
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  await expect(every).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#campaign-bcc-hint')).toHaveText('Saving…');
  // Only the address is on its way: the choice waits its turn behind it.
  await expect.poll(() => saves).toEqual([{ bcc: 'archive@fund.example' }]);

  // The choice goes once the address has landed, and is not lost to it.
  const modeSaved = page.waitForResponse(
    (r) =>
      r.url().includes('/copies') &&
      r.request().method() === 'PATCH' &&
      'bccMode' in ((r.request().postDataJSON() ?? {}) as object),
  );
  release();
  expect((await modeSaved).ok()).toBe(true);
  await expect(page.locator('#campaign-bcc-hint')).not.toHaveText('Saving…');
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  expect(saves).toEqual([{ bcc: 'archive@fund.example' }, { bccMode: 'first' }]);
  await page.unroute('**/api/campaigns/*/copies');

  // Saved: a reload (which opens on the message, the list being done) shows both.
  await page.reload();
  const steps = page.getByRole('navigation', { name: 'Campaign steps' });
  await steps.getByRole('button', { name: 'Recipients' }).click();
  await expect(page.getByLabel('BCC', { exact: true })).toHaveValue('archive@fund.example');
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  await expect(every).toHaveAttribute('aria-pressed', 'false');

  // And the review shows the one sample copy.
  await page.getByRole('button', { name: 'Next: the message' }).click();
  await page.getByLabel('Subject').fill('Hello');
  await page.getByLabel('Email', { exact: true }).fill('Hi {{first_name|there}},\n\nHello.');
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next: review' }).click();
  const review = page.getByRole('region', { name: 'Send to 1 person?' });
  await expect(review.getByTestId('who-gets-what-summary')).toHaveText(
    '0 with photo, 1 without, 0 problems; CC: none; BCC: archive@fund.example (one sample, on the first email that actually goes out); 0 people have their own CC.',
  );
});

test('one photo joins and matches its person by name; a failed upload says why on the page', async ({
  page,
}) => {
  await page.goto('/fund-ii?tab=campaigns');
  await page.getByRole('button', { name: 'New campaign' }).first().click();
  await page.waitForURL(/\/fund-ii\/campaigns\/[0-9a-f-]{36}$/);
  await page.getByLabel('Email addresses').fill('Priya Raman <priya@northwind.example>');
  await page.getByRole('button', { name: 'Add 1 pasted' }).click();
  await expect(page.getByText('Added 1 person.')).toBeVisible();

  const section = page.getByRole('region', { name: /Photos, one per person/ });
  const count = section.getByText('1 photo', { exact: true });
  await page
    .getByLabel('Add photos')
    .setInputFiles([{ name: 'Priya Raman.jpg', mimeType: 'image/jpeg', buffer: JPEG }]);
  await expect(page.getByText(/^1 photo added: 1 matched \(Priya Raman\)/)).toBeVisible();
  await expect(count).toBeVisible();
  await expect(section.getByRole('list', { name: 'Photos' }).getByRole('listitem')).toContainText(
    'For Priya Raman',
  );
  await expect(
    page.getByRole('button', { name: 'Photo for Priya Raman: Priya Raman.jpg' }),
  ).toBeVisible();
  await expect(section.getByRole('alert')).toHaveCount(0);

  // A file that is no image inside: refused, and the page says why.
  await page
    .getByLabel('Add photos')
    .setInputFiles([
      { name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from('%PDF-1.4 invented notes') },
    ]);
  const problem = section.getByRole('alert');
  await expect(problem).toContainText('A photo was not added');
  await expect(problem).toContainText(
    'notes.png is not a JPG, PNG, GIF, WebP or HEIC image inside.',
  );
  await expect(count).toBeVisible();

  // The server refusing an upload, as production did: its own words stay on
  // the page, and the count stays where it was.
  await page.route('**/api/campaigns/*/photos', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: false,
            error: {
              code: 'internal',
              message: 'Upload failed: mime type application/octet-stream is not supported',
            },
          }),
        })
      : route.fallback(),
  );
  await page
    .getByLabel('Add photos')
    .setInputFiles([{ name: 'Priya at the offsite.png', mimeType: 'image/png', buffer: PNG }]);
  await expect(problem).toContainText(
    'Upload failed: mime type application/octet-stream is not supported',
  );
  await expect(problem).not.toContainText('notes.png');
  await expect(count).toBeVisible();
  await page.unroute('**/api/campaigns/*/photos');
  await problem.getByRole('button', { name: /^Dismiss/ }).click();
  await expect(section.getByRole('alert')).toHaveCount(0);
});

test('a file campaigns cannot carry is refused with what they can; a PDF still attaches', async ({
  page,
}) => {
  await page.goto('/fund-ii?tab=campaigns');
  await page.getByRole('button', { name: 'New campaign' }).first().click();
  await page.waitForURL(/\/fund-ii\/campaigns\/[0-9a-f-]{36}$/);
  await page.getByLabel('Email addresses').fill('Priya Raman <priya@northwind.example>');
  await page.getByRole('button', { name: 'Add 1 pasted' }).click();
  await expect(page.getByText('Added 1 person.')).toBeVisible();
  await page.getByRole('button', { name: 'Next: the message' }).click();

  await page.getByLabel('Attach files').setInputFiles([
    {
      name: 'Model.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from('PK invented spreadsheet'),
    },
  ]);
  const problem = page.getByRole('alert').filter({ hasText: 'A file was not attached' });
  await expect(problem).toContainText(
    'Model.xlsx cannot be attached: campaigns carry PDF, Word (.docx), PowerPoint (.pptx), plain text, Markdown, CSV, HTML, JSON, PNG, JPG, GIF or WebP files.',
  );
  await expect(page.getByRole('list', { name: 'Attachments' })).toHaveCount(0);

  await page
    .getByLabel('Attach files')
    .setInputFiles([
      { name: 'Deck.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 invented') },
    ]);
  await expect(page.getByRole('list', { name: 'Attachments' })).toContainText('Deck.pdf');
  await expect(problem).toHaveCount(0);
});
