import { NextResponse } from "next/server";
import { tasks } from "@trigger.dev/sdk";
import type {
  submitApplicationForm,
} from "../../../../trigger/browser";
import { queueMatchAssessment } from "@/lib/match-queue";
import { z } from "zod";
import { newId } from "@/lib/crypto";
import { updateJobFeedback } from "@/lib/job-feedback";
import { answerBrowserQuestions, writeBrowserQuestionEssays } from "@/lib/browser-question-runs";
import { queueApplicationRun, dispatchUserQueue } from "@/lib/application-queue";
import { sendActionNeeded } from "@/lib/email";
import { withPacketFiles } from "@/lib/packet-files";
import { applyHumanAnswerEdits, confirmAiEssay } from "@/lib/answer-policy";
import { assertJobEligible } from "@/lib/application-policy";
import { reopenManualAttempt } from "@/lib/submission-recovery";
import { checkSubmissionResult } from "@/lib/submission-verification";
import { sameOrigin } from "@/lib/request-security";
import { adminSupabase } from "@/lib/supabase-admin";
import {
  refreshBrowserSnapshot,
  repairEducationFields,
  submitBrowser,
  cancelBrowser,
} from "@/lib/browser-runner";
import {
  coverLetterFromFacts,
  validatePacket,
  packetProfileHash,
} from "@/lib/drafting";
import {
  currentUserId,
  isDemo,
  loadState,
  mutateState,
} from "@/lib/repository";
import { canonicalJobUrl } from "@/lib/sources";
import { newImportedJob, refreshImportedJobs } from "@/lib/import-jobs";
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

async function perform(
  userId: string,
  action: string,
  payload: Record<string, unknown>,
) {
  if (action === "profile") {
    const verifiedEmail = isDemo()
      ? null
      : (await adminSupabase().auth.admin.getUserById(userId)).data.user?.email;
    if (!isDemo() && !verifiedEmail)
      throw new Error("Your sign-in email could not be verified.");
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
      profile.email = verifiedEmail || text(payload.email, 254);
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
      if ("timeZone" in payload) {
        const timeZone = z.string().max(100).parse(payload.timeZone);
        new Intl.DateTimeFormat("en-US", { timeZone });
        profile.timeZone = timeZone;
      }
      if ("facts" in payload)
        profile.facts = z
          .array(
            z.object({
              id: z.string(),
              text: z.string().min(1).max(500),
              verified: z.boolean(),
              source: z.enum(["resume", "user"]),
            }),
          )
          .max(80)
          .parse(payload.facts);
      if ("sensitiveAnswers" in payload)
        profile.sensitiveAnswers = z.record(z.enum(["requiresSponsorship", "workAuthorization", "gender", "ethnicity", "disability", "veteran"]), z.string().max(200)).parse(payload.sensitiveAnswers);
      profile.updatedAt = new Date().toISOString();
      state.matchCache = {};
      activity(
        state,
        "Profile updated",
        "Search preferences and confirmed facts were saved.",
      );
    });
  }
  if (action === "feedback")
    return mutateState(userId, (state) => {
      const result = updateJobFeedback(state, {
        jobId: text(payload.jobId, 200),
        kind: z.enum(["saved", "dismissed", "clear"]).parse(payload.kind),
        reason: text(payload.reason, 500),
      });
      activity(state, result.label, result.title);
    });
  if (action === "labelMatch") return mutateState(userId, (state) => {
    const job = state.jobs.find((item) => item.id === text(payload.jobId, 200));
    if (!job) throw new Error("Job not found.");
    const label = z.enum(["strong", "possible", "uncertain"]).parse(payload.label);
    state.matchLabels ??= [];
    state.matchLabels = state.matchLabels.filter((item) => item.jobId !== job.id);
    state.matchLabels.push({ jobId: job.id, label, profile: structuredClone(state.profile), job: structuredClone(job), labeledAt: new Date().toISOString() });
    state.matchLabels = state.matchLabels.slice(-100);
  });
  if (action === "timeSaved") return mutateState(userId, (state) => {
    const app = findApp(state, text(payload.applicationId, 100), userId);
    if (app.status !== "submitted") throw new Error("Record time saved after a confirmed submission.");
    app.timeSavedMinutes = z.number().finite().min(0).max(240).parse(payload.minutes);
  });
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
    });
  }
  if (action === "select")
    return mutateState(userId, (state) => {
      const app = selectApplication(state, text(payload.jobId, 200), userId);
      activity(state, "Job selected", findJob(state, app).title);
    });
  if (action === "draft") {
    await queueApplicationRun(userId, text(payload.applicationId, 100), "draft", z.enum(["resume", "essays"]).optional().parse(payload.draftMode));
    return;
  }
  if (action === "editPacket")
    return mutateState(userId, async (state) => {
      const app = findApp(state, text(payload.applicationId, 100), userId);
      if (app.status !== "draft_review" || app.queuedRun || !app.packet)
        throw new Error("Open the current packet review after drafting finishes.");
      const answers = z
        .array(
          z.object({
            question: z.string().max(500),
            answer: z.string().max(4000),
            factIds: z.array(z.string()),
            requiresUserInput: z.boolean(),
            userProvided: z.boolean().optional(),
          }),
        )
        .max(30)
        .parse(payload.answers);
      const packet = await withPacketFiles(state.profile, {
        ...app.packet,
        schemaVersion: app.packet.schemaVersion,
        answers: applyHumanAnswerEdits(app.packet.answers, answers),
        profileHash: packetProfileHash(state.profile),
        version: app.packet.version + 1,
        createdAt: new Date().toISOString(),
      });
      validatePacket(state.profile, packet);
      setPacket(state, app, packet);
      activity(state, "Packet revised", packet.summary);
    });
  if (action === "confirmEssay")
    return mutateState(userId, async (state) => {
      const app = findApp(state, text(payload.applicationId, 100), userId);
      if (app.status !== "draft_review" || app.queuedRun || !app.packet || app.packetHash !== text(payload.packetHash, 100))
        throw new Error("The packet changed. Review it again before confirming this essay.");
      const index = z.number().int().min(0).parse(payload.answerIndex);
      const answer = app.packet.answers[index];
      if (!answer?.aiDraft || answer.aiDraft.contentHash !== text(payload.answerHash, 100))
        throw new Error("The essay changed. Review its latest draft.");
      validatePacket(state.profile, app.packet);
      const answers = [...app.packet.answers];
      answers[index] = confirmAiEssay(state.profile, answer);
      const packet = await withPacketFiles(state.profile, { ...app.packet, answers, version: app.packet.version + 1, createdAt: new Date().toISOString() });
      setPacket(state, app, packet);
      activity(state, "Essay confirmed", "You confirmed this AI draft. Packet and final form approvals remain separate.");
    });
  if (action === "addCoverLetter") {
    const appId = text(payload.applicationId, 100);
    const state = await loadState(userId);
    const app = findApp(state, appId, userId);
    if (
      app.status !== "needs_user_action" ||
      !app.needsCoverLetter ||
      !app.packet
    )
      throw new Error("No required cover letter is awaiting review.");
    await cancelBrowser(app);
    return mutateState(userId, async (current) => {
      const target = findApp(current, appId, userId);
      if (!target.packet) throw new Error("Application packet is missing.");
      const letter = coverLetterFromFacts(
        current.profile,
        findJob(current, target),
      );
      transition(target, ["needs_user_action"], "draft_review");
      target.browserSessionId = undefined;
      target.browserConnectUrl = undefined;
      target.browserLiveUrl = undefined;
      target.needsCoverLetter = false;
      setPacket(current, target, await withPacketFiles(current.profile, {
        ...target.packet,
        schemaVersion: target.packet.schemaVersion,
        coverLetter: letter.text,
        coverLetterFactIds: letter.factIds,
        coverLetterContext: { title: findJob(current, target).title, company: findJob(current, target).company },
        version: target.packet.version + 1,
        createdAt: new Date().toISOString(),
      }));
      activity(
        current,
        "Cover letter added",
        "Review the revised packet and approve it before a new form fill.",
      );
    });
  }
  if (action === "approveFill")
    return mutateState(userId, (state) => {
      const app = findApp(state, text(payload.applicationId, 100), userId);
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
    });
  if (action === "startBrowser") {
    await queueApplicationRun(userId, text(payload.applicationId, 100), "fill");
    return;
  }
  if (action === "answerBrowserQuestions") {
    const answers = z.array(z.object({ questionId: z.string().max(5000), value: z.string().max(4000).optional(), confirmEssay: z.boolean().optional(), answerHash: z.string().max(100).optional() }).strict()).min(1).max(20).parse(payload.answers);
    await answerBrowserQuestions(userId, text(payload.applicationId, 100), text(payload.formHash, 100), answers);
    return;
  }
  if (action === "draftBrowserEssays") {
    await writeBrowserQuestionEssays(userId, text(payload.applicationId, 100), text(payload.formHash, 100));
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
    const form = app.status === "needs_user_action" && !app.submissionStartedAt && !app.submissionAttemptedAt &&
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
    });
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
    });
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
    });
    if (!isDemo()) {
      try {
        await tasks.trigger<typeof submitApplicationForm>(
          "submit-application-form",
          { userId, applicationId: appId },
        );
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
    const state = await loadState(userId);
    const app = findApp(state, appId, userId);
    try {
      const result = await submitBrowser(app);
      return mutateState(userId, (current) => {
        const target = findApp(current, appId, userId);
        transition(
          target,
          ["submitting"],
          result.confirmed ? "submitted" : result.verification ? "awaiting_verification" : "uncertain",
        );
        target.confirmation = result.evidence;
        target.submissionReceipt = result.receipt;
        target.submissionVerification = result.verification;
        target.submissionAttemptedAt = app.submissionAttemptedAt;
        if (result.confirmed) target.submittedAt = new Date().toISOString();
        activity(
          current,
          result.confirmed ? "Submission confirmed" : result.verification ? "Complete employer verification" : "Submission uncertain",
          result.evidence,
        );
      });
    } catch (error) {
      if (error instanceof Error && error.message === "FORM_CHANGED") {
        const form = await refreshBrowserSnapshot(app);
        return mutateState(userId, (current) => {
          const target = findApp(current, appId, userId);
          target.submissionStartedAt = undefined;
          target.submissionWorkerClaimedAt = undefined;
          setFormSnapshot(target, form);
          activity(
            current,
            "Form changed",
            "Review the new form state and approve again.",
          );
        });
      }
      await mutateState(userId, (current) => {
        const target = findApp(current, appId, userId);
        transition(target, ["submitting"], "uncertain");
        target.error =
          error instanceof Error ? error.message : "Submission result unknown.";
        target.submissionAttemptedAt = app.submissionAttemptedAt;
        activity(
          current,
          "Submission needs review",
          "The result is uncertain. No automatic retry will occur.",
        );
      });
      throw error;
    }
  }
  if (action === "cancel") {
    const appId = text(payload.applicationId, 100);
    const state = await loadState(userId);
    const app = findApp(state, appId, userId);
    if (
      ["submitting", "awaiting_verification", "submitted", "uncertain", "cancelled"].includes(app.status)
    )
      throw new Error("This application can no longer be cancelled.");
    await mutateState(userId, (current) => {
      const target = findApp(current, appId, userId);
      target.queuedRun = undefined;
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
        ],
        "cancelled",
      );
      activity(
        current,
        "Application cancelled",
        findJob(current, target).title,
      );
    });
    await cancelBrowser(app);
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
    });
    await cancelBrowser(before);
    return;
  }
  if (action === "restartBrowser") {
    const appId = text(payload.applicationId, 100);
    const state = await loadState(userId);
    const app = findApp(state, appId, userId);
    await mutateState(userId, (current) => {
      const target = findApp(current, appId, userId);
      transition(target, ["needs_user_action", "final_review"], "draft_review");
      target.approvals = [];
      target.form = undefined;
      target.browserSessionId = target.browserConnectUrl = target.browserLiveUrl = undefined;
      target.error = undefined;
      activity(current, "Browser closed", "Review and approve the packet again to start a new session.");
    });
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
    const { action, payload } = Input.parse(await request.json());
    await perform(userId, action, payload);
    if (
      !isDemo() &&
      process.env.OPENAI_API_KEY &&
      process.env.TRIGGER_SECRET_KEY &&
      ["profile", "import"].includes(action)
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
      if (message)
        await sendActionNeeded(state, message).catch(() => undefined);
    }
    if (action === "cancel" || action === "submit") await dispatchUserQueue(userId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Action failed.";
    return NextResponse.json(
      { error: message },
      { status: message === "AUTH_REQUIRED" ? 401 : 400 },
    );
  }
}
