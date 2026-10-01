import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { initialDemoState } from "@/lib/demo-data";
import { packetProfileHash } from "@/lib/drafting";
import { approveFill, selectApplication, setPacket } from "@/lib/workflow";
import { readBrowserUsage } from "@/lib/browser-usage";
import { prepareBrowser } from "@/lib/browser-runner";

const mocks = vi.hoisted(() => ({ create: vi.fn(), release: vi.fn(), connect: vi.fn() }));
vi.mock("@/lib/demo-mode", () => ({ isDemo: () => false }));
vi.mock("@/lib/browser-provider", () => ({
  createRemoteBrowser: mocks.create,
  releaseRemoteBrowser: mocks.release,
}));
vi.mock("@/lib/packet-files", () => ({ reviewedPacketFile: vi.fn(async () => ({ bytes: Buffer.from("pdf"), filename: "tailored-resume.pdf", mimeType: "application/pdf" })) }));
vi.mock("playwright-core", () => ({ chromium: { connectOverCDP: mocks.connect, launch: vi.fn() } }));

const usageDir = `/tmp/apply-browser-lifecycle-${process.pid}`;

beforeEach(() => {
  vi.stubEnv("BROWSER_USAGE_TEST_DIR", usageDir);
  mocks.create.mockResolvedValue({ provider: "browser-use", sessionId: "remote-session", connectUrl: "ws://controlled", liveUrl: "https://live.controlled", expiresAt: new Date(Date.now() + 60_000).toISOString(), providerReport: { status: "active" } });
  mocks.release.mockResolvedValue({ status: "stopped", finishedAt: new Date().toISOString() });
  const context = { pages: () => [{ context: () => context, url: () => "https://jobs.example/apply" }], route: vi.fn().mockResolvedValue(undefined) };
  mocks.connect.mockResolvedValue({ contexts: () => [context], close: vi.fn().mockResolvedValue(undefined) });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(usageDir, { recursive: true, force: true });
});

describe("remote browser lifecycle ledger", () => {
  it("records connected after the persisted session callback and releases on later transport failure", async () => {
    const state = initialDemoState();
    const job = { ...state.jobs[0], url: "https://jobs.example/apply", applyUrl: "https://jobs.example/apply" };
    state.jobs = [job];
    const app = selectApplication(state, job.id, state.profile.id);
    const fact = state.profile.facts.find((item) => item.verified)!;
    const packet = { schemaVersion: 1 as const, version: 1, summary: "Lifecycle test", resumeLines: [{ text: fact.text, factIds: [fact.id] }], answers: [], createdAt: new Date().toISOString(), model: "controlled-fixture", profileHash: packetProfileHash(state.profile), files: [{ kind: "resume" as const, filename: "tailored-resume.pdf", mimeType: "application/pdf" as const, size: 3, sha256: "a".repeat(64), factIds: [fact.id], storageBucket: "application-files" as const }] };
    setPacket(state, app, packet);
    approveFill(app, state.profile.id, app.packetHash!, job.applyUrl);
    const persisted: string[] = [];
    await expect(prepareBrowser(app, job, state.profile, async (session) => {
      persisted.push(session.sessionId);
      app.browserSessionId = session.sessionId;
      app.browserProvider = session.provider;
      return true;
    }, async (label) => {
      if (label === "Opening the employer form") throw new Error("controlled transport boundary");
      return true;
    })).rejects.toThrow("controlled transport boundary");
    expect(persisted).toEqual(["remote-session"]);
    expect(mocks.connect).toHaveBeenCalledWith("ws://controlled");
    expect(mocks.release).toHaveBeenCalledWith(expect.objectContaining({ browserSessionId: "remote-session", browserProvider: "browser-use" }));
    const report = await readBrowserUsage(state.profile.id);
    expect(report.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "connected", provider: "browser-use", sessionId: "remote-session", userId: state.profile.id, applicationId: app.id, jobId: job.id, runId: app.id }),
    ]));
  });
});
