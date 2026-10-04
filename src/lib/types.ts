import type { RendererDiagnosticPayload } from "@/lib/resume-renderer-diagnostics";

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
  sourceAnchorId?: string;
  status?: "accepted";
  category?: ResumeFactCategory;
  context?: string;
  grounding?: {
    version: 1;
    sourceHash: string;
    model: string;
    acceptedText: string;
    evidence: Array<{ anchorId: string; quote: string }>;
  };
}

export type ResumeFactCategory = "experience" | "project" | "education" | "skill" | "certification" | "publication" | "other";

export interface ResumeExtraction {
  id: string;
  status: "queued" | "extracting" | "checking" | "ready" | "failed" | "budget_limited";
  requestedAt: string;
  updatedAt: string;
  attempts: number;
  uploadSequence?: number;
  filename: string;
  error?: string;
  pending?: { source: ResumeSource; document?: ResumeSourceDocument };
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

export interface ResumeSourceAnchorBase {
  id: string;
  text: string;
  links?: Array<{ label: string; url: string }>;
  sectionId: string;
  sectionHeading: string;
  entryId: string;
  entryHeading: string;
  kind: "section" | "entry" | "bullet" | "paragraph";
  candidateClaim: boolean;
  editable: boolean;
  /** Physical position is known at PDF upload or after native DOCX worker preflight. */
  pageNumber?: number;
  regionId?: string;
  readingOrder?: number;
  repeatedRole?: "header" | "footer";
}

export interface ResumeSourceRegion {
  id: string;
  pageIndex: number;
  columnId: string;
  bounds: { left: number; top: number; right: number; bottom: number };
  readingOrder: number;
}

export interface ResumeSourcePageLayout {
  pageNumber: number;
  widthPt: number;
  heightPt: number;
  rotation: number;
  marginsPt?: { top: number; right: number; bottom: number; left: number };
  regions: ResumeSourceRegion[];
}

export interface ResumeSourceAnchorLayout {
  anchorId: string;
  pageNumber: number;
  regionId: string;
  readingOrder: number;
  boundsPt: { left: number; top: number; right: number; bottom: number };
}

export interface ResumeSourceLayoutMap {
  version: 1;
  pages: ResumeSourcePageLayout[];
  anchors: ResumeSourceAnchorLayout[];
}

export interface ResumePageValidation extends ResumeSourcePageLayout {
  visualOutsideEditDifference?: number;
  visualOutsideEditDifferenceAt144Dpi?: number;
  visualOutsideEditDifferenceAt300Dpi?: number;
}

export interface DocxSourceAnchor extends ResumeSourceAnchorBase {
  partName: string;
  paragraphIndex: number;
  styleHash: string;
  paragraphStyle: { alignment?: string; beforePt?: number; afterPt?: number; leftIndentPt?: number; rightIndentPt?: number; firstLineIndentPt?: number; numbered: boolean };
  font?: { family: string; sizePt: number; bold: boolean; italic: boolean; color?: string };
}

export interface DocxSourceRepresentation {
  version: 1;
  parser: "docx-ooxml-1";
  format: "docx";
  sourceHash: string;
  text: string;
  support: { status: "candidate" | "blocked"; reason?: string };
  layout: {
    columns: number;
    sectionCount: number;
    pageSizePt: { width: number; height: number };
    marginsPt: { top: number; right: number; bottom: number; left: number };
    pageCount?: number;
    fontFamilies: string[];
  };
  sections: Array<{ id: string; heading: string; anchorIds: string[] }>;
  anchors: DocxSourceAnchor[];
}

export interface PdfSourceAnchor extends ResumeSourceAnchorBase {
  pageNumber: number;
  sourceText: string;
  bulletPrefix: string;
  boundsPt: { left: number; top: number; right: number; bottom: number };
  /** PDF.js display-list show-text operator ordinal used to resolve TJ/Tj in the original stream. */
  showOperatorIndex?: number;
  /** Unicode decoded from the raw show-text operator, before PDF.js infers positioned word spaces. */
  operatorText?: string;
  operatorFingerprint: string;
  fontResourceName: string;
  font: { family: string; sizePt: number; bold: boolean; italic: boolean };
  styleHash: string;
}

export interface PdfSourceRepresentation {
  version: 1 | 2 | 3;
  parser: "pdfjs-text-1" | "pdfjs-text-2" | "pdfjs-text-3";
  format: "pdf";
  sourceHash: string;
  text: string;
  support: { status: "candidate" | "blocked"; reason?: string; diagnostic?: Extract<RendererDiagnosticPayload, { code: "pdf_source_font_unidentified" }> };
  layout: {
    columns: number;
    pageCount: number;
    pageSizePt: { width: number; height: number };
    marginsPt: { top: number; right: number; bottom: number; left: number };
    fontFamilies: string[];
    pages?: ResumeSourcePageLayout[];
  };
  sections: Array<{ id: string; heading: string; anchorIds: string[] }>;
  anchors: PdfSourceAnchor[];
}

export type ResumeSourceAnchor = DocxSourceAnchor | PdfSourceAnchor;
export type ResumeSourceDocument = DocxSourceRepresentation | PdfSourceRepresentation;

export type ProfileDetailKey = "name" | "contactEmail" | "phone" | "school" | "graduationYear" | "headline" | "location" | "linkedinUrl" | "githubUrl" | "portfolioUrl";
export interface SavedProfileAnswer {
  key: ProfileDetailKey | "languages" | "namePronunciation";
  question: string;
  value: string;
  applicationId: string;
  savedAt: string;
}

export interface Profile {
  id: string;
  name: string;
  email: string;
  school: string;
  phone: string;
  graduationYear: string;
  headline: string;
  /** Application contact email is independent of the authenticated account email. */
  contactEmail?: string;
  location?: string;
  linkedinUrl?: string;
  githubUrl?: string;
  portfolioUrl?: string;
  detailSources?: Partial<Record<ProfileDetailKey, { source: "user" | "resume"; value: string; sourceHash?: string; anchorId?: string; quote?: string }>>;
  resumeDetailsVersion?: number;
  resumeSkills?: { sourceHash: string; values: string[] };
  skillsEdited?: boolean;
  savedAnswers?: SavedProfileAnswer[];
  skills: string[];
  preferredTitles: string[];
  preferredLocations: string[];
  remoteOnly: boolean;
  strictLocations?: boolean;
  searchPreferencesConfirmedAt?: string;
  timeZone?: string;
  workAuthorization: string;
  facts: VerifiedFact[];
  sensitiveAnswers: Record<string, string>;
  resumeFileName?: string;
  resumeText?: string;
  resumeSource?: ResumeSource;
  resumeSourceDocument?: ResumeSourceDocument;
  resumeExtraction?: ResumeExtraction;
  resumeUploadSequence?: number;
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
  posting?: Job;
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
export type ResumeClaimOutcome = "supported" | "unsupported" | "uncertain" | "contradiction";
export interface ResumeDraftAttempts {
  writerAttempts: number;
  checkerAttempts: number;
  repairAttempts: number;
}
export interface ResumeGroundingFinding {
  claimId: string;
  affectedText: string;
  outcome: ResumeClaimOutcome;
  reason: string;
  evidenceFactIds: string[];
  requiredInformation?: string;
}
export interface ResumeGroundingSnapshot extends ResumeDraftAttempts {
  version: 1;
  findings: ResumeGroundingFinding[];
}
export interface ResumeDraftDiagnostics extends ResumeDraftAttempts {
  version: 1;
  outcome: "grounded" | "needs_information" | "technical_failure";
  findings: ResumeGroundingFinding[];
  requiredInformation: string[];
  technicalFailure?: "provider" | "malformed_response" | "deadline" | "renderer" | "other";
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
  grounding?: ResumeGroundingSnapshot;
  contentHash: string;
  evidenceHash: string;
}
export interface ResumeSourceEdit {
  anchorId: string;
  text: string;
  factIds: string[];
}
export interface ResumeSourceClaim {
  anchorId: string;
  text: string;
  factIds: string[];
}
export interface ResumeSourcePlan {
  version: 1;
  /** New plans re-evaluate substantive source content instead of trusting older parser flags. */
  evidencePolicyVersion?: 2;
  jobHashPolicyVersion?: 2;
  format: "docx" | "pdf";
  sourceHash: string;
  representationVersion: 1 | 2 | 3;
  profileHash: string;
  factsHash: string;
  settingsHash: string;
  jobHash: string;
  /** Bound to the untouched baseline's actual page/region map for representation v2. */
  layoutHash?: string;
  sourceLayout?: ResumeSourceLayoutMap;
  claims: ResumeSourceClaim[];
  edits: ResumeSourceEdit[];
  grounding: ResumeGroundingSnapshot;
  model: string;
}
export interface LatexResumeArtifact {
  format?: "latex";
  inputHash: string;
  pageCount: 1;
  compiler: "tectonic-0.17.0";
  source: { storageKey: string; sha256: string; size: number };
}
export interface DocxResumeArtifact {
  format: "docx";
  inputHash: string;
  pageCount: number;
  renderer: string;
  rendererVersion: string;
  sourceHash: string;
  representationVersion: 1 | 2;
  profileHash: string;
  factsHash: string;
  settingsHash: string;
  jobHash: string;
  layoutPolicy: "docx-single-column-one-page-v1" | "docx-page-regions-v2";
  layoutValidation: { outcome: "passed"; pageWidthPt: number; pageHeightPt: number; pages?: ResumePageValidation[]; layoutHash?: string; unchangedAnchorTolerancePt: 1; pageSizeTolerancePt: 0.5; visualOutsideEditTolerance: 0.001; visualOutsideEditDifference: number; baselinePdfHash: string };
  baseline: { storageKey: string; sha256: string; size: number; mimeType: "application/pdf" };
  source: { storageKey: string; sha256: string; size: number; mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
}
export interface PdfResumeArtifact {
  format: "pdf";
  inputHash: string;
  pageCount: number;
  renderer: "apache-pdfbox";
  rendererVersion: string;
  javaVersion: string;
  runtimeArchitecture: string;
  sourceHash: string;
  representationVersion: 1 | 2 | 3;
  profileHash: string;
  factsHash: string;
  settingsHash: string;
  jobHash: string;
  layoutPolicy: "pdf-single-column-one-page-v1" | "pdf-page-regions-v2";
  layoutValidation: {
    outcome: "passed";
    pageWidthPt: number;
    pageHeightPt: number;
    pages?: ResumePageValidation[];
    layoutHash?: string;
    unchangedAnchorTolerancePt: 0.5;
    pageSizeTolerancePt: 0.5;
    visualMaskPaddingPt: 1.5 | 2.5;
    visualOutsideEditTolerance: 0;
    visualOutsideEditDifferenceAt144Dpi: 0;
    visualOutsideEditDifferenceAt300Dpi: 0;
    baselinePdfHash: string;
  };
  baseline: { storageKey: string; sha256: string; size: number; mimeType: "application/pdf" };
  source: { storageKey: string; sha256: string; size: number; mimeType: "application/pdf" };
}
export type ResumeArtifact = LatexResumeArtifact | DocxResumeArtifact | PdfResumeArtifact;

export interface AutomaticEssayAuthorization {
  version: 1;
  profileVersion: number;
  profileHash: string;
  jobHash: string;
  targetUrl: string;
  questionHash: string;
  control?: { identifier: string; kind: string; label: string; formStructureHash: string; observedFormHash: string; sessionId: string };
  contentHash: string;
  evidenceHash: string;
}

export interface ScreeningAnswer {
  autonomousEssayAuthorization?: AutomaticEssayAuthorization;
  question: string;
  answer: string;
  factIds: string[];
  requiresUserInput: boolean;
  userProvided?: boolean;
  author?: "ai" | "human";
  confirmedAt?: string;
  userRevision?: {
    version: 1;
    contentHash: string;
    originalAnswer: string;
    originalFactIds: string[];
    originalDraftHash: string;
  };
  aiDraft?: {
    mode?: "general-truthful";
    preferenceSources?: true;
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
  schemaVersion: 1 | 2 | 3;
  version: number;
  summary: string;
  resumeLines: ResumeLine[];
  resumeMode?: "original" | "tailored";
  originalResume?: ResumeSource & { filename: string };
  resumeDocument?: ResumeDocument;
  resumeSourcePlan?: ResumeSourcePlan;
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
  /** Native radio value, retained separately from the user-facing option label. */
  optionValue?: string;
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

/** An applicant-confirmed value bound to one observed employer control. */
export interface AutonomousHumanAnswer {
  version: 1;
  userId: string;
  applicationId: string;
  targetUrl: string;
  profileHash: string;
  formHash: string;
  question: {
    identifier: string;
    label: string;
    kind: string;
    options: string[];
    /** Ordered native values for radio options; labels remain user-facing. */
    optionValues?: string[];
  };
  value: string;
  confirmedAt: string;
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

export type ImportedCompatibilityStatus = "reachable" | "blocked" | "uncertain";

export interface ImportedCompatibilityRecord {
  version: 1;
  ownerId: string;
  applicationId: string;
  jobId: string;
  canonicalPostingUrl: string;
  postingUrl: string;
  observedUrl: string;
  observedOrigin: string;
  formUrl?: string;
  formHash?: string;
  submitControl?: FormSnapshot["submitControl"];
  contextHash: string;
  postingEvidence: {
    postingUrl?: string;
    postingIdentityHash?: string;
    title?: string;
    company?: string;
    markers: string[];
    identityHash: string;
  };
  observedContext?: {
    title?: string;
    company?: string;
    location?: string;
    text: string;
  };
  checkedAt: string;
  status: ImportedCompatibilityStatus;
  blocker?: string;
  controlled?: boolean;
}

export type ImportedApplicationOutcomeKind = "reachable" | "attempted" | "blocked" | "confirmed" | "uncertain";

export interface ImportedApplicationOutcome {
  version: 1;
  kind: ImportedApplicationOutcomeKind;
  at: string;
  evidence?: string;
  synthetic?: boolean;
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

export type ApplicationBlockerReason =
  | "missing_answer"
  | "login"
  | "verification"
  | "disabled_material"
  | "unfamiliar_control"
  | "upload_failure"
  | "navigation"
  | "resource_hold"
  | "other";

export type ApplicationBlockerProgress = "blocked" | "resolved" | "resuming" | "expired";

export interface ApplicationBlocker {
  id: string;
  applicationId: string;
  userId: string;
  reason: ApplicationBlockerReason;
  message: string;
  progress: ApplicationBlockerProgress;
  createdAt: string;
  updatedAt: string;
  context?: {
    formHash?: string;
    packetHash?: string;
    targetUrl?: string;
    sessionId?: string;
    fieldIdentifiers?: string[];
    observedQuestion?: {
      identifier: string;
      label: string;
      kind: string;
      options: string[];
      value: string;
    };
  };
  resolvedAt?: string;
  reviewOnly?: boolean;
}

export interface Application {
  id: string;
  userId: string;
  jobId: string;
  jobSnapshot?: Job;
  status: ApplicationStatus;
  packet?: ApplicationPacket;
  packetHash?: string;
  /** Frozen reusable personal values; subsequent learning affects future applications. */
  profileMemory?: Record<string, string>;
  profileMemoryVersion?: number;
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
  browserReleasePending?: {
    sessionId: string;
    provider?: BrowserProvider;
    requestedAt: string;
    attempts: number;
    lastError?: string;
    budgetReservationId?: string;
    budgetMonth?: string;
  };
  browserConnectUrl?: string;
  browserLiveUrl?: string;
  needsCoverLetter?: boolean;
  confirmation?: string;
  submissionReceipt?: { version: 1; url: string; text: string; capturedAt: string; screenshotPath?: string };
  error?: string;
  resumeDraftDiagnostics?: ResumeDraftDiagnostics;
  blockers?: ApplicationBlocker[];
  /** Separate from packet answers and essay authorization. */
  autonomousHumanAnswers?: AutonomousHumanAnswer[];
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
  budgetReservation?: {
    reservationId: string;
    projectedUsd: number;
    month: string;
    ownerId: string;
    applicationId: string;
    status: "release_pending" | "released";
  };
  runToken?: string;
  runWorkerClaimedAt?: string;
  runDispatch?: { kind: "draft" | "fill"; draftMode?: "resume" | "essays"; token: string; confirmedAt?: string };
  runs?: Array<{ token: string; kind: "draft" | "fill"; projectedUsd: number; requestedAt: string }>;
  timeSavedMinutes?: number;
  transitionHistory?: Array<{ from: ApplicationStatus; to: ApplicationStatus; at: string }>;
  controlledTest?: { expiresAt: number; submissions: number; questions?: boolean; factualOnly?: boolean; essayOnly?: boolean; verification?: boolean; verified?: boolean };
  importedCompatibility?: ImportedCompatibilityRecord;
  importedOutcome?: ImportedApplicationOutcome;
  importedPreflight?: {
    token: string;
    startedAt: string;
    sessionId?: string;
    provider?: BrowserProvider;
    budgetReservationId?: string;
    budgetMonth?: string;
    allocationUncertain?: boolean;
    budgetReleasePending?: {
      kind: "unused";
      reservationId: string;
      month: string;
      attempts: number;
      lastError?: string;
    };
  };
  /** Immutable pilot denominator row and append-only evidence for this app. */
  pilotAttempt?: PilotAttempt;
}

export type PilotCohort = "internship" | "new-grad" | "unclassified";
export type PilotOrigin = "real" | "controlled" | "unknown";
export type PilotActorKind = "owner" | "service" | "operator";

export interface PilotActor {
  kind: PilotActorKind;
  userId?: string;
}

export interface PilotConsentEpisode {
  version: 1;
  id: string;
  ownerId: string;
  consentVersion: string;
  consentTextHash: string;
  consentedAt: string;
  onboardingCompletedAt: string;
  automationVersion: number;
  automationAuthorization?: AutomationAuthorization;
  profileHash: string;
  profileSnapshot: PilotProfileSnapshot;
  withdrawnAt?: string;
}

export interface PilotProfileSnapshot {
  name: string;
  school: string;
  graduationYear: string;
  headline: string;
  workAuthorization: string;
  facts: Array<Pick<VerifiedFact, "id" | "text" | "verified" | "source">>;
  skills: string[];
  preferredTitles: string[];
  preferredLocations: string[];
  questionnaire: OnboardingQuestionnaire;
  resumeHash?: string;
  factsTruncated?: boolean;
}

export interface PilotPostingSnapshot {
  jobId: string;
  source: JobSource;
  sourceId: string;
  canonicalUrl: string;
  targetIdentityHash: string;
  title: string;
  company: string;
  employmentType: string;
  description: string;
  evidenceHash: string;
}

export type PilotEventKind =
  | "initiated"
  | "queued"
  | "hold"
  | "intervention-requested"
  | "owner-action"
  | "submission-attempted"
  | "receipt-confirmed"
  | "outcome-uncertain"
  | "failed"
  | "cancelled"
  | "controlled-excluded"
  | "service-update";

export interface PilotEvent {
  version: 1;
  id: string;
  kind: PilotEventKind;
  at: string;
  actor: PilotActor;
  blockerId?: string;
  blockerReason?: ApplicationBlockerReason;
  outcome?: "confirmed" | "uncertain" | "failed" | "cancelled";
  detail?: string;
  evidenceHash?: string;
}

export interface PilotCostEvidence {
  version: 1;
  status: "unknown" | "incomplete" | "estimated" | "measured";
  projectedUsd: number;
  estimatedUsd?: number;
  measuredUsd?: number;
  reconciledUsd?: number;
  evidenceIds: string[];
  estimatedEvidenceIds?: string[];
  measuredEvidenceIds?: string[];
  reconciledEvidenceIds?: string[];
  rateVersions?: string[];
  capturedAt?: string;
}

export interface PilotReview {
  version: 1;
  id: string;
  attemptId: string;
  reviewerId: string;
  rubricVersion: string;
  suitability: "pass" | "fail" | "insufficient";
  factualAccuracy: "pass" | "fail" | "insufficient" | "not-applicable";
  notes: string;
  evidenceDigest: string;
  createdAt: string;
  supersedesReviewId?: string;
}

export interface PilotAttempt {
  version: 1;
  id: string;
  applicationId: string;
  ownerId: string;
  consentEpisodeId: string;
  consentVersion: string;
  consentedAt: string;
  initiatedAt: string;
  onboardingCompletedAt: string;
  automationVersion: number;
  automationAuthorization?: AutomationAuthorization;
  profileHash: string;
  profileSnapshot: PilotProfileSnapshot;
  postingSnapshot: PilotPostingSnapshot;
  origin: PilotOrigin;
  cohort: PilotCohort;
  cohortEvidence?: string;
  cohortClassifierVersion: string;
  costEvidence: PilotCostEvidence;
  events: PilotEvent[];
  reviews: PilotReview[];
  /** Immutable profile/facts snapshot captured with the durable pre-click marker. */
  submissionProfileSnapshot?: PilotProfileSnapshot;
  submissionEvidenceHash?: string;
  /** Report-only provenance for a late controlled exclusion. */
  controlledExclusion?: { eventIds: string[]; latestAt: string; afterCutoff: boolean };
  /** Derived only on report snapshots so an operator can submit a current review. */
  currentEvidenceDigest?: string;
}

export interface PilotState {
  version: 1;
  episodes: PilotConsentEpisode[];
  activeEpisodeId?: string;
  events: PilotEvent[];
}

export type PilotGateStatus = "insufficient-real-evidence" | "review-incomplete" | "failed" | "passed";

export interface PilotReportSnapshot {
  version: 1;
  id: string;
  createdAt: string;
  createdBy: PilotActor;
  cutoffAt: string;
  gateVersion: string;
  status: PilotGateStatus;
  reasons: string[];
  totals: {
    realInitiated: number;
    confirmed: number;
    unattendedConfirmed: number;
    interventions: number;
    controlled: number;
    unknown: number;
    unknownCosts: number;
  };
  cohorts: Record<PilotCohort, { initiated: number; confirmed: number }>;
  sourceManifest: {
    stateOwnerIds: string[];
    stateReadAt: string;
    complete: boolean;
    stateRows: Array<{ ownerId: string; revision?: number; readAt: string; eventPrefixes: Array<{ attemptId: string; eventIds: string[]; reviewIds: string[] }> }>;
    controlledExclusions: Array<{ attemptId: string; eventIds: string[]; latestAt: string }>;
    cost?: {
      scope: "owner" | "service";
      period?: string;
      evidenceIds: string[];
      unknownComponents: number;
      complete: boolean;
      error?: string;
      capturedAt: string;
    };
  };
  attempts: PilotAttempt[];
}

export interface ActivityEvent {
  id: string;
  at: string;
  label: string;
  detail: string;
}

export type DiscoverySourceStatus = "available" | "unavailable";
export type DiscoveryEventKind = "arrived" | "matched" | "queued" | "unavailable";

export interface DiscoverySource {
  source: string;
  status: DiscoverySourceStatus;
  checkedAt: string;
  error?: string;
}

export interface DiscoveryEvent {
  id: string;
  kind: DiscoveryEventKind;
  at: string;
  jobId?: string;
  source?: string;
  arrivalAt?: string;
  delayMs?: number;
  detail: string;
}

export interface DiscoveryState {
  lastRefreshAt?: string;
  sources: DiscoverySource[];
  events: DiscoveryEvent[];
  pendingMatches?: number;
  matchContinuation?: {
    token: string;
    profileUpdatedAt: string;
    requestedAt: string;
  };
}

export interface PersonalSearchState {
  status: "queued" | "searching" | "complete" | "failed" | "budget_limited";
  requestId: string;
  profileKey: string;
  requestedAt: string;
  completedAt?: string;
  resultsKey?: string;
  jobs: Job[];
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
  discovery?: DiscoveryState;
  personalSearch?: PersonalSearchState;
  pilot?: PilotState;
}
