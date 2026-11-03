import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { humanFill } from "@/lib/browser-runner";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined }); });
afterAll(async () => { await browser?.close(); });
afterEach(() => { vi.unstubAllEnvs(); });

async function form(html: string): Promise<Page> {
  const page = await browser.newPage();
  await page.setContent(`${html}<script>window.keys = []; document.addEventListener("keydown", () => window.keys.push(performance.now()));</script>`);
  return page;
}
const keyTimes = (page: Page) => page.evaluate(() => (window as unknown as { keys: number[] }).keys);

describe("human-paced filling", () => {
  it("types short text key by key with a different delay per key", async () => {
    vi.stubEnv("BROWSER_HUMAN_PACING", "true");
    const page = await form(`<input id="name" value="old">`);
    try {
      await humanFill(page, page.locator("#name"), "text", "Ada Lovelace");
      expect(await page.locator("#name").inputValue()).toBe("Ada Lovelace");
      const times = await keyTimes(page);
      expect(times.length).toBeGreaterThanOrEqual("Ada Lovelace".length);
      const gaps = times.slice(-12).slice(1).map((time, index) => Math.round(time - times.slice(-12)[index]));
      expect(new Set(gaps).size).toBeGreaterThan(1);
    } finally { await page.close(); }
  }, 30_000);

  it("finishes a 64-character value within a 5 second per-action timeout", async () => {
    vi.stubEnv("BROWSER_HUMAN_PACING", "true");
    const page = await form(`<input id="name">`);
    try {
      const value = "x".repeat(64);
      await humanFill(page, page.locator("#name"), "text", value, { timeout: 5000 });
      expect(await page.locator("#name").inputValue()).toBe(value);
    } finally { await page.close(); }
  }, 30_000);

  it("fills date, number, multi-line and long values without typing", async () => {
    vi.stubEnv("BROWSER_HUMAN_PACING", "true");
    const page = await form(`<form onsubmit="window.submitted = true; return false"><input id="date" type="date"><input id="count" type="number">
      <input id="line"><textarea id="essay"></textarea><button>Submit</button></form>`);
    try {
      await humanFill(page, page.locator("#date"), "date", "2026-06-01");
      await humanFill(page, page.locator("#count"), "number", "3");
      await humanFill(page, page.locator("#line"), "text", "123 Main St\nApt 4");
      const essay = "A long answer. ".repeat(10);
      await humanFill(page, page.locator("#essay"), "textarea", essay);
      expect(await page.locator("#date").inputValue()).toBe("2026-06-01");
      expect(await page.locator("#count").inputValue()).toBe("3");
      expect(await page.locator("#essay").inputValue()).toBe(essay);
      expect(await keyTimes(page)).toEqual([]);
      expect(await page.evaluate(() => (window as unknown as { submitted?: boolean }).submitted)).toBeUndefined();
    } finally { await page.close(); }
  }, 30_000);

  it("fills at once when pacing is disabled", async () => {
    vi.stubEnv("BROWSER_HUMAN_PACING", "false");
    const page = await form(`<input id="name">`);
    try {
      await humanFill(page, page.locator("#name"), "text", "Ada");
      expect(await page.locator("#name").inputValue()).toBe("Ada");
      expect(await keyTimes(page)).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);
});
