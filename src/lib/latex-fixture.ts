import { initialDemoState } from "./demo-data";
import { sealResume } from "./resume-document";
import type { ResumeDocument, ResumeEntry, ResumeField } from "./types";

export function latexFixture() {
  const profile = structuredClone(initialDemoState().profile);
  profile.id = "latex-fixture-user";
  profile.name = "Taylor Morgan"; profile.email = "taylor@example.com"; profile.phone = "+1 (555) 010-1234";
  profile.school = "State University"; profile.graduationYear = "May 2027 (expected)";
  const facts = [
    "State University, B.S. in Computer Science, GPA 3.76, Dean's List; expected graduation May 2027.",
    "Machine Learning Engineer Intern at Orbit Labs, remote, February 2026-June 2026.",
    "At Orbit Labs, developed an XGBoost regression model to predict campaign ROI from influencer engagement and audience metrics.",
    "Open Source Contributor to SourceForge Labs, April 2026.",
    "At SourceForge Labs, shipped a custom RuboCop cop preventing organization-scoped Rails URL-helper misuse across a 1.5M+ line monorepo.",
    "For Compass, built a personal AI agent using LangGraph with access to 15+ tools to complete tasks autonomously.",
    "For Compass, integrated a proactive engine for scheduled, location-based and travel-aware tasks with quiet hours and habit tracking.",
    "For Compass, shipped a native SwiftUI macOS app with secure Keychain authentication and automatic reconnection.",
    "For AI Security Monitor, architected a multi-agent LLM validation system with weighted scoring to classify alerts into threat categories.",
    "For AI Security Monitor, led an 8-person team to build a cloud-based security testing system using AWS and Docker, detecting 50+ simultaneous cyberattacks.",
    "Programming languages listed in resume: Python, JavaScript, TypeScript, Java, Swift, Kotlin, SQL, HTML/CSS.",
    "Professional profile: https://github.com/taylor-example",
    "Volunteered at a community garden.",
  ];
  profile.facts = facts.map((text, index) => ({ id: `latex-fact-${index}`, text, verified: true, source: "resume" as const }));
  const field = (text: string, ...ids: number[]): ResumeField => ({ text, factIds: ids.map((id) => `latex-fact-${id}`) });
  const empty = field("");
  const entry = (heading: ResumeField, subheading: ResumeField, dates: ResumeField, bullets: Array<ResumeField & { relevance: number }>): ResumeEntry => ({ heading, subheading, dates, location: empty, bullets });
  const doc: ResumeDocument = {
    version: 1, templateVersion: "classic-1", layout: "standard", model: "synthetic-fixture", contentHash: "", evidenceHash: "",
    education: [entry(field("State University", 0), field("B.S. in Computer Science", 0), field("May 2027 (expected)", 0), [{ ...field("GPA: 3.76 | Dean's List", 0), relevance: 80 }])],
    experience: [
      entry(field("Orbit Labs", 1), field("Machine Learning Engineer Intern | Remote", 1), field("February 2026-June 2026", 1), [{ ...field("Developed an XGBoost regression model to predict campaign ROI from influencer engagement and audience metrics.", 2), relevance: 90 }]),
      entry(field("SourceForge Labs", 3), field("Open Source Contributor", 3), field("April 2026", 3), [{ ...field("Shipped a custom RuboCop cop preventing organization-scoped Rails URL-helper misuse across a 1.5M+ line monorepo.", 4), relevance: 88 }]),
    ],
    projects: [
      entry(field("Compass", 5), empty, empty, [
        { ...field("Built a personal AI agent using LangGraph with access to 15+ tools to complete tasks autonomously.", 5), relevance: 100 },
        { ...field("Integrated a proactive engine for scheduled, location-based and travel-aware tasks with quiet hours and habit tracking.", 6), relevance: 90 },
        { ...field("Shipped a native SwiftUI macOS app with secure Keychain authentication and automatic reconnection.", 7), relevance: 85 },
      ]),
      entry(field("AI Security Monitor", 8), empty, empty, [
        { ...field("Architected a multi-agent LLM validation system with weighted scoring to classify alerts into threat categories.", 8), relevance: 95 },
        { ...field("Led an 8-person team building a cloud-based security testing system using AWS and Docker, detecting 50+ simultaneous cyberattacks.", 9), relevance: 90 },
      ]),
    ],
    skills: [field("Languages: Python, JavaScript, TypeScript, Java, Swift, Kotlin, SQL, HTML/CSS", 10), field("Tools: LangGraph, XGBoost, SwiftUI, AWS, Docker, RuboCop", 2, 4, 5, 7, 9)],
    links: [field("https://github.com/taylor-example", 11)],
    omitted: [{ ...field(facts[12], 12), reason: "relevance" }],
  };
  return { profile, document: sealResume(profile, doc) };
}
