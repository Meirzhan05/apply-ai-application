import { isUsableFact } from "@/lib/fact-evidence";
import type { Job, MatchAssessment, Profile } from "./types";

function words(text: string) {
  return new Set(text.toLowerCase().match(/[a-z][a-z0-9+#.-]*/g) ?? []);
}

/** Display literal overlaps, never a new qualification or eligibility verdict. */
export function matchEvidence(profile: Profile, job: Job, assessment?: MatchAssessment) {
  const comparisons = assessment?.category === "excluded" ? [] : job.requirements.flatMap(requirement => {
    const terms = [...words(requirement)].filter(term => term.length > 2);
    if (!terms.length) return [];
    const fact = profile.facts.find(item => isUsableFact(item) && terms.every(term => words(item.text).has(term)));
    return fact ? [{ requirement, fact: fact.text, factId: fact.id }] : [];
  });
  const listedSkills = assessment?.category === "excluded" ? [] : job.requirements.flatMap(requirement => {
    const terms = [...words(requirement)].filter(term => term.length > 2);
    const skill = terms.length ? profile.skills.find(item => terms.every(term => words(item).has(term))) : undefined;
    return skill ? [{ requirement, skill }] : [];
  });
  const substantive = assessment?.evidence.find(reason => !reason.startsWith("The posting title,"));
  const headline = comparisons.length
    ? `Posting: ${comparisons[0].requirement} · Your confirmed experience: ${comparisons[0].fact}`
    : listedSkills.length ? `Posting: ${listedSkills[0].requirement} · Skill you listed: ${listedSkills[0].skill}`
    : substantive && !substantive.includes("your profile mentions it") ? substantive : (assessment?.evidence.some(reason => reason.startsWith("The posting title,"))
      ? "Title matches your search. Review the requirements below."
      : "Review the posting to compare it with your experience.");
  const detailedReasons = (assessment?.evidence ?? []).filter(reason => {
    if (!comparisons.length) return true;
    if (reason.startsWith("The posting title,")) return false;
    const requirement = /^The posting asks for (.+); your profile mentions it\.$/.exec(reason)?.[1];
    return !comparisons.some(item => item.requirement === requirement);
  });
  return { headline, comparisons, listedSkills, detailedReasons };
}
