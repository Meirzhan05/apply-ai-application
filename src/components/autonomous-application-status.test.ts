import { describe, expect, it } from "vitest";
import type { Application } from "@/lib/types";
import { importedPreflightHandoff, importedPreflightRecheckAvailable } from "@/components/autonomous-application-status";

const blockedImported = (overrides: Partial<Application> = {}): Application => ({
  id: "imported-app",
  userId: "owner",
  jobId: "job-1",
  status: "selected",
  approvals: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  importedCompatibility: {
    version: 1,
    ownerId: "owner",
    applicationId: "imported-app",
    jobId: "job-1",
    canonicalPostingUrl: "https://example.com/jobs/1",
    postingUrl: "https://example.com/jobs/1",
    observedUrl: "https://example.com/jobs/1/apply",
    observedOrigin: "https://example.com",
    contextHash: "context",
    postingEvidence: { markers: ["Example"], identityHash: "identity" },
    checkedAt: "2026-10-01T00:00:00.000Z",
    status: "blocked",
    blocker: "The employer page requires sign in.",
  },
  importedOutcome: { version: 1, kind: "blocked", at: "2026-10-01T00:00:00.000Z", evidence: "The employer page requires sign in." },
  ...overrides,
});

describe("imported preflight review controls", () => {
  it("offers a same-application employer-link recheck after a closed blocked preflight", () => {
    const app = blockedImported();
    expect(importedPreflightRecheckAvailable(app)).toBe(true);
    expect(importedPreflightHandoff(app)).toMatch(/browser session is closed/);
  });

  it("does not offer recheck while a provider or allocation hold remains", () => {
    expect(importedPreflightRecheckAvailable(blockedImported({ browserSessionId: "session" }))).toBe(false);
    expect(importedPreflightRecheckAvailable(blockedImported({ importedPreflight: { token: "token", startedAt: "2026-10-01T00:00:00.000Z", allocationUncertain: true } }))).toBe(false);
    expect(importedPreflightRecheckAvailable(blockedImported({ submissionAttemptedAt: "2026-10-01T00:00:00.000Z" }))).toBe(false);
  });
});
