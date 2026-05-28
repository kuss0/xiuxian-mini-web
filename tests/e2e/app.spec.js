import { test, expect } from '@playwright/test';

test.describe('Xiuxian Mini Web E2E Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://127.0.0.1:8787');
  });

  test('should load homepage successfully', async ({ page }) => {
    await expect(page).toHaveTitle(/Xiuxian Mini Web/i);

    // Check main elements are present
    await expect(page.locator('#messageList')).toBeVisible();
    await expect(page.locator('#channelFilters')).toBeVisible();
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

  test('should have rate limiting', async ({ page }) => {
    // Make multiple requests quickly
    const responses = [];
    for (let i = 0; i < 65; i++) {
      const response = await page.request.get('http://127.0.0.1:8787/api/health');
      responses.push(response);
    }

    // Last request should be rate limited
    const lastResponse = responses[responses.length - 1];
    expect(lastResponse.status()).toBe(429);
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

    const channelFilters = page.locator('#channelFilters');
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
    await page.goto('http://127.0.0.1:8787');
    await page.waitForLoadState('networkidle');
    const loadTime = Date.now() - startTime;

    // Should load in less than 3 seconds
    expect(loadTime).toBeLessThan(3000);
  });
});
