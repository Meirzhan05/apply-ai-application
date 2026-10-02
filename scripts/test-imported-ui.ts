import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { initialDemoState } from '../src/lib/demo-data';
import { publicState } from '../src/lib/public-state';
import { saveOnboarding, activateAutomation } from '../src/lib/onboarding';
import { selectApplication } from '../src/lib/workflow';
import { createImportedCompatibilityRecord } from '../src/lib/import-compatibility';
import { recordApplicationBlocker } from '../src/lib/application-blockers';

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  await mkdir('.data/imports-qa', { recursive: true });
  try {
    for (const [device, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]] as const) {
      const state = initialDemoState();
      state.applications = [];
      state.jobs = [state.jobs[0]];
      const job = state.jobs[0];
      Object.assign(job, { source: 'imported', sourceLabel: 'Imported employer posting', url: 'https://employer.example/jobs/graduate-analyst', applyUrl: 'https://employer.example/jobs/graduate-analyst', importUrl: 'https://employer.example/jobs/graduate-analyst', importCheck: { status: 'unverified', checkedAt: new Date().toISOString() } });
      saveOnboarding(state.profile, { questionnaire: { workAuthorization: 'yes', requiresSponsorship: 'no' } });
      activateAutomation(state.profile, 'Controlled UI verification');
      const page = await browser.newPage({ viewport: { width, height } });
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
      let submitted = false;
      let requests = 0;
      let firstApplicationId: string | undefined;
      await page.route('**/api/state', route => route.fulfill({ json: publicState(state) }));
      await page.route('**/api/status', route => route.fulfill({ contentType: 'text/event-stream', body: `event: state\ndata: ${JSON.stringify(publicState(state))}\n\n` }));
      await page.route('**/api/actions', async route => {
        const { action, payload } = route.request().postDataJSON();
        assert.equal(action, 'preflightImportedPosting'); assert.equal(payload.jobId, job.id);
        submitted = true;
        requests += 1;
        const app = state.applications.find(item => item.jobId === job.id) ?? selectApplication(state, job.id, state.profile.id);
        if (firstApplicationId) assert.equal(app.id, firstApplicationId);
        firstApplicationId = app.id;
        app.status = 'needs_user_action';
        app.error = 'This employer requires login. Open the posting to continue.';
        app.importedCompatibility = createImportedCompatibilityRecord({ application: app, job, observed: { url: job.url }, status: 'blocked', blocker: app.error, controlled: true });
        app.importedOutcome = { version: 1, kind: 'blocked', at: new Date().toISOString(), evidence: app.error, synthetic: true };
        recordApplicationBlocker(app, 'login', app.error, { targetUrl: job.url });
        await route.fulfill({ json: { ok: true } });
      });
      await page.goto(process.env.TEST_UI_URL || 'https://apply-ai-chi.vercel.app');
      await page.getByRole('button', { name: 'Matches', exact: true }).click();
      const action = page.getByRole('button', { name: 'Verify and apply automatically', exact: true });
      await action.waitFor();
      await page.screenshot({ path: `.data/imports-qa/production-${device}-start.png`, fullPage: true });
      await action.click();
      await page.getByRole('region', { name: 'Automatic application outcome' }).waitFor();
      assert.equal(submitted, true);
      assert.equal(await page.getByText(appError(), { exact: false }).count() > 0, true);
      assert.equal(await page.getByText(/Application blocked · Controlled test evidence/).isVisible(), true);
      assert.equal(await page.getByText('EACH STEP NEEDS YOUR SAY', { exact: true }).count(), 0);
      assert.equal(await page.getByText('Start a fresh browser session', { exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Verify and apply automatically', exact: true }).count(), 0);
      const review = page.getByRole('region', { name: 'Blocked applications' });
      await review.waitFor();
      assert.equal(await review.getByRole('link', { name: 'Open employer posting', exact: true }).getAttribute('href'), job.url);
      assert.equal(await review.getByText(/browser session is closed/).isVisible(), true);
      assert.equal(await review.getByRole('button', { name: 'Check employer link again', exact: true }).count(), 1);
      await review.getByRole('button', { name: 'Check employer link again', exact: true }).click();
      await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).some(button => button.textContent === 'Check employer link again' && !button.disabled));
      assert.equal(requests, 2);
      assert.equal(state.applications.length, 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `.data/imports-qa/production-${device}-blocked.png`, fullPage: true });
      console.log(`PASS ${device}: one imported verify/apply action, public payload, honest login blocker, no overflow/runtime errors (synthetic intercepted state)`);
      await page.close();
    }
  } finally { await browser.close(); }
}
function appError() { return 'This employer requires login.'; }
main().catch(error => { console.error(error.message); process.exitCode = 1; });
