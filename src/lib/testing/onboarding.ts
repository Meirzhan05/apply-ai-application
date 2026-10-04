import { createHash } from "node:crypto";
import type { Profile } from "@/lib/types";

/** Build a source-backed v2 profile for operation tests without changing demo defaults. */
export function completeOnboardingFixture(profile: Profile): Profile {
  const next = structuredClone(profile);
  next.demo = false;
  next.name ||= "Synthetic Applicant";
  next.email ||= "synthetic@example.com";
  next.phone ||= "+1 212 555 0100";
  next.currentLocation = { city: "New York", region: "NY", country: "United States" };
  next.preferredLocations = ["United States"];
  next.workArrangements = ["remote", "hybrid", "on-site"];
  next.remoteOnly = false;
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
  next.onboarding = {
    questionnaire: { immigrationStatus: "us-citizen", workAuthorization: "yes", sponsorshipNow: "no", sponsorshipFuture: "no" },
    completedVersion: 2, completedAt: new Date().toISOString(), completedResumeHash: sha256,
  };
  return next;
}
