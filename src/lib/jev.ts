import { z } from "zod";
import type { Job, Profile } from "@/lib/types";
import { explicitConflict } from "@/lib/matching";

const Answer = z.object({
  type: z.literal("choice"),
  confidence: z.number().min(0).max(1),
});
const Response = z.object({
  answers: z.object({
    experience: Answer.extend({ choice: z.enum(["fit", "gap", "unknown"]) }),
    skills: Answer.extend({
      choice: z.enum(["strong", "some", "little", "unknown"]),
    }),
  }),
  usage: z
    .object({ input_tokens: z.number(), output_tokens: z.number() })
    .optional(),
});
export type JevTriage = {
  category: "strong" | "possible" | "uncertain";
  confidence: number;
  experience: string;
  skills: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
};

export function redactedProfile(profile: Profile): Profile {
  const identifiers = [profile.name, profile.email, profile.phone, ...profile.name.split(/\s+/).filter((part) => part.length > 2)].filter(Boolean);
  const redact = (value: string) => {
    let text = value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]").replace(/https?:\/\/\S+/gi, "[link]");
    for (const identifier of identifiers) text = text.replace(new RegExp(identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[redacted]");
    return text;
  };
  return {
    ...profile, id: "evaluation", name: "", email: "", phone: "", school: "",
    headline: redact(profile.headline),
    skills: profile.skills.map(redact),
    graduationYear: redact(profile.graduationYear),
    preferredTitles: profile.preferredTitles.map(redact),
    preferredLocations: profile.preferredLocations.map(redact),
    workAuthorization: redact(profile.workAuthorization),
    resumeFileName: undefined, resumeText: undefined, resumeSource: undefined, sensitiveAnswers: {},
    onboarding: undefined, automationAuthorization: undefined,
    facts: profile.facts.filter((fact) => fact.verified).map((fact) => ({ ...fact, text: redact(fact.text) })),
  };
}

export async function jevTriage(
  profile: Profile,
  job: Job,
): Promise<JevTriage> {
  if (explicitConflict(profile, job))
    throw new Error("Hard-rule conflicts are handled before Jev triage.");
  const key = process.env.TYPESAFE_API_KEY;
  if (!key)
    throw new Error("TYPESAFE_API_KEY is required for the shadow evaluation.");
  const minimal = redactedProfile(profile);
  const state = JSON.stringify({
    applicant: {
      headline: minimal.headline,
      skills: minimal.skills,
      graduationYear: minimal.graduationYear,
      verifiedFacts: minimal.facts
        .filter((fact) => fact.verified)
        .map((fact) => fact.text),
    },
    job: {
      title: job.title,
      description: job.description.slice(0, 6000),
      requirements: job.requirements,
      employmentType: job.employmentType,
    },
  });
  const started = performance.now();
  const response = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      state,
      model: "jev-latest",
      questions: {
        experience: {
          type: "choice",
          instructions:
            "Does the applicant's confirmed experience fit the job's stated career level? Missing experience requirements are uncertain.",
          criteria: {
            fit: "Fits the stated level",
            gap: "Explicit experience gap",
            unknown: "Not enough information",
          },
        },
        skills: {
          type: "choice",
          instructions:
            "How much of the job's stated skills overlap the applicant's confirmed skills and facts?",
          criteria: {
            strong: "Most core skills overlap",
            some: "Some core skills overlap",
            little: "Little confirmed overlap",
            unknown: "Skills are not stated clearly",
          },
        },
      },
    }),
  });
  if (!response.ok) throw new Error(`Jev request failed (${response.status}).`);
  const parsed = Response.parse(await response.json());
  const { experience, skills } = parsed.answers;
  const confidence = Math.min(experience.confidence, skills.confidence);
  const category =
    confidence < 0.55 ||
    experience.choice === "unknown" ||
    skills.choice === "unknown"
      ? "uncertain"
      : experience.choice === "gap" || skills.choice === "little"
        ? "uncertain"
        : experience.choice === "fit" && skills.choice === "strong"
          ? "strong"
          : "possible";
  return {
    category,
    confidence,
    experience: experience.choice,
    skills: skills.choice,
    latencyMs: Math.round(performance.now() - started),
    inputTokens: parsed.usage?.input_tokens,
    outputTokens: parsed.usage?.output_tokens,
  };
}
