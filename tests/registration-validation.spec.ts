import { test, expect } from '@playwright/test';

test('signup explains email-as-username and submits corrected details without OTP', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 714 });
  let registrations = 0;
  let otpRequests = 0;
  await page.route('**/api/auth/config', route => route.fulfill({ json: { emailVerificationRequired: false, googleEnabled: false } }));
  await page.route('**/api/auth/email-verification/request', route => { otpRequests++; return route.fulfill({ json: {} }); });
  await page.route('**/api/auth/register', route => {
    registrations++;
    expect(route.request().postDataJSON().username).toBe('jordan.lee');
    return route.fulfill({ status: 409, json: { error: 'email already in use' } });
  });
  await page.goto('/register');
  await page.getByLabel('Full name', { exact: true }).fill('Jordan Lee');
  await page.getByLabel('Username', { exact: true }).fill('jordan.lee@gmail.com');
  await page.getByLabel('Email address', { exact: true }).fill('jordan.lee@example.test');
  await page.getByLabel('Password', { exact: true }).fill('A test passphrase 2026!');
  await page.getByRole('button', { name: 'Create your account' }).click();
  await expect(page.getByRole('alert')).toContainText('Choose a username such as jordan.lee');
  await expect(page.getByLabel('Username', { exact: true })).toBeFocused();
  expect(registrations).toBe(0);
  await page.getByLabel('Username', { exact: true }).fill('jordan.lee');
  await page.getByLabel('Password', { exact: true }).fill('short');
  await page.getByRole('button', { name: 'Create your account' }).click();
  await expect(page.getByRole('alert')).toContainText('at least 8 characters');
  await page.getByLabel('Password', { exact: true }).fill('A test passphrase 2026!');
  await page.getByRole('button', { name: 'Create your account' }).click();
  await expect(page.getByText('email already in use', { exact: true })).toBeVisible();
  expect(registrations).toBe(1);
  expect(otpRequests).toBe(0);
});
