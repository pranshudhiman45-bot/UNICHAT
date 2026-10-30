import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import fs from 'node:fs/promises';

const API = 'http://localhost:4000/api';
type Account = { email: string; password: string };
async function accounts(): Promise<{ alex: Account; maya: Account }> { return JSON.parse(await fs.readFile('.local/test-accounts.json', 'utf8')); }

// Logins are rate limited (10 / 15 min / IP), so API tokens are fetched once and reused; access tokens last 15 min.
const tokenCache = new Map<string, string>();
async function apiLogin(request: APIRequestContext, account: Account) {
  const cached = tokenCache.get(account.email);
  if (cached) return cached;
  const response = await request.post(`${API}/auth/login`, { data: account });
  expect(response.ok(), `login failed: ${response.status()}`).toBeTruthy();
  const token = (await response.json()).accessToken as string;
  tokenCache.set(account.email, token);
  return token;
}
const call = async (request: APIRequestContext, token: string, method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, data?: unknown) => {
  const response = await request[method](`${API}${path}`, { headers: { authorization: `Bearer ${token}` }, data });
  return { status: response.status(), body: await response.json().catch(() => ({})) };
};

// A fresh workspace with alex (owner) and maya (member), so tests never depend on or alter seeded data.
async function workspaceWithTwoPeople(request: APIRequestContext, label: string) {
  const { alex, maya } = await accounts();
  const alexToken = await apiLogin(request, alex); const mayaToken = await apiLogin(request, maya);
  const created = await call(request, alexToken, 'post', '/workspaces', { name: `${label} ${Date.now()}` });
  expect(created.status).toBe(201);
  const workspace = created.body.workspace;
  const detail = await call(request, alexToken, 'get', `/workspaces/${workspace._id}`);
  const joined = await call(request, mayaToken, 'post', `/workspaces/join/${detail.body.workspace.inviteCode}`);
  expect(joined.status).toBe(202);
  const approval = await call(request, alexToken, 'post', `/workspaces/${workspace._id}/join-requests/${joined.body.request._id}/approve`);
  expect(approval.status).toBe(200);
  return { workspace, alexToken, mayaToken, alex, maya };
}

// One UI login per person for the whole file (logins are rate limited); each test opens a fresh page in that session.
const sessions = new Map<string, import('@playwright/test').BrowserContext>();
async function signIn(browser: Browser, account: Account, workspaceId: string): Promise<Page> {
  let context = sessions.get(account.email);
  if (!context) {
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const login = await context.newPage();
    await login.goto('/login');
    await login.getByLabel('Email address').fill(account.email);
    await login.getByLabel('Password', { exact: true }).fill(account.password);
    await login.getByRole('button', { name: 'Sign in to Unichat' }).click();
    await expect(login).toHaveURL(/\/workspaces/);
    await login.close();
    sessions.set(account.email, context);
  }
  const page = await context.newPage();
  await page.goto(`/chat/${workspaceId}`);
  await expect(page.getByRole('button', { name: /^general(?: |$)/ })).toBeVisible();
  return page;
}

test('join a public channel, post, and see membership changes live', async ({ browser, request }) => {
  const { workspace, alexToken, alex, maya } = await workspaceWithTwoPeople(request, 'E2E Channels');
  const alexPage = await signIn(browser, alex, workspace._id);
  const mayaPage = await signIn(browser, maya, workspace._id);

  // A new public channel appears for maya without a refresh, and she can preview it before joining.
  const channel = (await call(request, alexToken, 'post', '/channels', { workspaceId: workspace._id, name: 'launch', description: 'Launch planning' })).body.channel;
  await mayaPage.getByRole('button', { name: /^launch(?: |$)/ }).click();
  await expect(mayaPage.getByText('You are previewing')).toBeVisible();
  await expect(mayaPage.getByRole('button', { name: 'Join channel' })).toBeVisible();
  await mayaPage.getByRole('button', { name: 'Join channel' }).click();
  const composer = mayaPage.locator('.ProseMirror[contenteditable="true"]').last();
  await expect(composer).toBeVisible();

  // Messages flow live to the other member.
  await alexPage.getByRole('button', { name: /^launch(?: |$)/ }).click();
  await composer.fill('hello from maya');
  await composer.press('Enter');
  await expect(alexPage.getByText('hello from maya')).toBeVisible();

  // Alex opens channel details, promotes then removes maya.
  await alexPage.getByRole('button', { name: 'Channel details and members' }).click();
  const dialog = alexPage.getByRole('dialog');
  await expect(dialog.getByText('Maya', { exact: false }).first()).toBeVisible();
  await dialog.getByRole('button', { name: 'Make admin' }).click();
  await expect(dialog.getByRole('button', { name: 'Remove admin' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Remove admin' }).click();
  await expect(dialog.getByRole('button', { name: 'Make admin' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(dialog.getByLabel('Members').getByText('Maya', { exact: false })).toHaveCount(0);

  // Maya is told immediately: the conversation closes and she can no longer post, without reloading.
  await expect(mayaPage.getByText('No conversation selected')).toBeVisible();
  const recheck = await call(request, await apiLogin(request, maya), 'post', '/messages', { workspaceId: workspace._id, channelId: channel._id, content: 'should be refused' });
  expect(recheck.status).toBe(403);

  // The sole admin cannot leave while others remain; the UI surfaces the server's reason.
  await call(request, alexToken, 'post', `/channels/${channel._id}/invite`, { userIds: [(await call(request, alexToken, 'get', `/workspaces/${workspace._id}/members`)).body.members.find((m: any) => m.user.displayName !== undefined && m.role === 'member').user._id] });
  await alexPage.getByRole('button', { name: 'Leave channel' }).click();
  await alexPage.getByRole('button', { name: 'Yes, leave' }).click();
  await expect(alexPage.getByRole('alert')).toContainText(/only admin/i);
});

test('older history loads on demand without duplicates', async ({ browser, request }) => {
  const { workspace, alexToken, mayaToken, alex } = await workspaceWithTwoPeople(request, 'E2E History');
  const general = (await call(request, alexToken, 'get', `/channels/workspace/${workspace._id}`)).body.channels.find((c: any) => c.name === 'general');
  // 110 messages from two senders (each sender is limited to 60/minute).
  for (let i = 0; i < 55; i++) {
    expect((await call(request, alexToken, 'post', '/messages', { workspaceId: workspace._id, channelId: general._id, content: `history-${i * 2}` })).status).toBe(201);
    expect((await call(request, mayaToken, 'post', '/messages', { workspaceId: workspace._id, channelId: general._id, content: `history-${i * 2 + 1}` })).status).toBe(201);
  }
  const page = await signIn(browser, alex, workspace._id);
  await page.getByRole('button', { name: /^general(?: |$)/ }).click();
  await expect(page.getByText('history-109', { exact: true })).toBeVisible();
  await expect(page.getByText('history-0', { exact: true })).toHaveCount(0); // only the newest page is loaded
  await expect(page.getByRole('button', { name: 'Load earlier messages' })).toBeVisible();

  // Anchor on the oldest loaded message, load more, and check it did not jump.
  const anchor = page.getByText('history-60', { exact: true });
  await anchor.scrollIntoViewIfNeeded();
  const before = (await anchor.boundingBox())!.y;
  await page.getByRole('button', { name: 'Load earlier messages' }).evaluate((button) => (button as HTMLButtonElement).click()); // clicked inside the page: Playwright's own click would re-scroll the (moved) button into view afterwards, which a real user's click does not
  // Older pages load as the reader reaches the top; keep going until the very first message is present.
  for (let attempt = 0; attempt < 6 && await page.getByText('history-0', { exact: true }).count() === 0; attempt++) {
    const more = page.getByRole('button', { name: 'Load earlier messages' });
    if (await more.count()) await more.evaluate((button) => (button as HTMLButtonElement).click());
    await page.waitForTimeout(500);
  }
  await expect(page.getByText('history-0', { exact: true })).toBeAttached({ timeout: 10000 });
  const after = (await anchor.boundingBox())!.y;
  expect(Math.abs(after - before)).toBeLessThan(40);
  const ids = await page.locator('[data-message-id]').evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.messageId));
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.length).toBeGreaterThanOrEqual(110);
});

test('workspace members: roles, ownership transfer and leaving', async ({ browser, request }) => {
  const { workspace, alex, maya } = await workspaceWithTwoPeople(request, 'E2E Members');
  const alexPage = await signIn(browser, alex, workspace._id);
  const mayaPage = await signIn(browser, maya, workspace._id);

  await alexPage.locator('#workspace-sidebar button[aria-haspopup="dialog"]').click();
  await alexPage.getByRole('button', { name: 'Members & roles' }).click();
  const dialog = alexPage.getByRole('dialog', { name: new RegExp(`${workspace.name} members`) });
  await expect(dialog.getByText('owner', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Make admin' }).click();
  await expect(dialog.getByText('admin', { exact: true })).toBeVisible();

  // Transfer needs the exact workspace name typed in.
  await dialog.getByRole('button', { name: 'Make owner' }).click();
  const confirm = dialog.getByRole('button', { name: 'Transfer ownership' });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('Workspace name').fill(workspace.name);
  await confirm.click();
  await expect(dialog.getByText('owner', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Make owner' })).toHaveCount(0); // alex is no longer owner

  // Maya (new owner) cannot leave; alex (admin now) can, and is sent back to the workspace list.
  await mayaPage.locator('#workspace-sidebar button[aria-haspopup="dialog"]').click();
  await mayaPage.getByRole('button', { name: 'Members & roles' }).click();
  await expect(mayaPage.getByText('You are the owner. Transfer ownership before leaving.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Leave workspace' }).click();
  await dialog.getByRole('button', { name: 'Yes, leave' }).click();
  await expect(alexPage).toHaveURL(/\/workspaces/);
});
