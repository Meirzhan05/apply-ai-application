"use client";
import { AutonomousApplicationStatus, autonomousOutcome, importedPreflightHandoff, importedPreflightRecheckAvailable } from "@/components/autonomous-application-status";
import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { ResumeReview } from "@/app/resume-review";
import { OriginalResumeInspection } from "@/components/original-resume-inspection";
import { hasSourcePreservingResume, ResumeComparison, ResumeSourceSupportNotice } from "@/components/resume-comparison";
import { LiveBrowser } from "@/app/live-browser";
import { BrowserQuestionsDialog } from "@/app/browser-questions-dialog";
import { browserQuestions, browserTakeoverReasons, hasUnreadableQuestionLabels } from "@/lib/browser-questions";
import { useRouter } from "next/navigation";
import { browserSupabase } from "@/lib/supabase-browser";
import { compareRankedJobs } from "@/lib/ranking";
import { answerOwner, answerNeedsAction } from "@/lib/answer-responsibility";
import { onboardingMissingLabel } from "@/lib/onboarding";
import { canReopenManualAttempt, employerSubmissionBlock, formFieldValue } from "@/lib/form-review";
import {
  ArrowRight,
  Bookmark,
  BriefcaseBusiness,
  Check,
  CircleHelp,
  ClipboardList,
  FileText,
  LoaderCircle,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  UserRound,
  X,
} from "lucide-react";
import type {
  AppState,
  Application,
  MatchAssessment,
  Profile,
  ScreeningAnswer,
} from "@/lib/types";

type ViewState = AppState & {
  matches: { jobId: string; assessment: MatchAssessment }[];
  onboarding: { complete: boolean; missing: string[]; confirmedFactCount: number };
  automation: {
    enabled: boolean;
    paused: boolean;
    version: number;
    settings: NonNullable<Profile["automationSettings"]>;
  };
};
type Section = "matches" | "applications" | "profile" | "settings";
type Filter = "all" | "strong" | "possible" | "uncertain" | "saved";

export default function Dashboard() {
  const router = useRouter();
  const [data, setData] = useState<ViewState | null>(null);
  const [section, setSection] = useState<Section>("matches");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [confirmedUnacceptedId, setConfirmedUnacceptedId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [dismissJobId, setDismissJobId] = useState<string | null>(null);
  const [dismissReason, setDismissReason] = useState("Wrong role");
  const [importFields, setImportFields] = useState({
    url: "",
    company: "",
    title: "",
    location: "",
  });
  const [profileDraft, setProfileDraft] = useState<Profile | null>(null);
  const [factText, setFactText] = useState("");
  const [answerDraft, setAnswerDraft] = useState<ScreeningAnswer[]>([]);
  const [blockerAnswers, setBlockerAnswers] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    const response = await fetch("/api/state", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok)
      throw new Error(body.error || "Could not load workspace.");
    setData(body);
    return body as ViewState;
  }, []);
  useEffect(() => {
    let live = true;
    fetch("/api/state", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok)
          throw new Error(body.error || "Could not load workspace.");
        return body as ViewState;
      })
      .then((body) => {
        if (live) {
          setData(body);
          setProfileDraft({ ...structuredClone(body.profile), timeZone: body.profile.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone });
        }
      })
      .catch((err) => {
        if (live) setError(err.message);
      });
    const timer = setInterval(() => {
      if (live) reload().catch(() => undefined);
    }, 15000);
    const events = new EventSource("/api/status");
    events.addEventListener("state", (event) => { if (live) setData(JSON.parse((event as MessageEvent).data)); });
    return () => {
      live = false;
      clearInterval(timer);
      events.close();
    };
  }, [reload]);
  const act = async (action: string, payload: Record<string, unknown> = {}) => {
    setBusy(action);
    setError("");
    try {
      const response = await fetch("/api/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, payload }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Action failed.");
      const next = await reload();
      if (["profile", "editPacket"].includes(action)) setProfileDraft(structuredClone(next.profile));
      if (["editPacket", "confirmEssay", "draft"].includes(action)) setAnswerDraft([]);
      return next;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed.");
      return null;
    } finally {
      setBusy("");
    }
  };
  const jobs = data?.jobs ?? [];
  const matches = useMemo(
    () =>
      new Map(
        data?.matches.map((entry) => [entry.jobId, entry.assessment]) ?? [],
      ),
    [data],
  );
  const feedback = useMemo(
    () => new Map(data?.feedback.map((item) => [item.jobId, item]) ?? []),
    [data],
  );
  const applications = data?.applications ?? [];
  const filtered = jobs.filter(
    (job) =>
      job.active &&
      feedback.get(job.id)?.kind !== "dismissed" &&
      (filter === "all" ||
        (filter === "saved" && feedback.get(job.id)?.kind === "saved") ||
        matches.get(job.id)?.category === filter),
  );
  filtered.sort((a, b) => compareRankedJobs(a, b, matches, data?.feedback ?? [], jobs));
  const activeApp =
    applications.find((app) => app.id === selected) ?? applications[0];
  const appJob = jobs.find((job) => job.id === activeApp?.jobId);
  const activeAppIsAutomatic = Boolean(activeApp?.autonomousAuthorization || activeApp?.importedOutcome);
  const hasAutomaticApplications = applications.some((app) => app.autonomousAuthorization || app.importedOutcome);
  const employerBlock = activeApp ? employerSubmissionBlock(activeApp) : undefined;
  const incompleteFacts = (data?.profile.facts ?? []).filter(
    (fact) => !fact.verified,
  ).length;
  const needsAction = applications.filter((app) =>
    ["draft_review", "final_review", "needs_user_action", "awaiting_verification", "uncertain"].includes(
      app.status,
    ),
  );
  const discoveryEvents = (data?.discovery?.events ?? [])
    .filter((event) => event.kind === "arrived" || event.kind === "matched" || event.kind === "queued")
    .slice(-3)
    .reverse();
  const blockers = applications.flatMap((app) => (app.blockers ?? [])
    .filter((blocker) => (blocker.progress === "blocked" || blocker.progress === "resuming" || (blocker.reviewOnly && blocker.progress === "expired")) && blocker.userId === data?.profile.id)
    .map((blocker) => ({ blocker, app })));

  if (!data)
    return (
      <div className="loading">
        <div className="brand">
          Apply<span>.</span>
        </div>
        {error ? (
          <div className="errorbox">
            {error} <a href="/login">Sign in</a>
            <button
              className="signout"
              disabled={busy === "signout"}
              onClick={async () => {
                setBusy("signout");
                try {
                  const { error: signOutError } = await browserSupabase().auth.signOut({ scope: "local" });
                  if (signOutError) throw signOutError;
                  router.replace("/login");
                  router.refresh();
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Could not sign out. Please try again.");
                  setBusy("");
                }
              }}
            >
              {busy === "signout" ? "Signing out…" : "Use another account"}
            </button>
          </div>
        ) : (
          <p>Opening your workspace…</p>
        )}
      </div>
    );

  const applicationMaterials = !activeAppIsAutomatic && activeApp?.packet && appJob &&
                      [
                        "draft_review",
                        "authorized_to_fill",
                        "filling",
                        "needs_user_action",
                        "final_review",
                        "approved_to_submit",
                        "submitting",
                        "submitted",
                        "uncertain",
                      ].includes(activeApp.status) && (
                        <div className="step-card">
                          <div className="card-title">
                            <FileText size={20} />
                            <h3>Application packet</h3>
                            <span>Version {activeApp.packet.version}</span>
                          </div>
                          {activeApp.packet.resumeMode === "original" ? (
                            <OriginalResumeInspection packet={activeApp.packet} applicationId={activeApp.id} />
                          ) : hasSourcePreservingResume(activeApp.packet) ? (
                            <ResumeComparison
                              applicationId={activeApp.id}
                              profile={data.profile}
                              packet={activeApp.packet}
                              diagnostics={activeApp.resumeDraftDiagnostics}
                              latestError={activeApp.resumeDraftDiagnostics ? activeApp.error : undefined}
                              jobFingerprint={JSON.stringify(appJob)}
                              onReviewProfile={() => setSection("profile")}
                              onRebuildResume={activeApp.status === "draft_review" ? () => act("draft", { applicationId: activeApp.id, draftMode: "resume" }) : undefined}
                              rebuildDisabled={Boolean(busy) || Boolean(activeApp.queuedRun)}
                            />
                          ) : activeApp.packet.schemaVersion === 2 && activeApp.packet.resumeDocument ? (
                            <ResumeReview profile={data.profile} document={activeApp.packet.resumeDocument} applicationId={activeApp.id} pdfHash={activeApp.packet.files?.find((file) => file.kind === "resume")?.sha256 ?? ""} />
                          ) : <>
                          <p className="muted">
                            Each resume line comes from a confirmed profile
                            fact.
                          </p>
                          <div className="resume-preview">
                            <strong>{data.profile.name}</strong>
                            <small>
                              {data.profile.email}
                              {data.profile.school
                                ? ` · ${data.profile.school}`
                                : ""}
                            </small>
                            <h4>Selected experience & projects</h4>
                            {activeApp.packet.resumeLines.map((line, i) => (
                              <p key={i}>
                                • {line.text}{" "}
                                <small>
                                  Verified fact: {line.factIds.join(", ")}
                                </small>
                              </p>
                            ))}
                          </div>
                          <a
                            className="text-button"
                            href={`/api/applications/${activeApp.id}/files/resume`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open tailored resume PDF ↗
                          </a>
                          </>}
                          {activeApp.packet.coverLetter && (
                            <div className="cover-letter">
                              <h4>Cover letter</h4>
                              <pre>{activeApp.packet.coverLetter}</pre>
                              <a
                                className="text-button"
                                href={`/api/applications/${activeApp.id}/files/cover-letter`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Open cover letter PDF ↗
                              </a>
                            </div>
                          )}
                          <div className="answers">
                            <h4>Screening answers</h4>
                            <p className="muted">AI writes essays; you confirm them. Personal and consent answers come from you.</p>
                            {activeApp.packet.answers.map((answer, i) => (
                              <div className="screening-answer" key={i}>
                                <label htmlFor={`screening-${activeApp.id}-${i}`}>{answer.question}</label>
                                <textarea
                                  id={`screening-${activeApp.id}-${i}`}
                                  disabled={activeApp.status !== "draft_review" || Boolean(activeApp.queuedRun)}
                                  readOnly={answerOwner(answer.question) === "ai"}
                                  value={answerOwner(answer.question) === "ai" ? answer.answer : (answerDraft[i] ?? answer).answer}
                                  onChange={(event) => {
                                    if (answerOwner(answer.question) === "ai") return;
                                    const draft = [
                                      ...(answerDraft.length
                                        ? answerDraft
                                        : activeApp.packet!.answers),
                                    ];
                                    draft[i] = {
                                      ...draft[i],
                                      answer: event.target.value,
                                      userProvided: true,
                                      requiresUserInput: false,
                                    };
                                    setAnswerDraft(draft);
                                  }}
                                />
                                <small>
                                  {answerOwner(answer.question) === "ai" ? (answer.aiDraft ? (answer.confirmedAt ? "AI essay · confirmed by you" : "AI essay · your confirmation needed") : "AI draft needed · use Write essays with AI below") : answer.requiresUserInput &&
                                  !answer.userProvided
                                    ? "Human-only · your answer needed"
                                    : answer.userProvided
                                      ? "Your own answer"
                                      : "From your confirmed profile"}
                                </small>
                                {answerOwner(answer.question) === "ai" && answer.aiDraft && (
                                  <details><summary>Facts used in this essay</summary><ul>{answer.factIds.map((id) => <li key={id}>{data.profile.facts.find((fact) => fact.id === id)?.text ?? "Source fact unavailable"}</li>)}</ul></details>
                                )}
                                {answerOwner(answer.question) === "ai" && answer.aiDraft && !answer.confirmedAt && activeApp.status === "draft_review" && (
                                  <button className="outline-action" disabled={Boolean(busy) || Boolean(activeApp.queuedRun) || (answerDraft.length > 0 && JSON.stringify(answerDraft) !== JSON.stringify(activeApp.packet!.answers))}
                                    onClick={() => act("confirmEssay", { applicationId: activeApp.id, packetHash: activeApp.packetHash, answerIndex: i, answerHash: answer.aiDraft!.contentHash })}>Confirm essay</button>
                                )}
                              </div>
                            ))}
                          </div>
                          {activeApp.status === "draft_review" && (
                            <div className="action-row">
                              <button
                                className="outline-action"
                                disabled={Boolean(busy) || Boolean(activeApp.queuedRun)}
                                onClick={() =>
                                  act("editPacket", {
                                    applicationId: activeApp.id,
                                    answers: answerDraft.length
                                      ? answerDraft
                                      : activeApp.packet!.answers,
                                  })
                                }
                              >
                                Save my answers
                              </button>
                              <button className="outline-action" disabled={Boolean(busy) || Boolean(activeApp.queuedRun) || (answerDraft.length > 0 && JSON.stringify(answerDraft) !== JSON.stringify(activeApp.packet.answers))}
                                onClick={() => act("draft", { applicationId: activeApp.id, draftMode: "essays" })}>Write essays with AI</button>
                              <button className="outline-action" disabled={Boolean(busy) || Boolean(activeApp.queuedRun) || (answerDraft.length > 0 && JSON.stringify(answerDraft) !== JSON.stringify(activeApp.packet.answers))}
                                onClick={() => act("draft", { applicationId: activeApp.id, draftMode: "resume" })}>Rebuild resume</button>
                              <p className="target-url">
                                Approved destination:{" "}
                                <a
                                  href={appJob.applyUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {new URL(appJob.applyUrl).hostname} ↗
                                </a>
                              </p>
                              <button
                                className="dark-button"
                                disabled={
                                  Boolean(busy) || Boolean(activeApp.queuedRun) ||
                                  (answerDraft.length > 0 && JSON.stringify(answerDraft) !== JSON.stringify(activeApp.packet.answers)) ||
                                  activeApp.packet.answers.some(answerNeedsAction)
                                }
                                onClick={() =>
                                  act("approveFill", {
                                    applicationId: activeApp.id,
                                    packetHash: activeApp.packetHash,
                                  })
                                }
                              >
                                Approve packet for form fill
                              </button>
                            </div>
                          )}
                        </div>
                      );

  const nav: {
    key: Section;
    label: string;
    icon: typeof Search;
    count?: number;
  }[] = [
    { key: "matches", label: "Matches", icon: Search },
    {
      key: "applications",
      label: "Applications",
      icon: ClipboardList,
      count: needsAction.length,
    },
    { key: "profile", label: "Profile", icon: UserRound },
    { key: "settings", label: "Search settings", icon: Settings2 },
  ];
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="identity">
          <div className="brand">
            Apply<span>.</span>
          </div>
          <p>
            Real opportunities.
            <br />A brighter next step.
          </p>
        </div>
        <nav aria-label="Main navigation">
          {nav.map(({ key, label, icon: Icon, count }) => (
            <button
              key={key}
              aria-label={label}
              className={`navitem ${section === key ? "active" : ""}`}
              onClick={() => setSection(key)}
            >
              <Icon size={21} strokeWidth={1.8} />
              {label}
              {Boolean(count) && <b>{count}</b>}
            </button>
          ))}
        </nav>
        <div style={{ display: "flex", gap: 18, padding: "16px 24px" }}><a href="/usage" style={{ color: "var(--forest)", textUnderlineOffset: "4px" }}>AI usage</a><a href="/pilot" style={{ color: "var(--forest)", textUnderlineOffset: "4px" }}>Autonomy pilot</a></div>
        <div className="sidebar-foot">
          <div className="foot-icon">
            <Sparkles size={19} />
          </div>
          <div>
            <strong>Built for what’s next.</strong>
            <small>From campus to career and beyond.</small>
            {!data.profile.demo && (
              <button
                className="signout"
                onClick={async () => {
                  await browserSupabase().auth.signOut();
                  router.replace("/login");
                }}
              >
                Sign out
              </button>
            )}
          </div>
        </div>
      </aside>
      <div className="body-area">
        <header className="topbar">
          <div className="top-context">
            AI assisted job search <span> / </span>{" "}
            {section === "matches"
              ? "Opportunities"
              : section === "applications"
                ? "Applications"
                : section === "profile"
                  ? "Profile"
                  : "Preferences"}
          </div>
          <div className="greeting">
            <span>
              <strong>
                Good{" "}
                {new Date().getHours() < 12
                  ? "morning"
                  : new Date().getHours() < 17
                    ? "afternoon"
                    : "evening"}
                , {data.profile.name.split(" ")[0] || "there"}
              </strong>
              <small>
                {data.profile.school || "Your career workspace"}
                {data.profile.graduationYear
                  ? ` · Class of ${data.profile.graduationYear}`
                  : ""}
              </small>
            </span>
            <div className="avatar">
              {(data.profile.name || "A")
                .split(" ")
                .map((part) => part[0])
                .slice(0, 2)
                .join("")
                .toUpperCase()}
            </div>
          </div>
        </header>
        {error && (
          <div className="inline-error" role="alert">
            <CircleHelp size={18} />
            {error}
            <button onClick={() => setError("")} aria-label="Dismiss error">
              <X size={17} />
            </button>
          </div>
        )}
        {section === "matches" && (
          <div className="content-grid">
            <main className="main-panel">
              <div className="page-heading">
                <div>
                  <p className="eyebrow">YOUR SEARCH, IN MOTION</p>
                  <h1>Your next opportunities</h1>
                  <p>
                    {jobs.length} roles in your catalog ·{" "}
                    {data.lastRefreshAt
                      ? `updated ${relative(data.lastRefreshAt)}`
                      : "ready for your review"}
                  </p>
                </div>
                <button
                  className="outline-action"
                  onClick={() => setImportOpen(true)}
                >
                  + Import a job link
                </button>
              </div>
              <div className={`autonomy-strip ${data.automation.enabled ? "enabled" : data.automation.paused ? "paused" : "inactive"}`}>
                <div>
                  <strong>{data.automation.enabled ? "Applications can run automatically" : data.automation.paused ? "Automation is paused" : "Finish setup before enabling automation"}</strong>
                  <p>{data.onboarding.complete ? "Your confirmed facts and saved settings are ready." : `Onboarding is incomplete: ${data.onboarding.missing.map(onboardingMissingLabel).join(", ")}.`}</p>
                </div>
                <button className="text-button" onClick={() => setSection("settings")}>Review settings <ArrowRight size={15} /></button>
              </div>
              {data.discovery && (
                <section className="discovery-pulse" aria-label="Discovery freshness">
                  <div className="discovery-pulse-head">
                    <div>
                      <strong>Public opportunity monitor</strong>
                      <p>{data.discovery.lastRefreshAt ? `Last checked ${relative(data.discovery.lastRefreshAt)}.` : "Waiting for the first public catalog check."}</p>
                    </div>
                    <span>{data.discovery.sources.filter((source) => source.status === "available").length}/{data.discovery.sources.length || 0} sources available</span>
                  </div>
                  <div className="discovery-sources">
                    {data.discovery.sources.map((source) => (
                      <span key={source.source} className={source.status === "available" ? "available" : "unavailable"}>
                        <i aria-hidden="true" />
                        {source.source.replace(/:/g, " · ").replace(/[-_]/g, " ")}
                        {source.status === "unavailable" ? " unavailable" : " checked"}
                      </span>
                    ))}
                  </div>
                  {data.discovery.pendingMatches ? <p className="discovery-backlog">{data.discovery.pendingMatches} roles waiting for the next matching pass.</p> : null}
                  {discoveryEvents.length ? (
                    <ul className="discovery-events">
                      {discoveryEvents.map((event) => (
                        <li key={event.id}>
                          <span>{event.kind === "arrived" ? "New listing" : event.kind === "matched" ? "Match assessed" : "Application queued"}</span>
                          <small>{event.delayMs != null ? `${formatDelay(event.delayMs)} after discovery` : relative(event.at)}</small>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="discovery-empty">New arrivals and matching delays will appear here.</p>
                  )}
                </section>
              )}
              {(incompleteFacts > 0 || !data.profile.resumeFileName) && (
                <div className="review-banner">
                  <div className="banner-icon">
                    <FileText size={27} />
                  </div>
                  <div>
                    <strong>Review your profile facts</strong>
                    <p>
                      {incompleteFacts
                        ? `${incompleteFacts} facts need your confirmation.`
                        : "Upload a resume or add confirmed experience to improve your matches."}
                    </p>
                  </div>
                  <button
                    className="dark-button"
                    onClick={() => setSection("profile")}
                  >
                    Review profile
                  </button>
                </div>
              )}
              {needsAction.length > 0 && (
                <div className="next-action">
                  <div className="next-icon">
                    <Sparkles size={20} />
                  </div>
                  <div>
                    <strong>
                      {needsAction.length} application
                      {needsAction.length > 1 ? "s" : ""} need your decision
                    </strong>
                    <p>
                      Review a packet, complete a form, or check an uncertain
                      result.
                    </p>
                  </div>
                  <button onClick={() => setSection("applications")}>
                    Open applications <ArrowRight size={15} />
                  </button>
                </div>
              )}
              <div className="filterbar">
                <div className="filters">
                  {(
                    [
                      "all",
                      "strong",
                      "possible",
                      "uncertain",
                      "saved",
                    ] as Filter[]
                  ).map((item) => (
                    <button
                      key={item}
                      className={filter === item ? "selected" : ""}
                      onClick={() => setFilter(item)}
                    >
                      {item === "all"
                        ? "All matches"
                        : item[0].toUpperCase() + item.slice(1)}{" "}
                      <span>
                        {item === "all"
                          ? jobs.filter((job) => job.active).length
                          : item === "saved"
                            ? data.feedback.filter((x) => x.kind === "saved")
                                .length
                            : data.matches.filter(
                                (x) => x.assessment.category === item,
                              ).length}
                      </span>
                    </button>
                  ))}
                </div>
                <span className="sort-label">Most relevant first</span>
              </div>
              <div className="job-list">
                {filtered.length ? (
                  filtered.map((job) => {
                    const match = matches.get(job.id);
                    const application = applications.find(
                      (app) =>
                        app.jobId === job.id && app.status !== "cancelled",
                    );
                    const importedPreflight = job.source === "imported" && job.importCheck?.status !== "verified";
                    return (
                      <article className="job-row" key={job.id}>
                        <div className="company-block">
                          <div className="company-mark">
                            {job.company.charAt(0)}
                          </div>
                          <div>
                            <strong>{job.company}</strong>
                            <small>{job.location}</small>
                            <small>
                              {job.salary ? `${job.salary} · ` : ""}
                              {job.employmentType}
                            </small>
                          </div>
                        </div>
                        <div className="job-detail">
                          <h2>{job.title}</h2>
                          <div className="badges">
                            <span
                              className={`match-badge ${match?.category ?? "uncertain"}`}
                            >
                              {match?.category === "strong"
                                ? "Strong match"
                                : match?.category === "possible"
                                  ? "Possible match"
                                  : match?.category === "excluded"
                                    ? "Hard rule conflict"
                                    : "Uncertain"}
                            </span>
                            <span className="source-badge">
                              Source: {job.sourceLabel}
                            </span>
                            {job.postedAt && (
                              <span className="source-badge">
                                Posted {relative(job.postedAt)}
                              </span>
                            )}
                          </div>
                          <div className="match-reasons">
                            <div>
                              <strong>Why it fits</strong>
                              <ul>
                                {(match?.evidence.length
                                  ? match.evidence
                                  : ["Review the posting to assess fit."]
                                ).map((reason, i) => (
                                  <li key={i}>{reason}</li>
                                ))}
                              </ul>
                            </div>
                            <div>
                              <strong>Gaps and unknowns</strong>
                              <ul>
                                {(match?.gaps.length || match?.uncertainty.length
                                  ? [...new Set([...(match?.gaps ?? []), ...(match?.uncertainty ?? [])])]
                                  : ["No obvious gaps from confirmed facts."]
                                ).map((gap, i) => (
                                  <li key={i}>{gap}</li>
                                ))}
                              </ul>
                            </div>
                          </div>
                        </div>
                        <div className="job-actions">
                          <div className="small-actions">
                            <button
                              onClick={() =>
                                act("feedback", {
                                  jobId: job.id,
                                  kind: "saved",
                                })
                              }
                            >
                              <Bookmark
                                size={17}
                                fill={
                                  feedback.get(job.id)?.kind === "saved"
                                    ? "currentColor"
                                    : "none"
                                }
                              />
                              {feedback.get(job.id)?.kind === "saved"
                                ? "Saved"
                                : "Save"}
                            </button>
                            <button
                              onClick={() => {
                                setDismissJobId(job.id);
                                setDismissReason("Wrong role");
                              }}
                            >
                              <X size={17} />
                              Dismiss
                            </button>
                          </div>
                          {application ? (
                            <button
                              className="dark-button"
                              onClick={() => {
                                setSelected(application.id);
                                setSection("applications");
                              }}
                            >
                              View application
                            </button>
                          ) : (
                            <button
                              className="dark-button"
                              disabled={
                                Boolean(busy) || match?.category === "excluded"
                              }
                              onClick={async () => {
                                const next = await act(data.automation.enabled ? (importedPreflight ? "preflightImportedPosting" : "startAutonomous") : "select", {
                                  jobId: job.id,
                                });
                                if (next) {
                                  const app = next.applications.find(
                                    (item) => item.jobId === job.id,
                                  );
                                  if (app) {
                                    setSelected(app.id);
                                    setSection("applications");
                                  }
                                }
                              }}
                            >
                              {data.automation.enabled ? (importedPreflight ? "Verify and apply automatically" : "Apply automatically") : "Prepare application"}
                            </button>
                          )}
                          <a
                            className="job-link"
                            href={job.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            View original posting ↗
                          </a>
                        </div>
                      </article>
                    );
                  })
                ) : (
                  <div className="empty">
                    <Search size={28} />
                    <h3>No jobs in this view</h3>
                    <p>Try another filter or import a job link.</p>
                  </div>
                )}
              </div>
            </main>
            <aside className="activity-panel">
              <h2>Agent activity</h2>
              <div className="timeline">
                {data.activity.slice(0, 4).map((event) => (
                  <div className="timeline-item" key={event.id}>
                    <span className="dot" />
                    <small>
                      {new Date(event.at).toLocaleTimeString([], {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </small>
                    <strong>{event.label}</strong>
                    <p>{event.detail}</p>
                  </div>
                ))}
                <div className="timeline-item future">
                  <span className="dot" />
                  <small>Next update</small>
                  <strong>About every 4 hours</strong>
                  <p>Supported sources are checked for new roles.</p>
                </div>
              </div>
              <div className="digest-card">
                <h3>Daily digest</h3>
                <p>
                  One summary of new matches and applications that need you.
                </p>
                <span>Available after email is configured</span>
              </div>
              <div className="control-card">
                <ShieldCheck size={22} />
                <div>
                  <strong>You’re in control</strong>
                  <p>We find opportunities. You decide what happens next.</p>
                  <button onClick={() => setSection("settings")}>
                    Adjust search settings <ArrowRight size={15} />
                  </button>
                </div>
              </div>
            </aside>
          </div>
        )}
        {section === "applications" && (
          <main className="wide-panel">
            {!hasAutomaticApplications && <p className="eyebrow">EACH STEP NEEDS YOUR SAY</p>}
            <h1>Your applications</h1>
            <p className="subheading">
              {hasAutomaticApplications ? "Track your applications, review blocked items, and see saved employer confirmations." : "Review the details before the agent enters a form, then review the exact form before submission."}
            </p>
            {blockers.length > 0 && (
              <section className="next-action" aria-label="Blocked applications" aria-live="polite">
                <div className="next-icon"><CircleHelp size={20} /></div>
                <div>
                  <strong>{blockers.length} blocker{blockers.length === 1 ? "" : "s"} need your attention</strong>
                  <div className="blocker-list">
                    {blockers.map(({ blocker, app }) => {
                      const job = jobs.find((item) => item.id === app.jobId);
                      const jobTitle = job?.title ?? "Application";
                      const question = blocker.context?.observedQuestion;
                      const draft = blockerAnswers[blocker.id] ?? "";
                      const canAnswer = Boolean(question) && !blocker.reviewOnly && blocker.reason === "missing_answer";
                      const handoff = ["login", "verification", "unfamiliar_control"].includes(blocker.reason);
                      const canRecheckImported = !blocker.reviewOnly && blocker.reason !== "resource_hold" && importedPreflightRecheckAvailable(app);
                      return <div className="blocker-row" key={blocker.id}>
                        <div className="blocker-copy">
                          <strong>{jobTitle}</strong>
                          <span className="blocker-reason">{blocker.reviewOnly ? "review only" : blocker.reason.replaceAll("_", " ")}</span>
                          <span>{blocker.message}</span>
                          {question && <small>Observed {question.kind} control “{question.label}”{question.options.length ? ` · options: ${question.options.join(", ")}` : ""}</small>}
                        </div>
                        {canRecheckImported ? <div className="blocker-resolution"><small>{importedPreflightHandoff(app)}</small>{job?.url && <a className="text-button" href={job.url} target="_blank" rel="noreferrer">Open employer posting</a>}<button className="outline-action" disabled={Boolean(busy) || blocker.progress === "resuming"} onClick={() => act("preflightImportedPosting", { jobId: app.jobId })}>{busy === "preflightImportedPosting" ? "Checking…" : "Check employer link again"}</button></div> : !blocker.reviewOnly && blocker.reason === "disabled_material" ? <button className="outline-action" disabled={Boolean(busy)} onClick={() => setSection("settings")}>Open search settings</button> : canAnswer ? <div className="blocker-resolution">
                          {question!.options.length ? <select aria-label={`Answer ${question!.label} for ${jobTitle}`} value={draft} disabled={Boolean(busy) || blocker.progress === "resuming"} onChange={(event) => setBlockerAnswers((current) => ({ ...current, [blocker.id]: event.target.value }))}>
                            <option value="">Choose an answer</option>
                            {question!.options.map((option) => <option key={option} value={option}>{option}</option>)}
                          </select> : <input aria-label={`Answer ${question!.label} for ${jobTitle}`} value={draft} disabled={Boolean(busy) || blocker.progress === "resuming"} onChange={(event) => setBlockerAnswers((current) => ({ ...current, [blocker.id]: event.target.value }))} placeholder="Your confirmed answer" />}
                          <button className="outline-action" disabled={Boolean(busy) || blocker.progress === "resuming" || !draft.trim()} onClick={() => act("resolveBlocker", { applicationId: app.id, blockerId: blocker.id, answer: { question: { identifier: question!.identifier, label: question!.label, kind: question!.kind, options: question!.options }, value: draft } })}>Save answer and resume</button>
                          <button className="text-button" disabled={Boolean(busy) || blocker.progress === "resuming"} onClick={() => act("resolveBlocker", { applicationId: app.id, blockerId: blocker.id, freshReconstruct: true })}>Refresh question</button>
                        </div> : handoff ? <span className="blocker-handoff">Continue with browser takeover</span> : !blocker.reviewOnly && blocker.reason !== "resource_hold" ? <button className="outline-action" disabled={Boolean(busy) || blocker.progress === "resuming"} onClick={() => act("resolveBlocker", { applicationId: app.id, blockerId: blocker.id })}>Resolve and resume</button> : null}
                      </div>;
                    })}
                  </div>
                </div>
              </section>
            )}
            <div className="app-layout">
              <div className="app-list" hidden={!applications.length}>
                {applications.length ? (
                  applications.map((app) => {
                    const job = jobs.find((item) => item.id === app.jobId);
                    return (
                      <button
                        key={app.id}
                        className={`app-list-item ${activeApp?.id === app.id ? "selected" : ""}`}
                        onClick={() => {
                          setSelected(app.id);
                          setAnswerDraft(app.packet?.answers ?? []);
                        }}
                      >
                        <span className="company-mark small">
                          {job?.company.charAt(0) ?? "?"}
                        </span>
                        <span>
                          <strong>{job?.title ?? "Application"}</strong>
                          <small>
                            {job?.company} · {app.autonomousAuthorization || app.importedOutcome ? autonomousOutcome(app) : statusLabel(app.status)}
                          </small>
                        </span>
                        <ArrowRight size={16} />
                      </button>
                    );
                  })
                ) : (
                  <div className="empty compact">
                    <BriefcaseBusiness size={26} />
                    <p>Select a match to start an application.</p>
                    <button
                      className="text-button"
                      onClick={() => setSection("matches")}
                    >
                      Browse matches →
                    </button>
                  </div>
                )}
              </div>
              <div className="app-detail">
                {activeApp && appJob ? (
                  <>
                    <div className="detail-head">
                      <div>
                        <p className="employer-name">{appJob.company}</p>
                        <h2>{appJob.title}</h2>
                        <p>
                          {appJob.location} · {appJob.sourceLabel}
                        </p>
                      </div>
                    <span className="status-pill">
                        {activeApp.autonomousAuthorization || activeApp.importedOutcome ? autonomousOutcome(activeApp) : statusLabel(activeApp.status)}
                      </span>
                    </div>
                    {appJob.source === "imported" && appJob.importCheck?.status !== "verified" && (!activeApp.importedOutcome || activeApp.importedOutcome.kind === "reachable") && !activeApp.autonomousAuthorization && (
                      <div className="step-card" aria-label="Imported employer compatibility">
                        <h3>Check the employer posting first</h3>
                        <p>{activeApp.importedCompatibility?.status === "reachable"
                          ? "The posting and supported form were checked. We’re ready to continue with your saved profile and chosen materials."
                          : "We’ll check the public posting and supported form without filling or submitting anything. If everything still matches, we’ll continue with your saved profile and chosen materials."}</p>
                        {activeApp.importedCompatibility?.status === "reachable" ? <button className="dark-button" disabled={Boolean(busy)} onClick={() => act("startAutonomous", { jobId: appJob.id })}>{busy === "startAutonomous" ? "Starting…" : "Continue automatically"}</button> : <button className="dark-button" disabled={Boolean(busy)} onClick={() => act("preflightImportedPosting", { jobId: appJob.id })}>{busy === "preflightImportedPosting" ? "Checking…" : "Verify and apply automatically"}</button>}
                        {activeApp.importedCompatibility?.blocker && <p className="muted">{activeApp.importedCompatibility.blocker}</p>}
                      </div>
                    )}
                    {!activeAppIsAutomatic && <div className="progress">
                      {[
                        "Selected",
                        "Packet",
                        "Fill",
                        "Final review",
                        "Submitted",
                      ].map((item, i) => (
                        <span
                          key={item}
                          className={
                            progressIndex(activeApp.status) >= i ? "done" : ""
                          }
                        >
                          {i < progressIndex(activeApp.status) ? (
                            <Check size={13} />
                          ) : (
                            i + 1
                          )}{" "}
                          {item}
                        </span>
                      ))}
                    </div>}
                    {(activeApp.autonomousAuthorization || activeApp.importedOutcome) && <AutonomousApplicationStatus application={activeApp} busy={Boolean(busy)} checkResult={() => act("checkSubmissionResult", { applicationId: activeApp.id })} />}
                    {activeApp.queuedRun && (
                      <div className="step-card" role="status">
                        <h3>Application run queued</h3>
                        <p>{activeApp.queuedRun.reason === "budget" ? "The service spending limit is full. Your request is saved and will start when budget is available." : activeApp.queuedRun.reason === "active_run" ? "Finish or cancel your active browser session. This saved request will start afterward." : "Your saved request is waiting for a worker."}</p>
                      </div>
                    )}
                    {activeApp.status === "drafting" && <p role="status">Preparing your packet from confirmed facts…</p>}
                    {!activeAppIsAutomatic && activeApp.status === "selected" && !activeApp.queuedRun && (
                      <div className="step-card">
                        <h3>Prepare your application packet</h3>
                        <p>
                          The agent will use confirmed facts to build a tailored
                          resume and write essays for your confirmation. You
                          provide personal, authorization and consent answers.
                        </p>
                        <button
                          className="dark-button"
                          disabled={Boolean(busy)}
                          onClick={() =>
                            act("draft", { applicationId: activeApp.id })
                          }
                        >
                          {busy === "draft"
                            ? "Preparing…"
                            : "Draft from verified facts"}
                        </button>
                      </div>
                    )}
                    {activeApp.status === "draft_review" && applicationMaterials}
                    {!activeAppIsAutomatic && activeApp.status === "authorized_to_fill" && !activeApp.queuedRun && (
                      <div className="step-card">
                        <h3>Ready to fill the employer form</h3>
                        <p>
                          This opens an isolated browser and enters only the
                          packet you approved. You will review the filled form
                          before submission.
                        </p>
                        <button
                          className="dark-button"
                          disabled={Boolean(busy)}
                          onClick={() =>
                            act("startBrowser", { applicationId: activeApp.id })
                          }
                        >
                          Start browser run
                        </button>
                      </div>
                    )}
                    {activeApp.status === "awaiting_verification" && (
                      <div className="warning-note verification-note" role="status">
                        <CircleHelp size={20} />
                        <div>
                          <strong>Finish employer verification</strong>
                          <p>The employer opened a CAPTCHA after your approved Submit click. Complete it in the browser below, then check the result. Do not click Submit again.</p>
                          <div className="action-row">
                            <button className="dark-button" disabled={Boolean(busy)} onClick={() => act("checkSubmissionResult", { applicationId: activeApp.id })}>
                              {busy === "checkSubmissionResult" ? "Checking confirmation…" : "I’m done · check result"}
                            </button>
                            {activeApp.browserLiveUrl && <a className="text-button" href={activeApp.browserLiveUrl} target="_blank" rel="noreferrer">Open verification browser ↗</a>}
                            <button className="text-button" disabled={Boolean(busy)} onClick={() => act("stopSubmissionVerification", { applicationId: activeApp.id })}>Stop verification</button>
                          </div>
                          <p className="muted">Checking reads the existing attempt; it never submits again.{activeApp.browserSessionExpiresAt && ` Browser available until ${new Date(activeApp.browserSessionExpiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`}</p>
                          {activeApp.confirmation && !activeApp.confirmation.includes("opened a CAPTCHA") && <p>{activeApp.confirmation}</p>}
                        </div>
                      </div>
                    )}
                    {activeApp.status === "filling" && (
                      <div className="step-card">
                        <LoaderCircle className="spin" size={24} /> Filling the
                        form…
                      </div>
                    )}
                    {!activeAppIsAutomatic && activeApp.status === "needs_user_action" && (
                      <>
                      {activeApp.browserSessionId && hasUnreadableQuestionLabels(activeApp.form) ? <div className="step-card">
                        <h3>Update the form questions</h3>
                        <p>The employer’s question headings need to be read again before you answer. Your browser and packet are saved.</p>
                        <button className="dark-button" disabled={Boolean(busy) || Boolean(activeApp.browserQuestionRun)} onClick={() => act("resumeBrowser", { applicationId: activeApp.id })}>Refresh questions</button>
                      </div> : activeApp.browserSessionId && browserQuestions(activeApp.form).length > 0 && <BrowserQuestionsDialog key={`${activeApp.id}-${activeApp.browserSessionId}-${activeApp.form?.hash}`} application={activeApp} busy={busy} error={error} facts={data?.profile.facts ?? []} act={act} />}
                      <div className="step-card">
                        <h3>{!activeApp.browserSessionId ? "Start a fresh browser session" : browserTakeoverReasons(activeApp.form).length ? "Browser help needed" : "Your browser is saved"}</h3>
                        {browserTakeoverReasons(activeApp.form).map((blocker) => <p key={blocker}>{blocker}</p>)}
                        <p>
                          {!activeApp.browserSessionId ? "Your packet is saved. Review it and approve a fresh browser session to continue." : browserTakeoverReasons(activeApp.form).length ? "Complete the browser steps above, then refresh the form for review." : hasUnreadableQuestionLabels(activeApp.form) ? "Refresh the questions above to continue in this browser." : "You can inspect the browser at any time. Use the questions above to let the agent continue filling."}
                        </p>
                        {activeApp.browserLiveUrl && (
                          <a
                            className="dark-button inline"
                            href={activeApp.browserLiveUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open live browser ↗
                          </a>
                        )}
                        {activeApp.needsCoverLetter && (
                          <button
                            className="dark-button"
                            onClick={() =>
                              act("addCoverLetter", {
                                applicationId: activeApp.id,
                              })
                            }
                          >
                            Generate cover letter for review
                          </button>
                        )}
                        {activeApp.browserSessionId && <button
                          className="outline-action"
                          onClick={() =>
                            act("resumeBrowser", {
                              applicationId: activeApp.id,
                            })
                          }
                        >
                          Refresh form state
                        </button>}
                        <button className="outline-action" disabled={Boolean(busy)} onClick={() => act("restartBrowser", { applicationId: activeApp.id })}>Review packet for a new browser session</button>
                      </div>
                      </>
                    )}
                    {activeApp.status === "submitted" && !activeAppIsAutomatic && (
                      <div className="success-note">
                        <Check size={20} />
                        <div>
                          <strong>Submission confirmed</strong>
                          <p>{activeApp.confirmation}</p>
                          {activeApp.submissionReceipt?.screenshotPath && <a href={activeApp.submissionReceipt.screenshotPath} target="_blank" rel="noreferrer">View confirmation proof ↗</a>}
                          <label>Minutes this application saved you (optional)<input type="number" min={0} max={240} defaultValue={activeApp.timeSavedMinutes ?? ""} onBlur={(event) => { if (event.target.value && Number(event.target.value) !== activeApp.timeSavedMinutes) act("timeSaved", { applicationId: activeApp.id, minutes: Number(event.target.value) }); }} /></label>
                        </div>
                      </div>
                    )}
                    {!activeAppIsAutomatic && activeApp.form &&
                      [
                        "final_review",
                        "approved_to_submit",
                        "submitting",
                        "submitted",
                      ].includes(activeApp.status) && (
                        <div className="step-card">
                          <div className="card-title">
                            <ShieldCheck size={20} />
                            <h3>Final form review</h3>
                          </div>
                          <p className="muted">
                            Review the actual fields and attachments on{" "}
                            {new URL(activeApp.form.url).hostname}. Approval is
                            tied to this exact state.
                          </p>
                          {activeApp.form.submitControl?.action && (
                            <p className="muted" style={{ overflowWrap: "anywhere" }}>
                              Submit destination: {activeApp.form.submitControl.action}
                            </p>
                          )}
                          {activeApp.form.screenshotPath && (
                            <Image
                              className="form-shot"
                              src={`${activeApp.form.screenshotPath}${activeApp.form.screenshotPath.includes("?") ? "&" : "?"}capture=${encodeURIComponent(activeApp.form.capturedAt)}`}
                              alt="Filled application form screenshot"
                              width={1000}
                              height={600}
                              unoptimized
                            />
                          )}
                          {activeApp.browserLiveUrl && (
                            <a
                              href={activeApp.browserLiveUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-button"
                            >
                              Open live browser ↗
                            </a>
                          )}
                          <div className="form-fields">
                            {activeApp.form.fields.map((field, i) => (
                              <div key={i}>
                                <span>{field.label}</span>
                                <strong>
                                  {formFieldValue(field)}
                                </strong>
                              </div>
                            ))}
                          </div>
                          <p>
                            <strong>Attachments:</strong>{" "}
                            {activeApp.form.attachments.join(", ") || "None"}
                          </p>
                          {activeApp.status === "final_review" && (
                            <div className="action-row">
                              <button
                                className="outline-action"
                                onClick={() =>
                                  act("resumeBrowser", {
                                    applicationId: activeApp.id,
                                  })
                                }
                              >
                                Refresh form state
                              </button>
                              <button
                                className="dark-button"
                                disabled={Boolean(busy) || activeApp.form?.readyToSubmit === false}
                                onClick={() =>
                                  act("approveSubmit", {
                                    applicationId: activeApp.id,
                                    formHash: activeApp.form?.hash,
                                  })
                                }
                              >
                                Approve this form
                              </button>
                            </div>
                          )}
                          {activeApp.status === "approved_to_submit" && (
                            <div className="action-row">
                              <p>
                                Final approval recorded. This will click submit
                                once.
                              </p>
                              <button
                                className="dark-button"
                                disabled={Boolean(busy)}
                                onClick={() =>
                                  act("submit", { applicationId: activeApp.id })
                                }
                              >
                                Submit application once
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    {activeApp.status === "uncertain" && !activeAppIsAutomatic && (
                      <div className="warning-note">
                        <CircleHelp size={20} />
                        <div>
                          <strong>{employerBlock ? "Employer blocked submission" : "Submission result uncertain"}</strong>
                          <p>
                            {employerBlock || activeApp.confirmation ||
                              activeApp.error ||
                              "Check the employer site or email before taking further action."}{" "}
                            The agent will not retry automatically.
                          </p>
                          {activeApp.submissionReceipt && <p className="submission-capture">
                            Response captured {new Date(activeApp.submissionReceipt.capturedAt).toLocaleString("en-US", { timeZone: data.profile.timeZone || "America/New_York", dateStyle: "medium", timeStyle: "short" })}.
                          </p>}
                          {activeApp.submissionReceipt?.screenshotPath && <a href={activeApp.submissionReceipt.screenshotPath} target="_blank" rel="noreferrer">View submission screenshot ↗</a>}
                          {employerBlock && <p>
                            Review the employer’s instructions in your own browser. Your saved packet and confirmed essays are available below.{" "}
                            <a href={appJob.applyUrl} target="_blank" rel="noreferrer">Open employer application ↗</a>
                          </p>}
                          {activeApp.manualSubmissionReport && !activeApp.manualSubmissionReport.resolution && !activeApp.submissionAttemptedAt && <p>
                            The previous browser run has stopped. No new form fill has started.
                            Your saved packet and confirmed essays are available for review.
                          </p>}
                          {!activeApp.autonomousAuthorization && canReopenManualAttempt(activeApp) && <>
                            <p>Check the employer page or confirmation email first. Missing email alone does not confirm that an application failed.</p>
                            <label className="checkline">
                              <input type="checkbox" checked={confirmedUnacceptedId === activeApp.id} onChange={(event) => setConfirmedUnacceptedId(event.target.checked ? activeApp.id : null)} />
                              I confirmed this attempt did not submit an application.
                            </label>
                            <button className="outline-action" disabled={Boolean(busy) || confirmedUnacceptedId !== activeApp.id} onClick={() => act("reviewManualFailure", { applicationId: activeApp.id, confirmedNotAccepted: true })}>
                              Return to packet review
                            </button>
                            <p className="muted">This closes the old browser. A new fill run requires your packet approval.</p>
                          </>}
                          {activeApp.form && <details>
                            <summary>View previous browser snapshot</summary>
                            <p className="muted">Captured {new Date(activeApp.form.capturedAt).toLocaleString("en-US", { timeZone: data.profile.timeZone || "America/New_York", dateStyle: "medium", timeStyle: "short" })}. This saved snapshot predates the outcome review.</p>
                            <div className="form-fields">
                              {activeApp.form.fields.map((field, index) => <div key={index}><span>{field.label}</span><strong>{formFieldValue(field)}</strong></div>)}
                            </div>
                          </details>}
                        </div>
                      </div>
                    )}
                    <LiveBrowser key={`${activeApp.id}-${activeApp.browserSessionId || "pending"}`} application={activeApp} />
                    {activeApp.status !== "draft_review" && applicationMaterials && (
                      <details className="packet-reference" key={`materials-${activeApp.id}-${activeApp.status}`}>
                        <summary>Saved application materials · version {activeApp.packet?.version}</summary>
                        {applicationMaterials}
                      </details>
                    )}
                    {activeApp.error && activeApp.status !== "uncertain" && !activeAppIsAutomatic && (
                      <p className="inline-error">{activeApp.error}</p>
                    )}
                    {![
                      "submitted",
                      "submitting",
                      "awaiting_verification",
                      "uncertain",
                      "cancelled",
                    ].includes(activeApp.status) || (activeApp.autonomousAuthorization && activeApp.status === "submitting" && !activeApp.submissionAttemptedAt) ? (
                      <button
                        className="subtle-danger"
                        onClick={() =>
                          act("cancel", { applicationId: activeApp.id })
                        }
                      >
                        Cancel this application
                      </button>
                    ) : null}
                  </>
                ) : (
                  <div className="empty">
                    <h2>Start with a role you want</h2>
                    <p>Choose a match to prepare your first application. You review the materials and the employer form before submission.</p>
                    <button className="dark-button" onClick={() => setSection("matches")}>Browse matches <ArrowRight size={16} /></button>
                  </div>
                )}
              </div>
            </div>
          </main>
        )}
        {(section === "profile" || section === "settings") && profileDraft && (
          <main className="wide-panel profile-panel">
            <p className="eyebrow">YOUR VERIFIED STORY</p>
            <h1>
              {section === "profile" ? "Your profile" : "Search settings"}
            </h1>
            <p className="subheading">
              The agent uses only facts you confirm and preferences you set
              here.
            </p>
            <div className="profile-grid">
              <div className="profile-card">
                <h3>Basics</h3>
                <div className="form-grid">
                  {(
                    [
                      "name",
                      "email",
                      "phone",
                      "school",
                      "graduationYear",
                      "headline",
                    ] as const
                  ).map((key) => (
                    <label key={key}>
                      {labels[key]}
                      <input
                        value={profileDraft[key]}
                        disabled={key === "email" && !data.profile.demo}
                        onChange={(event) =>
                          setProfileDraft({
                            ...profileDraft,
                            [key]: event.target.value,
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
                <h3>Search preferences</h3>
                <div className="form-grid">
                  {(
                    ["preferredTitles", "preferredLocations", "skills"] as const
                  ).map((key) => (
                    <label key={key}>
                      {labels[key]}
                      <input
                        value={profileDraft[key].join(", ")}
                        onChange={(event) =>
                          setProfileDraft({
                            ...profileDraft,
                            [key]: event.target.value
                              .split(",")
                              .map((part) => part.trim())
                              .filter(Boolean),
                          })
                        }
                      />
                      <small>Separate entries with commas</small>
                    </label>
                  ))}
                  <label>
                    Work authorization
                    <select
                      value={profileDraft.workAuthorization}
                      onChange={(event) =>
                        setProfileDraft({
                          ...profileDraft,
                          workAuthorization: event.target.value,
                        })
                      }
                    >
                      {!["Unspecified", "Authorized to work in the US", "Requires sponsorship"].includes(profileDraft.workAuthorization) && (
                        <option value={profileDraft.workAuthorization}>{profileDraft.workAuthorization || "Unspecified"}</option>
                      )}
                      <option>Unspecified</option>
                      <option>Authorized to work in the US</option>
                      <option>Requires sponsorship</option>
                    </select>
                    <small>Student or visa status does not answer employment authorization or sponsorship. Enter those answers separately below.</small>
                  </label>
                </div>
                <label className="checkline">
                  <input
                    type="checkbox"
                    checked={profileDraft.remoteOnly}
                    onChange={(event) =>
                      setProfileDraft({
                        ...profileDraft,
                        remoteOnly: event.target.checked,
                      })
                    }
                  />{" "}
                  Show only remote roles
                </label>
                <label className="checkline"><input type="checkbox" checked={profileDraft.strictLocations ?? false} onChange={(event) => setProfileDraft({ ...profileDraft, strictLocations: event.target.checked })} /> Require listed locations for on-site roles</label>
                <h3>Optional saved screening answers</h3>
                <p className="muted">Only answers you enter here may be reused. Leave a field blank to answer it yourself on each application. Every entered value appears in the final form review.</p>
                {(["requiresSponsorship", "workAuthorization", "gender", "ethnicity", "disability", "veteran"] as const).map((key) => (
                  <label key={key}>
                    {{ requiresSponsorship: "Will you require sponsorship?", workAuthorization: "Work authorization answer", gender: "Gender answer", ethnicity: "Ethnicity answer", disability: "Disability answer", veteran: "Veteran status answer" }[key]}
                    <input maxLength={200} value={profileDraft.sensitiveAnswers[key] ?? ""} onChange={(event) => setProfileDraft({ ...profileDraft, sensitiveAnswers: { ...profileDraft.sensitiveAnswers, [key]: event.target.value } })} placeholder="Leave blank for manual entry" />
                  </label>
                ))}
                <h3>Required onboarding answers</h3>
                <p className="muted">These answers are stored as explicit declarations. Leaving one blank keeps it missing; “No” is saved as a real answer.</p>
                <label>
                  Are you authorized to work in the United States?
                  <select
                    value={profileDraft.onboarding?.questionnaire.workAuthorization ?? ""}
                    onChange={(event) => setProfileDraft({
                      ...profileDraft,
                      onboarding: {
                        questionnaire: {
                          ...profileDraft.onboarding?.questionnaire,
                          workAuthorization: event.target.value ? event.target.value as "yes" | "no" | "unknown" : undefined,
                        },
                      },
                    })}
                  >
                    <option value="">Choose an answer</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                    <option value="unknown">I’m not sure yet</option>
                  </select>
                </label>
                <label>
                  Will you require sponsorship for employment?
                  <select
                    value={profileDraft.onboarding?.questionnaire.requiresSponsorship ?? ""}
                    onChange={(event) => setProfileDraft({
                      ...profileDraft,
                      onboarding: {
                        questionnaire: {
                          ...profileDraft.onboarding?.questionnaire,
                          requiresSponsorship: event.target.value ? event.target.value as "yes" | "no" | "unknown" : undefined,
                        },
                      },
                    })}
                  >
                    <option value="">Choose an answer</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                    <option value="unknown">I’m not sure yet</option>
                  </select>
                </label>
                <label>
                  When are you available to start?
                  <input
                    maxLength={200}
                    value={profileDraft.onboarding?.questionnaire.availability ?? ""}
                    onChange={(event) => setProfileDraft({
                      ...profileDraft,
                      onboarding: {
                        questionnaire: {
                          ...profileDraft.onboarding?.questionnaire,
                          availability: event.target.value,
                        },
                      },
                    })}
                    placeholder="For example, May 2026 or immediately"
                  />
                </label>
                {section === "settings" && <>
                  <h3>Application materials</h3>
                  <label className="checkline">
                    <input type="checkbox" checked={profileDraft.automationSettings?.resumeTailoring ?? true} onChange={(event) => setProfileDraft({ ...profileDraft, automationSettings: { ...(profileDraft.automationSettings ?? { version: 1, coverLetterMode: "required-only", essayMode: "automatic-truthful" }), resumeTailoring: event.target.checked } })} />
                    Tailor my resume to each role
                  </label>
                  <label>
                    Cover letters
                    <select value={profileDraft.automationSettings?.coverLetterMode ?? "required-only"} onChange={(event) => setProfileDraft({ ...profileDraft, automationSettings: { ...(profileDraft.automationSettings ?? { version: 1, resumeTailoring: true, essayMode: "automatic-truthful" }), coverLetterMode: event.target.value as "disabled" | "required-only" | "enabled" } })}>
                      <option value="disabled">Never generate</option>
                      <option value="required-only">Generate when required</option>
                      <option value="enabled">Generate when supported</option>
                    </select>
                  </label>
                  <p className="muted">Essay answers use confirmed facts and general truthful language when personal detail is unavailable.</p>
                </>}
                <button
                  className="dark-button"
                  onClick={() =>
                    act(
                      "profile",
                      profileDraft as unknown as Record<string, unknown>,
                    )
                  }
                >
                  Save profile and preferences
                </button>
              </div>
              {section === "settings" && <section className="profile-card autonomy-card">
                <h3>Automation authorization</h3>
                <p className="muted">Automation acts only within your current confirmed facts and settings. You can pause future work at any time.</p>
                <div className={`automation-state ${data.automation.enabled ? "on" : data.automation.paused ? "paused" : "off"}`} role="status">
                  <strong>{data.automation.enabled ? "Enabled" : data.automation.paused ? "Paused" : "Not enabled"}</strong>
                  <span>Settings version {data.automation.version}</span>
                </div>
                {data.automation.enabled ? (
                  <button className="outline-action" disabled={Boolean(busy)} onClick={() => act("pauseAutomation")}>Pause automation</button>
                ) : (
                  <button className="dark-button" disabled={Boolean(busy) || !data.onboarding.complete} onClick={() => act("activateAutomation", { reason: "applicant-confirmed" })}>
                    {data.automation.paused ? "Resume automation" : "Enable automation"}
                  </button>
                )}
                {!data.onboarding.complete && <p className="muted">Complete the required answers and confirm at least one resume fact before enabling automation.</p>}
              </section>}
              <div className="profile-card">
                <h3>Resume and confirmed facts</h3>
                <p className="muted">
                  Uploading extracts text for your review. It never confirms
                  claims automatically. Source-preserving PDF and DOCX layouts
                  support up to eight pages and two text columns per page; DOCX
                  page count is checked after rendering.
                </p>
                <label className="upload-box">
                  <FileText size={24} />
                  <span>
                    {profileDraft.resumeFileName ||
                      "Upload PDF or DOCX · 5 MB max"}
                  </span>
                  <input
                    type="file"
                    accept=".pdf,.docx"
                    onChange={async (event) => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      setBusy("upload");
                      setError("");
                      const body = new FormData();
                      body.set("file", file);
                      try {
                        const response = await fetch("/api/resume", {
                          method: "POST",
                          body,
                        });
                        const result = await response.json();
                        if (!response.ok) throw new Error(result.error);
                        const next = await reload();
                        setProfileDraft(structuredClone(next.profile));
                      } catch (err) {
                        setError(
                          err instanceof Error ? err.message : "Upload failed.",
                        );
                      } finally {
                        setBusy("");
                      }
                    }}
                  />
                </label>
                {profileDraft.resumeSourceDocument && <ResumeSourceSupportNotice source={profileDraft.resumeSourceDocument} />}
                {profileDraft.resumeText && (
                  <details className="resume-text">
                    <summary>Review extracted resume text</summary>
                    <pre>{profileDraft.resumeText}</pre>
                  </details>
                )}
                <div className="facts-head">
                  <h4>Facts the agent may use</h4>
                  <small>Check each fact before use</small>
                </div>
                {profileDraft.facts.map((fact) => (
                  <div className="fact-row" key={fact.id}>
                    <input
                      type="checkbox"
                      checked={fact.verified}
                      aria-label={`Confirm ${fact.text}`}
                      onChange={(event) =>
                        setProfileDraft({
                          ...profileDraft,
                          facts: profileDraft.facts.map((item) =>
                            item.id === fact.id
                              ? { ...item, verified: event.target.checked }
                              : item,
                          ),
                        })
                      }
                    />
                    <span>{fact.text}</span>
                    <button
                      onClick={() =>
                        setProfileDraft({
                          ...profileDraft,
                          facts: profileDraft.facts.filter(
                            (item) => item.id !== fact.id,
                          ),
                        })
                      }
                      aria-label="Remove fact"
                    >
                      <X size={16} />
                    </button>
                  </div>
                ))}
                <div className="add-fact">
                  <input
                    placeholder="Add a specific experience or project fact"
                    value={factText}
                    onChange={(event) => setFactText(event.target.value)}
                  />
                  <button
                    onClick={() => {
                      if (!factText.trim()) return;
                      setProfileDraft({
                        ...profileDraft,
                        facts: [
                          ...profileDraft.facts,
                          {
                            id: crypto.randomUUID(),
                            text: factText.trim(),
                            source: "user",
                            verified: true,
                          },
                        ],
                      });
                      setFactText("");
                    }}
                  >
                    Add
                  </button>
                </div>
                <button
                  className="outline-action"
                  onClick={() =>
                    act(
                      "profile",
                      profileDraft as unknown as Record<string, unknown>,
                    )
                  }
                >
                  Save facts
                </button>
              </div>
            </div>
            {section === "settings" && <section className="profile-card">
              <h3>Help evaluate match quality</h3>
              <p className="muted">Label at least ten real roles based on your confirmed experience. These labels evaluate Jev; they do not start applications. Names, contact details, resumes, and sensitive answers are removed from the export.</p>
              {jobs.filter((job) => job.source !== "demo").slice(0, 20).map((job) => <div className="fact-row" key={job.id}><span><strong>{job.title}</strong> · {job.company}<br /><a href={job.url} target="_blank" rel="noreferrer">Review posting ↗</a></span><select aria-label={`Your fit label for ${job.title}`} value={data.matchLabels?.find((label) => label.jobId === job.id)?.label ?? ""} disabled={Boolean(busy)} onChange={(event) => { if (event.target.value) act("labelMatch", { jobId: job.id, label: event.target.value }); }}><option value="">Choose fit</option><option value="strong">Strong</option><option value="possible">Possible</option><option value="uncertain">Uncertain</option></select></div>)}
              <a className="outline-action inline" href="/api/evaluation/pairs">Export {data.matchLabels?.length ?? 0} labeled pairs</a>
              <h3>Your application results</h3>
              <table><tbody>
                <tr><th scope="row">Confirmed submissions</th><td>{applications.filter((app) => app.status === "submitted").length}</td></tr>
                <tr><th scope="row">Applications needing takeover</th><td>{applications.filter((app) => app.transitionHistory?.some((step) => step.to === "needs_user_action")).length}</td></tr>
                <tr><th scope="row">Uncertain outcomes</th><td>{applications.filter((app) => app.status === "uncertain").length}</td></tr>
                <tr><th scope="row">Match feedback</th><td>{data.feedback.length}</td></tr>
                <tr><th scope="row">Time saved, reported by you</th><td>{applications.reduce((sum, app) => sum + (app.timeSavedMinutes ?? 0), 0)} minutes</td></tr>
                <tr><th scope="row">Projected cost reserved per run</th><td>{applications.flatMap((app) => app.runs ?? []).length ? `$${(applications.flatMap((app) => app.runs ?? []).reduce((sum, run) => sum + run.projectedUsd, 0) / applications.flatMap((app) => app.runs ?? []).length).toFixed(2)}` : "No runs yet"}</td></tr>
              </tbody></table>
              <p className="muted">Reserved costs are projections. Actual provider charges must be reconciled before beta expansion.</p>
            </section>}
          </main>
        )}
      </div>
      {dismissJobId && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDismissJobId(null);
          }}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dismiss-heading"
          >
            <button
              className="modal-close"
              onClick={() => setDismissJobId(null)}
              aria-label="Close"
            >
              <X size={20} />
            </button>
            <p className="eyebrow">HELP REFINE YOUR SEARCH</p>
            <h2 id="dismiss-heading">Why dismiss this role?</h2>
            <p>Your reason will guide the order of similar future matches.</p>
            <label>
              Reason
              <select
                value={dismissReason}
                onChange={(event) => setDismissReason(event.target.value)}
              >
                <option>Wrong role</option>
                <option>Location is not right</option>
                <option>Experience level is not right</option>
                <option>Not interested in this employer</option>
                <option>Other</option>
              </select>
            </label>
            <button
              className="dark-button"
              onClick={async () => {
                const next = await act("feedback", {
                  jobId: dismissJobId,
                  kind: "dismissed",
                  reason: dismissReason,
                });
                if (next) setDismissJobId(null);
              }}
            >
              Dismiss role
            </button>
          </div>
        </div>
      )}
      {importOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setImportOpen(false);
          }}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-heading"
          >
            <button
              className="modal-close"
              onClick={() => setImportOpen(false)}
              aria-label="Close"
            >
              <X size={20} />
            </button>
            <p className="eyebrow">BRING YOUR OWN OPPORTUNITY</p>
            <h2 id="import-heading">Import a job link</h2>
            <p>
              Paste a Greenhouse, Lever, or Ashby job link to retrieve its details.
              For other sites, add the title and company. We’ll check the public posting and supported form before automatic application.
            </p>
            {(["url", "company", "title", "location"] as const).map((key) => (
              <label key={key}>
                {key === "url"
                  ? "Job URL"
                  : key[0].toUpperCase() + key.slice(1)}
                <input
                  value={importFields[key]}
                  onChange={(event) =>
                    setImportFields({
                      ...importFields,
                      [key]: event.target.value,
                    })
                  }
                  placeholder={key === "url" ? "https://…" : ""}
                />
              </label>
            ))}
            <button
              className="dark-button"
              onClick={async () => {
                const next = await act("import", importFields);
                if (next) {
                  setImportOpen(false);
                  setImportFields({
                    url: "",
                    company: "",
                    title: "",
                    location: "",
                  });
                }
              }}
            >
              Add to catalog
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const labels: Record<string, string> = {
  name: "Full name",
  email: "Email",
  phone: "Phone",
  school: "School or university",
  graduationYear: "Graduation year",
  headline: "Short headline",
  preferredTitles: "Preferred job titles",
  preferredLocations: "Preferred locations",
  skills: "Skills",
};
function relative(input: string) {
  const days = Math.max(
    0,
    Math.floor((Date.now() - new Date(input).getTime()) / 86400000),
  );
  return days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}
function formatDelay(milliseconds: number) {
  const minutes = Math.max(0, Math.round(milliseconds / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}
function statusLabel(status: Application["status"]) {
  return {
    selected: "Selected",
    drafting: "Drafting",
    draft_review: "Review packet",
    authorized_to_fill: "Ready to fill",
    filling: "Filling form",
    needs_user_action: "Your input needed",
    final_review: "Review final form",
    approved_to_submit: "Ready to submit",
    submitting: "Submitting",
    awaiting_verification: "Finish verification",
    submitted: "Submitted",
    uncertain: "Result uncertain",
    cancelled: "Cancelled",
  }[status];
}
function progressIndex(status: Application["status"]) {
  return {
    selected: 0,
    drafting: 1,
    draft_review: 1,
    authorized_to_fill: 2,
    filling: 2,
    needs_user_action: 2,
    final_review: 3,
    approved_to_submit: 3,
    submitting: 3,
    awaiting_verification: 3,
    submitted: 4,
    uncertain: 3,
    cancelled: 0,
  }[status];
}
