import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { initialDemoState } from "../src/lib/demo-data";
import { publicState } from "../src/lib/public-state";
import { updateJobFeedback } from "../src/lib/job-feedback";
import { matchKey } from "../src/lib/match-cache";
import { assessMatchLocally } from "../src/lib/matching";

async function main() {
  const origin = process.env.TEST_MATCHES_URL || "http://localhost:3008";
  const demoState = initialDemoState();
  demoState.jobs.forEach((job, index) => { job.postedAt = new Date(Date.now() - index * 86400000).toISOString(); });
  const intern = demoState.jobs.find(job => job.id === "demo-engineering-intern")!;
  // Deliberately exercise a high-fit assessment with unresolved eligibility;
  // ranking policy changes must not remove this presentation regression case.
  demoState.matchCache = { [matchKey(demoState.profile, intern)]: { ...assessMatchLocally(demoState.profile, intern), category: "strong" } };
  let fixture = publicState(demoState);
  let failFeedback = false;
  let slowFeedback = false;
  let failImport = false;
  let authImport = false;
  let authFeedback = false;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    const page = await browser.newPage();
    // Drive the shipped component with invented applicant/jobs. No account,
    // provider calls, application approvals or submissions are involved.
    await page.route("**/api/state", route => route.fulfill({ json: fixture }));
    await page.route("**/api/status", route => route.fulfill({ contentType: "text/event-stream", body: `event: state\ndata: ${JSON.stringify(fixture)}\n\n` }));
    await page.route("**/api/actions", async route => {
      const body = route.request().postDataJSON();
      if (body.action === "import") {
        if (authImport) { authImport = false; return route.fulfill({ status: 401, json: { error: "AUTH_REQUIRED" } }); }
        if (fixture.jobs.some(job => job.url === body.payload.url)) return route.fulfill({ status: 409, json: { error: "This link is already in your catalog." } });
        if (failImport) { failImport = false; return route.fulfill({ status: 503, json: { error: "Posting unavailable. Check the link or try later." } }); }
        await new Promise(resolve => setTimeout(resolve, 750));
        const job = { ...intern, id: "synthetic-import", company: body.payload.company, title: body.payload.title, url: body.payload.url, importUrl: body.payload.url, requirements: [], source: "imported" as const, sourceLabel: "Imported link", importCheck: { status: "manual" as const, checkedAt: new Date().toISOString() } };
        fixture.jobs.push(job);
        fixture.matches.push({ jobId: job.id, assessment: assessMatchLocally(fixture.profile, job) });
        return route.fulfill({ json: { ok: true } });
      }
      assert.equal(body.action, "feedback", "Only synthetic feedback/import actions are allowed in this test");
      assert.ok(["saved", "dismissed", "clear"].includes(body.payload.kind));
      if (authFeedback) { authFeedback = false; return route.fulfill({ status: 401, json: { error: "AUTH_REQUIRED" } }); }
      if (failFeedback) { failFeedback = false; return route.fulfill({ status: 503, json: { error: "Feedback could not be saved. Try again." } }); }
      if (slowFeedback) { slowFeedback = false; await new Promise(resolve => setTimeout(resolve, 750)); }
      updateJobFeedback(fixture, body.payload);
      return route.fulfill({ json: { ok: true } });
    });
    await mkdir(".data", { recursive: true });
    for (const [label, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]] as const) {
      await page.setViewportSize({ width, height });
      fixture = publicState(structuredClone(demoState));
      await page.goto(origin);
      const strongRole = page.getByRole("article", { name: "Software Engineering Intern Cedar Systems", exact: true });
      await strongRole.waitFor();
      if (label === "desktop") {
        const activity = page.locator("#matches-activity");
        const activityLauncher = page.getByRole("button", { name: "Activity", exact: true });
        assert.equal(await activity.isVisible(), false, "Quiet activity should leave room for role review");
        await activityLauncher.click();
        await activity.getByRole("heading", { name: "Agent activity", exact: true }).waitFor();
        assert.equal(await activity.getByText("Demo listings do not run live source checks.", { exact: true }).isVisible(), true);
        assert.equal(await activity.getByText("About every 4 hours", { exact: true }).count(), 0);
        await page.keyboard.press("Escape");
        assert.equal(await activity.isVisible(), false);
        assert.equal(await activityLauncher.evaluate(element => element === document.activeElement), true);
      }
      assert.equal(await strongRole.getByText("Strong fit", { exact: true }).isVisible(), true);
      const context = "Software Engineering Intern at Cedar Systems";
      const jobButton = (name: string) => strongRole.getByRole("button", { name: `${name} ${context}`, exact: true });
      assert.equal(await page.locator(".profile-context").getByText("Work authorization needs confirmation.", { exact: true }).isVisible(), true, "Strong fit must not conceal unresolved eligibility information");
      const setup = page.locator(".setup-context");
      assert.equal(await setup.isVisible(), true, "Incomplete setup must be discoverable before the role list");
      await setup.locator("summary").click();
      assert.equal(await setup.getByRole("list").getByText("sponsorship answer", { exact: true }).isVisible(), true);
      await setup.getByRole("button", { name: "Review profile", exact: false }).click();
      await page.getByRole("heading", { name: "Your profile", exact: true }).waitFor();
      assert.equal(await page.locator("#setup-workAuthorization").evaluate(element => element === document.activeElement), true, "Setup action focuses the next missing answer");
      await page.getByRole("button", { name: "Matches", exact: true }).click();
      assert.equal(await setup.getAttribute("open"), null);
      assert.equal(await strongRole.locator(".fit-highlight").isVisible(), true, "Show positive evidence without opening details");
      assert.equal(await strongRole.locator(".preparation-note").count(), 0, "Shared preparation guidance must not repeat in every role");
      await page.evaluate(() => window.scrollTo(0, 0));
      const firstRoleBox = await page.getByRole("article").first().boundingBox();
      assert.ok(firstRoleBox && firstRoleBox.y < height, "The first role must begin in the initial viewport");
      assert.equal(await strongRole.locator(".fit-highlight").innerText(), "Posting: React · Your confirmed experience: Built a React portfolio project");
      if (label === "mobile") {
        const prepareBox = await jobButton("Prepare application for").boundingBox();
        assert.ok(prepareBox && prepareBox.y + prepareBox.height <= height, "One complete opportunity and its preparation action should fit in the opening phone viewport");
      }
      if (label === "mobile") {
        const morePages = page.getByRole("button", { name: "More pages", exact: true });
        await morePages.click();
        await page.getByRole("link", { name: "AI usage", exact: true }).waitFor();
        await page.locator("#more-pages").getByRole("button", { name: "Agent activity", exact: true }).click();
        await page.locator("#matches-activity").getByRole("heading", { name: "Agent activity", exact: true }).waitFor();
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("#matches-activity").isVisible(), false);
        assert.equal(await page.locator("#more-pages").getByRole("button", { name: "Agent activity", exact: true }).evaluate(element => element === document.activeElement), true, "Closing nested activity returns focus to its More entry");
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "More pages");
        assert.equal(await morePages.evaluate(element => element === document.activeElement), true, "Closing auxiliary navigation restores focus");
        await page.getByRole("button", { name: /^Filter and sort/ }).click();
      }
      assert.equal(await page.getByRole("combobox", { name: "Sort roles" }).getAttribute("aria-describedby"), "sort-help");
      assert.equal(await page.getByText("Relevance considers fit and your feedback.", { exact: true }).isVisible(), true);
      await page.locator(".fit-guide summary").click();
      assert.equal(await page.getByText("Fit compares the posting with your confirmed profile and search preferences. It does not confirm eligibility or guarantee an offer.", { exact: true }).isVisible(), true);
      await page.locator(".fit-guide summary").click();
      assert.equal(await strongRole.locator(".match-reasons").isVisible(), false, "Full reasoning is disclosed on request");
      await strongRole.locator(".fit-evidence summary").click();
      assert.equal(await strongRole.locator(".evidence-comparison").getByText("Built a React portfolio project", { exact: true }).isVisible(), true);
      assert.equal(await strongRole.locator(".match-reasons").getByText("No confirmed evidence yet for TypeScript.", { exact: true }).isVisible(), true, "Disclosure must preserve every missing requirement");
      await strongRole.locator(".fit-evidence summary").click();
      const query = page.getByRole("searchbox", { name: "Search roles or companies" });
      await query.fill("cedar engineering");
      assert.equal(await page.getByRole("article").count(), 1, "Search matches company and title case-insensitively");
      assert.equal(await page.getByRole("button", { name: "Any fit 1", exact: true }).isVisible(), true);
      assert.equal(await page.getByRole("button", { name: "Strong 1", exact: true }).isVisible(), true);
      assert.equal(await page.getByRole("button", { name: "Possible 0", exact: true }).isVisible(), true);
      assert.equal(await page.locator(".result-summary").innerText(), '1 role in all roles for “cedar engineering”');
      await query.fill("no-company-has-this-name");
      await page.getByRole("heading", { name: "No roles match your search", exact: true }).waitFor();
      await page.getByRole("button", { name: "Clear search", exact: true }).last().click();
      assert.equal(await page.getByRole("article").count(), 3);
      await page.getByRole("combobox", { name: "Sort roles" }).selectOption("newest");
      assert.equal(await page.getByRole("article").first().getByRole("heading").innerText(), "Junior Product Analyst");
      await page.getByRole("combobox", { name: "Sort roles" }).selectOption("relevant");
      const savedBox = await page.getByRole("button", { name: "Saved 0", exact: true }).boundingBox();
      assert.ok(savedBox && savedBox.x >= 0 && savedBox.x + savedBox.width <= width, "Saved must be visible without horizontal filter scrolling");
      const launcher = page.getByRole("button", { name: "+ Import a job link", exact: true });
      await launcher.click();
      const dialog = page.getByRole("dialog", { name: "Import a job link" });
      await dialog.waitFor();
      assert.equal(await page.getByRole("textbox", { name: "Job URL (required)", exact: true }).evaluate(element => element === document.activeElement), true, "Opening import moves focus into its input");
      for (let step = 0; step < 9; step++) {
        await page.keyboard.press("Tab");
        assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true, "Tab must stay inside the modal");
      }
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      assert.equal(await launcher.evaluate(element => element === document.activeElement), true, "Closing import restores launcher focus");
      const dismissLauncher = jobButton("Dismiss");
      await dismissLauncher.click();
      await page.getByRole("button", { name: "Dismissed 1", exact: true }).waitFor();
      assert.equal(fixture.feedback.find(item => item.jobId === intern.id)?.reason, undefined, "Quick dismissal must not invent a reason");
      await page.locator(".feedback-options summary").click();
      const reasonLauncher = page.getByRole("button", { name: "Add a reason (optional)", exact: true });
      await reasonLauncher.click();
      const dismissDialog = page.getByRole("dialog", { name: "Add a dismissal reason" });
      await dismissDialog.waitFor();
      assert.equal(await dismissDialog.getByText(context, { exact: true }).isVisible(), true);
      assert.equal(await dismissDialog.getAttribute("aria-describedby"), "dismiss-role-context");
      assert.equal(await dismissDialog.getByRole("combobox", { name: "Reason" }).inputValue(), "");
      assert.equal(await dismissDialog.getByRole("combobox", { name: "Reason" }).evaluate(element => element === document.activeElement), true);
      await page.keyboard.press("Escape");
      await dismissDialog.waitFor({ state: "hidden" });
      assert.equal(await reasonLauncher.evaluate(element => element === document.activeElement), true);
      await reasonLauncher.click();
      await dismissDialog.getByRole("combobox", { name: "Reason" }).selectOption("Location is not right");
      authFeedback = true;
      await dismissDialog.getByRole("button", { name: "Save reason", exact: true }).click();
      await dismissDialog.getByRole("alert").getByText(/Sign in to open your workspace/).waitFor();
      assert.equal(await dismissDialog.getByRole("link", { name: "Sign in", exact: true }).getAttribute("href"), "/login");
      assert.doesNotMatch(await dismissDialog.getByRole("alert").innerText(), /AUTH_REQUIRED/);
      await dismissDialog.getByRole("button", { name: "Save reason", exact: true }).click();
      await dismissDialog.waitFor({ state: "hidden" });
      assert.equal(fixture.feedback.find(item => item.jobId === intern.id)?.reason, "Location is not right");
      await page.getByRole("button", { name: "Undo dismissal", exact: true }).click();
      await strongRole.waitFor();
      assert.match(await strongRole.locator(".fit-evidence summary").getAttribute("aria-label") ?? "", /2 things to check/);
      assert.equal(await page.getByRole("button", { name: "Matches", exact: true }).getAttribute("aria-current"), "page");
      assert.equal(await page.getByRole("button", { name: "Any fit 3", exact: true }).getAttribute("aria-pressed"), "true");
      for (const control of await strongRole.locator(".small-actions button, .dark-button, .job-link").all()) {
        const box = await control.boundingBox();
        assert.ok(box && box.width >= 44 && box.height >= 44, "Job actions need at least 44px targets");
      }
      await page.getByRole("button", { name: "Saved 0", exact: true }).click();
      await page.getByRole("heading", { name: "Your shortlist starts here", exact: true }).waitFor();
      await page.getByRole("button", { name: "Browse matches", exact: true }).click();
      failFeedback = true;
      await jobButton("Save").click();
      await strongRole.getByRole("alert").getByText("Feedback could not be saved. Try again.", { exact: true }).waitFor();
      assert.equal(await jobButton("Save").isVisible(), true, "Failed feedback must not invent a saved state");
      await strongRole.getByRole("button", { name: "Refresh workspace", exact: true }).click();
      await strongRole.getByRole("alert").waitFor({ state: "hidden" });
      slowFeedback = true;
      await jobButton("Save").click();
      await strongRole.getByText("Updating…", { exact: true }).waitFor();
      assert.equal(await jobButton("Save").isDisabled(), true);

      await jobButton("Unsave").waitFor();
      await page.getByRole("button", { name: "Saved 1", exact: true }).click();
      assert.equal(await page.getByRole("article").count(), 1);
      await page.getByRole("button", { name: "Strong 1", exact: true }).click();
      assert.equal(await page.getByRole("button", { name: "Saved 1", exact: true }).getAttribute("aria-pressed"), "true", "Fit changes must retain Saved scope");
      assert.equal(await page.getByRole("article").count(), 1);
      await page.getByRole("button", { name: "Uncertain 0", exact: true }).click();
      await page.getByRole("heading", { name: "No uncertain fit roles in saved", exact: true }).waitFor();
      await page.getByRole("button", { name: "Show any fit in this collection", exact: true }).click();
      await jobButton("Unsave").click();
      await page.getByRole("heading", { name: "Your shortlist starts here", exact: true }).waitFor();
      assert.equal(await page.locator("#matches-heading").evaluate(element => element === document.activeElement), true, "Unsave of the last Saved role hands focus to the heading");
      await page.getByRole("button", { name: "Browse matches", exact: true }).click();
      await jobButton("Save").click();
      await jobButton("Unsave").waitFor();
      await page.getByRole("button", { name: "Saved 1", exact: true }).click();
      await jobButton("Dismiss").click();
      await page.getByRole("button", { name: "Dismissed 1", exact: true }).waitFor();
      assert.equal(await page.getByRole("article").count(), 0);
      assert.equal(await page.getByRole("heading", { name: "Your next opportunities", exact: true }).evaluate(element => element === document.activeElement), true, "Removing the last visible role leaves focus at the view heading");
      await page.getByRole("button", { name: "Undo dismissal", exact: true }).click();
      await jobButton("Unsave").waitFor();
      assert.equal(await page.getByRole("article").count(), 1, "Undo restores both the role and its previous saved state");
      await page.getByRole("button", { name: "All roles 3", exact: true }).click();
      await jobButton("Dismiss").click();
      await page.getByRole("button", { name: "Dismissed 1", exact: true }).click();
      assert.equal(await page.getByRole("article").count(), 1);
      await jobButton("Restore role").click();
      await page.getByRole("heading", { name: "No dismissed roles", exact: true }).waitFor();
      assert.equal(await page.locator("#matches-heading").evaluate(element => element === document.activeElement), true, "Restore of the last Dismissed role hands focus to the heading");
      await page.getByRole("button", { name: "Browse matches", exact: true }).click();
      assert.equal(await page.getByRole("article").count(), 3);
      await page.getByRole("button", { name: "Close feedback message", exact: true }).click();
      await page.getByRole("button", { name: "Matches", exact: true }).focus();
      await page.keyboard.press("/");
      assert.equal(await query.evaluate(element => element === document.activeElement), true);
      await page.getByRole("button", { name: "Matches", exact: true }).focus();
      await page.keyboard.press("j");
      assert.equal(await page.getByRole("article").first().evaluate(element => element === document.activeElement), true);
      await launcher.click();
      const url = page.getByRole("textbox", { name: "Job URL (required)", exact: true });
      assert.equal(await dialog.getByRole("button", { name: "Add role", exact: true }).isDisabled(), true);
      await url.fill("http://company.example/role");
      await url.blur();
      assert.equal(await dialog.getByText("Use an HTTPS job link.", { exact: true }).isVisible(), true);
      await url.fill("https://boards.greenhouse.io/team/jobs/123");
      assert.equal(await dialog.getByRole("textbox", { name: "Company (required)", exact: true }).count(), 0);
      assert.equal(await dialog.getByRole("button", { name: "Add role", exact: true }).isEnabled(), true);
      await url.fill("https://company.example/careers/role");
      await dialog.getByRole("textbox", { name: "Company (required)", exact: true }).fill("Example");
      assert.equal(await dialog.getByRole("button", { name: "Add role", exact: true }).isDisabled(), true);
      await dialog.getByRole("textbox", { name: "Job title (required)", exact: true }).fill("Analyst");
      assert.equal(await dialog.getByRole("button", { name: "Add role", exact: true }).isEnabled(), true);
      authImport = true;
      await dialog.getByRole("button", { name: "Add role", exact: true }).click();
      await dialog.getByRole("alert").getByText(/Sign in to open your workspace/).waitFor();
      assert.equal(await dialog.getByRole("link", { name: "Sign in", exact: true }).getAttribute("href"), "/login");
      assert.doesNotMatch(await dialog.getByRole("alert").innerText(), /Check the link|AUTH_REQUIRED/);
      assert.equal(await url.inputValue(), "https://company.example/careers/role");
      failImport = true;
      await dialog.getByRole("button", { name: "Add role", exact: true }).click();
      await dialog.getByRole("alert").getByText(/Posting unavailable/).waitFor();
      assert.equal(await url.inputValue(), "https://company.example/careers/role", "Failed import preserves the entered link");
      assert.equal(await dialog.getByRole("textbox", { name: "Company (required)", exact: true }).inputValue(), "Example");
      await page.keyboard.press("Escape");
      await jobButton("Save").click();
      await page.getByRole("button", { name: "Saved 1", exact: true }).click();
      await page.getByRole("button", { name: "Strong 1", exact: true }).click();
      await query.fill("Cedar");
      await page.getByRole("combobox", { name: "Sort roles" }).selectOption("newest");
      await launcher.click();
      await page.reload();
      await dialog.waitFor();
      assert.equal(await url.inputValue(), "https://company.example/careers/role", "Reload restores the unfinished import");
      assert.equal(await dialog.getByRole("textbox", { name: "Company (required)", exact: true }).inputValue(), "Example");
      assert.equal(await query.inputValue(), "Cedar", "Reload restores the search");
      assert.equal(await page.getByRole("button", { name: "Saved 1", exact: true }).getAttribute("aria-pressed"), "true");
      assert.equal(await page.getByRole("button", { name: "Strong 1", exact: true, includeHidden: true }).getAttribute("aria-pressed"), "true");
      assert.equal(await page.getByRole("combobox", { name: "Sort roles", includeHidden: true }).inputValue(), "newest");
      await dialog.getByRole("button", { name: "Add role", exact: true }).click();
      await dialog.getByRole("button", { name: "Checking and adding…", exact: true }).waitFor();
      assert.equal(await dialog.getByRole("button", { name: "Checking and adding…", exact: true }).isDisabled(), true);
      await dialog.waitFor({ state: "hidden" });
      const imported = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Analyst", exact: true }) });
      await imported.waitFor();
      assert.equal(await page.getByRole("article").count(), 1, "Import reveals its specific opportunity, rather than the full list");
      assert.equal(await imported.evaluate(element => element === document.activeElement), true, "Import moves focus to its role");
      assert.equal(await page.locator(".feedback-summary").getByText("Added Analyst at Example. Review the posting details and fit below.", { exact: true }).isVisible(), true);
      await page.getByRole("button", { name: "Return to previous view", exact: true }).click();
      await strongRole.waitFor();
      assert.equal(await query.inputValue(), "Cedar");
      assert.equal(await page.getByRole("button", { name: "Saved 1", exact: true }).getAttribute("aria-pressed"), "true");
      assert.equal(await page.getByRole("button", { name: "Strong 1", exact: true, includeHidden: true }).getAttribute("aria-pressed"), "true");
      assert.equal(await page.getByRole("combobox", { name: "Sort roles", includeHidden: true }).inputValue(), "newest");
      await launcher.click();
      await url.fill("https://company.example/careers/role");
      await dialog.getByRole("textbox", { name: "Company (required)", exact: true }).fill("Example");
      await dialog.getByRole("textbox", { name: "Job title (required)", exact: true }).fill("Analyst");
      await dialog.getByRole("button", { name: "Add role", exact: true }).click();
      await dialog.getByRole("alert").getByText(/This role is already in your list/).waitFor();
      await dialog.getByRole("button", { name: "Review existing role", exact: true }).click();
      await imported.waitFor();
      assert.equal(fixture.jobs.length, 4, "Duplicate import recovery must not create another role");
      await page.getByRole("button", { name: "Return to previous view", exact: true }).click();
      await strongRole.waitFor();
      await launcher.click();
      await dialog.getByRole("button", { name: "Discard draft", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      await page.reload();
      await strongRole.waitFor();
      assert.equal(await dialog.count(), 0, "Discarded import must not reopen after reload");
      await launcher.click();
      assert.equal(await url.inputValue(), "", "Discard clears the stored import fields");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: /^All roles / }).click();
      if (label === "mobile") await page.getByRole("button", { name: /^Filter and sort/ }).click();
      await page.getByRole("button", { name: /^Any fit / }).click();
      await query.fill("");
      await page.getByRole("combobox", { name: "Sort roles" }).selectOption("relevant");
      await page.evaluate(owner => sessionStorage.removeItem(`apply-ai:matches:${owner}`), fixture.profile.id);
      for (const kind of ["saved", "dismissed"] as const) {
        fixture = publicState(structuredClone(demoState));
        fixture.jobs.forEach(job => updateJobFeedback(fixture, { jobId: job.id, kind }));
        await page.reload();
        await page.getByRole("button", { name: kind === "saved" ? "Saved 3" : "Dismissed 3", exact: true }).click();
        const nextTitle = await page.getByRole("article").nth(2).getByRole("heading").innerText();
        await page.getByRole("article").nth(1).getByRole("button", { name: kind === "saved" ? /^Unsave / : /^Restore role / }).click();
        await page.waitForFunction(() => document.querySelectorAll(".job-row").length === 2);
        assert.equal(await page.getByRole("article").filter({ has: page.getByRole("heading", { name: nextTitle, exact: true }) }).evaluate(element => element === document.activeElement), true, `${kind} middle-row removal hands focus to the next role`);
        for (const remaining of [1, 0]) {
          await page.getByRole("article").first().getByRole("button", { name: kind === "saved" ? /^Unsave / : /^Restore role / }).click();
          await page.waitForFunction(count => document.querySelectorAll(".job-row").length === count, remaining);
        }
        assert.equal(await page.locator("#matches-heading").evaluate(element => element === document.activeElement), true);
        await page.evaluate(owner => sessionStorage.removeItem(`apply-ai:matches:${owner}`), fixture.profile.id);
      }
      fixture = publicState(structuredClone(demoState));
      const assessment = fixture.matches.find(item => item.jobId === intern.id)!.assessment;
      fixture.jobs = Array.from({ length: 12 }, (_, index) => ({ ...intern, id: `feedback-qa-${index}`, company: `QA Company ${index}`, title: `QA Role ${index}` }));
      fixture.matches = fixture.jobs.map(job => ({ jobId: job.id, assessment }));
      fixture.feedback = [];
      await page.reload();
      await page.getByRole("article").last().getByRole("button", { name: /^Dismiss / }).click();
      await page.waitForFunction(() => document.querySelectorAll(".job-row").length === 11);
      const undoBox = await page.getByRole("button", { name: "Undo dismissal", exact: true }).boundingBox();
      assert.ok(undoBox && undoBox.y >= (label === "mobile" ? 78 : 0) && undoBox.y + undoBox.height <= height, "Lower-list Undo remains visible without scrolling back");
      await page.screenshot({ path: `.data/matches-feedback-${label}.png` });
      await page.getByRole("button", { name: "Undo dismissal", exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll(".job-row").length === 12);
      assert.equal(await page.getByRole("article").last().evaluate(element => element === document.activeElement), true, "Undo returns focus to the restored role");
      await page.getByRole("button", { name: "Close feedback message", exact: true }).click();
      assert.equal(await page.getByRole("article").last().evaluate(element => element === document.activeElement), true, "Closing feedback retains role context");
      await page.evaluate(owner => sessionStorage.removeItem(`apply-ai:matches:${owner}`), fixture.profile.id);
      fixture = publicState(structuredClone(demoState));
      await page.reload();
      await strongRole.waitFor();
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: `.data/matches-${label}.png`, fullPage: true });
      await page.screenshot({ path: `.data/matches-${label}-viewport.png` });
      fixture.lastRefreshAt = new Date().toISOString();
      fixture.discovery = { lastRefreshAt: new Date(Date.now() - 2 * 86400000).toISOString(), sources: [{ source: "first", status: "available", checkedAt: new Date().toISOString() }, { source: "second", status: "unavailable", checkedAt: new Date().toISOString() }], events: [] };
      await page.reload();
      await page.locator(".source-freshness").getByText("1 of 2 sources unavailable · Sources last checked 2 days ago", { exact: true }).waitFor();
      fixture.discovery.lastRefreshAt = undefined;
      await page.reload();
      await page.locator(".source-freshness").getByText("1 of 2 sources unavailable · Check time not reported", { exact: true }).waitFor();
      fixture.discovery = { sources: [], events: [] };
      await page.reload();
      await page.locator(".source-freshness").getByText("Waiting for the first source check", { exact: true }).waitFor();
      fixture.discovery = undefined;
      fixture.profile.demo = false;
      await page.reload();
      await page.locator(".source-freshness").getByText("Source check status is unavailable", { exact: true }).waitFor();
      fixture = publicState(structuredClone(demoState));
      fixture.automation.enabled = true;
      await page.reload();
      await strongRole.getByRole("button", { name: `Apply automatically for ${context}`, exact: true }).waitFor();
      assert.match((await page.locator("#application-mode-note").textContent()) ?? "", /can prepare and submit/);
      assert.doesNotMatch((await page.locator("#application-mode-note").textContent()) ?? "", /You approve materials/);
      await page.evaluate(owner => sessionStorage.removeItem(`apply-ai:matches:${owner}`), fixture.profile.id);
      console.log(`PASS ${label}: fit/search/counts/sort/disclosure, dialog keyboard behavior, touch targets, save/unsave, dismissal undo and restore`);
    }
    for (const [width, height] of [[320, 740], [820, 900], [720, 500]]) {
      await page.setViewportSize({ width, height });
      fixture = publicState(structuredClone(demoState));
      fixture.jobs[0].title = "Early career software engineering and analytics opportunity — international product development team";
      fixture.jobs[0].company = "International technology research and development company";
      await page.goto(origin);
      if (width > 640) {
        const activityLauncher = page.getByRole("button", { name: "Activity", exact: true });
        await activityLauncher.click();
        await page.locator("#matches-activity").getByRole("heading", { name: "Agent activity", exact: true }).waitFor();
        await page.keyboard.press("Escape");
        assert.equal(await activityLauncher.evaluate(element => element === document.activeElement), true, "Tablet retains activity access and focus restoration");
      }
      await page.getByRole("article").first().waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Long-content layout must not overflow at ${width}px`);
      for (const name of ["Matches", "Applications", "Profile", "Search settings"]) {
        const navigation = page.getByRole("button", { name, exact: true });
        assert.ok(await navigation.evaluate(element => parseFloat(getComputedStyle(element).fontSize) >= 10), `Navigation labels stay visible at ${width}px`);
      }
      console.log(`PASS responsive ${width}x${height}: long content, visible navigation, no horizontal overflow`);
    }
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
