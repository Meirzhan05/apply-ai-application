import { hashJson, newId } from "@/lib/crypto";
import { preflightBrowser } from "@/lib/browser-runner";
import { browserUsageContext, withBrowserUsageContext } from "@/lib/browser-usage";
import { loadState, mutateState } from "@/lib/repository";
import { canonicalJobUrl } from "@/lib/sources";
import { createImportedCompatibilityRecord, validateImportedPostingEvidence } from "@/lib/import-compatibility";
import { formDigest, selectImportedPostingForVerification } from "@/lib/workflow";
import { jobDestinationConflict } from "@/lib/matching";
import { assertAutomationEnabled } from "@/lib/autonomous-policy";
import { browserBudgetReservationId, releaseBrowserBudget, reserveBrowserBudget, serviceBudgetMonth } from "@/lib/budget";
import { blockerReason, recordApplicationBlocker } from "@/lib/application-blockers";
import { hasActiveBrowser } from "@/lib/application-queue";
import type { AppState, Application, FormSnapshot, Job } from "@/lib/types";
import type { RemoteBrowserSession } from "@/lib/browser-provider";

type PreflightBrowserResult = Awaited<ReturnType<typeof preflightBrowser>>;
type PreflightSession = Partial<RemoteBrowserSession> & { sessionId: string };
type PreflightObserver = (application: Application, job: Job, onSession: (opened: PreflightSession) => Promise<boolean>) => Promise<PreflightBrowserResult>;
type PreflightError = {
  browserSessionId?: string;
  browserProvider?: Application["browserProvider"];
  browserReleaseConfirmed?: boolean;
  allocationUncertain?: boolean;
  budgetNeverAllocated?: boolean;
};

type FailureOptions = {
  retainBudget?: boolean;
  releaseReservation?: boolean;
  allocationUncertain?: boolean;
};

const hardBlocker = /no application fields|login|password|captcha|unfamiliar required|final submit action is unavailable|submit destination requires a manual handoff|different site|enabled for automation/i;

function findJob(state: AppState, jobId: string): Job {
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job?.active) throw new Error("The imported posting is no longer available.");
  return job;
}

function findOrCreateApplication(state: AppState, job: Job, userId: string): Application {
  const existing = state.applications.find((item) => item.userId === userId && item.jobId === job.id && item.status !== "cancelled");
  return existing ?? selectImportedPostingForVerification(state, job.id, userId);
}

function errorMetadata(error: unknown): PreflightError {
  return error && typeof error === "object" ? error as PreflightError : {};
}

function terminalApplication(application: Application): boolean {
  return application.status === "cancelled" || Boolean(application.submissionAttemptedAt || application.submittedAt || application.submissionReceipt) || ["submitted", "uncertain", "submitting", "awaiting_verification"].includes(application.status);
}

async function releasePreflightBudget(userId: string, applicationId: string, token: string, month: string | undefined): Promise<void> {
  const released = await releaseBrowserBudget(userId, applicationId, token, month);
  if (!released) throw new Error("The unused browser budget reservation could not be released.");
}

async function clearPreflightAfterFailure(
  userId: string,
  applicationId: string,
  token: string,
  error: unknown,
  month?: string,
  options: FailureOptions = {},
): Promise<void> {
  const metadata = errorMetadata(error);
  let held = false;
  let shouldRelease = options.releaseReservation !== false && !options.retainBudget;
  const reservationId = browserBudgetReservationId(applicationId, token);
  await mutateState(userId, (state) => {
    const current = state.applications.find((item) => item.id === applicationId && item.userId === userId);
    if (!current) return;
    const preflight = current.importedPreflight;
    const knownSessionId = current.browserSessionId ?? preflight?.sessionId ?? metadata.browserSessionId;
    const knownProvider = current.browserProvider ?? preflight?.provider ?? metadata.browserProvider;
    const releaseConfirmed = metadata.browserReleaseConfirmed === true;
    const storedMonth = preflight?.budgetMonth ?? month;
    if (knownSessionId && !releaseConfirmed) {
      held = true;
      shouldRelease = false;
      current.browserSessionId = knownSessionId;
      current.browserProvider = knownProvider;
      current.browserReleasePending = {
        sessionId: knownSessionId,
        provider: knownProvider,
        requestedAt: current.browserReleasePending?.requestedAt ?? new Date().toISOString(),
        attempts: (current.browserReleasePending?.attempts ?? 0) + 1,
        lastError: error instanceof Error ? error.message : "The preflight browser session did not confirm release.",
        budgetReservationId: preflight?.budgetReservationId ?? reservationId,
        budgetMonth: storedMonth,
      };
      recordApplicationBlocker(current, "resource_hold", "The imported preflight browser session is still held. It must stop before this application can continue.", { sessionId: knownSessionId });
    } else if (options.retainBudget || options.allocationUncertain || metadata.allocationUncertain) {
      shouldRelease = false;
      if (preflight?.token === token) {
        current.importedPreflight = {
          ...preflight,
          budgetReservationId: preflight.budgetReservationId ?? reservationId,
          budgetMonth: storedMonth,
          allocationUncertain: options.allocationUncertain || metadata.allocationUncertain || undefined,
        };
        recordApplicationBlocker(current, "resource_hold", "The browser allocation outcome is uncertain. Resolve the provider hold before retrying this application.");
      }
    } else if (preflight?.token === token) {
      if (shouldRelease) {
        // Keep the claim until compensation succeeds. This prevents a failed
        // refund from turning an unused reservation into a retryable claim.
        current.browserSessionId = current.browserConnectUrl = current.browserLiveUrl = undefined;
        current.browserProvider = undefined;
        current.browserReleasePending = undefined;
      } else {
        current.importedPreflight = undefined;
        current.browserSessionId = current.browserConnectUrl = current.browserLiveUrl = undefined;
        current.browserProvider = undefined;
        current.browserReleasePending = undefined;
      }
    }
    if (!terminalApplication(current)) current.error = error instanceof Error ? error.message : "The imported preflight could not be completed.";
  });
  if (!shouldRelease || held) return;
  try {
    await releasePreflightBudget(userId, applicationId, token, month);
    await mutateState(userId, (state) => {
      const current = state.applications.find((item) => item.id === applicationId && item.userId === userId);
      if (current?.importedPreflight?.token === token) current.importedPreflight = undefined;
    });
  } catch (releaseError) {
    await mutateState(userId, (state) => {
      const current = state.applications.find((item) => item.id === applicationId && item.userId === userId);
      if (!current || current.importedPreflight?.token !== token) return;
      const storedMonth = current.importedPreflight.budgetMonth ?? month ?? serviceBudgetMonth();
      const storedReservationId = current.importedPreflight.budgetReservationId ?? reservationId;
      current.importedPreflight = {
        ...current.importedPreflight,
        budgetReservationId: storedReservationId,
        budgetMonth: storedMonth,
        budgetReleasePending: {
          kind: "unused",
          reservationId: storedReservationId,
          month: storedMonth,
          attempts: (current.importedPreflight.budgetReleasePending?.attempts ?? 0) + 1,
          lastError: releaseError instanceof Error ? releaseError.message : "The unused browser budget could not be released.",
        },
      };
      recordApplicationBlocker(current, "resource_hold", "Unused browser budget is awaiting compensation before this application can retry.");
    });
  }
}

export function preflightStatus(form: Pick<FormSnapshot, "fields" | "submitControl" | "blockers">, identityError?: string): "reachable" | "blocked" {
  if (identityError || !form.fields.length || !form.submitControl?.action) return "blocked";
  if ((form.blockers ?? []).some((blocker) => hardBlocker.test(blocker))) return "blocked";
  return "reachable";
}

export async function runImportedPreflight(
  userId: string,
  jobId: string,
  observe: PreflightObserver = preflightBrowser,
): Promise<{ applicationId: string; status: "reachable" | "blocked"; record: ReturnType<typeof createImportedCompatibilityRecord> }> {
  const token = newId();
  const applicationId = await mutateState(userId, (state) => {
    const job = findJob(state, jobId);
    if (job.source !== "imported" && !job.importUrl) throw new Error("Preflight is available only for imported employer links.");
    assertAutomationEnabled(state.profile);
    const application = findOrCreateApplication(state, job, userId);
    if (![
      "selected",
      "draft_review",
    ].includes(application.status) || application.importedPreflight || application.browserSessionId || application.browserReleasePending || application.queuedRun || application.runToken || application.submissionStartedAt || application.submissionAttemptedAt || application.submittedAt || application.submissionReceipt || application.manualSubmissionReport || ["submitted", "uncertain", "cancelled", "submitting", "awaiting_verification"].includes(application.status))
      throw new Error("This application is already running, held, or complete. Review its current state before preflight.");
    if (hasActiveBrowser(state, application.id)) throw new Error("Another browser session is active. Wait for it to stop before checking this posting.");
    application.importedPreflight = { token, startedAt: new Date().toISOString() };
    return application.id;
  });
  const budgetMonth = serviceBudgetMonth();
  let budgetReserved = false;
  try {
    const reserved = await reserveBrowserBudget(userId, applicationId, token, budgetMonth);
    if (!reserved) {
      const error = new Error("The service spending limit is full. The imported preflight was not started.");
      Object.assign(error, { budgetNeverAllocated: true });
      await clearPreflightAfterFailure(userId, applicationId, token, error, budgetMonth, { releaseReservation: false });
      throw error;
    }
    budgetReserved = true;
  } catch (error) {
    if (budgetReserved) await clearPreflightAfterFailure(userId, applicationId, token, error, budgetMonth);
    else if (errorMetadata(error).budgetNeverAllocated !== true) await clearPreflightAfterFailure(userId, applicationId, token, error, budgetMonth, { retainBudget: true, allocationUncertain: true, releaseReservation: false });
    else await clearPreflightAfterFailure(userId, applicationId, token, error, budgetMonth, { releaseReservation: false });
    throw error;
  }
  try {
    await mutateState(userId, (state) => {
      const current = state.applications.find((item) => item.id === applicationId && item.userId === userId);
      if (current?.importedPreflight?.token === token) {
        current.importedPreflight.budgetReservationId = browserBudgetReservationId(applicationId, token);
        current.importedPreflight.budgetMonth = budgetMonth;
      }
    });
  } catch (error) {
    await clearPreflightAfterFailure(userId, applicationId, token, error, budgetMonth);
    throw error;
  }
  let before: AppState;
  let app: Application;
  let job: Job;
  try {
    before = await loadState(userId);
    const loaded = before.applications.find((item) => item.id === applicationId && item.userId === userId);
    if (!loaded) throw new Error("The imported application could not be loaded.");
    app = loaded;
    job = findJob(before, app.jobId);
    if (app.importedPreflight?.token !== token || !["selected", "draft_review"].includes(app.status) || app.queuedRun || app.runToken || app.browserSessionId || app.browserReleasePending || app.submissionStartedAt || app.submissionAttemptedAt || app.submittedAt || app.submissionReceipt || hasActiveBrowser(before, app.id)) throw new Error("The imported preflight changed before browser allocation.");
    assertAutomationEnabled(before.profile);
  } catch (error) {
    await clearPreflightAfterFailure(userId, applicationId, token, error, budgetMonth);
    throw error;
  }
  const owner = { userId, applicationId, jobId: job.id, runId: `preflight:${applicationId}:${token}` };
  let result: PreflightBrowserResult | undefined;
  let error: unknown;
  let releaseConfirmed = false;
  let allocationStarted = false;
  try {
    const observer = (opened: PreflightSession) => {
      allocationStarted = true;
      return persistSession(userId, applicationId, token, opened);
    };
    result = await (browserUsageContext() ? observe(app, job, observer) : withBrowserUsageContext(owner, () => observe(app, job, observer)));
  } catch (caught) {
    error = caught;
    const metadata = errorMetadata(caught);
    releaseConfirmed = Boolean(metadata.browserReleaseConfirmed);
    allocationStarted ||= Boolean(metadata.browserSessionId || releaseConfirmed);
  }
  allocationStarted ||= Boolean(result);
  const now = new Date().toISOString();
  const identityError = result ? validateImportedPostingEvidence(job, result.postingEvidence) : undefined;
  const destinationError = result ? jobDestinationConflict({ location: result.postingContext?.location ?? "" }) : undefined;
  const status = result ? preflightStatus(result.form, identityError ?? destinationError ?? undefined) : "blocked";
  const formUrl = result?.form.url ?? job.applyUrl;
  const formHash = result?.form ? formDigest(result.form) : undefined;
  const record = createImportedCompatibilityRecord({
    application: app,
    job,
    observed: { url: formUrl, hash: formHash, submitControl: result?.form.submitControl, contextHash: result?.contextHash, postingEvidence: result?.postingEvidence, observedContext: result?.postingContext },
    checkedAt: now,
    status,
    blocker: error instanceof Error ? error.message : identityError ?? destinationError ?? (status === "blocked" ? result?.form.blockers?.join(" ") : undefined),
    controlled: app.controlledTest !== undefined,
  });
  let heldAfterSave = false;
  let retainBudgetAfterSave = allocationStarted || Boolean(errorMetadata(error).allocationUncertain);
  let saved = false;
  try {
    const finalization = await mutateState(userId, (state) => {
    const current = state.applications.find((item) => item.id === applicationId && item.userId === userId);
    if (!current) throw new Error("The imported application changed before preflight could be saved.");
    const currentJob = state.jobs.find((item) => item.id === current.jobId);
    const changed = !currentJob || canonicalJobUrl(currentJob.url) !== canonicalJobUrl(job.url) || !["selected", "draft_review"].includes(current.status) || current.submissionStartedAt || current.submissionAttemptedAt || current.submittedAt || current.submissionReceipt || current.importedPreflight?.token !== token;
    if (changed) {
      const metadata = errorMetadata(error);
      const sessionId = current.browserSessionId ?? current.importedPreflight?.sessionId ?? metadata.browserSessionId;
      const provider = current.browserProvider ?? current.importedPreflight?.provider ?? metadata.browserProvider;
      const cleanupConfirmed = !error || releaseConfirmed || metadata.browserReleaseConfirmed === true;
      if (sessionId && !cleanupConfirmed) {
        heldAfterSave = true;
        current.browserSessionId = sessionId;
        current.browserProvider = provider;
        current.browserReleasePending = { sessionId, provider, requestedAt: now, attempts: (current.browserReleasePending?.attempts ?? 0) + 1, lastError: error instanceof Error ? error.message : "The preflight browser session did not confirm release.", budgetReservationId: current.importedPreflight?.budgetReservationId ?? browserBudgetReservationId(applicationId, token), budgetMonth: current.importedPreflight?.budgetMonth ?? budgetMonth };
        retainBudgetAfterSave = true;
        recordApplicationBlocker(current, "resource_hold", "The imported preflight browser session is still held. It must stop before this application can continue.", { sessionId });
      } else if (error && metadata.allocationUncertain && current.importedPreflight?.token === token) {
        current.importedPreflight = { ...current.importedPreflight, allocationUncertain: metadata.allocationUncertain || undefined };
        recordApplicationBlocker(current, "resource_hold", "The browser allocation outcome is uncertain. Resolve the provider hold before retrying this application.");
      } else {
        current.browserSessionId = current.browserConnectUrl = current.browserLiveUrl = undefined;
        current.browserProvider = undefined;
        current.browserReleasePending = undefined;
      }
      const preserveClaim = Boolean(!retainBudgetAfterSave && current.importedPreflight?.token === token);
      if (!preserveClaim) current.importedPreflight = undefined;
      if (!terminalApplication(current)) current.error = error instanceof Error ? error.message : "The imported preflight changed before it could be saved.";
      return { saved: false };
    }
    current.importedCompatibility = record;
    current.importedOutcome = { version: 1, kind: status, at: now, evidence: record.blocker, synthetic: record.controlled };
    current.updatedAt = now;
    if (error && !releaseConfirmed) {
      const metadata = errorMetadata(error);
      const preflight = current.importedPreflight;
      const sessionId = current.browserSessionId ?? preflight?.sessionId ?? metadata.browserSessionId;
      const provider = current.browserProvider ?? preflight?.provider ?? metadata.browserProvider;
      if (sessionId) {
        heldAfterSave = true;
        retainBudgetAfterSave = true;
        current.browserSessionId = sessionId;
        current.browserProvider = provider;
        current.browserReleasePending = { sessionId, provider, requestedAt: now, attempts: (current.browserReleasePending?.attempts ?? 0) + 1, lastError: record.blocker ?? "The preflight browser session did not confirm release.", budgetReservationId: preflight?.budgetReservationId ?? browserBudgetReservationId(applicationId, token), budgetMonth: preflight?.budgetMonth ?? budgetMonth };
        recordApplicationBlocker(current, "resource_hold", "The preflight browser provider did not confirm release. Review this hold before trying again.", { sessionId });
      } else if (retainBudgetAfterSave) {
        if (preflight) current.importedPreflight = { ...preflight, allocationUncertain: errorMetadata(error).allocationUncertain || undefined };
        recordApplicationBlocker(current, "resource_hold", "The browser allocation outcome is uncertain. Resolve the provider hold before retrying this application.");
      }
      // Keep a proven-unused claim until the compensation release succeeds.
      current.error = record.blocker;
    } else {
      current.browserSessionId = current.browserConnectUrl = current.browserLiveUrl = undefined;
      current.browserProvider = undefined;
      current.browserReleasePending = undefined;
      current.importedPreflight = undefined;
      current.error = error instanceof Error ? error.message : undefined;
    }
    if (error && releaseConfirmed) current.importedPreflight = undefined;
    const blockerMessage = record.blocker;
    const hasPreflightHold = heldAfterSave || Boolean(current.importedPreflight?.allocationUncertain);
    if (blockerMessage && !hasPreflightHold && (status === "blocked" || error)) {
      recordApplicationBlocker(current, blockerReason(blockerMessage), blockerMessage, { targetUrl: result?.form.url ?? job.applyUrl });
    }
    state.activity.unshift({ id: newId(), at: now, label: status === "reachable" ? "Employer page checked" : "Imported application needs review", detail: record.blocker || "The imported posting and form were observed." });
    return { saved: true };
    });
    saved = finalization.saved;
  } catch (saveError) {
    await clearPreflightAfterFailure(userId, applicationId, token, saveError, budgetMonth, { retainBudget: allocationStarted, allocationUncertain: errorMetadata(saveError).allocationUncertain });
    throw saveError;
  }
  if (!heldAfterSave && !retainBudgetAfterSave) await clearPreflightAfterFailure(userId, applicationId, token, new Error("The imported preflight did not allocate a browser."), budgetMonth);
  if (!saved) throw new Error("The imported application changed before preflight could be saved.");
  return { applicationId, status, record };
}

async function persistSession(userId: string, applicationId: string, token: string, opened: PreflightSession): Promise<boolean> {
  return mutateState(userId, (state) => {
    const app = state.applications.find((item) => item.id === applicationId && item.userId === userId);
    if (!app) return false;
    const blockedByAnotherBrowser = hasActiveBrowser(state, applicationId);
    app.browserSessionId = opened.sessionId;
    app.browserProvider = opened.provider;
    if (app.importedPreflight?.token === token && !terminalApplication(app)) {
      app.importedPreflight = { ...app.importedPreflight, sessionId: opened.sessionId, provider: opened.provider };
      return !blockedByAnotherBrowser;
    }
    app.browserReleasePending = { sessionId: opened.sessionId, provider: opened.provider, requestedAt: new Date().toISOString(), attempts: (app.browserReleasePending?.attempts ?? 0) + 1, lastError: "The application changed while the preflight browser was being allocated.", budgetReservationId: app.importedPreflight?.budgetReservationId ?? browserBudgetReservationId(applicationId, token), budgetMonth: app.importedPreflight?.budgetMonth };
    return false;
  });
}

export function compatibilityFormHash(result: PreflightBrowserResult): string {
  return hashJson(result.form);
}
