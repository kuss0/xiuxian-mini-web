import { test, expect } from '@playwright/test';

test.describe('Xiuxian Mini Web E2E Tests', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await page.setExtraHTTPHeaders({
      'CF-Connecting-IP': `e2e-page-${testInfo.project.name}-${testInfo.workerIndex}-${Date.now()}-${Math.random()}`,
    });
    await page.goto('http://127.0.0.1:8787');
  });

  test('should load homepage successfully', async ({ page }) => {
    await expect(page).toHaveTitle(/(修仙|Xiuxian) Mini Web/i);

    await expect(page.locator('#activeIdentityDock')).toBeVisible();
    await expect(page.locator('.schedule-workbench')).toBeVisible();
    await expect(page.locator('#scheduleRail')).toBeVisible();
    await expect(page.locator('.common-action-panel > summary')).toBeVisible();
    await expect(page.locator('#logsButton')).toHaveCount(1);
    await expect(page.locator('#messageList')).toHaveCount(0);
    await expect(page.locator('#quickFilters')).toHaveCount(0);
    await expect(page.locator('#directSendComposer')).toHaveCount(0);
  });

  test('should have all modules loaded', async ({ page }) => {
    // Wait for modules to load
    await page.waitForTimeout(1000);

    // Check console for module load messages
    const logs = [];
    page.on('console', msg => logs.push(msg.text()));

    await page.reload();
    await page.waitForTimeout(1000);

    expect(logs.some(log => log.includes('Module loader initialized'))).toBeTruthy();
    expect(logs.some(log => log.includes('DOM references loaded'))).toBeTruthy();
    expect(logs.some(log => log.includes('Message utilities loaded'))).toBeTruthy();
  });

  test('should have gzip compression enabled', async ({ page }) => {
    const response = await page.goto('http://127.0.0.1:8787/static/app.js');
    const headers = response.headers();

    expect(headers['content-encoding']).toBe('gzip');
  });

  test('should have security headers', async ({ page }) => {
    const response = await page.goto('http://127.0.0.1:8787/');
    const headers = response.headers();

    expect(headers['content-security-policy']).toBeDefined();
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-xss-protection']).toBe('1; mode=block');
  });

  test('should have rate limiting', async ({ request }, testInfo) => {
    const clientId = `e2e-${testInfo.project.name}-${Date.now()}-${Math.random()}`;
    const responses = await Promise.all(
      Array.from({ length: 65 }, () => request.get('http://127.0.0.1:8787/api/tianjige/status', {
        headers: { 'CF-Connecting-IP': clientId },
      }))
    );

    const statuses = responses.map((response) => response.status());
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
    expect(statuses.filter((status) => status === 200).length).toBeLessThanOrEqual(60);
  });

  test('should keep chat stream removed from the live page', async ({ page }) => {
    await page.waitForTimeout(2000);

    await expect(page.locator('.chat-secondary-shell')).toHaveCount(0);
    await expect(page.locator('#messageList')).toHaveCount(0);
    await expect(page.locator('#detailPanel')).toHaveCount(0);
    await expect(page.locator('#jumpToLatest')).toHaveCount(0);
  });

  test('should keep schedule workbench as the primary surface', async ({ page }) => {
    await page.waitForTimeout(1000);

    await expect(page.locator('.schedule-workbench')).toBeVisible();
    await expect(page.locator('#scheduleIdentityDock')).toBeVisible();
    await expect(page.locator('#scheduleIdentityFollowChatButton')).toHaveText('跟随当前身份');
  });

  test('should keep direct send composer removed', async ({ page }) => {
    await expect(page.locator('#directSendComposer')).toHaveCount(0);
    await expect(page.locator('#directSendInput')).toHaveCount(0);
    await expect(page.locator('#directSendSubmit')).toHaveCount(0);
    await expect(page.locator('#quickActionHotbar')).toHaveCount(0);
  });

  test('should have no console errors', async ({ page }) => {
    const errors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    await page.waitForTimeout(2000);

    // Filter out expected errors (like network errors in test environment)
    const unexpectedErrors = errors.filter(err =>
      !err.includes('net::ERR') &&
      !err.includes('Failed to fetch')
    );

    expect(unexpectedErrors).toHaveLength(0);
  });

  test('should have good performance', async ({ page }) => {
    const startTime = Date.now();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('.schedule-workbench')).toBeVisible();
    const loadTime = Date.now() - startTime;

    // Should load in less than 3 seconds
    expect(loadTime).toBeLessThan(3000);
  });
});
