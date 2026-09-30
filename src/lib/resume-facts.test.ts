import { describe, expect, it } from "vitest";
import { suggestResumeFacts } from "@/lib/resume-facts";

describe("unconfirmed resume source suggestions", () => {
  it("keeps wrapped achievements and role dates in their employer context", () => {
    const facts = suggestResumeFacts(`WORK EXPERIENCE
Orbit Labs Remote
Machine Learning Intern February 2026 – June 2026
• Built a recommender aligned with the employer's highest-performing
campaigns and integrated SHAP explainability.
• Shipped a custom rule protecting a large codebase from
URL-helper misuse.
Other Labs
Software Engineer Intern July 2026 – August 2026
• Created a database service with PostgreSQL.`);
    expect(facts).toEqual([
      "Orbit Labs Remote · Machine Learning Intern February 2026 – June 2026 · Built a recommender aligned with the employer's highest-performing campaigns and integrated SHAP explainability.",
      "Orbit Labs Remote · Machine Learning Intern February 2026 – June 2026 · Shipped a custom rule protecting a large codebase from URL-helper misuse.",
      "Other Labs · Software Engineer Intern July 2026 – August 2026 · Created a database service with PostgreSQL.",
    ]);
  });
  it("does not attach one project's claim to the next project", () => {
    expect(suggestResumeFacts(`PROJECTS
Atlas | Python, FastAPI | GitHub
• Led a team building a security monitor, detecting multiple
simultaneous attacks.
Beacon | Swift, PostgreSQL | GitHub
• Built a personal AI agent using fifteen tools.
• Integrated scheduled, location-based, and travel-aware
tasks, with quiet hours and follow-up suggestions.`)).toEqual([
      "Atlas | Python, FastAPI | GitHub · Led a team building a security monitor, detecting multiple simultaneous attacks.",
      "Beacon | Swift, PostgreSQL | GitHub · Built a personal AI agent using fifteen tools.",
      "Beacon | Swift, PostgreSQL | GitHub · Integrated scheduled, location-based, and travel-aware tasks, with quiet hours and follow-up suggestions.",
    ]);
  });
  it("retains expected graduation and uncompleted manuscript status", () => {
    const facts = suggestResumeFacts(`EDUCATION
Example University
Computer Science, GPA 3.6 Expected May 2027
• Coursework: Operating Systems, Database
Systems, Artificial Intelligence
PUBLICATIONS
Example, Student, et al. “A Study of Face Instance
Segmentation.” Manuscript in preparation.
Example, Student, et al. “A Multi-Agent Framework.”
Manuscript in preparation.`);
    expect(facts).toHaveLength(2);
    expect(facts[0]).toContain("Expected May 2027");
    expect(facts[0]).toContain("Database Systems");
    expect(facts[1].match(/Manuscript in preparation\./g)).toHaveLength(2);
    expect(facts.some((fact) => /graduated|published|accepted/i.test(fact))).toBe(false);
  });
  it("joins wrapped skill lists and removes PDF page counters", () => {
    expect(suggestResumeFacts(`TECHNICAL SKILLS
Languages: Python, JavaScript,
TypeScript, SQL
Libraries: React, NumPy, TensorFlow
-- 1 of 1 --`)).toEqual([
      "TECHNICAL SKILLS: Languages: Python, JavaScript, TypeScript, SQL Libraries: React, NumPy, TensorFlow",
    ]);
  });
  it("never clips an oversized claim into a stronger but incomplete one", () => {
    const long = "Built a system " + "with research context ".repeat(30) + "that remains a prototype.";
    expect(suggestResumeFacts(`PROJECTS\nAtlas | Python\n• ${long}`)).toEqual([]);
  });
  it("deduplicates source text and excludes contact blocks", () => {
    expect(suggestResumeFacts(`• Built a Python API for a research prototype.
• Built a Python API for a research prototype.
PROFILE
Student Example student@example.com +1 (555) 123-4567`)).toEqual([
      "Built a Python API for a research prototype.",
    ]);
  });
  it("retains wrapped action paragraphs when DOCX extraction omits list markers", () => {
    expect(suggestResumeFacts(`WORK EXPERIENCE
Orbit Labs
Software Engineer Intern June 2026 – August 2026
Built a Python API for a research
prototype, with monitoring and error handling.
Integrated database migrations and rollback support.`)).toEqual([
      "Orbit Labs · Software Engineer Intern June 2026 – August 2026 · Built a Python API for a research prototype, with monitoring and error handling.",
      "Orbit Labs · Software Engineer Intern June 2026 – August 2026 · Integrated database migrations and rollback support.",
    ]);
  });
  it("does not mistake years inside a wrapped achievement for the next employment entry", () => {
    expect(suggestResumeFacts(`WORK EXPERIENCE
Orbit Labs
Data Intern June 2026 - August 2026
• Analyzed historical events using data
collected from activity between
2020 and 2024.`)).toEqual([
      "Orbit Labs · Data Intern June 2026 - August 2026 · Analyzed historical events using data collected from activity between 2020 and 2024.",
    ]);
  });
});
