/**
 * Load every page against a running server and fail on anything the browser
 * complains about.
 *
 * This is deliberately not a `node:test` file: it needs a server on port 4004
 * and a Chromium, which the unit and service tests do not, so CI runs it as its
 * own step. Run it locally with the server already up:
 *
 *     npm start &
 *     node test/smoke-ui.mjs
 *
 * It exists because every UI defect this project hit was invisible to the
 * service tests - a blank Fiori page, a chart that never drew, a table that
 * threw on an empty result. All of them announced themselves in the console.
 */

import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:4004';

/** Pages, and something that must be on each one before it counts as loaded. */
const PAGES = [
  { path: '/index.html', expect: '.app-header' },
  { path: '/command-center/index.html', expect: '.app-header' },
  { path: '/api/index.html', expect: '.app-header' },
];

const VIEWS = ['checkout-integrity', 'replenishment', 'fresh-waste', 'demand-forecast',
  'basket-affinity', 'personal-offers', 'cold-chain', 'insight-feed'];
for (const view of VIEWS) {
  PAGES.push({ path: `/scenarios/index.html?view=${view}`, expect: '#kpis .stat-value' });
}

/**
 * Noise that is not a defect. Kept explicit and narrow: a broad filter here
 * would quietly disarm the whole check.
 */
const IGNORE = [
  /favicon\.ico/i,
];

const failures = [];

// CI installs the browser that matches the pinned Playwright. Some sandboxes
// ship a single shared Chromium instead, which will not be where Playwright
// looks for it, so allow the path to be pointed at directly.
const browser = await chromium.launch(
  process.env.SMOKE_CHROMIUM ? { executablePath: process.env.SMOKE_CHROMIUM } : {},
);
const context = await browser.newContext({
  httpCredentials: { username: 'manager', password: 'manager' },
});

for (const { path, expect } of PAGES) {
  const page = await context.newPage();
  const problems = [];

  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (IGNORE.some((pattern) => pattern.test(text))) return;
    problems.push(`console error: ${text}`);
  });
  page.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`));
  page.on('requestfailed', (request) => {
    if (IGNORE.some((pattern) => pattern.test(request.url()))) return;
    problems.push(`request failed: ${request.url()} (${request.failure()?.errorText})`);
  });
  page.on('response', (response) => {
    if (response.status() < 400) return;
    if (IGNORE.some((pattern) => pattern.test(response.url()))) return;
    problems.push(`HTTP ${response.status()}: ${response.url()}`);
  });

  try {
    const response = await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 30000 });
    if (!response || !response.ok()) {
      problems.push(`navigation returned ${response ? response.status() : 'nothing'}`);
    }
    // Waiting for a real element rather than a timeout: a page that renders
    // nothing is exactly the failure this is here to catch.
    await page.waitForSelector(expect, { timeout: 15000 });
  } catch (error) {
    problems.push(`did not finish loading: ${error.message}`);
  }

  if (problems.length) {
    failures.push({ path, problems });
    console.log(`FAIL ${path}`);
    for (const problem of problems) console.log(`       ${problem}`);
  } else {
    console.log(`ok   ${path}`);
  }
  await page.close();
}

await browser.close();

if (failures.length) {
  console.error(`\n${failures.length} of ${PAGES.length} pages failed.`);
  process.exit(1);
}
console.log(`\nAll ${PAGES.length} pages loaded cleanly.`);
