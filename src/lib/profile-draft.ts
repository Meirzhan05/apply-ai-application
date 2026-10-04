import { z } from "zod";
import { normalizeProfileLinks } from "@/lib/resume-profile-basics";
import { profileLinkAnswers } from "@/lib/profile-links";
import type { Profile, ProfileDetailKey } from "@/lib/types";

/** The shared editable profile surface used by onboarding and legacy profile edits. */
export const profileDraftSchema = z.object({
  name: z.string().trim().max(200).optional(),
  email: z.union([z.email().max(254), z.literal("")]).optional(),
  contactEmail: z.union([z.email().max(254), z.literal("")]).optional(),
  phone: z.string().trim().max(100).optional(),
  // Keep the shared surface compatible with legacy profile links (30 entries)
  // and onboarding's historical long-link allowance (2048 characters).
  links: z.array(z.string().max(2048)).max(30).optional(),
  currentLocation: z.object({
    city: z.string().trim().max(120),
    region: z.string().trim().max(120),
    country: z.string().trim().max(120),
  }).optional(),
  preferredLocations: z.array(z.string().trim().max(160)).max(30).optional(),
  workArrangements: z.array(z.enum(["remote", "hybrid", "on-site"])).max(3).optional(),
  willingToRelocate: z.boolean().nullable().optional(),
});

export type ProfileDraft = z.infer<typeof profileDraftSchema>;

export function parseProfileDraft(input: unknown): ProfileDraft {
  return profileDraftSchema.parse(input);
}

export function applyProfileDraft(profile: Profile, input: ProfileDraft): void {
  const saveDetail = (key: ProfileDetailKey, value: string) => {
    if (profile[key] === value) return;
    profile[key] = value;
    profile.detailSources ??= {};
    profile.detailSources[key] = { source: "user", value };
    profile.savedAnswers = profile.savedAnswers?.filter(answer => answer.key !== key);
  };
  for (const key of ["name", "phone"] as const) {
    if (input[key] !== undefined) saveDetail(key, input[key]);
  }
  const contactEmail = input.contactEmail ?? input.email;
  if (contactEmail !== undefined) saveDetail("contactEmail", contactEmail);
  if (input.links !== undefined) {
    const links = normalizeProfileLinks(input.links);
    if (JSON.stringify(links) !== JSON.stringify(profile.links ?? [])) {
      const previous = profileLinkAnswers(profile);
      const updated = profileLinkAnswers({ ...profile, links });
      for (const [kind, key] of [["linkedin", "linkedinUrl"], ["github", "githubUrl"], ["portfolio", "portfolioUrl"]] as const) {
        const value = updated[kind] ?? (links.includes(profile[key] ?? "") ? profile[key] : undefined);
        if (value !== undefined || previous[kind] === profile[key]) saveDetail(key, value ?? "");
      }
    }
    profile.links = links;
  }
  if (input.currentLocation !== undefined) {
    if (JSON.stringify(profile.currentLocation) !== JSON.stringify(input.currentLocation)) {
      saveDetail("location", Object.values(input.currentLocation).filter(Boolean).join(", "));
    }
    profile.currentLocation = input.currentLocation;
  }
  if (input.preferredLocations !== undefined) profile.preferredLocations = [...new Set(input.preferredLocations.filter(Boolean))];
  if (input.workArrangements !== undefined) {
    profile.workArrangements = [...new Set(input.workArrangements)];
    profile.remoteOnly = profile.workArrangements.length === 1 && profile.workArrangements[0] === "remote";
  }
  if (input.willingToRelocate !== undefined) profile.willingToRelocate = input.willingToRelocate ?? undefined;
}
