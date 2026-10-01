import Browserbase from "@browserbasehq/sdk";
import { z } from "zod";
import type { Application, BrowserProvider } from "./types";

const api = "https://api.browser-use.com/api/v4/browsers";
const CloudBrowser = z.object({
  id: z.string().uuid(), status: z.enum(["active", "stopped"]),
  cdpUrl: z.string().nullable().optional(), liveUrl: z.string().nullable().optional(),
  timeoutAt: z.string().datetime(),
});
export type RemoteBrowserSession = {
  provider: BrowserProvider; sessionId: string; connectUrl: string;
  liveUrl?: string; expiresAt?: string;
};

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
    const session = await browserUseRequest("POST", "", {
      timeout: 30, proxyCountryCode: "us", solveCaptchas: false,
      enableRecording: false, allowResizing: false,
    });
    try {
      const connection = new URL(session.cdpUrl || "");
      const viewer = new URL(session.liveUrl || "");
      if (!["wss:", "https:"].includes(connection.protocol) || !connection.hostname.endsWith(".browser-use.com") ||
        viewer.protocol !== "https:" || viewer.hostname !== "live.browser-use.com" || session.status !== "active")
        throw new Error("Browser Use Cloud returned an invalid session connection.");
      return { provider, sessionId: session.id, connectUrl: connection.href, liveUrl: viewer.href, expiresAt: session.timeoutAt };
    } catch (error) {
      await releaseRemoteBrowser({ browserSessionId: session.id, browserProvider: provider }).catch(() => undefined);
      throw error;
    }
  }
  if (!process.env.BROWSERBASE_API_KEY) throw new Error("Browserbase is not configured.");
  const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
  const session = await bb.sessions.create({
    projectId: process.env.BROWSERBASE_PROJECT_ID, keepAlive: true, api_timeout: 1800,
    browserSettings: { allowedDomains: [new URL(targetUrl).hostname], solveCaptchas: false },
  });
  try {
    const debug = await bb.sessions.debug(session.id);
    return { provider, sessionId: session.id, connectUrl: session.connectUrl,
      liveUrl: debug.debuggerFullscreenUrl, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() };
  } catch (error) {
    await releaseRemoteBrowser({ browserSessionId: session.id, browserProvider: provider }).catch(() => undefined);
    throw error;
  }
}

export async function releaseRemoteBrowser(app: Pick<Application, "browserProvider" | "browserSessionId">): Promise<void> {
  if (!app.browserSessionId || app.browserSessionId.startsWith("local-")) return;
  if (applicationBrowserProvider(app) === "browser-use") {
    await browserUseRequest("PATCH", sessionPath(app.browserSessionId), { action: "stop" });
  } else {
    const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
    await bb.sessions.update(app.browserSessionId, { projectId: process.env.BROWSERBASE_PROJECT_ID, status: "REQUEST_RELEASE" });
  }
}

export async function remoteBrowserStatus(app: Pick<Application, "browserProvider" | "browserSessionId">): Promise<"active" | "stopped"> {
  if (!app.browserSessionId) return "stopped";
  if (applicationBrowserProvider(app) === "browser-use") return (await browserUseRequest("GET", sessionPath(app.browserSessionId))).status;
  const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
  return (await bb.sessions.retrieve(app.browserSessionId)).status === "RUNNING" ? "active" : "stopped";
}
