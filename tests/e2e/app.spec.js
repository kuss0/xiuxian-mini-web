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

    // Check main elements are present
    await expect(page.locator('#messageList')).toBeVisible();
    await expect(page.locator('#quickFilters')).toBeVisible();
    await expect(page.locator('#directSendComposer')).toBeVisible();
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

  test('should load messages', async ({ page }) => {
    // Wait for initial load
    await page.waitForTimeout(2000);

    // Check if message list is populated or shows empty state
    const messageList = page.locator('#messageList');
    await expect(messageList).toBeVisible();
  });

  test('should have working channel filters', async ({ page }) => {
    await page.waitForTimeout(1000);

    const channelFilters = page.locator('#quickFilters');
    await expect(channelFilters).toBeVisible();
  });

  test('should have working direct send composer', async ({ page }) => {
    const composer = page.locator('#directSendComposer');
    await expect(composer).toBeVisible();

    const input = page.locator('#directSendInput');
    await expect(input).toBeVisible();

    const submit = page.locator('#directSendSubmit');
    await expect(submit).toBeVisible();
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
    await expect(page.locator('#directSendComposer')).toBeVisible();
    const loadTime = Date.now() - startTime;

    // Should load in less than 3 seconds
    expect(loadTime).toBeLessThan(3000);
  });
});
