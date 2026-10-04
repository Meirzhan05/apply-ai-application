import { z } from "zod";
import { normalizeProfileLinks } from "@/lib/resume-profile-basics";
import type { Profile } from "@/lib/types";

/** The shared editable profile surface used by onboarding and legacy profile edits. */
export const profileDraftSchema = z.object({
  name: z.string().trim().max(200).optional(),
  email: z.union([z.email().max(254), z.literal("")]).optional(),
  phone: z.string().trim().max(100).optional(),
  links: z.array(z.string().max(500)).max(20).optional(),
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
  for (const key of ["name", "email", "phone"] as const) {
    if (input[key] !== undefined) profile[key] = input[key];
  }
  if (input.links !== undefined) profile.links = normalizeProfileLinks(input.links);
  if (input.currentLocation !== undefined) profile.currentLocation = input.currentLocation;
  if (input.preferredLocations !== undefined) profile.preferredLocations = [...new Set(input.preferredLocations.filter(Boolean))];
  if (input.workArrangements !== undefined) {
    profile.workArrangements = [...new Set(input.workArrangements)];
    profile.remoteOnly = profile.workArrangements.length === 1 && profile.workArrangements[0] === "remote";
  }
  if (input.willingToRelocate !== undefined) profile.willingToRelocate = input.willingToRelocate ?? undefined;
}
