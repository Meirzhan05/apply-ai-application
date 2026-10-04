import { tasks } from "@trigger.dev/sdk";
import type { extractUploadedResume } from "../../trigger/resume-facts";
import { loadState, mutateState, isDemo } from "@/lib/repository";
import { newId } from "@/lib/crypto";
import { reserveServiceBudget } from "@/lib/budget";
import { withModelUsageContext } from "@/lib/model-usage";
import { withAccountOperation } from "@/lib/account-lifecycle";
import { extractResumeFacts } from "@/lib/resume-fact-extraction";
import { parsePdfSource } from "@/lib/pdf-source";
import { parseDocxSource } from "@/lib/docx-source";
import { readOriginalResume } from "@/lib/original-resume";
import { saveOnboarding } from "@/lib/onboarding";
import { queuePersonalSearch } from "@/lib/personal-search";
import { queueMatchAssessment } from "@/lib/match-queue";
import type { Profile, ResumeExtraction } from "@/lib/types";

const processing = new Set(["queued", "extracting", "checking"]);
export function resumeExtractionPending(profile: Profile): boolean {
  return Boolean(profile.resumeExtraction && processing.has(profile.resumeExtraction.status));
}

export async function dispatchResumeExtraction(userId: string, requestId: string): Promise<void> {
  try {
    if (isDemo()) {
      // Demo requests use the same worker; production always runs on Trigger.dev.
      void withAccountOperation(userId, "worker", () => runResumeExtraction({ userId, requestId })).catch(() => undefined);
      return;
    }
    if (!process.env.TRIGGER_SECRET_KEY) throw new Error("Resume extraction is unavailable. Retry extraction later.");
    await withAccountOperation(userId, "dispatch", () => tasks.trigger<typeof extractUploadedResume>("extract-uploaded-resume", { userId, requestId }, {
      concurrencyKey: userId, idempotencyKey: `resume-facts:${userId}:${requestId}`, tags: [`owner:${userId}`],
    }), `resume-facts:${requestId}`);
  } catch {
    await mutateState(userId, state => {
      const job = state.profile.resumeExtraction;
      if (job?.id === requestId && job.status === "queued") {
        job.status = "failed"; job.error = "Resume extraction couldn't start. Retry extraction."; job.updatedAt = new Date().toISOString();
      }
    });
  }
}

export async function retryResumeExtraction(userId: string): Promise<void> {
  const requestId = newId();
  const queued = await mutateState(userId, state => {
    const previous = state.profile.resumeExtraction;
    if (!previous?.pending || processing.has(previous.status)) return false;
    const now = new Date().toISOString();
    state.profile.resumeExtraction = { ...previous, id: requestId, status: "queued", attempts: 0, error: undefined, requestedAt: now, updatedAt: now };
    return true;
  });
  if (queued) await dispatchResumeExtraction(userId, requestId);
}

/** Lazy migration uses the owner's saved original without changing existing facts until success. */
export async function ensureResumeExtraction(userId: string, profile: Profile): Promise<boolean> {
  if (isDemo() || profile.resumeExtraction || !profile.resumeSource || !profile.resumeFileName) return false;
  const id = newId();
  const queued = await mutateState(userId, state => {
    const current = state.profile;
    if (current.resumeExtraction || !current.resumeSource || !current.resumeFileName) return false;
    const now = new Date().toISOString();
    current.resumeExtraction = { id, status: "queued", attempts: 0, filename: current.resumeFileName, requestedAt: now, updatedAt: now,
      pending: { source: structuredClone(current.resumeSource) } };
    return true;
  });
  if (queued) await dispatchResumeExtraction(userId, id);
  return queued;
}

export async function recoverResumeExtraction(userId: string): Promise<void> {
  const job = (await loadState(userId)).profile.resumeExtraction;
  if (!job || !processing.has(job.status) || Date.now() - Date.parse(job.updatedAt) < 10 * 60_000) return;
  await mutateState(userId, state => {
    const current = state.profile.resumeExtraction;
    if (current?.id === job.id && processing.has(current.status) && current.updatedAt === job.updatedAt) {
      current.status = "failed"; current.error = "Resume extraction stopped before finishing. Retry extraction.";
      current.updatedAt = new Date().toISOString();
    }
  });
}

export async function runResumeExtraction({ userId, requestId }: { userId: string; requestId: string }) {
  const claimed = await mutateState(userId, state => {
    const job = state.profile.resumeExtraction;
    if (!job || job.id !== requestId || !job.pending || job.status === "ready" || job.status === "budget_limited" || job.attempts >= 2) return false;
    if (job.status !== "queued" && job.status !== "failed") return false;
    job.status = "extracting"; job.attempts++; job.error = undefined; job.updatedAt = new Date().toISOString();
    return true;
  });
  if (!claimed) return { skipped: true };
  const profile = (await loadState(userId)).profile;
  const job = profile.resumeExtraction!;
  const pending = job.pending!;
  const assertCurrent = async () => {
    const current = (await loadState(userId)).profile;
    if (current.resumeExtraction?.id !== requestId || !processing.has(current.resumeExtraction.status) || current.name !== profile.name)
      throw new Error("The uploaded resume or profile name changed during extraction.");
  };
  try {
    await assertCurrent();
    if (!await reserveServiceBudget(userId, `resume-facts:${requestId}:${job.attempts}`, 0.10)) {
      await mutateState(userId, state => {
        if (state.profile.resumeExtraction?.id === requestId) {
          state.profile.resumeExtraction.status = "budget_limited";
          state.profile.resumeExtraction.error = "Resume extraction is paused by the service spending limit. Retry later.";
          state.profile.resumeExtraction.updatedAt = new Date().toISOString();
        }
      });
      return { budgetLimited: true };
    }
    let source = pending.document;
    if (!source || source.sourceHash !== pending.source.sha256 || (source.format === "pdf" && source.version < 3)) {
      const bytes = await readOriginalResume(userId, { ...pending.source, filename: job.filename });
      source = pending.source.mimeType === "application/pdf" ? await parsePdfSource(bytes, profile.name) : await parseDocxSource(bytes, profile.name);
    }
    if (source.sourceHash !== pending.source.sha256) throw new Error("The resume no longer matches its stored original. Upload it again.");
    const facts = await withModelUsageContext({ userId, runId: requestId, backgroundJobId: `resume-facts:${requestId}` }, () => extractResumeFacts(source!, {
      userId, trustedName: profile.name, beforeModelCall: assertCurrent,
      onProgress: async status => { await mutateState(userId, state => {
        const current = state.profile.resumeExtraction;
        if (current?.id !== requestId || !processing.has(current.status)) throw new Error("The uploaded resume changed during extraction.");
        current.status = status; current.updatedAt = new Date().toISOString();
      }); },
    }));
    const published = await mutateState(userId, state => {
      const current = state.profile;
      if (current.resumeExtraction?.id !== requestId || !processing.has(current.resumeExtraction.status)) return false;
      if (current.name !== profile.name) throw new Error("Your profile name changed. Retry extraction using the current name.");
      const manual = current.facts.filter(fact => fact.source === "user");
      if (manual.length + facts.length > 80) throw new Error("The resume and manually added facts exceed 80 facts. Shorten the resume or remove unused manual facts, then retry.");
      current.resumeFileName = job.filename; current.resumeSource = pending.source;
      current.resumeSourceDocument = source; current.resumeText = source.text;
      saveOnboarding(current, { facts: [...manual, ...facts] });
      const now = new Date().toISOString();
      current.resumeExtraction = { ...current.resumeExtraction, status: "ready", pending: undefined, error: undefined, updatedAt: now };
      current.updatedAt = now; state.matchCache = {};
      state.activity.unshift({ id: newId(), at: now, label: "Resume facts ready", detail: `${facts.length} facts extracted and grounded in your resume. No confirmation needed.` });
      return true;
    });
    if (published && !isDemo()) {
      await queuePersonalSearch(userId).catch(() => false);
      await queueMatchAssessment(userId).catch(() => undefined);
    }
    return { ready: published, facts: facts.length };
  } catch (error) {
    await mutateState(userId, state => {
      const current = state.profile.resumeExtraction;
      if (current?.id === requestId && current.status !== "ready") {
        current.status = "failed";
        current.error = error instanceof Error && !/api.key|token|Bearer|sk-/i.test(error.message) && error.message.length < 350
          ? error.message : "Resume extraction couldn't finish. Retry extraction.";
        current.updatedAt = new Date().toISOString();
      }
    });
    throw error;
  }
}

export function queuedResumeExtraction(filename: string, pending: NonNullable<ResumeExtraction["pending"]>): ResumeExtraction {
  const now = new Date().toISOString();
  return { id: newId(), filename, pending, status: "queued", attempts: 0, requestedAt: now, updatedAt: now };
}
