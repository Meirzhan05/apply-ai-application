import { NextResponse } from "next/server";
import { tasks } from "@trigger.dev/sdk";
import type {
  submitApplicationForm,
} from "../../../../trigger/browser";
import { queuePersonalSearch } from "@/lib/personal-search";
import { queueMatchAssessment } from "@/lib/match-queue";
import { startAutonomousApplication } from "@/lib/autonomous-application";
import { z } from "zod";
import { hashJson, newId } from "@/lib/crypto";
import { updateJobFeedback } from "@/lib/job-feedback";
import { answerBrowserQuestions, reviseBrowserEssay, writeBrowserQuestionEssays } from "@/lib/browser-question-runs";
import { queueApplicationRun, dispatchUserQueue } from "@/lib/application-queue";
import { prepareApiApplication } from "@/lib/ats-application";
import { sendActionNeeded } from "@/lib/email";
import { withPacketFiles } from "@/lib/packet-files";
import { applyHumanAnswerEdits, confirmReviewedEssay, reviseEssay } from "@/lib/answer-policy";
import { returnToMaterials } from "@/lib/material-review-recovery";
import { applyFactCorrection } from "@/lib/fact-corrections";
import { answerReviewHash } from "@/lib/answer-responsibility";
import { assertJobEligible } from "@/lib/application-policy";
import { reopenManualAttempt } from "@/lib/submission-recovery";
import { checkSubmissionResult } from "@/lib/submission-verification";
import { sameOrigin } from "@/lib/request-security";
import { AccountDeletionInProgressError, withAccountOperation } from "@/lib/account-lifecycle";
import { normalizeProfileLinks } from "@/lib/resume-profile-basics";
import {
  refreshBrowserSnapshot,
  repairEducationFields,
  cancelBrowser,
} from "@/lib/browser-runner";
import {
  coverLetterFromFacts,
  validatePacket,
  packetProfileHash,
} from "@/lib/drafting";
import { assertSourceJobCurrent } from "@/lib/resume-source-freshness";
import {
  currentUserId,
  isDemo,
  loadState,
  mutateState,
} from "@/lib/repository";
import { canonicalJobUrl } from "@/lib/sources";
import { newImportedJob, refreshImportedJobs } from "@/lib/import-jobs";
import { runImportedPreflight } from "@/lib/import-preflight";
import { resumeBlockedApplication } from "@/lib/application-blockers";
import { recordApplicationBlocker } from "@/lib/application-blockers";
import {
  activateAutomation,
  bumpAutomationVersion,
  pauseAutomation,
  saveOnboarding,
  updateAutomationSettings,
} from "@/lib/onboarding";
import {
  approveFill,
  approveSubmit,
  canSubmit,
  hasFillApproval,
  selectApplication,
  setFormSnapshot,
  setPacket,
  transition,
} from "@/lib/workflow";
import type { AppState, Application, Job, Profile } from "@/lib/types";
import { enrollPilot, withdrawPilot } from "@/lib/pilot";
import { onboardingQuestionnaireSchema } from "@/lib/onboarding-questionnaire";

export const runtime = "nodejs";
export const maxDuration = 300;
const Input = z.object({
  action: z.string().max(40),
  payload: z.record(z.string(), z.unknown()).default({}),
});
const text = (value: unknown, max = 500) =>
  String(value ?? "")
    .trim()
    .slice(0, max);
const activity = (state: AppState, label: string, detail: string) =>
  state.activity.unshift({
    id: newId(),
    at: new Date().toISOString(),
    label,
    detail,
  });
const findApp = (state: AppState, id: string, userId: string): Application => {
  const app = state.applications.find(
    (item) => item.id === id && item.userId === userId,
  );
  if (!app) throw new Error("Application not found.");
  return app;
};
const findJob = (state: AppState, app: Application): Job => {
  const job =
    state.jobs.find((item) => item.id === app.jobId) ?? app.jobSnapshot;
  if (!job) throw new Error("Job not found.");
  return job;
};
const assertSourcePlanJobCurrent = (state: AppState, app: Application) => assertSourceJobCurrent(app, findJob(state, app));

// Storage/rendering happens before CAS; only the unchanged review can publish it.
const materialReviewHash = (state: AppState, app: Application) => hashJson({
  profile: packetProfileHash(state.profile), job: findJob(state, app),
  packet: app.packet, packetHash: app.packetHash, status: app.status,
  queuedRun: app.queuedRun, needsCoverLetter: app.needsCoverLetter,
  browserSessionId: app.browserSessionId,
});
const assertMaterialReviewCurrent = (state: AppState, app: Application, expected: string) => {
  if (materialReviewHash(state, app) !== expected)
    throw new Error("The application or confirmed facts changed while preparing files. Review it again.");
};

async function perform(
  userId: string,
  action: string,
  payload: Record<string, unknown>,
) {
  const ownerContext = { actor: { kind: "owner" as const, userId }, action };
  if (action === "enrollPilot") {
    return mutateState(userId, (state) => {
      const input = z.object({ consentVersion: z.string().max(80), confirmed: z.literal(true) }).parse(payload);
      const episode = enrollPilot(state, userId, input);
      activity(state, "Pilot enrollment saved", `Participation episode ${episode.id} is active. Automation settings were not changed.`);
    }, ownerContext);
  }
  if (action === "withdrawPilot") {
    return mutateState(userId, (state) => {
      withdrawPilot(state, userId);
      activity(state, "Pilot participation withdrawn", "Future pilot initiations are paused; existing evidence is retained.");
    }, ownerContext);
  }
  if (action === "onboarding") {
    return mutateState(userId, (state) => {
      const questionnaire = onboardingQuestionnaireSchema.parse(payload.questionnaire ?? payload);
      const facts = payload.facts === undefined
        ? undefined
        : z
            .array(
              z.object({
                id: z.string(),
                text: z.string().min(1).max(500),
                verified: z.boolean(),
                source: z.enum(["resume", "user"]),
                sourceAnchorId: z.string().max(160).optional(),
              }),
            )
            .max(80)
            .parse(payload.facts);
      const currentAnchors = new Set(state.profile.resumeSourceDocument?.anchors.map((anchor) => anchor.id) ?? []);
      if (facts?.some((fact) => fact.sourceAnchorId && (!currentAnchors.has(fact.sourceAnchorId) || fact.source !== "resume"))) throw new Error("A résumé fact references an unknown source location. Upload and inspect the résumé again.");
      saveOnboarding(state.profile, { questionnaire, facts });
      state.profile.updatedAt = new Date().toISOString();
      state.matchCache = {};
      activity(state, "Onboarding saved", "Your questionnaire and confirmed facts were saved.");
    }, ownerContext);
  }
  if (action === "activateAutomation" || action === "activate") {
    return mutateState(userId, (state) => {
      const authorization = activateAutomation(state.profile, text(payload.reason, 200));
      state.profile.updatedAt = new Date().toISOString();
      activity(state, "Automation enabled", `Authorization version ${authorization.version} is active.`);
    }, ownerContext);
  }
  if (action === "pauseAutomation" || action === "pause") {
    return mutateState(userId, (state) => {
      pauseAutomation(state.profile);
      state.profile.updatedAt = new Date().toISOString();
      activity(state, "Automation paused", "New autonomous application work is paused until you resume it.");
    }, ownerContext);
  }
  if (action === "automationSettings") {
    return mutateState(userId, (state) => {
      const settings = z
        .object({
          resumeTailoring: z.boolean().optional(),
          coverLetterMode: z.enum(["disabled", "required-only", "enabled"]).optional(),
          essayMode: z.literal("automatic-truthful").optional(),
          preferredTitles: z.array(z.string().max(120)).max(30).optional(),
          preferredLocations: z.array(z.string().max(120)).max(30).optional(),
          remoteOnly: z.boolean().optional(),
          strictLocations: z.boolean().optional(),
        })
        .parse(payload.settings ?? payload);
      updateAutomationSettings(state.profile, settings);
      if (["preferredTitles", "preferredLocations", "remoteOnly", "strictLocations"].some((key) => key in settings)) state.profile.searchPreferencesConfirmedAt = new Date().toISOString();
      state.profile.updatedAt = new Date().toISOString();
      state.matchCache = {};
      activity(state, "Automation settings updated", "Your saved filters and material preferences were updated.");
    }, ownerContext);
  }
  if (action === "profile") {
    return mutateState(userId, (state) => {
      const profile = state.profile;
      const fields: Array<keyof Profile> = [
        "name",
        "phone",
        "school",
        "graduationYear",
        "headline",
        "workAuthorization",
      ];
      fields.forEach((key) => {
        if (key in payload)
          Object.assign(profile, { [key]: text(payload[key], 500) });
      });
      if ("email" in payload) profile.email = z.union([z.email().max(254), z.literal("")]).parse(text(payload.email, 254));
      if ("links" in payload) profile.links = normalizeProfileLinks(z.array(z.string().max(500)).max(30).parse(payload.links));
      for (const key of [
        "skills",
        "preferredTitles",
        "preferredLocations",
      ] as const) {
        if (key in payload)
          profile[key] = z
            .array(z.string().max(120))
            .max(30)
            .parse(payload[key])
            .map((item) => item.trim())
            .filter(Boolean);
      }
      if ("remoteOnly" in payload)
        profile.remoteOnly = payload.remoteOnly === true;
      if ("strictLocations" in payload) profile.strictLocations = payload.strictLocations === true;
      if ("currentLocation" in payload) profile.currentLocation = z.object({
        city: z.string().trim().max(120), region: z.string().trim().max(120), country: z.string().trim().max(120),
      }).parse(payload.currentLocation);
      if ("workArrangements" in payload) {
        profile.workArrangements = [...new Set(z.array(z.enum(["remote", "hybrid", "on-site"])).max(3).parse(payload.workArrangements))];
        profile.remoteOnly = profile.workArrangements.length === 1 && profile.workArrangements[0] === "remote";
      }
      if ("willingToRelocate" in payload) profile.willingToRelocate = z.boolean().nullable().parse(payload.willingToRelocate) ?? undefined;
      if ("timeZone" in payload) {
        const timeZone = z.string().max(100).parse(payload.timeZone);
        new Intl.DateTimeFormat("en-US", { timeZone });
        profile.timeZone = timeZone;
      }
      const facts = "factPatch" in payload ? applyFactCorrection(profile.facts, payload.factPatch) : "facts" in payload ? z
          .array(
            z.object({
              id: z.string(),
              text: z.string().min(1).max(500),
              verified: z.boolean(),
              source: z.enum(["resume", "user"]),
              sourceAnchorId: z.string().max(160).optional(),
            }),
          )
          .max(80)
          .parse(payload.facts) : undefined;
      if (facts) {
        const anchors = new Set(profile.resumeSourceDocument?.anchors.map((anchor) => anchor.id) ?? []);
        if (facts.some((fact) => fact.sourceAnchorId && (!anchors.has(fact.sourceAnchorId) || fact.source !== "resume"))) throw new Error("A résumé fact references an unknown source location. Upload and inspect the résumé again.");
        profile.facts = facts;
      }
      if ("sensitiveAnswers" in payload)
        profile.sensitiveAnswers = z.partialRecord(z.enum(["requiresSponsorship", "workAuthorization", "gender", "ethnicity", "disability", "veteran"]), z.string().max(200)).parse(payload.sensitiveAnswers);
      const questionnaire = payload.questionnaire ?? (typeof payload.onboarding === "object" && payload.onboarding !== null ? (payload.onboarding as Record<string, unknown>).questionnaire : undefined);
      const parsedQuestionnaire = questionnaire === undefined ? undefined : onboardingQuestionnaireSchema.parse(questionnaire);
      const settings = payload.automationSettings && typeof payload.automationSettings === "object" ? z.object({
        resumeTailoring: z.boolean().optional(),
        coverLetterMode: z.enum(["disabled", "required-only", "enabled"]).optional(),
        essayMode: z.literal("automatic-truthful").optional(),
      }).parse(payload.automationSettings) : undefined;
      if (parsedQuestionnaire || facts) saveOnboarding(profile, { questionnaire: parsedQuestionnaire, facts });
      if (settings) updateAutomationSettings(profile, settings);
      if (!parsedQuestionnaire && !facts && !settings) bumpAutomationVersion(profile);
      if (["preferredTitles", "preferredLocations", "remoteOnly", "strictLocations", "workArrangements"].some((key) => key in payload)) profile.searchPreferencesConfirmedAt = new Date().toISOString();
      profile.updatedAt = new Date().toISOString();
      state.matchCache = {};
      activity(
        state,
        "Profile updated",
        "Search preferences and confirmed facts were saved.",
      );
    }, ownerContext);
  }
  if (action === "feedback")
    return mutateState(userId, (state) => {
      const result = updateJobFeedback(state, {
        jobId: text(payload.jobId, 200),
        kind: z.enum(["saved", "dismissed", "clear"]).parse(payload.kind),
        reason: text(payload.reason, 500),
      });
      activity(state, result.label, result.title);
    }, ownerContext);
  if (action === "labelMatch") return mutateState(userId, (state) => {
    const job = state.jobs.find((item) => item.id === text(payload.jobId, 200));
    if (!job) throw new Error("Job not found.");
    const label = z.enum(["strong", "possible", "uncertain"]).parse(payload.label);
    state.matchLabels ??= [];
    state.matchLabels = state.matchLabels.filter((item) => item.jobId !== job.id);
    state.matchLabels.push({ jobId: job.id, label, profile: structuredClone(state.profile), job: structuredClone(job), labeledAt: new Date().toISOString() });
    state.matchLabels = state.matchLabels.slice(-100);
  }, ownerContext);
  if (action === "timeSaved") return mutateState(userId, (state) => {
    const app = findApp(state, text(payload.applicationId, 100), userId);
    if (app.status !== "submitted") throw new Error("Record time saved after a confirmed submission.");
    app.timeSavedMinutes = z.number().finite().min(0).max(240).parse(payload.minutes);
  }, ownerContext);
  if (action === "import") {
    const pending = newImportedJob({ url: text(payload.url, 2048),
      company: text(payload.company, 120), title: text(payload.title, 160),
      location: text(payload.location, 160), description: text(payload.description, 4000) });
    const duplicate = (state: AppState, job: Job) => state.jobs.some((item) =>
      canonicalJobUrl(item.url) === canonicalJobUrl(job.url) ||
      canonicalJobUrl(item.importUrl ?? item.url) === canonicalJobUrl(job.importUrl ?? job.url));
    if (duplicate(await loadState(userId), pending)) throw new Error("This link is already in your catalog.");
    const [job] = await refreshImportedJobs([pending]);
    return mutateState(userId, (state) => {
      if (duplicate(state, job))
        throw new Error("This link is already in your catalog.");
      state.jobs.unshift(job);
      state.importedJobs ??= [];
      state.importedJobs.unshift(job);
      activity(state, "Link imported", job.title);
    }, ownerContext);
  }
  if (action === "startAutonomous") return startAutonomousApplication(userId, text(payload.jobId, 200), ownerContext);
  if (action === "preflightImportedPosting") {
    const jobId = text(payload.jobId, 200);
    const result = await runImportedPreflight(userId, jobId);
    if (result.status === "reachable") await startAutonomousApplication(userId, jobId, ownerContext);
    return result;
  }
  if (action === "select")
    return mutateState(userId, (state) => {
      const app = selectApplication(state, text(payload.jobId, 200), userId);
      activity(state, "Job selected", findJob(state, app).title);
    }, ownerContext);
  if (action === "draft") {
    await queueApplicationRun(userId, text(payload.applicationId, 100), "draft", z.enum(["resume", "essays"]).optional().parse(payload.draftMode), ownerContext);
    return;
  }
  if (action === "editPacket") {
    const state = await loadState(userId);
    const app = findApp(state, text(payload.applicationId, 100), userId);
    assertSourcePlanJobCurrent(state, app);
    if (app.status !== "draft_review" || app.queuedRun || !app.packet)
      throw new Error("Open the current packet review after drafting finishes.");
    const answers = z.array(z.object({
      question: z.string().max(500), answer: z.string().max(4000),
      factIds: z.array(z.string()), requiresUserInput: z.boolean(),
      userProvided: z.boolean().optional(),
    })).parse(payload.answers);
    const expected = materialReviewHash(state, app);
    const packet = await withPacketFiles(state.profile, {
      ...app.packet, answers: applyHumanAnswerEdits(app.packet.answers, answers),
      profileHash: packetProfileHash(state.profile), version: app.packet.version + 1,
      createdAt: new Date().toISOString(),
    });
    validatePacket(state.profile, packet);
    return mutateState(userId, (current) => {
      const target = findApp(current, app.id, userId);
      assertMaterialReviewCurrent(current, target, expected);
      setPacket(current, target, packet);
      activity(current, "Packet revised", packet.summary);
    }, ownerContext);
  }
  if (action === "confirmEssay") {
    const state = await loadState(userId);
    const app = findApp(state, text(payload.applicationId, 100), userId);
    assertSourcePlanJobCurrent(state, app);
    if (app.status !== "draft_review" || app.queuedRun || !app.packet || app.packetHash !== text(payload.packetHash, 100))
      throw new Error("The packet changed. Review it again before confirming this essay.");
    const index = z.number().int().min(0).parse(payload.answerIndex);
    const answer = app.packet.answers[index];
    if (!answer || !answerReviewHash(answer) || answerReviewHash(answer) !== text(payload.answerHash, 100))
      throw new Error("The essay changed. Review its latest draft.");
    validatePacket(state.profile, app.packet);
    const expected = materialReviewHash(state, app);
    const answers = [...app.packet.answers];
    answers[index] = confirmReviewedEssay(state.profile, answer);
    const packet = await withPacketFiles(state.profile, { ...app.packet, answers, version: app.packet.version + 1, createdAt: new Date().toISOString() });
    return mutateState(userId, (current) => {
      const target = findApp(current, app.id, userId);
      assertMaterialReviewCurrent(current, target, expected);
      setPacket(current, target, packet);
      activity(current, "Essay confirmed", "You confirmed this exact wording. Packet and final form approvals remain separate.");
    }, ownerContext);
  }
  if (action === "reviseEssay") {
    const state = await loadState(userId);
    const app = findApp(state, text(payload.applicationId, 100), userId);
    assertSourcePlanJobCurrent(state, app);
    if (app.status !== "draft_review" || app.queuedRun || !app.packet || app.packetHash !== text(payload.packetHash, 100))
      throw new Error("The packet changed. Open its current review before editing.");
    const index = z.number().int().min(0).parse(payload.answerIndex);
    const answer = app.packet.answers[index];
    if (!answer || !answerReviewHash(answer) || answerReviewHash(answer) !== text(payload.answerHash, 100))
      throw new Error("The essay changed. Review its latest wording before editing.");
    validatePacket(state.profile, app.packet);
    const expected = materialReviewHash(state, app);
    const answers = [...app.packet.answers];
    answers[index] = reviseEssay(state.profile, answer, z.string().trim().min(1).max(4000).parse(payload.text));
    const packet = await withPacketFiles(state.profile, { ...app.packet, answers, version: app.packet.version + 1, createdAt: new Date().toISOString() });
    return mutateState(userId, (current) => {
      const target = findApp(current, app.id, userId);
      assertMaterialReviewCurrent(current, target, expected);
      setPacket(current, target, packet);
      activity(current, "Essay revised", "Applicant edited the wording. Review and confirmation are required again; source facts were not changed.");
    }, ownerContext);
  }
  if (action === "reviseBrowserEssay") {
    await reviseBrowserEssay(userId, text(payload.applicationId, 100), text(payload.formHash, 100),
      z.string().min(1).max(5000).parse(payload.questionId), text(payload.answerHash, 100), z.string().trim().min(1).max(4000).parse(payload.text),
      { sessionId: text(payload.sessionId, 100), packetHash: text(payload.packetHash, 100) }, ownerContext);
    return;
  }
  if (action === "addCoverLetter") {
    const state = await loadState(userId);
    const app = findApp(state, text(payload.applicationId, 100), userId);
    assertSourcePlanJobCurrent(state, app);
    if (app.status !== "needs_user_action" || app.queuedRun || !app.needsCoverLetter || !app.packet)
      throw new Error("No required cover letter is awaiting review.");
    const expected = materialReviewHash(state, app);
    await cancelBrowser(app);
    const job = findJob(state, app);
    const letter = coverLetterFromFacts(state.profile, job);
    const packet = await withPacketFiles(state.profile, {
      ...app.packet, coverLetter: letter.text, coverLetterFactIds: letter.factIds,
      coverLetterContext: { title: job.title, company: job.company },
      version: app.packet.version + 1, createdAt: new Date().toISOString(),
    });
    validatePacket(state.profile, packet);
    return mutateState(userId, (current) => {
      const target = findApp(current, app.id, userId);
      assertMaterialReviewCurrent(current, target, expected);
      transition(target, ["needs_user_action"], "draft_review");
      target.browserSessionId = undefined;
      target.browserConnectUrl = undefined;
      target.browserLiveUrl = undefined;
      target.needsCoverLetter = false;
      setPacket(current, target, packet);
      activity(current, "Cover letter added", "Review the revised packet and approve it before a new form fill.");
    }, ownerContext);
  }
  if (action === "approveFill")
    return mutateState(userId, (state) => {
      const app = findApp(state, text(payload.applicationId, 100), userId);
      assertSourcePlanJobCurrent(state, app);
      if (app.packet) validatePacket(state.profile, app.packet);
      approveFill(
        app,
        userId,
        text(payload.packetHash, 100),
        findJob(state, app).applyUrl,
      );
      activity(
        state,
        "Fill approved",
        "The approved packet may now be entered on the target form.",
      );
    }, ownerContext);
  if (action === "startBrowser") {
    await queueApplicationRun(userId, text(payload.applicationId, 100), "fill", undefined, ownerContext);
    return;
  }
  if (action === "answerBrowserQuestions") {
    const answers = z.array(z.object({ questionId: z.string().max(5000), value: z.string().max(4000).optional(), confirmEssay: z.boolean().optional(), answerHash: z.string().max(100).optional() }).strict()).min(1).parse(payload.answers);
    await answerBrowserQuestions(userId, text(payload.applicationId, 100), text(payload.formHash, 100), answers, ownerContext);
    return;
  }
  if (action === "draftBrowserEssays") {
    await writeBrowserQuestionEssays(userId, text(payload.applicationId, 100), text(payload.formHash, 100));
    return;
  }
  if (action === "resolveBlocker" || action === "resumeBlocked") {
    const answer = payload.answer === undefined ? undefined : z.object({
      question: z.object({
        identifier: z.string().min(1).max(200),
        label: z.string().min(1).max(500),
        kind: z.string().min(1).max(40),
        options: z.array(z.string().max(300)).max(100),
      }),
      value: z.string().min(1).max(500),
    }).parse(payload.answer);
    const freshReconstruct = payload.freshReconstruct === undefined ? false : z.boolean().parse(payload.freshReconstruct);
    await resumeBlockedApplication(userId, text(payload.applicationId, 100), text(payload.blockerId, 100), answer, { freshReconstruct });
    return;
  }
  if (action === "resumeBrowser") {
    const appId = text(payload.applicationId, 100);
    const state = await loadState(userId);
    const app = findApp(state, appId, userId);
    if (app.browserQuestionRun) throw new Error("The agent is continuing this form. Wait for it to finish before refreshing.");
    if (app.status !== "needs_user_action" && app.status !== "final_review")
      throw new Error("This browser run is not awaiting review.");
    const job = findJob(state, app);
    const api = app.form?.apiSubmission ? await prepareApiApplication(app, job, state.profile) : undefined;
    if (api?.kind === "browser") {
      return mutateState(userId, (current) => {
        const target = findApp(current, appId, userId);
        if (target.status !== app.status || target.form?.hash !== app.form?.hash || target.submissionStartedAt || target.submissionAttemptedAt)
          throw new Error("The application changed while refreshing.");
        transition(target, [app.status], "authorized_to_fill");
        target.form = undefined;
        target.approvals = target.approvals.filter((approval) => approval.kind !== "submit");
        target.error = "The employer form changed. Prepare the application again and review it before submission.";
      }, ownerContext);
    }
    const form = api?.kind === "api" ? api.form : app.status === "needs_user_action" && !app.submissionStartedAt && !app.submissionAttemptedAt &&
      (!app.manualSubmissionReport || app.manualSubmissionReport.resolution?.outcome === "not_accepted") && hasFillApproval(app, userId, job.applyUrl)
      ? await repairEducationFields(app, job, state.profile)
      : await refreshBrowserSnapshot(app);
    return mutateState(userId, (current) => {
      const target = findApp(current, appId, userId);
      if (target.status !== app.status || target.browserSessionId !== app.browserSessionId || target.packetHash !== app.packetHash ||
        target.form?.hash !== app.form?.hash || target.submissionStartedAt || target.submissionAttemptedAt)
        throw new Error("The browser run changed while refreshing. Review its current state.");
      setFormSnapshot(target, form);
      activity(
        current,
        "Form refreshed",
        "Review the latest fields before approving submission.",
      );
    }, ownerContext);
  }
  if (action === "checkSubmissionResult" || action === "stopSubmissionVerification") {
    await checkSubmissionResult(userId, text(payload.applicationId, 100), action === "stopSubmissionVerification");
    return;
  }
  if (action === "approveSubmit")
    return mutateState(userId, (state) => {
      const app = findApp(state, text(payload.applicationId, 100), userId);
      assertJobEligible(state.profile, findJob(state, app));
      if (app.packet) validatePacket(state.profile, app.packet);
      approveSubmit(app, userId, text(payload.formHash, 100));
      activity(state, "Final form approved", findJob(state, app).title);
    }, ownerContext);
  if (action === "submit") {
    const appId = text(payload.applicationId, 100);
    await mutateState(userId, (state) => {
      const app = findApp(state, appId, userId);
      assertJobEligible(state.profile, findJob(state, app));
      if (app.packet) validatePacket(state.profile, app.packet);
      if (!canSubmit(app))
        throw new Error("The current form needs final approval.");
      transition(app, ["approved_to_submit"], "submitting");
      app.submissionStartedAt = new Date().toISOString();
    }, ownerContext);
    if (!isDemo()) {
      try {
        await withAccountOperation(userId, "dispatch", () => tasks.trigger<typeof submitApplicationForm>(
          "submit-application-form",
          { userId, applicationId: appId },
          { tags: [`owner:${userId}`] },
        ), `submission:${appId}`);
        return;
      } catch (error) {
        await mutateState(userId, (state) => {
          const app = findApp(state, appId, userId);
          if (app.status === "submitting")
            transition(app, ["submitting"], "uncertain");
          app.error =
            "The submit task could not be confirmed. Check the employer site before taking further action.";
        });
        throw error;
      }
    }
    return (await import("@/lib/application-submission")).runSubmission({ userId, applicationId: appId });
  }
  if (action === "cancel") {
    const appId = text(payload.applicationId, 100);
    const state = await loadState(userId);
    const app = findApp(state, appId, userId);
    if (
      ["awaiting_verification", "submitted", "uncertain", "cancelled"].includes(app.status) || (app.status === "submitting" && (!app.autonomousAuthorization || app.submissionAttemptedAt))
    )
      throw new Error("This application can no longer be cancelled.");
    await mutateState(userId, (current) => {
      const target = findApp(current, appId, userId);
      if (target.submissionAttemptedAt) throw new Error("A submission was already attempted; its outcome must be observed.");
      target.queuedRun = undefined;
      for (const blocker of target.blockers ?? []) {
        if (blocker.progress === "blocked" || blocker.progress === "resuming") {
          blocker.progress = "resolved";
          blocker.resolvedAt = new Date().toISOString();
          blocker.updatedAt = blocker.resolvedAt;
        }
      }
      transition(
        target,
        [
          "selected",
          "drafting",
          "draft_review",
          "authorized_to_fill",
          "filling",
          "final_review",
          "approved_to_submit",
          "needs_user_action",
          ...(target.autonomousAuthorization ? ["submitting" as const] : []),
        ],
        "cancelled",
      );
      activity(
        current,
        "Application cancelled",
        findJob(current, target).title,
      );
    }, ownerContext);
    let released = true;
    const releaseApp = { ...app, browserSessionId: app.browserSessionId ?? app.browserReleasePending?.sessionId };
    try { await cancelBrowser(releaseApp, { strict: true }); }
    catch { released = false; }
    await mutateState(userId, (current) => {
      const target = findApp(current, appId, userId);
      if (released) {
        target.browserSessionId = target.browserConnectUrl = target.browserLiveUrl = undefined;
        target.browserReleasePending = undefined;
      } else if (releaseApp.browserSessionId) {
        target.browserSessionId = releaseApp.browserSessionId;
        target.browserReleasePending = { sessionId: releaseApp.browserSessionId, requestedAt: new Date().toISOString(), attempts: 1, lastError: "The provider did not confirm the browser release." };
        recordApplicationBlocker(target, "resource_hold", "The browser provider has not confirmed release yet. The cancelled application will remain held until this session is stopped.", { sessionId: releaseApp.browserSessionId });
      }
    }, ownerContext);
    return;
  }
  if (action === "reviewManualFailure") {
    const appId = text(payload.applicationId, 100);
    const confirmed = z.literal(true).parse(payload.confirmedNotAccepted);
    const before = findApp(await loadState(userId), appId, userId);
    await mutateState(userId, (current) => {
      const app = findApp(current, appId, userId);
      if (!app.packet) throw new Error("The saved packet is unavailable.");
      validatePacket(current.profile, app.packet);
      reopenManualAttempt(app, userId, confirmed);
      activity(current, "Manual attempt reviewed", "You confirmed the employer did not accept the application. Review and approve the saved packet before a new fill run.");
    }, ownerContext);
    await cancelBrowser(before);
    return;
  }
  if (action === "restartBrowser") {
    const appId = text(payload.applicationId, 100);
    const state = await loadState(userId);
    const app = findApp(state, appId, userId);
    await mutateState(userId, (current) => {
      const target = findApp(current, appId, userId);
      returnToMaterials(target);
      activity(current, "Browser closed", "Review and approve the packet again to start a new session.");
    }, ownerContext);
    await cancelBrowser(app);
    return;
  }
  throw new Error("Unknown action.");
}

export async function POST(request: Request) {
  if (!sameOrigin(request))
    return NextResponse.json(
      { error: "Cross-origin request rejected." },
      { status: 403 },
    );
  try {
    const userId = await currentUserId();
    return await withAccountOperation(userId, "request", async () => {
    const { action, payload } = Input.parse(await request.json());
    await perform(userId, action, payload);
    if (!isDemo() && ["profile", "onboarding", "automationSettings"].includes(action)) {
      const searching = await queuePersonalSearch(userId);
      // Unchanged search inputs reuse the private discovery results, but profile
      // edits still invalidate fit assessments (for example new fact IDs).
      if (!searching && process.env.OPENAI_API_KEY && process.env.TRIGGER_SECRET_KEY &&
        (await loadState(userId)).jobs.some((job) => job.active)) {
        await queueMatchAssessment(userId).catch(() => undefined);
      }
    }
    if (
      !isDemo() &&
      process.env.OPENAI_API_KEY &&
      process.env.TRIGGER_SECRET_KEY &&
      ["import"].includes(action)
    ) {
      await queueMatchAssessment(userId).catch(() => undefined);
    }
    if (
      process.env.RESEND_API_KEY &&
      process.env.EMAIL_FROM &&
      ["draft", "startBrowser", "submit"].includes(action)
    ) {
      const state = await loadState(userId);
      const app = state.applications.find(
        (item) => item.id === text(payload.applicationId, 100),
      );
      const message =
        app?.status === "draft_review"
          ? "An application packet is ready for your review"
          : app?.status === "needs_user_action"
            ? "Your browser run needs your help"
            : app?.status === "final_review"
              ? "A filled application is ready for final review"
              : app?.status === "uncertain"
                ? "Check an uncertain application result"
                : null;
      if (message && !app?.autonomousAuthorization)
        await sendActionNeeded(state, message).catch(() => undefined);
    }
    if (action === "cancel" || action === "submit") await dispatchUserQueue(userId);
    return NextResponse.json({ ok: true });
    }, "api/actions");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Action failed.";
    return NextResponse.json(
      { error: message },
      { status: message === "AUTH_REQUIRED" ? 401 : error instanceof AccountDeletionInProgressError ? 409 : 400 },
    );
  }
}
