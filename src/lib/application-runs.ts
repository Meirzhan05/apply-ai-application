import { prepareAutonomousFormEssays } from "@/lib/autonomous-essays";
import { withModelUsageContext } from "@/lib/model-usage";
import { assertAutonomous, assertAutonomousDestination, sealAutonomousPacket, unsupportedAutonomousForm } from "@/lib/autonomous-policy";
import { queueAutonomousSubmission, saveAutonomousSubmission } from "@/lib/autonomous-application";
import { hashJson, newId } from "@/lib/crypto";
import { loadState, mutateState } from "@/lib/repository";
import { draftPacket, validatePacket, withGroundedCoverLetter } from "@/lib/drafting";
import { ResumeDraftError } from "@/lib/resume-document";
import { assertJobEligible } from "@/lib/application-policy";
import { cancelBrowser, prepareBrowser } from "@/lib/browser-runner";
import { sendActionNeeded } from "@/lib/email";
import { writeBrowserQuestionEssays } from "@/lib/browser-question-runs";
import { browserQuestions } from "@/lib/browser-questions";
import { recordBrowserUsageEvent, withBrowserUsageContext } from "@/lib/browser-usage";
import { formDigest, setFormSnapshot, setPacket, transition } from "@/lib/workflow";
import { blockerReason, recordApplicationBlocker, resolveResumingApplicationBlockers } from "@/lib/application-blockers";
import { importedAutonomyJob } from "@/lib/import-compatibility";
import { assertSourceJobCurrent } from "@/lib/resume-source-freshness";
import { originalResumeManifest, readOriginalResume } from "@/lib/original-resume";
import { prepareApiApplication } from "@/lib/ats-application";
import { parsePdfSource } from "@/lib/pdf-source";
import { unconfirmedPdfFactSuggestions, sourceWithCurrentEvidenceClaims } from "@/lib/source-plan-evidence";
import type { AppState, Application, Profile } from "@/lib/types";
import { isResumeOnboardingComplete } from "@/lib/onboarding-gate";

export type RunPayload = { userId: string; applicationId: string; runToken?: string; draftMode?: "resume" | "essays" };

async function assertTailoringSourceReady(profile: Profile): Promise<void> {
  if (!profile.resumeSource || !profile.resumeFileName)
    throw new Error("Upload and confirm your original PDF or DOCX résumé before tailoring. Choose the original-résumé setting only when you want to attach unchanged source bytes.");
  const format = profile.resumeSource.mimeType === "application/pdf" ? "PDF" : "DOCX";
  if (!profile.resumeSourceDocument)
    throw new Error(`This saved ${format} predates source-aware résumé review. Re-upload it to inspect and confirm its original layout before tailoring; choose the original-résumé setting to attach its exact unchanged bytes.`);
  if (profile.resumeSourceDocument.format !== (format === "PDF" ? "pdf" : "docx") ||
      profile.resumeSourceDocument.sourceHash !== profile.resumeSource.sha256)
    throw new Error(`The inspected ${format} no longer matches the uploaded original. Re-upload it before tailoring.`);
  if (profile.resumeSourceDocument.support.status !== "candidate")
    throw new Error(profile.resumeSourceDocument.support.reason ?? `This ${format} layout is not supported for source-preserving tailoring. Upload an editable DOCX or choose the exact original-résumé setting.`);
  const original = originalResumeManifest(profile);
  await readOriginalResume(profile.id, original);
}

async function refreshLegacyPdfInspection(userId: string, state: AppState): Promise<AppState> {
  const profile = state.profile;
  const previous = profile.resumeSourceDocument;
  const resumeSource = profile.resumeSource;
  if (!resumeSource || !previous || previous.format !== "pdf" || previous.sourceHash !== resumeSource.sha256) return state;

  let inspected = previous;
  if (previous.version < 3) {
    const original = originalResumeManifest(profile);
    const bytes = await readOriginalResume(userId, original);
    inspected = await parsePdfSource(bytes, profile.name);
    if (inspected.version !== 3 || inspected.sourceHash !== resumeSource.sha256)
      throw new Error("The saved PDF could not be re-inspected against its original bytes. Re-upload and confirm the current source before tailoring.");
  }
  inspected = sourceWithCurrentEvidenceClaims(inspected, profile.name);
  const previousAnchors = new Map(previous.anchors.map((anchor) => [anchor.id, anchor]));
  // Re-inspecting the same bytes repairs metadata, not the owner's source-claim selection.
  inspected = { ...inspected, anchors: inspected.anchors.map((anchor) => {
    const original = previousAnchors.get(anchor.id);
    return original?.text === anchor.text ? { ...anchor, candidateClaim: original.candidateClaim } : anchor;
  }) };
  const inspectedAnchorIds = new Set(inspected.anchors.map((anchor) => anchor.id));
  if (previous.version < 3 && profile.facts.some((fact) => fact.sourceAnchorId && !inspectedAnchorIds.has(fact.sourceAnchorId)))
    throw new Error("A confirmed résumé fact no longer matches the same source text after PDF re-inspection. Re-upload and reconfirm that fact before tailoring.");

  await mutateState(userId, (current) => {
    const currentProfile = current.profile;
    const currentSource = currentProfile.resumeSource;
    const currentDocument = currentProfile.resumeSourceDocument;
    if (!currentSource || currentSource.storageKey !== resumeSource.storageKey || currentSource.sha256 !== resumeSource.sha256 ||
        currentSource.size !== resumeSource.size || currentSource.mimeType !== resumeSource.mimeType ||
        currentProfile.resumeFileName !== profile.resumeFileName || currentDocument?.format !== "pdf" ||
        currentDocument.version !== previous.version || currentDocument.sourceHash !== previous.sourceHash ||
        hashJson(currentDocument) !== hashJson(previous))
      throw new Error("The saved PDF source changed while it was being re-inspected. Retry using the current source; no facts were remapped.");
    if (previous.version < 3 && currentProfile.facts.some((fact) => fact.sourceAnchorId && !inspectedAnchorIds.has(fact.sourceAnchorId)))
      throw new Error("A confirmed résumé fact changed while the PDF was being re-inspected. Retry after reviewing the current source facts.");
    currentProfile.resumeSourceDocument = inspected;
    currentProfile.resumeText = inspected.text;
    const selectedAnchors = new Set(inspected.anchors.filter((anchor) => anchor.candidateClaim).map((anchor) => anchor.id));
    const suggestions = unconfirmedPdfFactSuggestions(currentProfile, inspected).filter((suggestion) => selectedAnchors.has(suggestion.sourceAnchorId));
    for (const suggestion of suggestions) {
      if (currentProfile.facts.length >= 80) break;
      currentProfile.facts.push({ id: newId(), text: suggestion.text, verified: false, source: "resume", sourceAnchorId: suggestion.sourceAnchorId });
    }
  });
  return loadState(userId);
}

async function releaseParkedBrowser(userId: string, application: Application, sessionId: string, provider: Application["browserProvider"]): Promise<boolean> {
  try {
    await cancelBrowser({ ...application, browserSessionId: sessionId, browserProvider: provider }, { strict: true });
  } catch (error) {
    await mutateState(userId, (state) => {
      const target = state.applications.find((item) => item.id === application.id && item.userId === userId);
      if (!target || target.browserSessionId !== sessionId) return;
      const timestamp = new Date().toISOString();
      target.browserReleasePending = {
        sessionId,
        requestedAt: target.browserReleasePending?.requestedAt ?? timestamp,
        attempts: (target.browserReleasePending?.attempts ?? 0) + 1,
        lastError: error instanceof Error ? error.message : "The provider did not confirm the browser release.",
      };
      recordApplicationBlocker(target, "resource_hold", "The browser provider has not confirmed release yet. The next application will wait until this session is stopped.", { sessionId, packetHash: target.packetHash, targetUrl: target.form?.url });
    });
    return false;
  }
  await mutateState(userId, (state) => {
    const target = state.applications.find((item) => item.id === application.id && item.userId === userId);
    if (target?.browserSessionId === sessionId) {
      target.browserSessionId = target.browserConnectUrl = target.browserLiveUrl = undefined;
      target.browserReleasePending = undefined;
    }
  });
  return true;
}

async function currentAutonomousRun(userId: string, applicationId: string, runToken: string | undefined, phase: "draft" | "fill") {
  await mutateState(userId, (state) => {
    const app = state.applications.find((item) => item.id === applicationId && item.userId === userId);
    if (!app || app.runToken !== runToken || app.status !== (phase === "draft" ? "drafting" : "filling")) throw new Error("The automatic run changed before provider work.");
    assertAutonomous(app, state.profile, state.jobs.find((job) => job.id === app.jobId), phase);
  });
}

async function currentDraftRun(userId: string, applicationId: string, runToken: string | undefined, expected: {
  claimedAt?: string;
  profileHash: string;
  jobHash: string;
  packetHash?: string;
  packetContentHash: string;
  autonomous: boolean;
}) {
  await mutateState(userId, (state) => {
    const app = state.applications.find((item) => item.id === applicationId && item.userId === userId);
    if (!app || app.status !== "drafting" || app.runToken !== runToken || app.runWorkerClaimedAt !== expected.claimedAt)
      throw new Error("The application draft was cancelled or changed before provider work.");
    const job = state.jobs.find((item) => item.id === app.jobId) ?? app.jobSnapshot;
    if (!job?.active) throw new Error("The job is closed or unavailable.");
    const eligibilityJob = importedAutonomyJob(app, job);
    if (Boolean(app.autonomousAuthorization) !== expected.autonomous || hashJson(state.profile) !== expected.profileHash ||
      hashJson(eligibilityJob) !== expected.jobHash || app.packetHash !== expected.packetHash || hashJson(app.packet ?? null) !== expected.packetContentHash)
      throw new Error("The profile, job, or prior packet changed before provider work. Start a new draft.");
    assertJobEligible(state.profile, eligibilityJob);
    if (app.autonomousAuthorization) assertAutonomous(app, state.profile, state.jobs.find((item) => item.id === app.jobId), "draft");
  });
}

async function claimRun(userId: string, applicationId: string, runToken: string | undefined, status: "drafting" | "filling") {
  return mutateState(userId, (state) => {
    if (!isResumeOnboardingComplete(state.profile)) return false;
    const app = state.applications.find((item) => item.id === applicationId && item.userId === userId);
    if (!app || app.status !== status || app.runToken !== runToken || app.runWorkerClaimedAt) return false;
    app.runWorkerClaimedAt = new Date().toISOString();
    app.updatedAt = app.runWorkerClaimedAt;
    if (status === "drafting") app.resumeDraftDiagnostics = undefined;
    return true;
  });
}

export async function runDraft({ userId, applicationId, runToken, draftMode }: RunPayload) {
  if (!(await claimRun(userId, applicationId, runToken, "drafting"))) return { skipped: true };
  let state = await loadState(userId);
  const claimedApp = state.applications.find((item) => item.id === applicationId);
  if (!claimedApp || claimedApp.userId !== userId || claimedApp.status !== "drafting" || claimedApp.runToken !== runToken) return { skipped: true };
  let app: Application = claimedApp;
  const job = state.jobs.find((item) => item.id === app.jobId) ?? app.jobSnapshot;
  try {
    if (state.profile.automationSettings?.resumeTailoring !== false && (!app.packet || draftMode === "resume")) {
      state = await refreshLegacyPdfInspection(userId, state);
      const refreshedApp = state.applications.find((item) => item.id === applicationId);
      if (!refreshedApp || refreshedApp.userId !== userId || refreshedApp.status !== "drafting" || refreshedApp.runToken !== runToken) return { skipped: true };
      app = refreshedApp;
    }
    if (!job?.active) throw new Error("The job is closed or unavailable.");
    if (state.profile.automationSettings?.resumeTailoring !== false && app.packet?.resumeSourcePlan && draftMode !== "resume") assertSourceJobCurrent(app, job);
    if (state.profile.automationSettings?.resumeTailoring !== false && (!app.packet || draftMode === "resume"))
      await assertTailoringSourceReady(state.profile);
    else if (state.profile.automationSettings?.resumeTailoring === false)
      await readOriginalResume(state.profile.id, originalResumeManifest(state.profile));
    const eligibilityJob = importedAutonomyJob(app, job);
    assertJobEligible(state.profile, eligibilityJob);
    if (app.autonomousAuthorization) assertAutonomous(app, state.profile, state.jobs.find((item) => item.id === app.jobId), "draft");
    const expectedRunInputs = {
      claimedAt: app.runWorkerClaimedAt,
      profileHash: hashJson(state.profile),
      jobHash: hashJson(eligibilityJob),
      packetHash: app.packetHash,
      packetContentHash: hashJson(app.packet ?? null),
      autonomous: Boolean(app.autonomousAuthorization),
    };
    const beforeModelCall = () => currentDraftRun(userId, applicationId, runToken, expectedRunInputs);
    await beforeModelCall();
    const packet = await withModelUsageContext({ userId, applicationId, jobId: job.id, runId: runToken ?? newId() }, () => draftPacket(state.profile, eligibilityJob, app.packet, { resumeFormat: "latex", deadline: Date.now() + 540_000, beforeModelCall, knownAnswersOnly: Boolean(app.autonomousAuthorization), preserveResume: Boolean(app.packet) && draftMode !== "resume", regenerateEssays: draftMode === "essays" || (Boolean(app.packet) && !draftMode) }));
    await mutateState(userId, (current) => {
      const target = current.applications.find((item) => item.id === applicationId);
      if (!target || target.status !== "drafting" || target.runToken !== runToken) return;
      const currentJob = current.jobs.find((item) => item.id === target.jobId) ?? target.jobSnapshot;
      if (!currentJob) throw new Error("The job is closed or unavailable.");
      if (packet.resumeSourcePlan) assertSourceJobCurrent(target, currentJob, packet.resumeSourcePlan.jobHash, packet.resumeSourcePlan.jobHashPolicyVersion ?? 1);
      if (target.autonomousAuthorization) assertAutonomous(target, current.profile, current.jobs.find((item) => item.id === target.jobId), "draft");
      validatePacket(current.profile, packet);
      setPacket(current, target, packet);
      target.resumeDraftDiagnostics = undefined;
      if (target.autonomousAuthorization) {
        sealAutonomousPacket(target);
        transition(target, ["draft_review"], "authorized_to_fill");
        target.queuedRun = { id: newId(), kind: "fill", requestedAt: new Date().toISOString(), reason: "waiting" };
      }
      current.activity.unshift({ id: newId(), at: new Date().toISOString(), label: "Packet ready", detail: packet.summary });
    });
    if (app.autonomousAuthorization) await (await import("@/lib/application-queue")).queueApplicationRun(userId, applicationId, "fill");
    else if (process.env.EMAIL_FROM) await sendActionNeeded(await loadState(userId), "An application packet is ready for review").catch(() => undefined);
    return { drafted: true };
  } catch (error) {
    await mutateState(userId, (current) => {
      const target = current.applications.find((item) => item.id === applicationId);
      if (target?.status === "drafting" && target.runToken === runToken) {
        transition(target, ["drafting"], target.autonomousAuthorization ? "needs_user_action" : target.packet ? "draft_review" : "selected");
        target.runWorkerClaimedAt = undefined;
        const message = error instanceof Error ? error.message : "Drafting failed.";
        const withoutPreservation = message.replace(/(?:Your |The |your |the )?(?:last valid|previous) packet is preserved\.?/g, "").replace(/\s+([.;])/g, "$1").replace(/;\s*$/g, ".").trim();
        target.error = `${withoutPreservation}${target.packet ? " Your existing materials remain available." : ""}`;
        if (error instanceof ResumeDraftError) target.resumeDraftDiagnostics = error.diagnostics;
        if (target.autonomousAuthorization) recordApplicationBlocker(target, error instanceof ResumeDraftError && error.diagnostics.outcome === "needs_information" ? "missing_answer" : blockerReason(target.error), target.error, { packetHash: target.packetHash, targetUrl: job?.applyUrl });
      }
    });
    if (app.autonomousAuthorization) await (await import("@/lib/application-queue")).dispatchUserQueue(userId).catch(() => undefined);
    throw error;
  }
}

export async function runFill({ userId, applicationId, runToken }: RunPayload) {
  if (!(await claimRun(userId, applicationId, runToken, "filling"))) return { skipped: true };
  const state = await loadState(userId);
  const app = state.applications.find((item) => item.id === applicationId);
  if (!app || app.userId !== userId || app.status !== "filling" || app.runToken !== runToken) return { skipped: true };
  const job = state.jobs.find((item) => item.id === app.jobId) ?? app.jobSnapshot;
  let session: Awaited<ReturnType<typeof prepareBrowser>> | undefined;
  try {
    if (!job?.active || !app.packet) throw new Error("The job or approved packet is unavailable.");
    assertSourceJobCurrent(app, job);
    const eligibilityJob = importedAutonomyJob(app, job);
    assertJobEligible(state.profile, eligibilityJob);
    validatePacket(state.profile, app.packet);
    if (app.autonomousAuthorization) assertAutonomous(app, state.profile, state.jobs.find((item) => item.id === app.jobId), "fill");
    if (app.autonomousAuthorization) await currentAutonomousRun(userId, applicationId, runToken, "fill");
    const api = await prepareApiApplication(app, job, state.profile);
    if (api.kind === "api" && (!app.autonomousAuthorization || !unsupportedAutonomousForm(api.form, app))) {
      const saved = await mutateState(userId, (current) => {
        const target = current.applications.find((item) => item.id === applicationId && item.userId === userId);
        if (!target || target.status !== "filling" || target.runToken !== runToken || target.packetHash !== app.packetHash ||
          hashJson(target.packet) !== app.packetHash || hashJson(current.profile) !== hashJson(state.profile)) return false;
        const currentJob = current.jobs.find((item) => item.id === target.jobId) ?? target.jobSnapshot;
        if (!currentJob?.active || currentJob.applyUrl !== job.applyUrl || currentJob.url !== job.url) return false;
        assertJobEligible(current.profile, currentJob);
        assertSourceJobCurrent(target, currentJob);
        validatePacket(current.profile, target.packet!);
        if (target.autonomousAuthorization) assertAutonomous(target, current.profile, currentJob, "fill");
        setFormSnapshot(target, api.form);
        target.error = undefined;
        if (target.autonomousAuthorization) {
          resolveResumingApplicationBlockers(target);
          saveAutonomousSubmission(current, target);
        }
        current.activity.unshift({ id: newId(), at: new Date().toISOString(), label: "Application prepared", detail: `${job.title} · direct employer submission` });
        return true;
      });
      if (!saved) return { cancelled: true };
      if (app.autonomousAuthorization) await queueAutonomousSubmission(userId, applicationId);
      else if (process.env.EMAIL_FROM) await sendActionNeeded(await loadState(userId), "An application is ready for review").catch(() => undefined);
      return { needsAction: false, transport: "api" as const };
    }
    session = await withBrowserUsageContext({ userId, applicationId, jobId: job.id, runId: runToken ?? app.runToken ?? newId() }, () => prepareBrowser(app, job, state.profile, async (opened) => mutateState(userId, (current) => {
      const target = current.applications.find((item) => item.id === applicationId);
      if (!target || target.status !== "filling" || target.runToken !== runToken) return false;
      const currentJob = current.jobs.find((item) => item.id === target.jobId) ?? target.jobSnapshot;
      if (!currentJob) throw new Error("The job or approved packet is unavailable.");
      assertSourceJobCurrent(target, currentJob);
      if (target.autonomousAuthorization) assertAutonomous(target, current.profile, current.jobs.find((item) => item.id === target.jobId), "fill");
      validatePacket(current.profile, target.packet!);
      app.browserSessionId = opened.sessionId;
      target.browserSessionId = opened.sessionId;
      target.browserProvider = opened.provider;
      target.browserSessionExpiresAt = opened.expiresAt;
      target.browserCaptchaSolving = opened.captchaSolving;
      target.browserActions = [];
      target.browserConnectUrl = opened.connectUrl;
      target.browserLiveUrl = opened.liveUrl;
      target.browserSessionCreatedAt = new Date().toISOString();
      return true;
    }), async (label) => mutateState(userId, (current) => {
      const target = current.applications.find((item) => item.id === applicationId && item.userId === userId);
      if (!target || target.status !== "filling" || target.runToken !== runToken) return false;
      const currentJob = current.jobs.find((item) => item.id === target.jobId) ?? target.jobSnapshot;
      if (!currentJob) throw new Error("The job or approved packet is unavailable.");
      assertSourceJobCurrent(target, currentJob);
      if (target.autonomousAuthorization) assertAutonomous(target, current.profile, current.jobs.find((item) => item.id === target.jobId), "fill");
      else validatePacket(current.profile, target.packet!);
      target.browserActions = [...(target.browserActions || []), { at: new Date().toISOString(), label }].slice(-60);
      return true;
    }), app.autonomousAuthorization ? async (observed) => {
      if (!observed.fields.some((field) => field.kind === "file" && field.required && /cover\s*letter/i.test(field.label))) throw new Error("The required cover-letter control changed.");
      assertAutonomousDestination(app, observed);
      if (state.profile.automationSettings!.coverLetterMode === "disabled") throw new Error("The employer requires a cover letter, but your cover-letter setting is disabled.");
      const packet = await withGroundedCoverLetter(state.profile, eligibilityJob, app.packet!, () => currentAutonomousRun(userId, applicationId, runToken, "fill"));
      await mutateState(userId, (current) => {
        const target = current.applications.find((item) => item.id === applicationId && item.userId === userId);
        if (!target || target.status !== "filling" || target.runToken !== runToken || target.packetHash !== app.packetHash) throw new Error("The application materials changed during letter preparation.");
        assertAutonomous(target, current.profile, current.jobs.find((item) => item.id === target.jobId), "fill");
        validatePacket(current.profile, packet);
        target.packet = packet; target.packetHash = hashJson(packet); target.form = undefined; target.autonomousAuthorization!.requiredCoverLetter = true; sealAutonomousPacket(target);
        current.activity.unshift({ id: newId(), at: new Date().toISOString(), label: "Required cover letter prepared", detail: "Grounded in confirmed facts; continuing the same authorized browser session." });
      });
      app.packet = packet; app.packetHash = hashJson(packet); app.autonomousAuthorization!.requiredCoverLetter = true; sealAutonomousPacket(app);
      return packet;
    } : undefined, app.autonomousAuthorization ? async (observed) => {
      assertAutonomousDestination(app, observed);
      const packet = await withModelUsageContext({ userId, applicationId, jobId: job.id, runId: runToken ?? app.runToken ?? newId() }, () => prepareAutonomousFormEssays(state.profile, eligibilityJob, app, observed, () => currentAutonomousRun(userId, applicationId, runToken, "fill")));
      await mutateState(userId, (current) => {
        const target = current.applications.find((item) => item.id === applicationId && item.userId === userId);
        if (!target || target.status !== "filling" || target.runToken !== runToken || target.packetHash !== app.packetHash || target.browserSessionId !== app.browserSessionId) throw new Error("The form or materials changed during automatic essay preparation.");
        assertAutonomous(target, current.profile, current.jobs.find((item) => item.id === target.jobId), "fill");
        validatePacket(current.profile, packet);
        target.packet = packet; target.packetHash = hashJson(packet); target.form = undefined; sealAutonomousPacket(target);
        current.activity.unshift({ id: newId(), at: new Date().toISOString(), label: "Essay prepared", detail: "Truthfully grounded; continuing the same authorized form." });
      });
      app.packet = packet; app.packetHash = hashJson(packet); sealAutonomousPacket(app);
      return packet;
    } : undefined));
    const result = session;
    if (app.autonomousAuthorization && (result.needsCoverLetter || unsupportedAutonomousForm(result.form, app))) {
      result.needsAction = true;
      result.form.readyToSubmit = false;
      result.form.blockers = [...result.form.blockers || [], result.needsCoverLetter ? "The employer requires a cover letter, but your saved cover-letter mode does not permit this attachment." : "An essay or required answer could not be grounded under the current authorization."];
    }
    const saved = await mutateState(userId, (current) => {
      const target = current.applications.find((item) => item.id === applicationId);
      if (!target || target.status !== "filling" || target.runToken !== runToken) return false;
      if (target.autonomousAuthorization) assertAutonomous(target, current.profile, current.jobs.find((item) => item.id === target.jobId), "fill");
      validatePacket(current.profile, target.packet!);
      target.browserSessionId = result.sessionId;
      target.browserProvider = result.provider;
      target.browserSessionExpiresAt = result.expiresAt;
      target.browserCaptchaSolving = result.captchaSolving;
      target.browserSessionCreatedAt = app.runWorkerClaimedAt || app.updatedAt;
      target.browserConnectUrl = result.connectUrl;
      target.browserLiveUrl = result.liveUrl;
      target.needsCoverLetter = result.needsCoverLetter;
      if (result.needsAction) {
        target.form = { ...result.form, hash: formDigest(result.form) };
        const messages = result.form.blockers?.length ? result.form.blockers : ["The employer form needs user action before automatic processing can continue."];
        const observedQuestions = browserQuestions(target.form);
        for (const message of messages) {
          const label = message.match(/(?:field|option for):\s*(.+)$/i)?.[1]?.trim();
          const observedQuestion = label ? observedQuestions.find((question) => question.label === label) : undefined;
          recordApplicationBlocker(target, blockerReason(message), message, {
          formHash: target.form.hash,
          packetHash: target.packetHash,
          targetUrl: target.form.url,
          sessionId: result.sessionId,
          fieldIdentifiers: target.form.fields.filter((field) => field.required && field.valid === false).map((field) => field.identifier || field.label),
            observedQuestion: observedQuestion ? {
              identifier: observedQuestion.identifier,
              label: observedQuestion.label,
              kind: observedQuestion.kind,
              options: observedQuestion.options,
              value: observedQuestion.value,
            } : undefined,
          });
        }
        transition(target, ["filling"], "needs_user_action");
      } else {
        setFormSnapshot(target, result.form);
        if (target.autonomousAuthorization) resolveResumingApplicationBlockers(target);
        if (target.autonomousAuthorization) saveAutonomousSubmission(current, target);
      }
      current.activity.unshift({ id: newId(), at: new Date().toISOString(), label: result.needsAction ? "Your input needed" : target.autonomousAuthorization ? "Form ready" : "Form ready for review", detail: job.title });
      return true;
    });
    if (!saved) {
      let released = true;
      try {
        await withBrowserUsageContext({ userId, applicationId, jobId: job.id, runId: runToken ?? app.runToken ?? newId() }, () => cancelBrowser({ ...app, browserSessionId: result.sessionId, browserProvider: result.provider }, { strict: true }));
      } catch {
        released = false;
      }
      if (!released) {
        await mutateState(userId, (current) => {
          const target = current.applications.find((item) => item.id === applicationId && item.userId === userId);
          if (!target || (target.browserSessionId && target.browserSessionId !== result.sessionId)) return;
          target.browserSessionId = result.sessionId;
          target.browserProvider = result.provider;
          target.browserReleasePending = { sessionId: result.sessionId, requestedAt: new Date().toISOString(), attempts: 1, lastError: "The provider did not confirm the browser release." };
          if (target.autonomousAuthorization) recordApplicationBlocker(target, "resource_hold", "The browser provider has not confirmed release yet. The cancelled run will remain held until this session is stopped.", { sessionId: result.sessionId, packetHash: target.packetHash, targetUrl: result.form.url });
        });
      }
      return { cancelled: true };
    }
    if (app.autonomousAuthorization) {
      if (!result.needsAction) await queueAutonomousSubmission(userId, applicationId);
      else {
        const released = await releaseParkedBrowser(userId, app, result.sessionId, result.provider);
        if (!released) return { needsAction: true, releasePending: true };
        // A parked blocker must not hold the owner's only provider slot. The
        // queue scanner can now start the next queued application.
        await (await import("@/lib/application-queue")).dispatchUserQueue(userId);
      }
    } else if (browserQuestions({ ...result.form, hash: formDigest(result.form) }).some((question) => question.owner === "ai"))
      await writeBrowserQuestionEssays(userId, applicationId, formDigest(result.form)).catch(() => undefined);
    if (!app.autonomousAuthorization && process.env.EMAIL_FROM) await sendActionNeeded(await loadState(userId), session.needsAction ? "Your browser run needs your help" : "A filled application is ready for review").catch(() => undefined);
    return { needsAction: session.needsAction };
  } catch (error) {
    await withBrowserUsageContext({ userId, applicationId, jobId: job?.id, runId: runToken ?? app.runToken ?? newId() }, () => recordBrowserUsageEvent({ userId, applicationId, jobId: job?.id, runId: runToken ?? app.runToken ?? newId(), provider: app.browserProvider ?? (process.env.BROWSER_PROVIDER === "browser-use" ? "browser-use" : "browserbase"), sessionId: session?.sessionId ?? null, event: "failed", report: null, failure: "allocation_failed", orphanedSessionId: null })).catch(() => undefined);
    let released = true;
    const failedSessionId = session?.sessionId ?? app.browserSessionId;
    const failedProvider = session?.provider ?? app.browserProvider;
    if (failedSessionId) {
      try {
        await cancelBrowser({ ...app, browserSessionId: failedSessionId, browserProvider: failedProvider }, { strict: true });
      } catch {
        released = false;
      }
    }
    await mutateState(userId, (current) => {
      const target = current.applications.find((item) => item.id === applicationId);
      if (target && target.runToken === runToken && (target.status === "filling" || (target.autonomousAuthorization && target.status === "final_review"))) {
        transition(target, [target.status], target.autonomousAuthorization ? "needs_user_action" : "authorized_to_fill");
        target.error = error instanceof Error ? error.message : "Browser run failed.";
        if (target.autonomousAuthorization) {
          recordApplicationBlocker(target, blockerReason(target.error), target.error, { packetHash: target.packetHash, targetUrl: job?.applyUrl, sessionId: released ? undefined : failedSessionId });
          if (!released) recordApplicationBlocker(target, "resource_hold", "The browser provider has not confirmed release yet. The next application will wait until this session is stopped.", { sessionId: failedSessionId, packetHash: target.packetHash, targetUrl: target.form?.url });
          if (!released && failedSessionId) target.browserReleasePending = { sessionId: failedSessionId, requestedAt: new Date().toISOString(), attempts: 1, lastError: "The provider did not confirm the browser release." };
          if (released) target.browserSessionId = target.browserConnectUrl = target.browserLiveUrl = undefined;
        } else if (released) target.browserSessionId = target.browserConnectUrl = target.browserLiveUrl = undefined;
      }
    });
    if (app.autonomousAuthorization && !released) return { needsAction: true, releasePending: true };
    if (app.autonomousAuthorization) await (await import("@/lib/application-queue")).dispatchUserQueue(userId).catch(() => undefined);
    throw error;
  }
}
