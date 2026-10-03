import { afterEach, describe, expect, it, vi } from "vitest";
const legacy = vi.hoisted(() => ({ update: vi.fn(), retrieve: vi.fn() }));
const usage = vi.hoisted(() => ({ context: undefined as undefined | { userId: string; applicationId: string; runId: string }, record: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@browserbasehq/sdk", () => ({ default: class { sessions = legacy; } }));
vi.mock("./browser-usage", () => ({
  BROWSER_USE_RATE: 0,
  browserUsageContext: () => usage.context,
  recordBrowserUsageEvent: usage.record,
}));
import { applicationBrowserProvider, configuredBrowserProvider, createRemoteBrowser, releaseRemoteBrowser, remoteBrowserStatus } from "./browser-provider";

const id = "d1be2c6e-a564-40c9-b139-b111d8b161fe";
const session = { id, status: "active", cdpUrl: "https://test.cdp.browser-use.com", liveUrl: "https://live.browser-use.com/session/test", timeoutAt: "2026-10-01T01:00:00Z" };
afterEach(() => { usage.context = undefined; vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
function setup() { vi.stubEnv("BROWSER_USE_API_KEY", "secret-test-key"); vi.stubEnv("BROWSER_PROVIDER", "browser-use"); vi.stubEnv("BROWSER_USE_SOLVE_CAPTCHAS", ""); }
describe("Browser Use Cloud session lifecycle", () => {
  it("creates a bounded isolated browser with provider CAPTCHA handling enabled", async () => {
    setup(); const fetch = vi.fn().mockResolvedValue(Response.json(session)); vi.stubGlobal("fetch", fetch);
    expect(await createRemoteBrowser("https://employer.example/apply")).toMatchObject({ provider: "browser-use", sessionId: id, expiresAt: session.timeoutAt, captchaSolving: true });
    const [url, request] = fetch.mock.calls[0];
    expect(url).toBe("https://api.browser-use.com/api/v4/browsers");
    expect(request.headers["X-Browser-Use-API-Key"]).toBe("secret-test-key");
    expect(JSON.parse(request.body)).toEqual({ timeout: 30, proxyCountryCode: "us", solveCaptchas: true, enableRecording: false, allowResizing: false });
    expect(JSON.parse(request.body).profileId).toBeUndefined();
  });
  it("supports explicitly disabling solving for a newly created session", async () => {
    setup(); vi.stubEnv("BROWSER_USE_SOLVE_CAPTCHAS", "false");
    const fetch = vi.fn().mockResolvedValue(Response.json(session)); vi.stubGlobal("fetch", fetch);
    expect(await createRemoteBrowser("https://employer.example/apply")).toMatchObject({ captchaSolving: false });
    expect(JSON.parse(fetch.mock.calls[0][1].body).solveCaptchas).toBe(false);
  });
  it("preserves explicit provider zeroes and leaves omitted usage fields unknown", async () => {
    setup(); const fetch = vi.fn().mockResolvedValue(Response.json({ ...session, proxyUsedMb: "0", proxyCost: "0", browserCost: "0" })); vi.stubGlobal("fetch", fetch);
    const result = await createRemoteBrowser("https://employer.example/apply");
    expect(result.providerReport).toMatchObject({ proxyUsedMb: 0, proxyCostUsd: 0, browserCostUsd: 0 });
    setup(); const missing = vi.fn().mockResolvedValue(Response.json(session)); vi.stubGlobal("fetch", missing);
    expect((await createRemoteBrowser("https://employer.example/apply")).providerReport).toMatchObject({ proxyUsedMb: undefined, proxyCostUsd: undefined, browserCostUsd: undefined });
  });
  it("explicitly stops Browser Use sessions even when Browserbase keys also exist", async () => {
    setup(); vi.stubEnv("BROWSERBASE_API_KEY", "legacy-key"); const fetch = vi.fn().mockResolvedValueOnce(Response.json({ ...session, status: "stopped" })).mockResolvedValueOnce(Response.json({ ...session, status: "stopped", finishedAt: "2026-10-01T00:30:00Z", browserCost: "0.01" })); vi.stubGlobal("fetch", fetch);
    await releaseRemoteBrowser({ browserProvider: "browser-use", browserSessionId: id });
    expect(fetch.mock.calls[0][1].method).toBe("PATCH"); expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ action: "stop" }); expect(legacy.update).not.toHaveBeenCalled();
  });
  it("releases legacy Browserbase records using their provider rather than the new default", async () => {
    setup(); legacy.update.mockResolvedValue({}); legacy.retrieve.mockResolvedValue({ status: "RUNNING" }); await releaseRemoteBrowser({ browserSessionId: "legacy-session" });
    expect(applicationBrowserProvider({})).toBe("browserbase"); expect(legacy.update).toHaveBeenCalledWith("legacy-session", expect.objectContaining({ status: "REQUEST_RELEASE" }));
  });
  it("returns actionable quota errors without leaking provider response data or retrying", async () => {
    setup(); const fetch = vi.fn().mockResolvedValue(Response.json({ detail: "secret-test-key private-data" }, { status: 402 })); vi.stubGlobal("fetch", fetch);
    await expect(createRemoteBrowser("https://employer.example/apply")).rejects.toThrow("insufficient credits"); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not retry allocation after ambiguous transport failures", async () => {
    setup(); const fetch = vi.fn().mockRejectedValue(new Error("secret-test-key")); vi.stubGlobal("fetch", fetch);
    await expect(createRemoteBrowser("https://employer.example/apply")).rejects.toThrow("No automatic session retry"); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["malformed JSON", () => new Response("{", { status: 200 })],
    ["a failed response body read", () => ({ ok: true, status: 200, json: () => Promise.reject(new TypeError("stream terminated")) })],
  ])("keeps a successful allocation with %s unresolved", async (_label, makeResponse) => {
    setup();
    usage.context = { userId: "owner-a", applicationId: "application-a", runId: "run-a" };
    const response = makeResponse();
    const fetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetch);

    await expect(createRemoteBrowser("https://employer.example/apply"))
      .rejects.toMatchObject({ allocationUncertain: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(usage.record).toHaveBeenNthCalledWith(1, expect.objectContaining({ event: "allocation_started", sessionId: null }));
    expect(usage.record).toHaveBeenLastCalledWith(expect.objectContaining({ event: "ambiguous", failure: "ambiguous_allocation" }));
  });
  it("resolves a definite rejected allocation response", async () => {
    setup();
    usage.context = { userId: "owner-a", applicationId: "application-a", runId: "run-a" };
    const fetch = vi.fn().mockResolvedValue(Response.json({ detail: "credits" }, { status: 402 }));
    vi.stubGlobal("fetch", fetch);

    await expect(createRemoteBrowser("https://employer.example/apply")).rejects.toThrow("insufficient credits");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(usage.record).toHaveBeenNthCalledWith(1, expect.objectContaining({ event: "allocation_started", sessionId: null }));
    expect(usage.record).toHaveBeenLastCalledWith(expect.objectContaining({ event: "failed", failure: "allocation_failed" }));
  });
  it("releases sessions with unsafe connection or viewer URLs", async () => {
    setup(); const fetch = vi.fn().mockResolvedValueOnce(Response.json({ ...session, liveUrl: "https://evil.example" })).mockResolvedValueOnce(Response.json({ ...session, status: "stopped" })).mockResolvedValueOnce(Response.json({ ...session, status: "stopped" })); vi.stubGlobal("fetch", fetch);
    await expect(createRemoteBrowser("https://employer.example/apply")).rejects.toThrow("invalid session connection"); expect(fetch).toHaveBeenCalledTimes(3); expect(fetch.mock.calls[1][1].method).toBe("PATCH");
  });
  it("validates identifiers before sending API requests", async () => {
    setup(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(releaseRemoteBrowser({ browserProvider: "browser-use", browserSessionId: "../other" })).rejects.toThrow("Invalid Browser Use session"); expect(fetch).not.toHaveBeenCalled();
  });
  it("reads authoritative lifecycle status", async () => {
    setup(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ...session, status: "stopped" })));
    expect(await remoteBrowserStatus({ browserProvider: "browser-use", browserSessionId: id })).toBe("stopped");
  });
  it("maps Browserbase documented statuses without treating a release request as terminal", async () => {
    setup(); vi.stubEnv("BROWSERBASE_API_KEY", "legacy-key");
    legacy.retrieve.mockResolvedValueOnce({ status: "PENDING" }).mockResolvedValueOnce({ status: "COMPLETED" }).mockResolvedValueOnce({ status: "ERROR" });
    expect(await remoteBrowserStatus({ browserProvider: "browserbase", browserSessionId: "legacy-session" })).toBe("active");
    expect(await remoteBrowserStatus({ browserProvider: "browserbase", browserSessionId: "legacy-session" })).toBe("stopped");
    expect(await remoteBrowserStatus({ browserProvider: "browserbase", browserSessionId: "legacy-session" })).toBe("stopped");
    legacy.retrieve.mockResolvedValueOnce({ status: "REQUEST_RELEASE" });
    await expect(remoteBrowserStatus({ browserProvider: "browserbase", browserSessionId: "legacy-session" })).rejects.toThrow("unknown session status");
  });
  it("requires the chosen provider key and never silently falls back", async () => {
    setup(); vi.stubEnv("BROWSER_USE_API_KEY", ""); vi.stubEnv("BROWSERBASE_API_KEY", "legacy-key");
    await expect(createRemoteBrowser("https://employer.example/apply")).rejects.toThrow("BROWSER_USE_API_KEY");
    vi.stubEnv("BROWSER_PROVIDER", "other"); expect(configuredBrowserProvider).toThrow("Invalid browser provider");
  });
});
