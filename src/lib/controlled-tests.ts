import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJobUrl } from "@/lib/sources";
import type { AppState, Job } from "@/lib/types";

interface TestGrant { userId: string; applicationId: string; expiresAt: number }

export function issueControlledTestGrant(userId: string, applicationId: string): { token: string; grant: TestGrant } {
  const secret = process.env.INTERNAL_TASK_SECRET;
  if (!secret) throw new Error("Configure INTERNAL_TASK_SECRET before running controlled cloud tests.");
  const grant = { userId, applicationId, expiresAt: Date.now() + 15 * 60 * 1000 };
  const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
  const signature = createHmac("sha256", secret).update(`controlled-form:${payload}`).digest("base64url");
  return { token: `${payload}.${signature}`, grant };
}

export function verifyControlledTestGrant(token: string): TestGrant | null {
  const secret = process.env.INTERNAL_TASK_SECRET;
  if (!secret || token.length > 1000) return null;
  try {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) return null;
    const expected = createHmac("sha256", secret).update(`controlled-form:${payload}`).digest("base64url");
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const grant = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TestGrant;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return typeof grant.userId === "string" && uuid.test(grant.userId) && typeof grant.applicationId === "string" && uuid.test(grant.applicationId) && Number.isFinite(grant.expiresAt) && grant.expiresAt > Date.now() ? grant : null;
  } catch { return null; }
}

export interface ControlledFixtureScope {
  controlled: boolean;
  applicationId?: string;
  jobId?: string;
}

function grantForApplication(application: AppState["applications"][number]): TestGrant | null {
  const snapshot = application.jobSnapshot;
  if (!snapshot || !application.controlledTest || application.controlledTest.expiresAt <= Date.now()) return null;
  const urls = [snapshot.url, snapshot.applyUrl];
  for (const raw of urls) {
    try {
      const token = new URL(raw).searchParams.get("token");
      if (!token) continue;
      const grant = verifyControlledTestGrant(token);
      if (grant && grant.expiresAt === application.controlledTest.expiresAt &&
        grant.userId === application.userId && grant.applicationId === application.id) return grant;
    } catch {
      // A malformed fixture URL is an invalid scope, never a reason to widen it.
    }
  }
  return null;
}

/**
 * Controlled cloud fixtures are signed to one owner, application, and posting.
 * The presence of a fixture application puts that owner in a deny-by-default
 * scope until its short-lived grant is valid; ordinary catalog jobs must never
 * be used as a validation side effect.
 */
export function controlledFixtureScope(state: AppState, userId: string): ControlledFixtureScope {
  const controlled = state.applications.filter((application) => application.controlledTest);
  if (!controlled.length) return { controlled: false };
  const application = controlled.find((candidate) => candidate.userId === userId && grantForApplication(candidate));
  const grant = application ? grantForApplication(application) : null;
  if (!application || !grant) return { controlled: true };
  return { controlled: true, applicationId: grant.applicationId, jobId: application.jobId };
}

export function controlledFixtureAllowsJob(state: AppState, userId: string, job: Job): boolean {
  const scope = controlledFixtureScope(state, userId);
  if (!scope.controlled) return true;
  const application = state.applications.find((candidate) => candidate.id === scope.applicationId && candidate.jobId === scope.jobId);
  return Boolean(scope.applicationId && scope.jobId === job.id && application?.jobSnapshot &&
    canonicalJobUrl(application.jobSnapshot.url) === canonicalJobUrl(job.url) &&
    canonicalJobUrl(application.jobSnapshot.applyUrl) === canonicalJobUrl(job.applyUrl));
}
