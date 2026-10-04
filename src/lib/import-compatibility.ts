import { hashJson } from "@/lib/crypto";
import { canonicalJobUrl } from "@/lib/sources";
import { controlledReceiverUrl, verifyControlledTestGrant } from "@/lib/controlled-tests";
import { importedPosting } from "@/lib/import-jobs";
import type {
  Application,
  FormSnapshot,
  ImportedCompatibilityRecord,
  Job,
  Profile,
} from "@/lib/types";

type ObservedForm = Pick<FormSnapshot, "url" | "submitControl"> & {
  hash?: string;
  contextHash?: string;
  postingEvidence?: { postingUrl?: string; postingIdentityHash?: string; title?: string; company?: string; markers: string[]; identityHash: string };
  observedContext?: { title?: string; company?: string; location?: string; text: string };
};

export function isImportedJob(job: Job | undefined): boolean {
  return job?.source === "imported" || Boolean(job?.importUrl);
}

/**
 * Controlled receiver applications are server-created synthetic fixtures. The
 * exact receiver URL and signed grant are checked by the receiver itself; the
 * autonomous policy only treats the marker as an exemption for those fixtures.
 * Ordinary imported jobs never get this exemption.
 */
export function isControlledImportedFixture(application: Application, job: Job | undefined): boolean {
  if (!application.controlledTest || !job || !isImportedJob(job)) return false;
  try {
    const url = controlledReceiverUrl(job.applyUrl);
    if (!url) return false;
    const token = url.searchParams.get("token");
    const grant = token ? verifyControlledTestGrant(token) : null;
    return Boolean(grant && grant.userId === application.userId && grant.applicationId === application.id && grant.expiresAt === application.controlledTest.expiresAt);
  } catch {
    return false;
  }
}

export function latestImportedCompatibility(application: Application): ImportedCompatibilityRecord | undefined {
  return application.importedCompatibility;
}

export function importedCompatibilityRequired(application: Application, job: Job | undefined): boolean {
  const providerVerified = Boolean(job?.importCheck?.status === "verified" && importedPosting(job.importUrl ?? job.url));
  return isImportedJob(job) && !providerVerified && !isControlledImportedFixture(application, job);
}

export function importedAutonomyJob(application: Application, job: Job): Job {
  if (!importedCompatibilityRequired(application, job)) return job;
  const proof = application.importedCompatibility;
  const context = proof?.observedContext;
  if (proof && (proof.jobLocation ?? application.jobSnapshot?.location) !== job.location)
    return { ...job, location: "Destination changed since verification", remote: null };
  if (!proof || proof.status !== "reachable" || !context?.text.trim()) {
    return { ...job, location: "Location not confirmed", remote: null, description: "", requirements: [] };
  }
  return {
    ...job,
    title: proof.postingEvidence.title || job.title,
    company: proof.postingEvidence.company || job.company,
    location: context.location || "Location not confirmed",
    remote: null,
    description: context.text,
    requirements: [],
  };
}

export function createImportedCompatibilityRecord(input: {
  application: Application;
  job: Job;
  observed: ObservedForm;
  checkedAt?: string;
  status: ImportedCompatibilityRecord["status"];
  blocker?: string;
  controlled?: boolean;
}): ImportedCompatibilityRecord {
  const observedUrl = new URL(input.observed.url);
  return {
    version: 1,
    ownerId: input.application.userId,
    applicationId: input.application.id,
    jobId: input.application.jobId,
    jobLocation: input.job.location,
    canonicalPostingUrl: canonicalJobUrl(input.job.url),
    postingUrl: input.job.url,
    observedUrl: observedUrl.href,
    observedOrigin: observedUrl.origin,
    formUrl: input.observed.url,
    formHash: input.observed.hash,
    submitControl: input.observed.submitControl,
    contextHash: input.observed.contextHash ?? hashJson({ url: observedUrl.href, posting: canonicalJobUrl(input.job.url) }),
    postingEvidence: {
      ...(input.observed.postingEvidence ?? { markers: [], identityHash: hashJson({}) }),
      postingUrl: input.observed.postingEvidence?.postingUrl ?? canonicalJobUrl(input.job.url),
      postingIdentityHash: input.observed.postingEvidence?.postingIdentityHash ?? hashJson({ postingUrl: canonicalJobUrl(input.job.url) }),
    },
    observedContext: input.observed.observedContext,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
    status: input.status,
    blocker: input.blocker,
    controlled: input.controlled,
  };
}

function sameUrl(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  try {
    const a = new URL(left); a.hash = "";
    const b = new URL(right); b.hash = "";
    return a.href === b.href;
  } catch {
    return false;
  }
}

export function assertImportedCompatibility(application: Application, profile: Profile, job: Job | undefined): void {
  if (!importedCompatibilityRequired(application, job)) return;
  const proof = latestImportedCompatibility(application);
  if (!proof || proof.version !== 1 || proof.status !== "reachable" ||
      proof.ownerId !== profile.id || proof.ownerId !== application.userId ||
      proof.applicationId !== application.id || proof.jobId !== application.jobId ||
      !job || proof.canonicalPostingUrl !== canonicalJobUrl(job.url) ||
      !sameUrl(proof.postingUrl, job.url) || !proof.formUrl || !proof.formHash ||
      !proof.submitControl?.action || !sameUrl(proof.observedUrl, proof.formUrl) ||
      !proof.postingEvidence.postingUrl || !proof.postingEvidence.postingIdentityHash || !proof.postingEvidence.markers.length || !proof.postingEvidence.identityHash ||
      !proof.observedContext?.text.trim())
    throw new Error("Verify the imported employer posting and form before enabling automatic application.");
  const formOrigin = new URL(proof.formUrl).origin;
  if ((proof.jobLocation ?? application.jobSnapshot?.location) !== job.location)
    throw new Error("The job destination changed. Verify the imported posting again before preparing or filling an application.");
  const actionOrigin = new URL(proof.submitControl.action, proof.formUrl).origin;
  if (formOrigin !== proof.observedOrigin || actionOrigin !== proof.observedOrigin)
    throw new Error("The imported application form leaves the verified employer site. Review it manually.");
  const evidenceError = validateImportedPostingEvidence(job, proof.postingEvidence);
  if (evidenceError) throw new Error(evidenceError);
}

function comparable(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function validateImportedPostingEvidence(job: Job, evidence: { postingUrl?: string; postingIdentityHash?: string; title?: string; company?: string; markers: string[] }): string | undefined {
  if (!evidence.postingUrl || canonicalJobUrl(evidence.postingUrl) !== canonicalJobUrl(job.url) || !evidence.postingIdentityHash)
    return "The public page did not remain bound to the imported posting link.";
  const markers = evidence.markers.map(comparable).filter(Boolean);
  if (!markers.length) return "The public page did not expose enough posting identity to verify this imported link.";
  const title = comparable(job.title);
  const company = comparable(job.company);
  const observedTitle = comparable(evidence.title);
  const observedCompany = comparable(evidence.company);
  if (!title || title === "imported opportunity" || !company || company === "unknown employer" || !observedTitle || !observedCompany)
    return "Add a posting title and employer that the public page can corroborate before enabling automatic application.";
  const phraseMatch = (expected: string, marker: string) => marker === expected || marker.startsWith(`${expected} `) || marker.includes(` ${expected} `) || marker.endsWith(` ${expected}`);
  const titleMatch = observedTitle === title;
  const companyMatch = phraseMatch(company, observedCompany);
  if (!titleMatch || !companyMatch)
    return "The public page did not corroborate the imported employer and posting title.";
  return undefined;
}

export function assertImportedDestination(application: Application, job: Job | undefined, form: Pick<FormSnapshot, "url" | "submitControl">): void {
  const effectiveJob = job ?? application.jobSnapshot;
  if (!effectiveJob || !isImportedJob(effectiveJob) || isControlledImportedFixture(application, effectiveJob))
    throw new Error("An exact imported posting and form proof is required before following this destination.");
  const proof = latestImportedCompatibility(application);
  if (!proof || proof.status !== "reachable" || !proof.formUrl || !proof.submitControl?.action ||
      !sameUrl(form.url, proof.formUrl) || !sameUrl(form.submitControl?.action ?? form.url, proof.submitControl.action) ||
      new URL(form.url).origin !== proof.observedOrigin || new URL(form.submitControl?.action ?? form.url, form.url).origin !== proof.observedOrigin)
    throw new Error("The observed imported form or submit destination changed from the verified preflight.");
}

export function compatibilityChanged(application: Application, job: Job, proof: ImportedCompatibilityRecord): boolean {
  return proof.applicationId !== application.id || proof.ownerId !== application.userId || proof.jobId !== application.jobId ||
    proof.canonicalPostingUrl !== canonicalJobUrl(job.url) || !sameUrl(proof.postingUrl, job.url);
}
