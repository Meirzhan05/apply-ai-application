export type MatchCategory = "strong" | "possible" | "uncertain" | "excluded";
export type JobSource = "demo" | "greenhouse" | "lever" | "ashby" | "imported";
export type ApplicationStatus =
  | "selected"
  | "drafting"
  | "draft_review"
  | "authorized_to_fill"
  | "filling"
  | "final_review"
  | "approved_to_submit"
  | "submitting"
  | "awaiting_verification"
  | "submitted"
  | "needs_user_action"
  | "uncertain"
  | "cancelled";

export interface VerifiedFact {
  id: string;
  text: string;
  verified: boolean;
  source: "resume" | "user";
}

export type FactualDeclaration = "yes" | "no" | "unknown";
export type CoverLetterMode = "disabled" | "required-only" | "enabled";
export type EssayMode = "automatic-truthful";

export interface OnboardingQuestionnaire {
  workAuthorization?: FactualDeclaration;
  requiresSponsorship?: FactualDeclaration;
  availability?: string;
  graduationYear?: string;
}

export interface OnboardingProfile {
  questionnaire: OnboardingQuestionnaire;
  completedAt?: string;
}

export interface AutomationSettings {
  version: number;
  resumeTailoring: boolean;
  coverLetterMode: CoverLetterMode;
  essayMode: EssayMode;
}

export interface AutomationAuthorization {
  version: number;
  status: "enabled" | "paused";
  reason: string;
  authorizedAt: string;
  pausedAt?: string;
}

export interface ResumeSource {
  storageKey?: string;
  sha256: string;
  size: number;
  mimeType: "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
}

export interface Profile {
  id: string;
  name: string;
  email: string;
  school: string;
  phone: string;
  graduationYear: string;
  headline: string;
  skills: string[];
  preferredTitles: string[];
  preferredLocations: string[];
  remoteOnly: boolean;
  strictLocations?: boolean;
  timeZone?: string;
  workAuthorization: string;
  facts: VerifiedFact[];
  sensitiveAnswers: Record<string, string>;
  resumeFileName?: string;
  resumeText?: string;
  resumeSource?: ResumeSource;
  onboarding?: OnboardingProfile;
  automationSettings?: AutomationSettings;
  automationAuthorization?: AutomationAuthorization;
  automationVersion: number;
  demo: boolean;
  updatedAt: string;
}

export interface Job {
  id: string;
  source: JobSource;
  sourceId: string;
  sourceLabel: string;
  company: string;
  title: string;
  location: string;
  remote: boolean | null;
  employmentType: string;
  salary?: string;
  description: string;
  requirements: string[];
  url: string;
  applyUrl: string;
  postedAt?: string;
  deadline?: string;
  active: boolean;
  discoveredAt: string;
  lastCheckedAt?: string;
  importUrl?: string;
  importCheck?: {
    status: "verified" | "closed" | "unavailable" | "manual";
    checkedAt: string;
    message?: string;
  };
}

export interface MatchAssessment {
  version: 1;
  category: MatchCategory;
  score: number;
  evidence: string[];
  gaps: string[];
  uncertainty: string[];
  evaluatedAt: string;
  model: string;
}

export interface JobFeedback {
  jobId: string;
  kind: "saved" | "dismissed";
  reason?: string;
  updatedAt: string;
  jobSnapshot?: Pick<Job, "title" | "requirements" | "location">;
}

export interface ResumeLine {
  text: string;
  factIds: string[];
}

export interface ResumeField { text: string; factIds: string[] }
export interface ResumeBullet extends ResumeField { relevance: number }
export interface ResumeEntry {
  heading: ResumeField;
  subheading: ResumeField;
  dates: ResumeField;
  location: ResumeField;
  bullets: ResumeBullet[];
}
export interface ResumeDocument {
  version: 1;
  templateVersion: "classic-1";
  education: ResumeEntry[];
  experience: ResumeEntry[];
  projects: ResumeEntry[];
  skills: ResumeField[];
  links: ResumeField[];
  omitted: Array<ResumeField & { reason: "relevance" | "page-length" }>;
  layout: "standard" | "compact";
  model: string;
  contentHash: string;
  evidenceHash: string;
}
export interface ResumeArtifact {
  inputHash: string;
  pageCount: 1;
  compiler: "tectonic-0.17.0";
  source: { storageKey: string; sha256: string; size: number };
}

export interface ScreeningAnswer {
  question: string;
  answer: string;
  factIds: string[];
  requiresUserInput: boolean;
  userProvided?: boolean;
  author?: "ai" | "human";
  confirmedAt?: string;
  aiDraft?: {
    version: 1;
    model: string;
    contentHash: string;
    evidenceHash: string;
    sentences: Array<{ text: string; kind: "fact" | "perspective"; factIds: string[] }>;
  };
}

export interface PacketFile {
  kind: "resume" | "cover-letter";
  filename: string;
  mimeType: ResumeSource["mimeType"];
  sha256: string;
  size: number;
  factIds: string[];
  storageKey?: string;
  storageBucket?: "resumes" | "application-files";
}

export interface ApplicationPacket {
  schemaVersion: 1 | 2;
  version: number;
  summary: string;
  resumeLines: ResumeLine[];
  resumeMode?: "original" | "tailored";
  originalResume?: ResumeSource & { filename: string };
  resumeDocument?: ResumeDocument;
  resumeArtifact?: ResumeArtifact;
  answers: ScreeningAnswer[];
  coverLetter?: string;
  coverLetterFactIds?: string[];
  coverLetterContext?: { title: string; company: string };
  createdAt: string;
  model: string;
  profileHash?: string;
  files?: PacketFile[]; // Absent only in the legacy, implicitly versioned format.
}

export interface FormFieldSnapshot {
  label: string;
  value: string;
  kind: string;
  required?: boolean;
  checked?: boolean;
  options?: string[];
  fileHashes?: string[];
  identifier?: string;
  valid?: boolean;
  editable?: boolean;
  autocomplete?: boolean;
}

export interface BrowserQuestion {
  id: string;
  identifier: string;
  label: string;
  kind: string;
  options: string[];
  owner: "human" | "ai";
  value: string;
}

export interface BrowserAnswerApproval {
  version: 1;
  userId: string;
  applicationId: string;
  targetUrl: string;
  sessionId: string;
  packetHash: string;
  formHash: string;
  question: BrowserQuestion;
  answer: ScreeningAnswer;
  approvedAt: string;
}

export interface FormSnapshot {
  version: 1;
  url: string;
  fields: FormFieldSnapshot[];
  attachments: string[];
  screenshotPath?: string;
  capturedAt: string;
  hash: string;
  readyToSubmit?: boolean;
  blockers?: string[];
  submitControl?: { label: string; identifier: string; action?: string; method?: string; encoding?: string };
}

export interface Approval {
  version: 1;
  id: string;
  kind: "fill" | "submit";
  userId: string;
  applicationId: string;
  targetUrl: string;
  reviewHash: string;
  createdAt: string;
}

export type BrowserProvider = "browser-use" | "browserbase";

export interface Application {
  id: string;
  userId: string;
  jobId: string;
  jobSnapshot?: Job;
  status: ApplicationStatus;
  packet?: ApplicationPacket;
  packetHash?: string;
  form?: FormSnapshot;
  approvals: Approval[];
  autonomousAuthorization?: {
    version: 1;
    userId: string;
    profileVersion: number;
    targetUrl: string;
    authorizedAt: string;
    expectedFormUrl?: string;
    expectedSubmitAction?: string;
    requiredCoverLetter?: boolean;
    profileHash?: string;
    jobHash?: string;
    postingIdentity?: string;
    packetHash?: string;
    filesHash?: string;
    formHash?: string;
  };
  browserSessionId?: string;
  browserProvider?: BrowserProvider;
  browserSessionExpiresAt?: string;
  browserCaptchaSolving?: boolean;
  browserActions?: Array<{ at: string; label: string }>;
  browserQuestionDrafts?: { formHash: string; sessionId: string; packetHash: string; answers: Record<string, ScreeningAnswer> };
  browserAnswerApprovals?: BrowserAnswerApproval[];
  browserQuestionRun?: { token: string; startedAt: string; kind: "answers" | "essays" };
  browserSessionCreatedAt?: string;
  browserConnectUrl?: string;
  browserLiveUrl?: string;
  needsCoverLetter?: boolean;
  confirmation?: string;
  submissionReceipt?: { version: 1; url: string; text: string; capturedAt: string; screenshotPath?: string };
  error?: string;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  submissionStartedAt?: string;
  submissionWorkerClaimedAt?: string;
  submissionDispatch?: { token: string; confirmedAt?: string };
  submissionMaterials?: { resumeMode: "original" | "tailored"; coverLetterMode?: CoverLetterMode; files: PacketFile[]; capturedAt: string };
  submissionAttemptedAt?: string;
  submissionVerification?: {
    version: 1;
    kind: "captcha";
    sessionId: string;
    targetUrl: string;
    attemptedAt: string;
    beforeHash: string;
    beforeHadConfirmation: boolean;
  };
  submissionVerificationCheck?: { token: string; startedAt: string };
  manualSubmissionReport?: {
    reportedAt: string;
    source: "owner";
    outcome: "unconfirmed";
    siteMessage: string;
    resolution?: { outcome: "not_accepted"; reviewedAt: string; previousForm?: FormSnapshot; previousApprovals: Approval[] };
  };
  queuedRun?: {
    id: string;
    kind: "draft" | "fill";
    draftMode?: "resume" | "essays";
    requestedAt: string;
    reason: "waiting" | "budget" | "active_run";
  };
  runToken?: string;
  runWorkerClaimedAt?: string;
  runDispatch?: { kind: "draft" | "fill"; draftMode?: "resume" | "essays"; token: string; confirmedAt?: string };
  runs?: Array<{ token: string; kind: "draft" | "fill"; projectedUsd: number; requestedAt: string }>;
  timeSavedMinutes?: number;
  transitionHistory?: Array<{ from: ApplicationStatus; to: ApplicationStatus; at: string }>;
  controlledTest?: { expiresAt: number; submissions: number; questions?: boolean; verification?: boolean; verified?: boolean };
}

export interface ActivityEvent {
  id: string;
  at: string;
  label: string;
  detail: string;
}

export interface AppState {
  profile: Profile;
  jobs: Job[];
  importedJobs: Job[];
  feedback: JobFeedback[];
  matchCache: Record<string, MatchAssessment>;
  applications: Application[];
  activity: ActivityEvent[];
  lastRefreshAt?: string;
  lastDigestAt?: string;
  estimatedSpendUsd: number;
  budgetMonth?: string;
  budgetReservations?: Record<string, number>;
  matchLabels?: Array<{ jobId: string; label: "strong" | "possible" | "uncertain"; profile: Profile; job: Job; labeledAt: string }>;
}
