import Browserbase from "@browserbasehq/sdk";
import { z } from "zod";
import type { Application, BrowserProvider } from "./types";
import { BROWSER_USE_RATE, browserUsageContext, recordBrowserUsageEvent, type BrowserProviderReport } from "./browser-usage";

const api = "https://api.browser-use.com/api/v4/browsers";
const CloudBrowser = z.object({
  id: z.string().uuid(), status: z.enum(["active", "stopped"]),
  cdpUrl: z.string().nullable().optional(), liveUrl: z.string().nullable().optional(),
  timeoutAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable().optional(), finishedAt: z.string().datetime().nullable().optional(),
  proxyUsedMb: z.union([z.string(), z.number()]).optional(), proxyCost: z.union([z.string(), z.number()]).optional(),
  browserCost: z.union([z.string(), z.number()]).optional(),
});
export type RemoteBrowserSession = {
  provider: BrowserProvider; sessionId: string; connectUrl: string;
  liveUrl?: string; expiresAt?: string;
  captchaSolving?: boolean;
  providerReport?: BrowserProviderReport;
};

function providerReport(session: z.infer<typeof CloudBrowser>): BrowserProviderReport {
  const decimal = (value: string | number | undefined) => {
    if (value === undefined) return undefined;
    if (typeof value === "string" && value.trim() === "") return undefined;
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  return { status: session.status, startedAt: session.startedAt ?? undefined, finishedAt: session.finishedAt ?? undefined, expiresAt: session.timeoutAt,
    proxyUsedMb: decimal(session.proxyUsedMb), proxyCostUsd: decimal(session.proxyCost), browserCostUsd: decimal(session.browserCost), rate: BROWSER_USE_RATE };
}

function browserbaseReport(session: unknown): BrowserProviderReport {
  const value = session && typeof session === "object" ? session as Record<string, unknown> : {};
  const date = (key: string) => typeof value[key] === "string" ? value[key] as string : undefined;
  const bytes = typeof value.proxyBytes === "number" && Number.isFinite(value.proxyBytes) && value.proxyBytes >= 0 ? value.proxyBytes / 1_000_000 : undefined;
  const status = value.status === "PENDING" || value.status === "RUNNING" ? "active" : value.status === "ERROR" || value.status === "TIMED_OUT" || value.status === "COMPLETED" ? "stopped" : "unknown";
  return { status, startedAt: date("startedAt"), finishedAt: date("endedAt"), expiresAt: date("expiresAt"), proxyUsedMb: bytes };
}

export function configuredBrowserProvider(): BrowserProvider {
  const selected = process.env.BROWSER_PROVIDER || "browser-use";
  if (selected !== "browser-use" && selected !== "browserbase") throw new Error("Invalid browser provider configuration.");
  return selected;
}

// Old records predate provider selection and belong to Browserbase.
export function applicationBrowserProvider(app: Pick<Application, "browserProvider">): BrowserProvider {
  return app.browserProvider || "browserbase";
}

async function browserUseRequest(method: string, suffix = "", body?: unknown) {
  const key = process.env.BROWSER_USE_API_KEY;
  if (!key) throw new Error("Browser Use Cloud is not configured. Add BROWSER_USE_API_KEY on the server.");
  let response: Response;
  try {
    response = await fetch(`${api}${suffix}`, {
      method, headers: { "X-Browser-Use-API-Key": key, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(25_000), cache: "no-store",
    });
  } catch {
    // Never automatically repeat a session allocation after a transport timeout.
    throw new Error("Browser Use Cloud could not be reached. No automatic session retry was made.");
  }
  if (!response.ok) {
    if (response.status === 402) throw new Error("Browser Use Cloud has insufficient credits. Restore the provider balance before starting a new run.");
    if ([401, 403].includes(response.status)) throw new Error("Browser Use Cloud rejected the server API key or account access.");
    if (response.status === 429) throw new Error("Browser Use Cloud is at capacity. Wait for the current sessions to finish.");
    throw new Error(`Browser Use Cloud request failed (${response.status}).`);
  }
  return CloudBrowser.parse(await response.json());
}

function sessionPath(sessionId: string) {
  if (!z.string().uuid().safeParse(sessionId).success) throw new Error("Invalid Browser Use session identifier.");
  return `/${sessionId}`;
}

export async function createRemoteBrowser(targetUrl: string): Promise<RemoteBrowserSession> {
  const provider = configuredBrowserProvider();
  if (provider === "browser-use") {
    const captchaSolving = process.env.BROWSER_USE_SOLVE_CAPTCHAS !== "false";
    let session: Awaited<ReturnType<typeof browserUseRequest>>;
    try {
      session = await browserUseRequest("POST", "", {
        timeout: 30, proxyCountryCode: "us", solveCaptchas: captchaSolving,
        enableRecording: false, allowResizing: false,
      });
    } catch (error) {
      const ambiguous = error instanceof Error && error.message.includes("No automatic session retry");
      if (ambiguous && error instanceof Error) Object.assign(error, { allocationUncertain: true });
      const owner = browserUsageContext();
      if (owner) await recordBrowserUsageEvent({ ...owner, provider, sessionId: null, event: ambiguous ? "ambiguous" : "failed", report: null, failure: ambiguous ? "ambiguous_allocation" : "allocation_failed", orphanedSessionId: null }).catch(() => undefined);
      throw error;
    }
    try {
      const connection = new URL(session.cdpUrl || "");
      const viewer = new URL(session.liveUrl || "");
      if (!["wss:", "https:"].includes(connection.protocol) || !connection.hostname.endsWith(".browser-use.com") ||
        viewer.protocol !== "https:" || viewer.hostname !== "live.browser-use.com" || session.status !== "active")
        throw new Error("Browser Use Cloud returned an invalid session connection.");
      const report = providerReport(session);
      const result = { provider, sessionId: session.id, connectUrl: connection.href, liveUrl: viewer.href, expiresAt: session.timeoutAt, captchaSolving, providerReport: report };
      const owner = browserUsageContext();
      if (owner) await recordBrowserUsageEvent({ ...owner, provider, sessionId: session.id, event: "created", report, failure: null, orphanedSessionId: null });
      return result;
    } catch (error) {
      await releaseRemoteBrowser({ browserSessionId: session.id, browserProvider: provider }).catch(() => undefined);
      throw error;
    }
  }
  if (!process.env.BROWSERBASE_API_KEY) throw new Error("Browserbase is not configured.");
  const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
  let session: Awaited<ReturnType<typeof bb.sessions.create>>;
  try {
    session = await bb.sessions.create({
      projectId: process.env.BROWSERBASE_PROJECT_ID, keepAlive: true, api_timeout: 1800,
      browserSettings: { allowedDomains: [new URL(targetUrl).hostname], solveCaptchas: false },
    });
  } catch (error) {
    const owner = browserUsageContext();
    if (owner) await recordBrowserUsageEvent({ ...owner, provider, sessionId: null, event: "failed", report: null, failure: "allocation_failed", orphanedSessionId: null }).catch(() => undefined);
    throw error;
  }
  try {
    const debug = await bb.sessions.debug(session.id);
    const report: BrowserProviderReport = { status: "active", expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() };
    const result = { provider, sessionId: session.id, connectUrl: session.connectUrl,
      liveUrl: debug.debuggerFullscreenUrl, expiresAt: report.expiresAt, providerReport: report };
    const owner = browserUsageContext();
    if (owner) await recordBrowserUsageEvent({ ...owner, provider, sessionId: session.id, event: "created", report, failure: null, orphanedSessionId: null });
    return result;
  } catch (error) {
    await releaseRemoteBrowser({ browserSessionId: session.id, browserProvider: provider }).catch(() => undefined);
    throw error;
  }
}

export async function releaseRemoteBrowser(app: Pick<Application, "browserProvider" | "browserSessionId">): Promise<BrowserProviderReport | undefined> {
  if (!app.browserSessionId || app.browserSessionId.startsWith("local-")) return;
  if (applicationBrowserProvider(app) === "browser-use") {
    const provider = applicationBrowserProvider(app);
    try {
      await browserUseRequest("PATCH", sessionPath(app.browserSessionId), { action: "stop" });
      const report = providerReport(await browserUseRequest("GET", sessionPath(app.browserSessionId)));
      const owner = browserUsageContext();
      if (report.status !== "stopped") {
        if (owner) await recordBrowserUsageEvent({ ...owner, provider, sessionId: app.browserSessionId, event: "release_failed", report, failure: "release_failed", orphanedSessionId: app.browserSessionId });
        return report;
      }
      if (owner) await recordBrowserUsageEvent({ ...owner, provider, sessionId: app.browserSessionId, event: "stopped", report, failure: null, orphanedSessionId: null });
      return report;
    } catch (error) {
      const owner = browserUsageContext();
      if (owner) await recordBrowserUsageEvent({ ...owner, provider, sessionId: app.browserSessionId, event: "release_failed", report: null, failure: "release_failed", orphanedSessionId: app.browserSessionId });
      throw error;
    }
  } else {
    const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
    try {
      await bb.sessions.update(app.browserSessionId, { projectId: process.env.BROWSERBASE_PROJECT_ID, status: "REQUEST_RELEASE" });
      const report = browserbaseReport(await bb.sessions.retrieve(app.browserSessionId));
      const owner = browserUsageContext();
      if (report.status !== "stopped") {
        if (owner) await recordBrowserUsageEvent({ ...owner, provider: "browserbase", sessionId: app.browserSessionId, event: "release_failed", report, failure: "release_failed", orphanedSessionId: app.browserSessionId });
        return report;
      }
      if (owner) await recordBrowserUsageEvent({ ...owner, provider: "browserbase", sessionId: app.browserSessionId, event: "stopped", report, failure: null, orphanedSessionId: null });
      return report;
    } catch (error) {
      const owner = browserUsageContext();
      if (owner) await recordBrowserUsageEvent({ ...owner, provider: "browserbase", sessionId: app.browserSessionId, event: "release_failed", report: null, failure: "release_failed", orphanedSessionId: app.browserSessionId });
      throw error;
    }
  }
}

export async function remoteBrowserStatus(app: Pick<Application, "browserProvider" | "browserSessionId">): Promise<"active" | "stopped"> {
  if (!app.browserSessionId) return "stopped";
  if (applicationBrowserProvider(app) === "browser-use") {
    const provider = applicationBrowserProvider(app);
    const session = await browserUseRequest("GET", sessionPath(app.browserSessionId));
    const report = providerReport(session);
    const owner = browserUsageContext();
    if (owner) await recordBrowserUsageEvent({ ...owner, provider, sessionId: app.browserSessionId, event: report.status === "stopped" ? "status" : "status", report, failure: null, orphanedSessionId: null });
    return session.status;
  }
  const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
  const report = browserbaseReport(await bb.sessions.retrieve(app.browserSessionId));
  if (report.status !== "active" && report.status !== "stopped") throw new Error("Browserbase returned an unknown session status.");
  const status = report.status;
  const owner = browserUsageContext();
  if (owner) await recordBrowserUsageEvent({ ...owner, provider: "browserbase", sessionId: app.browserSessionId, event: "status", report, failure: null, orphanedSessionId: null });
  return status;
}
