import { expect, test, type Page } from '@playwright/test';

/**
 * Settings → Integrations → Connect Claude (MCP), end to end in demo mode:
 * an owner creates a token, it is shown once as a connector URL and a bare
 * token, the endpoint answers it (header and URL forms), and after Revoke it
 * answers 401.
 */

async function enterDemo(page: Page) {
  await page.goto('/login');
  const enter = page.getByRole('button', { name: 'Enter demo workspace' });
  if (await enter.isVisible().catch(() => false)) await enter.click();
  await page.waitForURL(/\/today/);
}

const TOOLS_LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

test('create a Claude connection, use it, revoke it', async ({ page }) => {
  await enterDemo(page);
  await page.goto('/settings');
  await page.getByRole('tab', { name: 'Integrations' }).click();
  await expect(page.getByRole('heading', { name: 'Connect Claude (MCP)' })).toBeVisible();

  const name = `e2e client ${Date.now()}`;
  await page.getByLabel('Connection name').fill(name);
  await page.getByRole('button', { name: 'Create token' }).click();

  const fresh = page.getByRole('region', { name: 'New token' });
  await expect(fresh).toBeVisible();
  await expect(fresh).toContainText('will not be shown again');
  const url = await fresh.getByLabel('Connector URL', { exact: true }).inputValue();
  const token = await fresh.getByLabel('Token', { exact: true }).inputValue();
  expect(token).toMatch(/^tcmcp_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/);
  expect(url.endsWith(`/api/mcp/${token}`)).toBe(true);

  // The endpoint answers the token, as a Bearer header and in the URL path.
  const viaHeader = await page.request.post('/api/mcp', {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    data: TOOLS_LIST,
  });
  expect(viaHeader.status()).toBe(200);
  const listed = (await viaHeader.json()) as { result: { tools: { name: string }[] } };
  expect(listed.result.tools.map((t) => t.name)).toContain('lp_pipeline');

  const viaPath = await page.request.post(`/api/mcp/${token}`, {
    headers: { 'content-type': 'application/json' },
    data: {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'search', arguments: { query: 'Brindle' } },
    },
  });
  expect(viaPath.status()).toBe(200);
  const found = (await viaPath.json()) as { result: { content: { text: string }[] } };
  expect(found.result.content[0]?.text).toContain('Brindle Health');

  // Dismissed, the token is gone from the page for good; the row stays.
  await fresh.getByRole('button', { name: 'Done, I have copied it' }).click();
  await expect(fresh).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(token);
  const row = page.getByRole('listitem', { name });
  await expect(row).toContainText('Live');
  await expect(row).toContainText(`…${token.slice(-4)}`);

  await row.getByRole('button', { name: `Revoke ${name}` }).click();
  await row.getByRole('button', { name: `Confirm revoking ${name}` }).click();
  await expect(row).toContainText('Revoked');

  const afterRevoke = await page.request.post('/api/mcp', {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    data: TOOLS_LIST,
  });
  expect(afterRevoke.status()).toBe(401);
});

test('the endpoint refuses a request with no token', async ({ request }) => {
  const response = await request.post('/api/mcp', {
    headers: { 'content-type': 'application/json' },
    data: TOOLS_LIST,
  });
  expect(response.status()).toBe(401);
  expect(response.headers()['www-authenticate']).toMatch(/^Bearer/);
});
