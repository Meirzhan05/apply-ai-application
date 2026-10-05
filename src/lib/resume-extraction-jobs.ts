import { tasks } from "@trigger.dev/sdk";
import type { extractUploadedResume } from "../../trigger/resume-facts";
import { loadState, mutateState, isDemo } from "@/lib/repository";
import { newId } from "@/lib/crypto";
import { reserveServiceBudget } from "@/lib/budget";
import { withModelUsageContext } from "@/lib/model-usage";
import { withAccountOperation } from "@/lib/account-lifecycle";
import { sourceWithCurrentEvidenceClaims } from "@/lib/source-plan-evidence";
import { applyResumeProfile, extractResumeProfile, type ResumeProfileDetail } from "@/lib/resume-profile-extraction";
import { resumeProfileBasics } from "@/lib/resume-profile-basics";
import { extractResumeFacts } from "@/lib/resume-fact-extraction";
import { parsePdfSource } from "@/lib/pdf-source";
import { parseDocxSource } from "@/lib/docx-source";
import { readOriginalResume } from "@/lib/original-resume";
import { saveOnboarding } from "@/lib/onboarding";
import { resumeOnboardingStatus } from "@/lib/onboarding-completion";
import { queuePersonalSearch } from "@/lib/personal-search";
import { queueMatchAssessment } from "@/lib/match-queue";
import type { Profile, ResumeExtraction } from "@/lib/types";

const processing = new Set(["queued", "extracting", "checking"]);
export function resumeExtractionPending(profile: Profile): boolean {
  return Boolean(profile.resumeExtraction && processing.has(profile.resumeExtraction.status));
}

export function fillImportedCurrentLocation(profile: Profile, source: NonNullable<Profile["resumeSourceDocument"]>, groundedLocation?: string): void {
  if (!groundedLocation || Object.values(profile.currentLocation ?? {}).some(value => value.trim())) return;
  const location = resumeProfileBasics({ ...source, text: groundedLocation }).currentLocation;
  if (location) profile.currentLocation = location;
}

export function fillReusedOnboardingBasics(profile: Profile, source: NonNullable<Profile["resumeSourceDocument"]>): void {
  for (const key of ["name", "contactEmail", "phone"] as const) {
    const previous = profile.detailSources?.[key];
    if (!profile[key]?.trim() && previous?.source === "resume" && previous.sourceHash === source.sourceHash) profile[key] = previous.value;
  }
  if (!profile.links?.length) profile.links = [...new Set([profile.linkedinUrl, profile.githubUrl, profile.portfolioUrl].filter((value): value is string => Boolean(value)))];
  const location = profile.detailSources?.location;
  if (location?.source === "resume" && location.sourceHash === source.sourceHash) fillImportedCurrentLocation(profile, source, location.value);
}

function applyOnboardingBasics(profile: Profile, source: NonNullable<Profile["resumeSourceDocument"]>, details: ResumeProfileDetail[], incoming: NonNullable<ResumeExtraction["pending"]>["onboardingImport"]): void {
  if (!incoming) return;
  const values = new Map(details.map(detail => [detail.key, detail.value]));
  const baseline = incoming.baseline;
  const fields = { name: values.get("name") ?? "", contactEmail: values.get("contactEmail") ?? "", phone: values.get("phone") ?? "" };
  profile.detailSources ??= {};
  for (const key of ["name", "contactEmail", "phone"] as const) {
    // The queued snapshot lets replacement import update old answers, but never overwrite a later edit.
    if (profile[key] !== baseline[key] || (incoming.reused && profile[key]?.trim())) continue;
    profile[key] = fields[key];
    const detail = details.find(item => item.key === key);
    if (detail) profile.detailSources[key] = { source: "resume", value: fields[key], sourceHash: source.sourceHash, anchorId: detail.anchorId, quote: detail.quote };
    else delete profile.detailSources[key];
  }
  if (!incoming.reused && JSON.stringify(profile.links) === JSON.stringify(baseline.links)) {
    for (const key of ["linkedinUrl", "githubUrl", "portfolioUrl"] as const) {
      if (profile[key] !== baseline[key]) continue;
      // Mark unchanged prior values as replaceable resume data. applyResumeProfile
      // will overwrite or clear them from the newly grounded detail set.
      profile.detailSources[key] = { source: "resume", value: profile[key] ?? "", sourceHash: source.sourceHash };
    }
  }
  fillImportedCurrentLocation(profile, source, values.get("location"));
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
  if (isDemo() || (profile.resumeExtraction && (profile.resumeExtraction.status !== "ready" || profile.resumeDetailsVersion === 1)) || !profile.resumeSource || !profile.resumeFileName) return false;
  const id = newId();
  const queued = await mutateState(userId, state => {
    const current = state.profile;
    if ((current.resumeExtraction && (current.resumeExtraction.status !== "ready" || current.resumeDetailsVersion === 1)) || !current.resumeSource || !current.resumeFileName) return false;
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
  const profileNameAtStart = profile.name;
  let extractionName = profile.name;
  const assertCurrent = async () => {
    const current = (await loadState(userId)).profile;
    if (current.resumeExtraction?.id !== requestId || !processing.has(current.resumeExtraction.status) || current.name !== profileNameAtStart)
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
    const deadline = Date.now() + 480_000;
    let source = pending.document;
    if (!source || source.sourceHash !== pending.source.sha256 || (source.format === "pdf" && source.version < 3)) {
      const bytes = await readOriginalResume(userId, { ...pending.source, filename: job.filename });
      source = pending.source.mimeType === "application/pdf" ? await parsePdfSource(bytes, profile.name) : await parseDocxSource(bytes, profile.name);
    }
    source = sourceWithCurrentEvidenceClaims(source, profile.name);
    if (source.sourceHash !== pending.source.sha256) throw new Error("The resume no longer matches its stored original. Upload it again.");
    let details: ResumeProfileDetail[] | undefined;
    if (job.profileSourceHash !== source.sourceHash) {
      details = await withModelUsageContext({ userId, runId: requestId, backgroundJobId: `resume-facts:${requestId}` }, () => extractResumeProfile(source!, { userId, beforeModelCall: assertCurrent, deadline }));
      const current = (await loadState(userId)).profile;
      if (current.resumeExtraction?.id !== requestId || !processing.has(current.resumeExtraction.status)) return { ready: false };
      if (current.name !== profileNameAtStart) throw new Error("Your profile name changed. Retry extraction using the current name.");
      extractionName = details.find(detail => detail.key === "name")?.value ?? extractionName;
    }
    const facts = await withModelUsageContext({ userId, runId: requestId, backgroundJobId: `resume-facts:${requestId}` }, () => extractResumeFacts(source!, {
      userId, trustedName: extractionName, deadline, beforeModelCall: assertCurrent,
      onProgress: async status => { await mutateState(userId, state => {
        const current = state.profile.resumeExtraction;
        if (current?.id !== requestId || !processing.has(current.status)) throw new Error("The uploaded resume changed during extraction.");
        current.status = status; current.updatedAt = new Date().toISOString();
      }); },
    }));
    const published = await mutateState(userId, state => {
      const current = state.profile;
      if (current.resumeExtraction?.id !== requestId || !processing.has(current.resumeExtraction.status)) return false;
      if (current.name !== profileNameAtStart) throw new Error("Your profile name changed. Retry extraction using the current name.");
      const completedAt = resumeOnboardingStatus(current).complete ? current.onboarding?.completedAt : undefined;
      const manual = current.facts.filter(fact => fact.source === "user");
      if (manual.length + facts.length > 80) throw new Error("The resume and manually added facts exceed 80 facts. Shorten the resume or remove unused manual facts, then retry.");
      if (details) {
        applyOnboardingBasics(current, source!, details, pending.onboardingImport);
        applyResumeProfile(current, source!, details);
        const incoming = pending.onboardingImport;
        if (incoming && JSON.stringify(current.links) === JSON.stringify(incoming.baseline.links) && (!incoming.reused || !current.links?.length))
          current.links = [...new Set([current.linkedinUrl, current.githubUrl, current.portfolioUrl].filter((value): value is string => Boolean(value)))];
      }
      current.resumeFileName = job.filename; current.resumeSource = pending.source;
      current.resumeSourceDocument = source; current.resumeText = source.text;
      saveOnboarding(current, { facts: [...manual, ...facts] });
      if (completedAt && pending.onboardingImport?.reused && current.onboarding!.completedResumeHash === source!.sourceHash)
        current.onboarding!.completedAt = completedAt;
      const now = new Date().toISOString();
      current.resumeExtraction = { ...current.resumeExtraction, status: "ready", pending: undefined, error: undefined,
        ...(details ? { profileSourceHash: source!.sourceHash } : {}), updatedAt: now };
      current.updatedAt = now; state.matchCache = {};
      state.activity.unshift({ id: newId(), at: now, label: "Resume facts ready", detail: `${facts.length} facts extracted and grounded in your resume. Review your profile before finishing onboarding.` });
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
