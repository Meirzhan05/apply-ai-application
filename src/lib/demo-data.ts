import type { AppState, Job, Profile } from "@/lib/types";

const now = new Date().toISOString();
const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export const demoProfile: Profile = {
  id: "demo-user",
  name: "Taylor Morgan",
  email: "taylor@example.com",
  school: "State University",
  phone: "",
  graduationYear: "2026",
  headline: "Computer science student interested in product and data",
  skills: ["Python", "SQL", "React", "User research"],
  preferredTitles: [
    "Product Analyst",
    "Software Engineering Intern",
    "UX Researcher",
  ],
  preferredLocations: ["New York", "Remote"],
  remoteOnly: false,
  workAuthorization: "Unspecified",
  facts: [
    {
      id: "fact-python",
      text: "Built a Python project to analyze survey data",
      verified: true,
      source: "user",
    },
    {
      id: "fact-sql",
      text: "Used SQL in coursework to query relational databases",
      verified: true,
      source: "user",
    },
    {
      id: "fact-react",
      text: "Built a React portfolio project",
      verified: true,
      source: "user",
    },
    {
      id: "fact-research",
      text: "Conducted interviews for a student UX research project",
      verified: true,
      source: "user",
    },
  ],
  sensitiveAnswers: {},
  automationVersion: 1,
  automationSettings: {
    version: 1,
    resumeTailoring: true,
    coverLetterMode: "required-only",
    essayMode: "automatic-truthful",
  },
  onboarding: { questionnaire: {} },
  demo: true,
  updatedAt: now,
};

export const demoJobs: Job[] = [
  {
    id: "demo-product-analyst",
    source: "demo",
    sourceId: "product-analyst",
    sourceLabel: "Demo listing",
    company: "Northstar Labs",
    title: "Junior Product Analyst",
    location: "New York, NY · Hybrid",
    remote: false,
    employmentType: "Full-time",
    salary: "$80k–$105k",
    description:
      "Analyze product usage, work with SQL and Python, and help teams understand customer needs. This is an illustrative demo role.",
    requirements: ["SQL", "Python", "Product analytics", "Entry level"],
    url: `${baseUrl}/demo/jobs/product-analyst`,
    applyUrl: `${baseUrl}/demo/apply/product-analyst`,
    postedAt: now,
    active: true,
    discoveredAt: now,
  },
  {
    id: "demo-engineering-intern",
    source: "demo",
    sourceId: "engineering-intern",
    sourceLabel: "Demo listing",
    company: "Cedar Systems",
    title: "Software Engineering Intern",
    location: "Remote · United States",
    remote: true,
    employmentType: "Internship",
    salary: "$38–$48/hr",
    description:
      "Build product features with React and TypeScript alongside a small engineering team. This is an illustrative demo role.",
    requirements: ["React", "TypeScript", "Student", "Git"],
    url: `${baseUrl}/demo/jobs/engineering-intern`,
    applyUrl: `${baseUrl}/demo/apply/engineering-intern`,
    postedAt: now,
    active: true,
    discoveredAt: now,
  },
  {
    id: "demo-ux-researcher",
    source: "demo",
    sourceId: "ux-researcher",
    sourceLabel: "Demo listing",
    company: "Fieldnote Health",
    title: "Associate UX Researcher",
    location: "Boston, MA · Hybrid",
    remote: false,
    employmentType: "Full-time",
    description:
      "Plan interviews, synthesize findings, and present research to product teams. This is an illustrative demo role.",
    requirements: [
      "User research",
      "Interviewing",
      "Research synthesis",
      "Entry level",
    ],
    url: `${baseUrl}/demo/jobs/ux-researcher`,
    applyUrl: `${baseUrl}/demo/apply/ux-researcher`,
    postedAt: now,
    active: true,
    discoveredAt: now,
  },
];

export function initialDemoState(): AppState {
  return {
    profile: structuredClone(demoProfile),
    jobs: structuredClone(demoJobs),
    importedJobs: [],
    feedback: [],
    matchCache: {},
    applications: [],
    activity: [
      {
        id: "activity-ready",
        at: now,
        label: "Ready to explore",
        detail: "Demo roles are ready for review",
      },
    ],
    lastRefreshAt: now,
    estimatedSpendUsd: 0,
  };
}
