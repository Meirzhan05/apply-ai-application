import { afterEach, describe, expect, it, vi } from "vitest";
import { humanFill, launchLocalBrowser } from "@/lib/browser-runner";

afterEach(() => { vi.unstubAllEnvs(); });

describe("local browser stealth", () => {
  it("hides automation markers in the local fallback browser", async () => {
    const { browser, page } = await launchLocalBrowser();
    try {
      await page.setContent("<p>stealth</p>");
      const seen = await page.evaluate(() => ({ webdriver: navigator.webdriver, userAgent: navigator.userAgent, width: innerWidth, language: navigator.language }));
      expect(seen.webdriver).toBe(false);
      expect(seen.userAgent).not.toContain("HeadlessChrome");
      expect(seen.userAgent).toContain("Chrome/");
      expect(seen.width).toBe(1366);
      expect(seen.language).toBe("en-US");
    } finally { await browser.close(); }
  }, 30_000);

  it("types short values key by key and replaces any existing value", async () => {
    vi.stubEnv("BROWSER_HUMAN_PACING", "true");
    const { browser, page } = await launchLocalBrowser();
    try {
      await page.setContent(`<input id="name" value="old"><textarea id="essay"></textarea>
        <script>window.keys = 0; document.addEventListener("keydown", () => window.keys++);</script>`);
      await humanFill(page.locator("#name"), "Ada Lovelace");
      expect(await page.locator("#name").inputValue()).toBe("Ada Lovelace");
      const typed = await page.evaluate(() => (window as unknown as { keys: number }).keys);
      expect(typed).toBeGreaterThanOrEqual("Ada Lovelace".length);
      const essay = "A long answer. ".repeat(10);
      await humanFill(page.locator("#essay"), essay);
      expect(await page.locator("#essay").inputValue()).toBe(essay);
      expect(await page.evaluate(() => (window as unknown as { keys: number }).keys)).toBe(typed);
    } finally { await browser.close(); }
  }, 30_000);

  it("fills at once when pacing is disabled", async () => {
    vi.stubEnv("BROWSER_HUMAN_PACING", "false");
    const { browser, page } = await launchLocalBrowser();
    try {
      await page.setContent(`<input id="name"><script>window.keys = 0; document.addEventListener("keydown", () => window.keys++);</script>`);
      await humanFill(page.locator("#name"), "Ada");
      expect(await page.locator("#name").inputValue()).toBe("Ada");
      expect(await page.evaluate(() => (window as unknown as { keys: number }).keys)).toBe(0);
    } finally { await browser.close(); }
  }, 30_000);
});
