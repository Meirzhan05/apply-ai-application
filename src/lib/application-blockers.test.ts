import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Application } from "@/lib/types";

const fixture = vi.hoisted(() => ({ state: undefined as unknown as AppState, queue: vi.fn() }));
vi.mock("@/lib/repository", () => ({
  loadState: async () => structuredClone(fixture.state),
  mutateState: async (_userId: string, change: (state: AppState) => unknown) => change(fixture.state),
}));
vi.mock("@/lib/application-queue", () => ({ dispatchUserQueue: fixture.queue }));

import { initialDemoState } from "@/lib/demo-data";
import { authorizeKnownAnswerApplication } from "@/lib/autonomous-policy";
import {
  activeApplicationBlockers,
  blockerReason,
  recordApplicationBlocker,
  resumeBlockedApplication,
} from "@/lib/application-blockers";
import { selectApplication } from "@/lib/workflow";

function application(): Application {
  const app = selectApplication(fixture.state, fixture.state.jobs[0].id, fixture.state.profile.id);
  authorizeKnownAnswerApplication(app, fixture.state.profile, fixture.state.jobs[0]);
  app.status = "needs_user_action";
  return app;
}

beforeEach(() => {
  fixture.state = initialDemoState();
  fixture.state.profile.automationAuthorization = {
    version: 1, status: "enabled", reason: "test", authorizedAt: new Date().toISOString(),
  };
  fixture.state.profile.onboarding = { questionnaire: { workAuthorization: "yes", requiresSponsorship: "no" }, completedAt: new Date().toISOString() };
  fixture.state.profile.automationSettings = { version: 1, resumeTailoring: true, coverLetterMode: "required-only", essayMode: "automatic-truthful" };
  fixture.queue.mockReset();
});

describe("autonomous blocker review", () => {
  it.each([
    ["Please provide the required graduation year", "missing_answer"],
    ["Sign in to continue", "login"],
    ["Complete CAPTCHA verification", "verification"],
    ["This required cover letter is disabled", "disabled_material"],
    ["The upload failed", "upload_failure"],
    ["The employer has an unfamiliar control", "unfamiliar_control"],
  ] as const)("classifies %s as %s", (message, reason) => {
    expect(blockerReason(message)).toBe(reason);
  });

  it("keeps one actionable blocker with progress and current form context", () => {
    const app = application();
    const first = recordApplicationBlocker(app, "login", "Sign in to continue", { formHash: "form-1", sessionId: "browser-1" });
    const second = recordApplicationBlocker(app, "login", "Sign in to continue", { formHash: "form-2" });
    expect(first.id).toBe(second.id);
    expect(activeApplicationBlockers(app)).toHaveLength(1);
    expect(activeApplicationBlockers(app)[0]).toMatchObject({ progress: "blocked", context: { formHash: "form-2" } });
  });

  it("resumes only the owner application once and reconstructs pre-submit state", async () => {
    const app = application();
    app.form = { version: 1, url: fixture.state.jobs[0].applyUrl, fields: [], attachments: [], capturedAt: new Date().toISOString(), hash: "old" };
    const blocker = recordApplicationBlocker(app, "missing_answer", "Provide the missing answer");
    await resumeBlockedApplication(app.userId, app.id, blocker.id);
    expect(app.status).toBe("selected");
    expect(app.form).toBeUndefined();
    expect(app.queuedRun?.kind).toBe("draft");
    expect(app.blockers?.[0].progress).toBe("resuming");
    expect(fixture.queue).toHaveBeenCalledOnce();
    await expect(resumeBlockedApplication("another-user", app.id, blocker.id)).rejects.toThrow("Application not found");
  });

  it("does not resume a cancelled application", async () => {
    const app = application();
    const blocker = recordApplicationBlocker(app, "login", "Sign in to continue");
    app.status = "cancelled";
    await expect(resumeBlockedApplication(app.userId, app.id, blocker.id)).rejects.toThrow(/cancelled/);
    expect(fixture.queue).not.toHaveBeenCalled();
  });
  it("holds resume until a pending provider release is confirmed", async () => {
    const app = application();
    app.browserSessionId = "remote-session";
    app.browserReleasePending = { sessionId: "remote-session", requestedAt: new Date().toISOString(), attempts: 1 };
    const blocker = recordApplicationBlocker(app, "missing_answer", "Provide the missing answer");
    await expect(resumeBlockedApplication(app.userId, app.id, blocker.id)).rejects.toThrow(/still attached/);
    expect(fixture.queue).not.toHaveBeenCalled();
    app.browserSessionId = undefined;
    app.browserReleasePending = undefined;
    await resumeBlockedApplication(app.userId, app.id, blocker.id);
    expect(fixture.queue).toHaveBeenCalledOnce();
  });


  it("accepts only the owner-confirmed value for the observed control", async () => {
    const app = application();
    app.form = {
      version: 1,
      url: fixture.state.jobs[0].applyUrl,
      fields: [{ identifier: "snack", label: "Favorite snack", kind: "select", value: "", options: ["Tea", "Coffee"], required: true, valid: false }],
      attachments: [], capturedAt: new Date().toISOString(), hash: "observed-form", readyToSubmit: false,
    };
    const blocker = recordApplicationBlocker(app, "missing_answer", "Correct or complete the field: Favorite snack", {
      formHash: "observed-form", targetUrl: app.form.url,
      observedQuestion: { identifier: "snack", label: "Favorite snack", kind: "select", options: ["Tea", "Coffee"], value: "" },
    });
    await expect(resumeBlockedApplication(app.userId, app.id, blocker.id, {
      question: { identifier: "snack", label: "Favorite snack", kind: "select", options: ["Tea", "Juice"] }, value: "Tea",
    })).rejects.toThrow(/changed/);
    const targetUrl = app.form.url;
    await resumeBlockedApplication(app.userId, app.id, blocker.id, {
      question: { identifier: "snack", label: "Favorite snack", kind: "select", options: ["Tea", "Coffee"] }, value: "Coffee",
    });
    expect(app.autonomousHumanAnswers).toMatchObject([{ applicationId: app.id, targetUrl, value: "Coffee" }]);
  });

  it("rejects a radio answer when the employer changes its option values", async () => {
    const app = application();
    app.form = {
      version: 1,
      url: fixture.state.jobs[0].applyUrl,
      fields: [
        { identifier: "pattern", label: "Preferred work pattern", kind: "radio", value: "Remote", optionValue: "pattern-remote", required: true, checked: false, valid: false },
        { identifier: "pattern", label: "Preferred work pattern", kind: "radio", value: "Office", optionValue: "pattern-office", required: true, checked: false, valid: false },
      ],
      attachments: [], capturedAt: new Date().toISOString(), hash: "radio-form", readyToSubmit: false,
    };
    const blocker = recordApplicationBlocker(app, "missing_answer", "Correct or complete the field: Preferred work pattern", {
      formHash: "radio-form", targetUrl: app.form.url,
      observedQuestion: { identifier: "pattern", label: "Preferred work pattern", kind: "radio", options: ["Remote", "Office"], value: "" },
    });
    await expect(resumeBlockedApplication(app.userId, app.id, blocker.id, {
      question: { identifier: "pattern", label: "Preferred work pattern", kind: "radio", options: ["Remote", "Hybrid"] }, value: "pattern-office",
    })).rejects.toThrow(/changed/);
    expect(app.autonomousHumanAnswers).toBeUndefined();
  });

  it("accepts a radio choice when its label and native value are the same", async () => {
    const app = application();
    app.form = {
      version: 1,
      url: fixture.state.jobs[0].applyUrl,
      fields: [
        { identifier: "consent", label: "Consent", kind: "radio", value: "Yes", optionValue: "Yes", required: true, checked: false, valid: false },
        { identifier: "consent", label: "Consent", kind: "radio", value: "No", optionValue: "No", required: true, checked: false, valid: false },
      ],
      attachments: [], capturedAt: new Date().toISOString(), hash: "same-radio", readyToSubmit: false,
    };
    const blocker = recordApplicationBlocker(app, "missing_answer", "Correct or complete the field: Consent", {
      formHash: "same-radio", targetUrl: app.form.url,
      observedQuestion: { identifier: "consent", label: "Consent", kind: "radio", options: ["Yes", "No"], value: "" },
    });
    await resumeBlockedApplication(app.userId, app.id, blocker.id, {
      question: { identifier: "consent", label: "Consent", kind: "radio", options: ["Yes", "No"] }, value: "Yes",
    });
    expect(app.autonomousHumanAnswers?.[0].question.optionValues).toEqual(["Yes", "No"]);
  });
});
