import { test, expect } from '@playwright/test';
import { io } from 'socket.io-client';
async function roomAccess(token: string, event: string, id: string) {
  const socket = io(process.env.APPROVAL_TEST_API!.replace(/\/api$/, ''), { auth: { token }, transports: ['websocket'], reconnection: false });
  try {
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    return await socket.timeout(3000).emitWithAck(event, id);
  } finally { socket.disconnect(); }
}

test('creator reviews join requests before members can open the workspace', async ({ browser }) => {
  test.skip(!process.env.APPROVAL_TEST_API, 'Run npm --prefix backend run test:workspace-approval for isolated services.');
  const ownerContext = await browser.newContext({ baseURL: process.env.PLAYWRIGHT_BASE_URL });
  const memberContext = await browser.newContext({ baseURL: process.env.PLAYWRIGHT_BASE_URL, viewport: { width: 400, height: 714 } });
  const owner = await ownerContext.newPage(); const member = await memberContext.newPage();
  const errors: string[] = []; owner.on('pageerror', error => errors.push(error.message)); member.on('pageerror', error => errors.push(error.message));
  async function signup(page: typeof owner, name: string, handle: string) {
    await page.goto('/register');
    await page.getByLabel('Full name', { exact: true }).fill(name);
    await page.getByLabel('Username', { exact: true }).fill(handle);
    await page.getByLabel('Email address', { exact: true }).fill(`${handle}@example.test`);
    await page.getByLabel('Password', { exact: true }).fill('A strong browser passphrase!');
    const registered = page.waitForResponse(response => response.url().endsWith('/api/auth/register'));
    await page.getByRole('button', { name: 'Create your account' }).click();
    await expect(page).toHaveURL(/\/workspaces$/);
    return await (await registered).json();
  }
  await signup(owner, 'Workspace Owner', 'workspace_owner');
  await owner.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await owner.getByLabel('Workspace name').fill('Handshake Studio');
  const created = owner.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/workspaces'));
  await owner.getByRole('button', { name: 'Create', exact: true }).click();
  const { workspace, channels } = await (await created).json();
  await expect(owner).toHaveURL(/\/chat\//);
  const memberAuth = await signup(member, 'Pending Member', 'pending_member');
  await member.getByRole('button', { name: 'Join with code' }).click();
  await member.getByLabel('Invite code').fill(workspace.inviteCode);
  await member.getByRole('button', { name: 'Request to join', exact: true }).click();
  await expect(member.getByText('Waiting for administrator approval')).toBeVisible();
  expect((await roomAccess(memberAuth.accessToken, 'workspace:join', workspace._id)).ok).toBe(false);
  expect((await roomAccess(memberAuth.accessToken, 'channel:join', channels[0]._id)).ok).toBe(false);
  await member.reload();
  await expect(member.getByText('Waiting for administrator approval')).toBeVisible();
  await member.goto(`/chat/${workspace._id}`);
  await expect(member.getByText('This workspace is unavailable')).toBeVisible();
  await member.goto('/workspaces');
  // Owner receives activity while chatting; it links directly to the review queue.
  await owner.getByRole('button', { name: /^Activity/ }).click();
  await owner.getByRole('button', { name: /Open activity: .*requested to join/ }).click();
  await expect(owner.getByRole('heading', { name: 'Manage access · Handshake Studio' })).toBeVisible();
  await expect(owner.getByText('@pending_member · pending_member@example.test')).toBeVisible();
  await owner.screenshot({ path: '.local/qa/join-approval-desktop.png', fullPage: true });
  await member.screenshot({ path: '.local/qa/join-pending-mobile.png', fullPage: true });
  await owner.getByRole('button', { name: 'Approve Pending Member', exact: true }).click();
  await expect(owner.getByText('Member approved. They can now open the workspace.')).toBeVisible();
  await expect(member.getByRole('button', { name: /Handshake Studio/ })).toBeVisible();
  expect((await roomAccess(memberAuth.accessToken, 'channel:join', channels[0]._id)).ok).toBe(true);
  await member.getByRole('button', { name: /Handshake Studio/ }).click();
  await expect(member.locator('[contenteditable="true"]')).toBeVisible();
  await member.locator('[contenteditable="true"]').fill('Approved and ready to collaborate.');
  await member.locator('[contenteditable="true"]').press('Enter');
  await expect(member.getByText('Approved and ready to collaborate.', { exact: true })).toBeVisible();
  const rejectedContext = await browser.newContext({ baseURL: process.env.PLAYWRIGHT_BASE_URL });
  const rejected = await rejectedContext.newPage();
  await signup(rejected, 'Rejected Applicant', 'rejected_applicant');
  await rejected.getByRole('button', { name: 'Join with code' }).click();
  await rejected.getByLabel('Invite code').fill(workspace.inviteCode);
  await rejected.getByRole('button', { name: 'Request to join', exact: true }).click();
  await owner.getByRole('button', { name: 'Reject Rejected Applicant', exact: true }).click();
  await expect(rejected.getByText('Request declined · Contact the workspace administrator')).toBeVisible();
  await rejected.reload();
  await expect(rejected.getByText('Request declined · Contact the workspace administrator')).toBeVisible();
  await expect(rejected.getByRole('button', { name: /Handshake Studio/ })).toHaveCount(0);
  expect(errors).toEqual([]);
  await Promise.all([ownerContext.close(), memberContext.close(), rejectedContext.close()]);
});
