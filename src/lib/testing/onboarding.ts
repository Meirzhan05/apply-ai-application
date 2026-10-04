import { createHash } from "node:crypto";
import { isUnitedStatesLocation } from "@/lib/location-fit";
import type { OnboardingQuestionnaire, Profile } from "@/lib/types";

const syntheticQuestionnaire: OnboardingQuestionnaire = {
  immigrationStatus: "us-citizen",
  workAuthorization: "yes",
  requiresSponsorship: "no",
  sponsorshipNow: "no",
  sponsorshipFuture: "no",
};

function syntheticSource(next: Profile): void {
  if (next.resumeFileName || next.resumeSource || next.resumeSourceDocument) return;
  const text = "Synthetic Applicant\nBuilt a source-backed project.";
  const sha256 = createHash("sha256").update(text).digest("hex");
  next.resumeFileName = "synthetic-resume.pdf";
  next.resumeText = text;
  next.resumeSource = { sha256, size: text.length, mimeType: "application/pdf" };
  next.resumeSourceDocument = {
    version: 3, parser: "pdfjs-text-3", format: "pdf", sourceHash: sha256, text,
    support: { status: "candidate" },
    layout: { columns: 1, pageCount: 1, pageSizePt: { width: 612, height: 792 }, marginsPt: { top: 36, right: 36, bottom: 36, left: 36 }, fontFamilies: ["Helvetica"] },
    sections: [], anchors: [],
  };
}

function completeExistingSource(next: Profile): void {
  if (!next.resumeSource?.sha256) return;
  const questionnaire = { ...syntheticQuestionnaire, ...next.onboarding?.questionnaire };
  const declaration = questionnaire.workAuthorization;
  if (declaration === "yes") next.workAuthorization = "Authorized to work in the US";
  if (declaration === "no") next.workAuthorization = "Not authorized to work in the US";
  if (declaration === "unknown") next.workAuthorization = "Unspecified";
  next.onboarding = {
    ...next.onboarding,
    questionnaire,
    completedVersion: 2,
    completedAt: new Date().toISOString(),
    completedResumeHash: next.resumeSource.sha256,
  };
  next.searchPreferencesConfirmedAt ??= next.onboarding.completedAt;
}

/** Build a source-backed v2 profile while preserving source and owner answers already in the fixture. */
export function completeOnboardingFixture(profile: Profile): Profile {
  const next = structuredClone(profile);
  next.demo = false;
  next.name ||= "Synthetic Applicant";
  next.email ||= "synthetic@example.com";
  next.phone ||= "+1 212 555 0100";
  next.currentLocation ??= { city: "New York", region: "NY", country: "United States" };
  next.preferredLocations = next.preferredLocations.filter(isUnitedStatesLocation);
  if (!next.preferredLocations.length) next.preferredLocations = ["United States"];
  next.workArrangements ??= ["remote", "hybrid", "on-site"];
  next.remoteOnly = next.remoteOnly ?? false;
  syntheticSource(next);
  completeExistingSource(next);
  return next;
}

/** Mark a fixture with its real uploaded source as completed; never invent source storage or parsing metadata. */
export function completeUploadedOnboardingFixture(profile: Profile): Profile {
  const next = structuredClone(profile);
  if (!next.resumeFileName || !next.resumeSource?.sha256 || !next.resumeSourceDocument?.text.trim() ||
    next.resumeSourceDocument.sourceHash !== next.resumeSource.sha256) {
    throw new Error("completeUploadedOnboardingFixture requires a real parsed uploaded source");
  }
  next.demo = false;
  next.name ||= "Synthetic Applicant";
  next.email ||= "synthetic@example.com";
  next.phone ||= "+1 212 555 0100";
  next.currentLocation ??= { city: "New York", region: "NY", country: "United States" };
  next.preferredLocations = next.preferredLocations.filter(isUnitedStatesLocation);
  if (!next.preferredLocations.length) next.preferredLocations = ["United States"];
  next.workArrangements ??= ["remote", "hybrid", "on-site"];
  next.remoteOnly = next.remoteOnly ?? false;
  completeExistingSource(next);
  return next;
}
