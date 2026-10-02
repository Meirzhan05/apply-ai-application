import assert from "node:assert/strict";
import { chromium, type Page, type Route } from "playwright-core";

const baseUrl = process.env.TEST_COSTS_URL || "http://localhost:3000";
const origin = new URL(baseUrl).origin;

const report = (period: string, knownTotalUsd: number, scope: "owner" | "service", operator = false) => ({
  operator,
  scope,
  ownerId: scope === "owner" ? "owner" : undefined,
  period,
  projectedUsd: 0,
  measuredEstimateUsd: knownTotalUsd,
  unreconciledEstimateUsd: knownTotalUsd,
  reconciledUsd: 0,
  knownTotalUsd,
  unknownComponents: 0,
  confirmedSubmissions: 1,
  costPerConfirmedSubmission: knownTotalUsd,
  activeUsers: 1,
  costPerActiveUser: knownTotalUsd,
  heldRequests: 0,
  invoiceLines: [],
  evidence: [],
});

type RaceState = {
  mode: "race";
  initialServed: boolean;
  octoberStarted: Promise<void>;
  markOctoberStarted: () => void;
  octoberCompleted: Promise<void>;
  markOctoberCompleted: () => void;
  releaseOctober?: () => void;
};

const makeRaceState = (): RaceState => {
  let start: () => void = () => undefined;
  let complete: () => void = () => undefined;
  const state: RaceState = {
    mode: "race",
    initialServed: false,
    octoberStarted: new Promise<void>((resolve) => { start = resolve; }),
    markOctoberStarted: () => start(),
    octoberCompleted: new Promise<void>((resolve) => { complete = resolve; }),
    markOctoberCompleted: () => complete(),
  };
  return state;
};

type CostState = { mode: "error" | "operator"; initialServed: boolean } | RaceState;

async function routeCosts(route: Route, state: CostState): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  const period = url.searchParams.get("period") || "";
  if (request.method() === "POST") {
    await route.fulfill({ json: { ok: true } });
    return;
  }
  if (state.mode === "error" && period === "2026-10") {
    await route.fulfill({ status: 503, json: { error: "Controlled period unavailable" } });
    return;
  }
  if (state.mode === "race" && period === "2026-10") {
    state.markOctoberStarted();
    await new Promise<void>((resolve) => { state.releaseOctober = resolve; });
    await route.fulfill({ json: report("2026-10", 503, "owner") });
    state.markOctoberCompleted();
    return;
  }
  if (state.mode === "race" && period === "2026-09" && state.initialServed) {
    await route.fulfill({ json: report("2026-09", 12, "owner") });
    state.releaseOctober?.();
    return;
  }
  state.initialServed = true;
  const operator = state.mode === "operator";
  const scope = url.searchParams.get("scope") === "service" ? "service" : "owner";
  await route.fulfill({ json: report(period, scope === "service" ? 21 : 12, scope, operator) });
}

async function waitForKnownTotal(page: Page, value: string): Promise<void> {
  const total = page.getByText("Known combined total", { exact: true }).locator("..");
  await total.getByText(value, { exact: true }).waitFor();
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const runtimeErrors: string[] = [];
    page.on("pageerror", (error) => runtimeErrors.push(error.message));

    const errorState = { mode: "error" as const, initialServed: false };
    await page.route(`${origin}/api/costs**`, (route) => routeCosts(route, errorState));
    await page.goto(`${baseUrl}/costs?period=2026-09`);
    await waitForKnownTotal(page, "$12.0000");
    await page.getByLabel("Period", { exact: true }).fill("2026-10");
    await page.getByRole("alert").waitFor();
    assert.equal(new URL(page.url()).searchParams.get("period"), "2026-10");
    assert.equal(await page.getByText("$12.0000", { exact: true }).count(), 0, "failed period must not retain old totals");
    assert.equal(await page.getByRole("link", { name: "Download CSV", exact: true }).count(), 0, "failed period must not retain stale CSV link");
    console.log("PASS stale period totals and CSV are cleared on filter error");

    const raceState = makeRaceState();
    await page.unroute(`${origin}/api/costs**`);
    await page.route(`${origin}/api/costs**`, (route) => routeCosts(route, raceState));
    await page.goto(`${baseUrl}/costs?period=2026-09&race=1`);
    await waitForKnownTotal(page, "$12.0000");
    const periodInput = page.getByLabel("Period", { exact: true });
    await periodInput.fill("2026-10");
    await raceState.octoberStarted;
    await periodInput.fill("2026-09");
    await waitForKnownTotal(page, "$12.0000");
    await raceState.octoberCompleted;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.equal(new URL(page.url()).searchParams.get("period"), "2026-09");
    assert.equal(await page.getByText("$503.0000", { exact: true }).count(), 0, "late old response must not win the current period");
    assert.equal(runtimeErrors.length, 0, `page runtime errors: ${runtimeErrors.join("; ")}`);
    console.log("PASS delayed response cannot overwrite the latest period");

    const operatorState = { mode: "operator" as const, initialServed: false };
    await page.unroute(`${origin}/api/costs**`);
    await page.route(`${origin}/api/costs**`, (route) => routeCosts(route, operatorState));
    await page.goto(`${baseUrl}/costs?period=2026-09&operator=1`);
    await waitForKnownTotal(page, "$12.0000");
    const scopeToggle = page.getByLabel("Service totals", { exact: true });
    assert(await scopeToggle.isVisible(), "operator scope control should be visible");
    await scopeToggle.check();
    await waitForKnownTotal(page, "$21.0000");
    const csvHref = await page.getByRole("link", { name: "Download CSV", exact: true }).getAttribute("href");
    assert(csvHref?.includes("scope=service") && csvHref.includes("format=csv"), "CSV must follow the selected scope");
    assert((await page.getByLabel("Cost filters").getByLabel("Period", { exact: true }).evaluate((element) => (element as HTMLInputElement).getBoundingClientRect().height)) >= 44);
    for (const label of ["Provider", "Invoice", "Line", "Amount USD"]) {
      assert((await page.getByLabel(label, { exact: true }).evaluate((element) => (element as HTMLInputElement).getBoundingClientRect().height)) >= 44, `${label} should have a 44px target`);
    }
    await page.getByLabel("Provider", { exact: true }).fill("controlled-provider");
    await page.getByLabel("Invoice", { exact: true }).fill("invoice-1");
    await page.getByLabel("Line", { exact: true }).fill("line-1");
    await page.getByLabel("Amount USD", { exact: true }).fill("2.50");
    await page.getByRole("button", { name: "Import line", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Invoice line imported." }).waitFor();
    assert.equal(await page.getByLabel("Provider", { exact: true }).inputValue(), "", "successful invoice import should reset native controls");
    console.log("PASS owner/service filters, CSV link, invoice control sizing and reset");
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
