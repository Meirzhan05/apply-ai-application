"use client";
import { AutonomousApplicationStatus, autonomousOutcome, importedPreflightHandoff, importedPreflightRecheckAvailable } from "@/components/autonomous-application-status";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createWorkspaceRefresh, type WorkspaceConnection } from "@/lib/workspace-refresh";
import Image from "next/image";
import { ApplicationProgress } from "@/components/application-progress";
import { EssayReview } from "@/components/essay-review";
import { PacketReadiness } from "@/components/packet-readiness";
import { ResumeReview } from "@/app/resume-review";
import { OriginalResumeInspection } from "@/components/original-resume-inspection";
import { AccountDeletionPanel } from "@/components/account-deletion";
import { hasSourcePreservingResume, ResumeComparison, ResumeSourceSupportNotice } from "@/components/resume-comparison";
import { LiveBrowser } from "@/app/live-browser";
import { BrowserQuestionsDialog } from "@/app/browser-questions-dialog";
import { WorkspaceDialog } from "@/app/workspace-dialog";
import { browserQuestions, browserTakeoverReasons, hasUnreadableQuestionLabels } from "@/lib/browser-questions";
import { useRouter } from "next/navigation";
import { browserSupabase } from "@/lib/supabase-browser";
import { compareRankedJobs } from "@/lib/ranking";
import { matchView, type MatchFilter, type MatchCollection } from "@/lib/match-view";
import { dismissalReasons, emptyImport, readMatchesSession, writeMatchesSession, type BrowseView } from "@/lib/matches-session";
import { readWorkspaceNavigation, writeWorkspaceNavigation, type WorkspaceSection } from "@/lib/workspace-navigation";
import { PersonalSearchStatus } from "@/components/personal-search-status";
import { personalSearchReadiness } from "@/lib/personal-search-policy";
import { actionNeedsWorkspaceCheck, postWorkspaceAction } from "@/lib/workspace-action";
import { saveRoleBatch } from "@/lib/save-role-batch";
import { checkAge, discoveryStatus } from "@/lib/discovery-status";
import { matchEvidence } from "@/lib/match-evidence";
import { importInput, importedRole, roleForPosting } from "@/lib/import-input";
import { FactCorrectionDialog } from "@/components/fact-correction-dialog";
import { ApplicationHelp } from "@/components/application-help";
import { ApplicationPicker } from "@/components/application-picker";
import { canReturnToMaterials } from "@/lib/material-review-recovery";
import { browserSessionAvailable } from "@/lib/browser-session-status";
import { answerOwner, answerNeedsAction, answerReviewHash } from "@/lib/answer-responsibility";
import { onboardingMissingLabel } from "@/lib/onboarding";
import { canReopenManualAttempt, employerSubmissionBlock, formFieldValue } from "@/lib/form-review";
import {
  ArrowRight,
  Bookmark,
  BriefcaseBusiness,
  Check,
  ChevronDown,
  CircleHelp,
  ClipboardList,
  FileText,
  LoaderCircle,
  Menu,
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
  Job,
  MatchAssessment,
  Profile,
  ScreeningAnswer,
  VerifiedFact,
} from "@/lib/types";

type ViewState = Omit<AppState, "applications"> & {
  applications: Array<Application & { materialsStale?: boolean }>;
  matches: { jobId: string; assessment: MatchAssessment }[];
  onboarding: { complete: boolean; missing: string[]; confirmedFactCount: number };
  automation: {
    enabled: boolean;
    paused: boolean;
    version: number;
    settings: NonNullable<Profile["automationSettings"]>;
  };
};
type Section = WorkspaceSection;
type Filter = MatchFilter;

export default function Dashboard() {
  const router = useRouter();
  const [data, setData] = useState<ViewState | null>(null);
  const [connection, setConnection] = useState<WorkspaceConnection>("current");
  const [section, setSection] = useState<Section>("matches");
  const [applicationSearch, setApplicationSearch] = useState("");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const applicationSearchInput = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [collection, setCollection] = useState<MatchCollection>("all");
  const searchInput = useRef<HTMLInputElement>(null);
  const jobList = useRef<HTMLDivElement>(null);
  const pendingRoleFocus = useRef<string | null>(null);
  const feedbackReturnFocus = useRef<string | null>(null);
  const pendingSetupFocus = useRef<string | null>(null);
  const [importTouched, setImportTouched] = useState(false);
  const [confirmDiscardImport, setConfirmDiscardImport] = useState(false);
  const keepImportEditing = useRef<HTMLButtonElement>(null);
  const batchCancel = useRef(false);
  const batchActive = useRef(false);
  const pendingBatchFocus = useRef(false);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number; stopping?: boolean } | null>(null);
  const [busyJob, setBusyJob] = useState("");
  const [search, setSearch] = useState("");
  const [filterOptionsOpen, setFilterOptionsOpen] = useState(false);
  const [shortcutsEnabled, setShortcutsEnabled] = useState(true);
  const [sort, setSort] = useState<"relevant" | "newest">("relevant");
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [confirmedUnacceptedId, setConfirmedUnacceptedId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pendingActionCheck, setPendingActionCheck] = useState<{ owner: string; action: string; message: string } | null>(null);
  const actionCheck = pendingActionCheck?.owner === data?.profile.id ? pendingActionCheck : null;
  const activeError = error || actionCheck?.message || "";
  const needsWorkspaceCheck = Boolean(actionCheck) || actionNeedsWorkspaceCheck(activeError);
  const requiresSignIn = activeError === "AUTH_REQUIRED" || actionCheck?.message === "AUTH_REQUIRED";
  const [notice, setNotice] = useState("");
  const [editingEssay, setEditingEssay] = useState<number | null>(null);
  const [essayDraft, setEssayDraft] = useState<{ applicationId: string; answerIndex: number; text: string } | null>(null);
  const [pendingNavigation, setPendingNavigation] = useState<{ run: () => void } | null>(null);
  const [cancellationId, setCancellationId] = useState<string | null>(null);
  const [, updateBrowserClock] = useState(0);
  const applicationList = useRef<HTMLDivElement>(null);
  const [factCorrection, setFactCorrection] = useState<{ applicationId: string; facts: VerifiedFact[]; claim: string } | null>(null);
  const [lastFactCorrection, setLastFactCorrection] = useState<{ owner: string; applicationId: string; before: VerifiedFact[]; after: VerifiedFact[] } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [dismissJobId, setDismissJobId] = useState<string | null>(null);
  const [dismissDraft, setDismissDraft] = useState<{ owner: string; jobId: string; reason: string } | null>(null);
  const dismissReason = dismissDraft?.owner === data?.profile.id && dismissDraft?.jobId === dismissJobId ? dismissDraft.reason : "";
  const [feedbackNotice, setFeedbackNotice] = useState<{ message: string; savedGroup?: boolean; batchResult?: { confirmed: number; total: number }; compactMessage?: string; undo?: { jobId: string; kind: "saved" | "clear" }; reasonFor?: string; returnView?: BrowseView; postingUrl?: string } | null>(null);
  const [importFields, setImportFields] = useState(emptyImport);
  const sessionOwner = useRef<string | null>(null);
  const actionFocus = useRef<HTMLElement | null>(null);
  const [profileDraft, setProfileDraft] = useState<Profile | null>(null);
  const [factText, setFactText] = useState("");
  const [answerEdits, setAnswerEdits] = useState<{ applicationId: string; answers: ScreeningAnswer[] } | null>(null);
  const [blockerAnswers, setBlockerAnswers] = useState<Record<string, string>>({});

  useEffect(() => { if (confirmDiscardImport) keepImportEditing.current?.focus(); }, [confirmDiscardImport]);

  const refresh = useMemo(() => createWorkspaceRefresh<ViewState>(setData, setConnection), []);
  const reload = useCallback(() => refresh.reload(), [refresh]);
  useEffect(() => {
    let live = true;
    refresh.start();
    reload()
      .then((body) => {
        if (live) {
          try {
            const saved = readMatchesSession(window.sessionStorage, body.profile.id);
            if (saved) {
              setCollection(saved.view.collection); setFilter(saved.view.filter); setSearch(saved.view.search); setSort(saved.view.sort);
              setImportFields(saved.draft); setImportOpen(saved.importOpen);
              if (typeof saved.shortcutsEnabled === "boolean") setShortcutsEnabled(saved.shortcutsEnabled);
              if (saved.dismissDraft && body.jobs.some(job => job.id === saved.dismissDraft?.jobId) && body.feedback.some(item => item.jobId === saved.dismissDraft?.jobId && item.kind === "dismissed")) {
                setDismissDraft({ owner: body.profile.id, jobId: saved.dismissDraft.jobId, reason: saved.dismissDraft.reason });
                if (saved.dismissDraft.open) setDismissJobId(saved.dismissDraft.jobId);
              }
            }
            const navigation = readWorkspaceNavigation(window.sessionStorage, body.profile.id, body.applications.map(app => app.id));
            if (navigation) {
              setSection(navigation.section); setSelected(navigation.applicationId);
              setApplicationSearch(navigation.search); setAttentionOnly(navigation.attentionOnly);
            }
          } catch { /* Storage can be disabled by browser preferences. */ }
          sessionOwner.current = body.profile.id;
          setData(body);
          setProfileDraft({ ...structuredClone(body.profile), timeZone: body.profile.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone });
        }
      })
      .catch((err) => {
        if (live) setError(err.message);
      });
    return () => {
      live = false;
      refresh.stop();
    };
  }, [reload, refresh]);
  useEffect(() => {
    const owner = data?.profile.id;
    if (!owner || sessionOwner.current !== owner) return;
    try { writeMatchesSession(window.sessionStorage, owner, { view: { collection, filter, search, sort }, draft: importFields, importOpen, shortcutsEnabled, ...(dismissDraft?.owner === owner ? { dismissDraft: { jobId: dismissDraft.jobId, reason: dismissDraft.reason, open: dismissJobId === dismissDraft.jobId } } : {}) }); }
    catch { /* Keep working when browser storage is disabled. */ }
  }, [data?.profile.id, collection, filter, search, sort, importFields, importOpen, shortcutsEnabled, dismissDraft, dismissJobId]);
  const act = async (action: string, payload: Record<string, unknown> = {}) => {
    if (!data) return null;
    if (actionCheck) { setError(actionCheck.message); return null; }
    setFeedbackNotice(current => current?.batchResult ? { ...current, batchResult: undefined } : current);
    const launcher = document.activeElement;
    actionFocus.current = launcher instanceof HTMLElement && launcher.closest(".app-detail") ? launcher : null;
    setBusy(action);
    setBusyJob(String(payload.jobId ?? ""));
    setError("");
    setNotice("");
    let accepted = false;
    try {
      await postWorkspaceAction(action, payload);
      accepted = true;
      const next = await reload();
      setPendingActionCheck(null);
      if (["profile", "editPacket"].includes(action)) setProfileDraft(structuredClone(next.profile));
      if (["editPacket", "confirmEssay", "reviseEssay", "draft"].includes(action)) setAnswerEdits(current => current?.applicationId === payload.applicationId ? null : current);
      if (action === "editPacket") setNotice("Your answers are saved.");
      if (action === "reviseEssay") setNotice("Your essay revision is saved. Review and confirm the new wording.");
      if (action === "confirmEssay") setNotice("Essay confirmed. Your application has not been submitted.");
      return next;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Action failed.";
      if (accepted || actionNeedsWorkspaceCheck(message)) setPendingActionCheck({ owner: data.profile.id, action, message });
      setError(message);
      return null;
    } finally {
      setBusy("");
    }
  };
  useEffect(() => {
    if (batchProgress || !pendingBatchFocus.current) return;
    pendingBatchFocus.current = false;
    const frame = requestAnimationFrame(() => {
      const destination = document.querySelector<HTMLElement>('.inline-error .workspace-recovery-actions .dark-button, .inline-error .workspace-recovery-actions .text-button') ?? document.querySelector<HTMLElement>('.feedback-notice [data-match-action="review-saved"]') ?? document.querySelector<HTMLElement>('.batch-save-control button');
      destination?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [batchProgress, feedbackNotice]);
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
  const cancellation = applications.find(app => app.id === cancellationId);
  const view = matchView({ jobs, matches, feedback, filter, collection, search });
  const filtered = view.jobs;
  filtered.sort((a, b) => sort === "newest"
    ? (new Date(b.postedAt || b.discoveredAt).getTime() - new Date(a.postedAt || a.discoveredAt).getTime()) || a.id.localeCompare(b.id)
    : compareRankedJobs(a, b, matches, data?.feedback ?? [], jobs));
  const displayedApplications = applications.filter(app => {
    const job = jobs.find(item => item.id === app.jobId);
    return (!attentionOnly || needsApplicationReview(app)) && `${job?.company ?? ""} ${job?.title ?? ""} ${statusLabel(app.status)}`.toLowerCase().includes(applicationSearch.trim().toLowerCase());
  });
  const currentCollection = section === "applications" ? displayedApplications : applications;
  const activeApp = currentCollection.find(app => app.id === selected) ?? currentCollection[0];
  useEffect(() => {
    if (busy || !actionFocus.current) return;
    const launcher = actionFocus.current;
    actionFocus.current = null;
    const frame = requestAnimationFrame(() => {
      if (launcher.isConnected || document.activeElement !== document.body) return;
      const target = document.getElementById(`readiness-${activeApp?.id}`) ?? document.querySelector<HTMLElement>(".app-detail .status-pill");
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [busy, activeApp?.id]);
  useEffect(() => {
    const owner = data?.profile.id;
    if (!owner || sessionOwner.current !== owner) return;
    try { writeWorkspaceNavigation(window.sessionStorage, owner, { section, applicationId: activeApp?.id ?? null, search: applicationSearch, attentionOnly }); }
    catch { /* Browser preferences may disable access to session storage itself. */ }
  }, [data?.profile.id, section, activeApp?.id, applicationSearch, attentionOnly]);
  const answerDraft = answerEdits && answerEdits.applicationId === activeApp?.id ? answerEdits.answers : [];
  const setAnswerDraft = (answers: ScreeningAnswer[]) => setAnswerEdits(activeApp && answers.length ? { applicationId: activeApp.id, answers } : null);
  const answersDirty = Boolean(activeApp?.packet && answerDraft.length && JSON.stringify(answerDraft) !== JSON.stringify(activeApp.packet.answers));
  const appJob = jobs.find((job) => job.id === activeApp?.jobId);
  const hasCurrentBrowser = browserSessionAvailable(activeApp);
  const activeAppIsAutomatic = Boolean(activeApp?.autonomousAuthorization || activeApp?.importedOutcome);
  const hasAutomaticApplications = applications.some((app) => app.autonomousAuthorization || app.importedOutcome);
  const employerBlock = activeApp ? employerSubmissionBlock(activeApp) : undefined;
  const sharedUnknown = "Work authorization has not been confirmed.";
  const hasSharedUnknown = data?.matches.some(entry => entry.assessment.uncertainty.includes(sharedUnknown));
  const dismissedRole = jobs.find(job => job.id === dismissJobId);
  const unavailableSources = data?.discovery?.sources.filter(source => source.status === "unavailable").length ?? 0;
  const sourceFreshness = discoveryStatus(data?.discovery, data?.profile.demo ?? false);
  const importCheck = importInput(importFields.url);
  const existingImport = error === "This link is already in your catalog." ? roleForPosting(jobs, importFields.url) : undefined;
  const importReady = !importCheck.error && (!importCheck.manual || Boolean(importFields.company.trim() && importFields.title.trim()));
  const incompleteFacts = (data?.profile.facts ?? []).filter(
    (fact) => !fact.verified,
  ).length;
  const needsAction = applications.filter(needsApplicationReview);
  const discoveryEvents = (data?.discovery?.events ?? [])
    .filter((event) => event.kind === "arrived" || event.kind === "matched" || event.kind === "queued")
    .slice(-3)
    .reverse();
  const blockers = applications.flatMap((app) => (app.blockers ?? [])
    .filter((blocker) => (blocker.progress === "blocked" || blocker.progress === "resuming" || (blocker.reviewOnly && blocker.progress === "expired")) && blocker.userId === data?.profile.id)
    .map((blocker) => ({ blocker, app })));
  const quietActivity = needsAction.length === 0 && blockers.length === 0;

  useEffect(() => {
    const list = applicationList.current;
    if (section !== "applications" || !list) return;
    const keepSelectedVisible = () => {
      const item = list.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
      if (!item || list.scrollWidth <= list.clientWidth) return;
      const container = list.getBoundingClientRect();
      const selectedItem = item.getBoundingClientRect();
      if (selectedItem.left < container.left) list.scrollLeft += selectedItem.left - container.left;
      else if (selectedItem.right > container.right) list.scrollLeft += selectedItem.right - container.right;
    };
    keepSelectedVisible();
    const observer = new ResizeObserver(keepSelectedVisible);
    observer.observe(list);
    return () => observer.disconnect();
  }, [section, activeApp?.id]);

  useEffect(() => {
    if (section !== "matches" || !shortcutsEnabled) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.ctrlKey || event.metaKey || event.altKey || target.closest("input, textarea, select, [contenteditable], dialog") || document.querySelector("[popover]:popover-open")) return;
      if (event.key === "/") { event.preventDefault(); searchInput.current?.focus(); }
      if (event.key === "?") {
        event.preventDefault();
        const help = document.getElementById("matches-keyboard-help") as HTMLDetailsElement | null;
        const guidance = document.getElementById("matches-help") as HTMLDetailsElement | null;
        if (guidance) guidance.open = true;
        if (help) { help.open = true; help.querySelector<HTMLElement>("summary")?.focus(); }
      }
      if (!event.repeat && ["s", "d", "u"].includes(event.key)) {
        const role = target.closest("article");
        const action = event.key === "u"
          ? target.closest(".matches-workspace")?.querySelector<HTMLButtonElement>('[data-match-action="undo"]')
          : role?.querySelector<HTMLButtonElement>(event.key === "s" ? '[data-match-action="save"]' : '[data-match-action="dismiss"], [data-match-action="restore"]');
        if (action && !action.disabled) { event.preventDefault(); action.click(); }
      }
      if (event.key === "j" || event.key === "k") {
        const roles = Array.from(jobList.current?.querySelectorAll<HTMLElement>("article") ?? []);
        const index = roles.findIndex(role => role.contains(document.activeElement));
        const next = index < 0 ? 0 : Math.max(0, Math.min(roles.length - 1, index + (event.key === "j" ? 1 : -1)));
        if (roles[next]) { event.preventDefault(); roles[next].focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [section, shortcutsEnabled]);
  useEffect(() => {
    const expires = Date.parse(activeApp?.browserSessionExpiresAt ?? "");
    if (!activeApp?.browserSessionId || !Number.isFinite(expires) || expires <= Date.now()) return;
    const timer = window.setTimeout(() => updateBrowserClock(value => value + 1), Math.min(expires - Date.now() + 20, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [activeApp?.browserSessionId, activeApp?.browserSessionExpiresAt]);
  useEffect(() => {
    if (section !== "matches" || data?.profile.demo || !data?.personalSearch?.completedAt) return;
    const timer = window.setInterval(() => updateBrowserClock(value => value + 1), 60_000);
    return () => window.clearInterval(timer);
  }, [section, data?.profile.demo, data?.personalSearch?.completedAt]);
  useEffect(() => {
    if (!answersDirty && editingEssay === null) return;
    const protectDraft = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", protectDraft);
    return () => window.removeEventListener("beforeunload", protectDraft);
  }, [answersDirty, editingEssay]);

  const requestNavigation = useCallback((run: () => void) => {
    if (busy) return;
    if (section === "applications" && (answersDirty || editingEssay !== null)) setPendingNavigation({ run });
    else run();
  }, [busy, section, answersDirty, editingEssay, setPendingNavigation]);
  const navigateSection = (next: Section) => {
    if (next !== section) requestNavigation(() => setSection(next));
  };
  const openApplication = useCallback((id: string, resetCollection = true) => requestNavigation(() => {
    if (resetCollection) { setApplicationSearch(""); setAttentionOnly(false); }
    setSelected(id);
    setAnswerEdits(null);
    setEditingEssay(null);
    setEssayDraft(null);
    setNotice("");
    setError("");
    setSection("applications");
  }), [requestNavigation, setApplicationSearch, setAttentionOnly, setSelected, setAnswerEdits, setEditingEssay, setEssayDraft, setNotice, setError, setSection]);
  const switchApplication = (id: string) => { if (id !== activeApp?.id) openApplication(id, false); };
  useEffect(() => {
    if (section !== "applications") return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.ctrlKey || event.metaKey || event.altKey || target.closest("input, textarea, select, [contenteditable], dialog") || document.querySelector("[popover]:popover-open")) return;
      if (event.key === "/") { event.preventDefault(); const tools = document.getElementById("application-collection-tools") as HTMLDetailsElement | null; if (tools) tools.open = true; applicationSearchInput.current?.focus(); }
      if (event.key === "?") { event.preventDefault(); const help = document.getElementById("applications-help") as HTMLDetailsElement | null; if (help) { help.open = true; help.querySelector<HTMLInputElement>("input")?.focus(); } }
      if (event.key === "j" || event.key === "k") {
        const current = displayedApplications.findIndex(app => app.id === activeApp?.id);
        const next = current + (event.key === "j" ? 1 : -1);
        if (next >= 0 && next < displayedApplications.length) { event.preventDefault(); openApplication(displayedApplications[next].id, false); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [section, displayedApplications, activeApp?.id, openApplication]);

  useEffect(() => {
    if (!pendingRoleFocus.current) return;
    const role = document.getElementById(`role-${pendingRoleFocus.current}`)?.closest("article") ?? document.getElementById("matches-heading");
    if (role instanceof HTMLElement) { role.focus({ preventScroll: true }); role.scrollIntoView({ block: "nearest" }); pendingRoleFocus.current = null; }
  }, [data, feedbackNotice]);
  const continueAfterRemoval = (jobId: string) => {
    const index = filtered.findIndex(item => item.id === jobId);
    const adjacent = filtered[index + 1] ?? filtered[index - 1];
    pendingRoleFocus.current = adjacent?.id ?? "__heading__";
    feedbackReturnFocus.current = adjacent?.id ?? null;
  };
  useEffect(() => {
    if (section !== "profile" || !pendingSetupFocus.current) return;
    document.getElementById(pendingSetupFocus.current)?.focus();
    pendingSetupFocus.current = null;
  }, [section]);
  const revealRole = (job: Job, message: string, dismissed = feedback.get(job.id)?.kind === "dismissed") => {
    const previousView = { collection, filter, search, sort };
    setImportOpen(false); setCollection(dismissed ? "dismissed" : "all"); setFilter("all"); setSearch(`${job.company} ${job.title}`);
    pendingRoleFocus.current = job.id;
    feedbackReturnFocus.current = job.id;
    setFeedbackNotice({ message, returnView: previousView });
  };
  const baseError = activeError === "This link is already in your catalog." ? "This role is already in your list." : activeError === "AUTH_REQUIRED" ? "Sign in to open your workspace." :
    /failed to fetch|networkerror|load failed/i.test(activeError) ? "Connection lost. Check your internet connection, then refresh your workspace." : activeError;
  const batchRecovery = section === "matches" && actionCheck?.action === "feedback" ? feedbackNotice?.batchResult : undefined;
  const outcomeUncertainty = batchRecovery ? batchRecovery.confirmed === batchRecovery.total ? "Your saves were confirmed, but the role list is out of date." : "Remaining save outcomes need checking." : actionCheck?.action === "import" ? "We couldn’t confirm whether this role was added." : actionCheck?.action === "feedback" ? "We couldn’t confirm whether your collection changes were saved." : "We couldn’t confirm whether your changes were saved.";
  const displayError = actionCheck && !requiresSignIn ? activeError !== actionCheck.message ? `${baseError} ${outcomeUncertainty}` : `${outcomeUncertainty} Refresh your workspace to check the latest status before trying again.` : baseError;
  const retryWorkspace = async () => {
    setBusy("reload");
    try { const next = await reload(); setProfileDraft(current => current ?? structuredClone(next.profile)); setError(""); setPendingActionCheck(null);
      if (batchRecovery) { pendingBatchFocus.current = true; setFeedbackNotice({ message: "Save status refreshed. Review your saved roles.", compactMessage: "Save status refreshed.", savedGroup: true }); }
    }
    catch (err) { setError(err instanceof Error && err.message === "AUTH_REQUIRED" ? "AUTH_REQUIRED" : "Could not refresh your workspace. Check your connection and try again."); }
    finally { setBusy(""); }
  };

  if (!data)
    return (
      <div className="loading">
        <div className="brand">
          Apply<span>.</span>
        </div>
        {error ? (
          <div className="errorbox" role="alert">
            {displayError} {error === "AUTH_REQUIRED" && <a href="/login">Sign in</a>}
            <button className="outline-action" disabled={Boolean(busy)} onClick={retryWorkspace}>{busy === "reload" ? "Refreshing…" : "Retry workspace"}</button>
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
          <p role="status">Opening your workspace…</p>
        )}
      </div>
    );

  const correctClaim = (factIds: string[], claim: string) => {
    if (!activeApp) return;
    requestNavigation(() => {
      setEditingEssay(null);
      setError("");
      setFactCorrection({ applicationId: activeApp.id, facts: structuredClone(data.profile.facts.filter(fact => factIds.includes(fact.id))), claim });
    });
  };


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
                        "cancelled",
                      ].includes(activeApp.status) && (
                        <div className="step-card">
                          <div className="card-title">
                            <FileText size={20} />
                            <h3>Application materials</h3>
                            <span>Version {activeApp.packet.version}</span>
                          </div>
                          <div id={`resume-review-${activeApp.id}`}>
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
                              onReviewProfile={() => correctClaim(activeApp.packet!.resumeLines.flatMap((line) => line.factIds), "Application resume")}
                              onCorrectClaim={activeApp.status === "draft_review" ? correctClaim : undefined}
                              onRebuildResume={activeApp.status === "draft_review" ? () => act("draft", { applicationId: activeApp.id, draftMode: "resume" }) : undefined}
                              rebuildDisabled={Boolean(busy) || Boolean(activeApp.queuedRun)}
                            />
                          ) : activeApp.packet.schemaVersion === 2 && activeApp.packet.resumeDocument ? (
                            <ResumeReview profile={data.profile} document={activeApp.packet.resumeDocument} applicationId={activeApp.id} pdfHash={activeApp.packet.files?.find((file) => file.kind === "resume")?.sha256 ?? ""} onCorrectClaim={activeApp.status === "draft_review" ? correctClaim : undefined} />
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
                                  Verified source: {line.factIds.map((id) => data.profile.facts.find((fact) => fact.id === id)?.text ?? "Source unavailable").join("; ")}
                                </small>
                                {activeApp.status === "draft_review" && <button type="button" className="text-button" onClick={() => correctClaim(line.factIds, line.text)}>Correct or unconfirm source facts</button>}
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
                          </div>
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
                          <div className="answers" id={`screening-answers-${activeApp.id}`}>
                            <h4>Screening answers</h4>
                            <p className="muted">Review AI drafts, edit wording if needed, then confirm each essay. Personal and consent answers come from you.</p>
                            {activeApp.packet.answers.map((answer, i) => (
                              <div className="screening-answer" key={i}>
                                <label htmlFor={`screening-${activeApp.id}-${i}`}>{answer.question}</label>
                                {answerOwner(answer.question) === "ai" && answerReviewHash(answer) ? <>
                                  <EssayReview key={`${activeApp.id}-${i}-${answerReviewHash(answer)}`} answer={answer} facts={data.profile.facts}
                                    inputId={`screening-${activeApp.id}-${i}`} editable={activeApp.status === "draft_review"}
                                    editing={editingEssay === i}
                                    blocked={Boolean(busy) || Boolean(activeApp.queuedRun) || Boolean(activeApp.materialsStale) || answersDirty || (editingEssay !== null && editingEssay !== i)}
                                    onEditingChange={(editing) => { setEditingEssay(editing ? i : null); setEssayDraft(editing ? { applicationId: activeApp.id, answerIndex: i, text: answer.answer } : null); }}
                                    onDraftChange={(text) => setEssayDraft({ applicationId: activeApp.id, answerIndex: i, text })}
                                    onSave={(text) => act("reviseEssay", { applicationId: activeApp.id, packetHash: activeApp.packetHash, answerIndex: i, answerHash: answerReviewHash(answer), text })} />
                                  {!answer.confirmedAt && activeApp.status === "draft_review" && <button className="outline-action"
                                    disabled={Boolean(busy) || Boolean(activeApp.queuedRun) || Boolean(activeApp.materialsStale) || answersDirty || editingEssay !== null}
                                    onClick={() => act("confirmEssay", { applicationId: activeApp.id, packetHash: activeApp.packetHash, answerIndex: i, answerHash: answerReviewHash(answer) })}>Confirm essay</button>}
                                </> : <>
                                  <textarea id={`screening-${activeApp.id}-${i}`} maxLength={4000}
                                    disabled={activeApp.status !== "draft_review" || Boolean(activeApp.materialsStale) || Boolean(busy) || Boolean(activeApp.queuedRun) || editingEssay !== null}
                                    readOnly={answerOwner(answer.question) === "ai"} value={(answerDraft[i] ?? answer).answer}
                                    onChange={(event) => {
                                      if (answerOwner(answer.question) === "ai") return;
                                      const draft = [...(answerDraft.length ? answerDraft : activeApp.packet!.answers)];
                                      draft[i] = { ...draft[i], answer: event.target.value, userProvided: true, requiresUserInput: false };
                                      setAnswerDraft(draft);
                                    }} />
                                  <small>{answerOwner(answer.question) === "ai" ? "AI draft needed · use Write essays with AI below" : answersDirty && answerDraft[i]?.answer !== answer.answer ? "Your answer · unsaved changes" : answer.requiresUserInput && !answer.userProvided ? "Human-only · your answer needed" : answer.userProvided ? "Your own answer" : "From your confirmed profile"}</small>
                                </>}
                              </div>
                            ))}
                          </div>
                          {activeApp.status === "draft_review" && (
                            <>
                            <PacketReadiness application={activeApp} stale={activeApp.materialsStale} pendingAnswers={answerDraft} dirty={answersDirty} busy={busy} notice={notice} editingEssay={editingEssay !== null} />
                            <div className="action-row">
                              <button
                                id={`save-answers-${activeApp.id}`}
                                className="outline-action"
                                disabled={Boolean(busy) || Boolean(activeApp.queuedRun) || Boolean(activeApp.materialsStale) || !answersDirty || editingEssay !== null}
                                onClick={() =>
                                  act("editPacket", {
                                    applicationId: activeApp.id,
                                    answers: answerDraft.length
                                      ? answerDraft
                                      : activeApp.packet!.answers,
                                  })
                                }
                              >
                                {busy === "editPacket" ? "Saving answers…" : "Save my answers"}
                              </button>
                              {answersDirty && <button className="text-button" disabled={Boolean(busy) || editingEssay !== null} onClick={() => setAnswerDraft(activeApp.packet!.answers)}>Cancel answer changes</button>}
                              <details className="material-tools"><summary>Revise or rebuild materials</summary>
                              <button className="outline-action" disabled={Boolean(busy) || Boolean(activeApp.queuedRun) || answersDirty || editingEssay !== null}
                                onClick={() => act("draft", { applicationId: activeApp.id, draftMode: "essays" })}>Write essays with AI</button>
                              <button className="outline-action" disabled={Boolean(busy) || Boolean(activeApp.queuedRun) || answersDirty || editingEssay !== null}
                                onClick={() => act("draft", { applicationId: activeApp.id, draftMode: "resume" })}>Rebuild resume</button>
                              </details>
                              <p className="target-url">
                                Employer destination:{" "}
                                <a
                                  href={appJob.applyUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {new URL(appJob.applyUrl).hostname} ↗
                                </a>
                              </p>
                              <button
                                id={`packet-approval-${activeApp.id}`}
                                className="dark-button"
                                disabled={
                                  Boolean(busy) || Boolean(activeApp.queuedRun) ||
                                  answersDirty || editingEssay !== null || Boolean(activeApp.materialsStale) ||
                                  activeApp.packet.answers.some(answerNeedsAction)
                                }
                                onClick={() =>
                                  act("approveFill", {
                                    applicationId: activeApp.id,
                                    packetHash: activeApp.packetHash,
                                  })
                                }
                              >
                                {busy === "approveFill" ? "Recording approval…" : "Approve materials for form filling"}
                              </button>
                            </div>
                            </>
                          )}
                        </div>
                      );
  const activityContent = <>
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
                  <small>{data.profile.demo ? "Source checks" : "Expected check frequency"}</small>
                  <strong>{data.profile.demo ? "Demo workspace" : "About every 4 hours"}</strong>
                  <p>{data.profile.demo ? "Demo listings do not run live source checks." : "Supported sources are checked for new roles."}</p>
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
                  <p>{data.automation.enabled ? "Enabled automation can prepare and submit applications using your saved settings." : "Find opportunities, then choose what to prepare."}</p>
                  <button onClick={() => navigateSection("settings")}>
                    Adjust search settings <ArrowRight size={15} />
                  </button>
                </div>
              </div>
  </>;

  const signOut = async () => {
    setBusy("signout");
    try {
      const { error: signOutError } = await browserSupabase().auth.signOut();
      if (signOutError) throw signOutError;
      router.replace("/login");
      router.refresh();
    } catch {
      setError("Could not sign out. Check your connection and try again.");
      setBusy("");
    }
  };

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
  const batchCandidates = filtered.filter(job => feedback.get(job.id)?.kind !== "saved" && feedback.get(job.id)?.kind !== "dismissed").slice(0, 20);
  const saveFilteredRoles = async () => {
    if (busy || batchActive.current || needsWorkspaceCheck || batchCandidates.length < 2) return;
    batchActive.current = true;
    const ids = batchCandidates.map(job => job.id);
    const owner = data.profile.id;
    batchCancel.current = false;
    setBusy("saving-view"); setBusyJob(""); setError("");
    setBatchProgress({ done: 0, total: ids.length });
    let ownerChanged = false;
    try {
      const result = await saveRoleBatch(ids, {
        cancelled: () => batchCancel.current,
        onProgress: done => setBatchProgress(current => current ? { ...current, done } : null),
        save: async jobId => {
          await postWorkspaceAction("feedback", { jobId, kind: "saved", expectedKind: "clear", expectedOwnerId: owner });
        },
      });
      const count = result.savedIds.length;
      setFeedbackNotice({ batchResult: { confirmed: count, total: ids.length }, message: result.error ? `Confirmed ${count} of ${ids.length} saves. Refresh to check remaining roles before trying again.` : `Saved ${count} of ${ids.length} roles from this view.${result.stopped ? " Stopped further saves." : " Review them in Saved."}`, compactMessage: result.error ? `Interrupted. ${count}/${ids.length} saves confirmed.` : result.stopped ? `Stopped. Saved ${count}/${ids.length}.` : `Saved ${count} roles.`, savedGroup: count > 0 });
      if (result.error) {
        setError(result.error);
        if (actionNeedsWorkspaceCheck(result.error)) setPendingActionCheck({ owner, action: "feedback", message: result.error });
      }
      try {
        const next = await reload();
        setPendingActionCheck(null);
        if (next.profile.id !== owner) { ownerChanged = true; setFeedbackNotice(null); setError(""); }
        else if (result.error && actionNeedsWorkspaceCheck(result.error)) {
          setError("");
          setFeedbackNotice({ message: "Save status refreshed. Review your saved roles.", compactMessage: "Save status refreshed.", savedGroup: true });
        }
      } catch (err) {
        const message = "The save status could not be refreshed. Refresh your workspace to check which roles were saved before trying again.";
        setPendingActionCheck({ owner, action: "feedback", message: result.error && actionNeedsWorkspaceCheck(result.error) ? result.error : message });
        setError(err instanceof Error && err.message === "AUTH_REQUIRED" ? "AUTH_REQUIRED" : message);
      }
    } finally { batchActive.current = false; pendingBatchFocus.current = !ownerChanged; setBatchProgress(null); setBusy(""); }
  };
  const emptyPersonalView = !data.profile.demo && jobs.length === 0 && !search.trim() && filter === "all" && collection === "all";
  const personalStatus = <PersonalSearchStatus profile={data.profile} search={data.personalSearch} onConfigure={() => {
    pendingSetupFocus.current = !data.profile.name.trim() ? "setup-basic-name" : !data.profile.facts.some(fact => fact.verified && fact.text.trim()) ? "confirmed-resume-facts" : "search-preferences";
    navigateSection("profile");
  }} onImport={() => { setError(""); setImportOpen(true); }} />;
  return (
    <div className={`shell ${section === "matches" ? "matches-workspace" : section === "applications" ? "applications-workspace" : ""}`}>
      <aside className="sidebar">
        <div className="identity">
          <div className="brand">
            Apply<span>.</span>
          </div>
          {section !== "matches" && <p>
            Real opportunities.
            <br />A brighter next step.
          </p>}
        </div>
        <nav aria-label="Main navigation">
          {nav.map(({ key, label, icon: Icon, count }) => (
            <button
              key={key}
              aria-label={label}
              aria-describedby={key === "applications" && count ? "application-attention-count" : undefined}
              aria-current={section === key ? "page" : undefined}
              title={label}
              className={`navitem ${section === key ? "active" : ""}`}
              onClick={() => navigateSection(key)}
            >
              <Icon size={21} strokeWidth={1.8} />
              <span className="nav-label">{key === "settings" ? "Settings" : label}</span>
              {Boolean(count) && <b aria-hidden="true">{count}</b>}
              {key === "applications" && Boolean(count) && <span className="sr-only" id="application-attention-count">{count} applications need your attention</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-tools"><a href="/usage">AI usage</a><a href="/pilot">Autonomy pilot</a></div>
        <button className="sidebar-more" popoverTarget="more-pages" aria-label="More pages"><Menu size={20} /><span>More</span></button>
        <div id="more-pages" popover="auto" className="more-pages">
          {section === "matches" && <button popoverTarget="matches-activity">Agent activity</button>}
          <a href="/usage">AI usage</a><a href="/pilot">Autonomy pilot</a>
          {!data.profile.demo && <div className="responsive-account">
            <p>Workspace: {data.profile.name || "Your profile"}</p>
            <button disabled={Boolean(busy)} onClick={signOut}>{busy === "signout" ? "Signing out…" : "Sign out"}</button>
          </div>}
        </div>
        {!data.profile.demo && <button className="tablet-signout" disabled={Boolean(busy)} onClick={signOut} title={`Workspace: ${data.profile.name || "Your profile"}`}>{busy === "signout" ? "Signing out…" : "Sign out"}</button>}
        {(section !== "matches" || !data.profile.demo) && <div className="sidebar-foot">
          {section !== "matches" && <div className="foot-icon">
            <Sparkles size={19} />
          </div>}
          <div>
            {section !== "matches" && <><strong>Built for what’s next.</strong>
            <small>From campus to career and beyond.</small></>}
            {!data.profile.demo && (
              <button
                className="signout"
                disabled={Boolean(busy)}
                onClick={signOut}
              >
                {busy === "signout" ? "Signing out…" : "Sign out"}
              </button>
            )}
          </div>
        </div>}
      </aside>
      <div className="body-area">
        <header className="topbar">
          {section !== "matches" && <div className="top-context">
            AI assisted job search <span> / </span>{" "}
            {section === "applications"
                ? "Applications"
                : section === "profile"
                  ? "Profile"
                  : "Preferences"}
          </div>}
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
        {connection !== "current" && <div className="workspace-connection" role="status">
          <p>{connection === "auth-required" ? "Sign in to resume updates. Showing the last received list." : "Reconnecting. Showing the last received list."}</p>
          {connection === "auth-required" ? <a className="text-button" href="/login">Sign in</a> : <button className="text-button" disabled={Boolean(busy)} onClick={retryWorkspace}>{busy === "reload" ? "Refreshing…" : "Retry updates"}</button>}
        </div>}
        {busy && <p className="workspace-progress" role="status">{busy === "saving-view" ? `${batchProgress?.stopping ? "Stopping after the current save" : "Saving this view"}: ${batchProgress?.done ?? 0} of ${batchProgress?.total ?? 0} roles…` : busy === "feedback" ? "Updating your job collection…" : busy === "import" ? "Checking the posting and adding its details…" : busy === "reload" ? "Refreshing your workspace…" : "Updating your workspace…"}{batchProgress && <button className="text-button" disabled={batchProgress.stopping} onClick={() => { batchCancel.current = true; setBatchProgress(current => current ? { ...current, stopping: true } : null); }}>{batchProgress.stopping ? "Stopping…" : "Stop further saves"}</button>}</p>}
        {activeError && !importOpen && !dismissJobId && !(section === "matches" && busyJob && filtered.some(job => job.id === busyJob)) && (
          <div className="inline-error" role="alert">
            <CircleHelp size={18} />
            <div>{batchRecovery && <strong>This batch: {batchRecovery.confirmed} of {batchRecovery.total} saves confirmed. </strong>}{displayError}{!actionCheck && <p>Refresh the workspace to check the latest status.</p>}<div className="workspace-recovery-actions">{requiresSignIn && <a className="dark-button" href="/login">Sign in</a>}<button className={needsWorkspaceCheck && !requiresSignIn ? "dark-button" : "text-button"} disabled={Boolean(busy)} onClick={retryWorkspace}>{busy === "reload" ? "Refreshing…" : "Refresh workspace"}</button></div></div>
            {!actionCheck && <button onClick={() => setError("")} aria-label="Dismiss error">
              <X size={17} />
            </button>}
          </div>
        )}
              {section === "matches" && feedbackNotice && !batchRecovery && <div className="feedback-notice matches-feedback-rail" role="status">
                <span className="feedback-summary" title={feedbackNotice.message}>{feedbackNotice.compactMessage ?? feedbackNotice.message}</span>
                {feedbackNotice.savedGroup && <button className="text-button" disabled={Boolean(batchProgress)} data-match-action="review-saved" onClick={() => { setFeedbackNotice({ ...feedbackNotice, savedGroup: false, returnView: { collection, filter, search, sort } }); setCollection("saved"); setFilter("all"); setSearch(""); }}>Review saved</button>}
                {feedbackNotice.undo && <button className="text-button" data-match-action="undo" aria-keyshortcuts={shortcutsEnabled ? "u" : undefined} aria-label="Undo dismissal" disabled={Boolean(busy) || needsWorkspaceCheck} onClick={async () => {
                  const undo = feedbackNotice.undo;
                  if (!undo) return;
                  const next = await act("feedback", undo);
                  if (next) {
                    if (dismissDraft?.jobId === undo.jobId) setDismissDraft(null);
                    if (collection === "dismissed") continueAfterRemoval(undo.jobId);
                    else { pendingRoleFocus.current = undo.jobId; feedbackReturnFocus.current = undo.jobId; }
                    const restoredRole = next.jobs.find(role => role.id === undo.jobId);
                    setFeedbackNotice({ message: restoredRole ? `${restoredRole.title} at ${restoredRole.company} is back in your matches.` : "Dismissal undone. The role is back in your matches." });
                  }
                }}>Undo</button>}
                {feedbackNotice.returnView && <button className="text-button" aria-label="Return to previous view" onClick={() => {
                  const previous = feedbackNotice.returnView!;
                  setCollection(previous.collection); setFilter(previous.filter); setSearch(previous.search); setSort(previous.sort); setFeedbackNotice(null);
                  document.getElementById("matches-heading")?.focus();
                }}>Previous view</button>}
                {feedbackNotice.reasonFor && <button className="text-button" disabled={Boolean(busy) || needsWorkspaceCheck} onClick={() => { setError(""); if (dismissDraft?.owner !== data.profile.id || dismissDraft.jobId !== feedbackNotice.reasonFor) setDismissDraft(null); setDismissJobId(feedbackNotice.reasonFor!); }}>Add reason</button>}
                <details className="feedback-options" key={feedbackNotice.message}>
                  <summary aria-label="More feedback options" title="Feedback details"><Menu size={18} /><span>Details</span></summary>
                  <div className="feedback-details">
                    {feedbackNotice.compactMessage && <p>{feedbackNotice.message}</p>}
                    {feedbackNotice.postingUrl && <a href={feedbackNotice.postingUrl} target="_blank" rel="noreferrer">View original posting ↗</a>}
                    {!feedbackNotice.compactMessage && <p>{feedbackNotice.message}</p>}
                  </div>
                </details>
                <button aria-label="Close feedback message" onClick={() => { pendingRoleFocus.current = feedbackReturnFocus.current ?? "__heading__"; setFeedbackNotice(null); }}><X size={18} /></button>
              </div>}
        {section === "matches" && (
          <div className={`content-grid matches-content-scroll ${quietActivity ? "activity-quiet" : ""}`} role="region" aria-label="Matches workspace" tabIndex={0}>
            <main className={`main-panel matches-panel ${feedbackNotice ? "feedback-visible" : ""}`}>
              <div className="page-heading">
                <div>
                  <h1 id="matches-heading" tabIndex={-1}>Your next opportunities</h1>
                  <p>
                    {view.availableCount} roles available{jobs.length !== view.availableCount && <span className="catalog-count"> · {jobs.length} roles tracked</span>}<span className={`source-freshness ${unavailableSources ? "source-unavailable" : ""}`} role="status">{data.profile.demo ? sourceFreshness : data.personalSearch?.completedAt ? `Your search checked ${checkAge(data.personalSearch.completedAt)}` : "Personal search"}</span>
                  </p>
                </div>
                <div className="matches-heading-actions">
                <button className={`outline-action activity-launcher ${quietActivity ? "" : "activity-attention"}`} popoverTarget="matches-activity">Activity <ChevronDown size={15} /></button>
                <button
                  className="outline-action import-launcher"
                  aria-label="+ Import a job link"
                  onClick={() => { setError(""); setImportOpen(true); }}
                >
                  <span className="desktop-import-label">+ Import a job link</span><span className="compact-import-label">Import a link</span>
                </button>
                </div>
              </div>
              {!data.profile.demo && !emptyPersonalView && data.personalSearch?.status !== "complete" && personalStatus}
              {!emptyPersonalView && (!data.onboarding.complete ? <details className="profile-context setup-context">
                <summary aria-label={`Finish profile setup: ${data.onboarding.missing.length} items remaining. Next: ${onboardingMissingLabel(data.onboarding.missing[0] ?? "profile answers")}`}><span>{data.onboarding.missing.includes("workAuthorization") ? "Work authorization needs confirmation." : `Next: ${onboardingMissingLabel(data.onboarding.missing[0] ?? "profile answers")}.`}</span><small>Setup · {data.onboarding.missing.length}<ChevronDown size={15} /></small></summary>
                <div><p>Complete these profile items to improve your matches and enable automation:</p><ul>{data.onboarding.missing.map(item => <li key={item}>{onboardingMissingLabel(item)}</li>)}</ul><button className="text-button" onClick={() => { pendingSetupFocus.current = data.onboarding.missing[0] === "confirmedResumeFact" ? "confirmed-resume-facts" : `setup-${data.onboarding.missing[0]}`; navigateSection("profile"); }}>Review profile <ArrowRight size={15} /></button></div>
              </details> : hasSharedUnknown && <div className="profile-context" role="note">
                <span>Work authorization needs confirmation.</span>
                <button className="text-button" onClick={() => navigateSection("profile")}>Review profile</button>
              </div>)}

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
                      Review materials, complete a form, or check an uncertain
                      result.
                    </p>
                  </div>
                  <button onClick={() => navigateSection("applications")}>
                    Open applications <ArrowRight size={15} />
                  </button>
                </div>
              )}
              {!emptyPersonalView && <>
              <div className="matches-browse-controls">
              <div className="job-search">
                <label htmlFor="job-search">Search roles or companies <kbd>/</kbd></label>
                <div>
                  <Search size={18} aria-hidden="true" />
                  <input ref={searchInput} id="job-search" type="search" disabled={Boolean(batchProgress)} value={search} onChange={event => setSearch(event.target.value)} placeholder="Search job title or company" />
                  {search && <button disabled={Boolean(batchProgress)} aria-label="Clear search" onClick={() => setSearch("")}><X size={18} /></button>}
                </div>
              </div>
              <div className="collectionbar" role="group" aria-label="Job collection">
                {(["all", "saved", "dismissed"] as MatchCollection[]).map(scope => <button key={scope} disabled={Boolean(batchProgress)} className={`collection-filter ${collection === scope ? "selected" : ""}`} aria-pressed={collection === scope} onClick={() => setCollection(scope)}>
                  {scope === "saved" && <Bookmark size={16} aria-hidden="true" />}{scope === "all" ? "All roles" : scope === "saved" ? "Saved" : "Dismissed"} <span>{view.collections[scope]}</span>
                </button>)}
              </div>
              </div>
              <div className="matches-controls">
              <button className="mobile-filters-toggle" aria-expanded={filterOptionsOpen} aria-controls="match-filter-options" onClick={() => setFilterOptionsOpen(!filterOptionsOpen)}><Settings2 size={16} /><span><strong>Filter and sort</strong><small>{filtered.length} {filtered.length === 1 ? "role" : "roles"} · {filter === "all" ? "Any fit" : `${filter[0].toUpperCase() + filter.slice(1)} fit`} · {sort === "relevant" ? "Most relevant" : "Newest first"}</small></span><ChevronDown size={16} className={filterOptionsOpen ? "expanded" : ""} /></button>
              <div id="match-filter-options" className={`filterbar ${filterOptionsOpen ? "expanded" : "collapsed"}`}>
                <div className="filters" role="group" aria-label="Fit within this collection">
                  {(["all", "strong", "possible", "uncertain"] as Filter[]).map(item => <button key={item} disabled={Boolean(batchProgress)} aria-pressed={filter === item} className={filter === item ? "selected" : ""} onClick={() => setFilter(item)}>
                    {item === "all" ? "Any fit" : item[0].toUpperCase() + item.slice(1)} <span>{view.counts[item]}</span>
                  </button>)}
                </div>
                <div className="sort-options"><label className="sort-control">Sort <select disabled={Boolean(batchProgress)} aria-label="Sort roles" aria-describedby="sort-help" value={sort} onChange={event => setSort(event.target.value as "relevant" | "newest")}><option value="relevant">Most relevant</option><option value="newest">Newest first</option></select></label><p id="sort-help">{sort === "relevant" ? "Relevance considers fit and your feedback." : "Newest uses the posting date, or when we found the role."}</p></div>
                {collection !== "dismissed" && (search.trim() || filter !== "all") && batchCandidates.length > 1 && <div className="batch-save-control"><button className="text-button" disabled={Boolean(busy) || needsWorkspaceCheck} onClick={saveFilteredRoles}>Save {batchCandidates.length === 20 ? "first 20" : batchCandidates.length} unsaved roles in this view</button></div>}
              </div>
              <div className="matches-subbar">
              <p className={`result-summary ${collection === "all" && filter === "all" && !search.trim() ? "sr-only" : ""}`} role="status">{filtered.length} {filtered.length === 1 ? "role" : "roles"} in {collection === "all" ? "all roles" : collection}{filter !== "all" && ` · ${filter} fit`}{search.trim() && ` for “${search.trim()}”`}</p>
              <details id="matches-help" className="matches-help matches-guidance">
                <summary aria-label="Fit and keyboard help">Help</summary>
              <details className="fit-guide matches-guidance">
                <summary><span className="desktop-guide-label">{data.automation.enabled ? "Automatic submission enabled" : "About fit and applying"}</span><span className="compact-guide-label">{data.automation.enabled ? "Auto apply on" : "Fit guide"}</span></summary>
                <p id="application-mode-note">{data.automation.enabled ? "Automation can prepare and submit applications using your saved settings." : "You approve materials and the filled form before submission."}</p>
                <button className="text-button" onClick={() => navigateSection("settings")}>{data.automation.enabled ? "Review automation settings" : "Review settings"}</button>
                <p>Fit compares the posting with your confirmed profile and search preferences. It does not confirm eligibility or guarantee an offer.</p>
                <p>Most relevant combines fit with your saved and dismissed feedback. Newest first uses the posting date, or the date we found the role when no posting date is available.</p>
                <dl>
                  <div><dt>Strong fit</dt><dd>Substantial overlap with your profile and preferences.</dd></div>
                  <div><dt>Possible fit</dt><dd>Some overlap, with requirements to review.</dd></div>
                  <div><dt>Uncertain</dt><dd>Important information is missing or needs verification.</dd></div>
                  <div><dt>Search rule conflict</dt><dd>The posting conflicts with a required search preference.</dd></div>
                </dl>
              </details>
              <details id="matches-keyboard-help" className="keyboard-guide matches-guidance">
                <summary aria-label={`Keyboard shortcuts${shortcutsEnabled ? "" : ", disabled"}`}><span className="desktop-shortcuts-label">Keyboard shortcuts</span><span className="compact-shortcuts-label">Shortcuts</span> {shortcutsEnabled ? <kbd>?</kbd> : <span>off</span>}</summary>
                <label className="shortcuts-toggle"><input type="checkbox" checked={shortcutsEnabled} onChange={event => setShortcutsEnabled(event.target.checked)} />Enable keyboard shortcuts</label>
                <p>Shortcuts pause while typing or using dialogs and menus. Save and dismiss act on the focused role.</p>
                <dl className="keyboard-list" aria-label="Matches shortcuts">
                  <div><dt><kbd>/</kbd></dt><dd>Search roles</dd></div>
                  <div><dt><kbd>j</kbd></dt><dd>Next role</dd></div>
                  <div><dt><kbd>k</kbd></dt><dd>Previous role</dd></div>
                  <div><dt><kbd>s</kbd></dt><dd>Save or Unsave</dd></div>
                  <div><dt><kbd>d</kbd></dt><dd>Dismiss or Restore</dd></div>
                  <div><dt><kbd>u</kbd></dt><dd>Undo dismissal</dd></div>
                </dl>
                <p>Shortcuts never prepare or submit an application.</p>
              </details>
              </details>
              </div>
              </div>
              </>}
              <div className="job-list" ref={jobList}>
                {filtered.length ? (
                  filtered.map((job) => {
                    const match = matches.get(job.id);
                    const application = applications.find(
                      (app) =>
                        app.jobId === job.id && app.status !== "cancelled",
                    );
                    const importedPreflight = job.source === "imported" && job.importCheck?.status !== "verified";
                    const rowChecks = [...new Set([...(match?.gaps ?? []), ...(match?.uncertainty ?? [])])].filter(check => check !== sharedUnknown);
                    const context = `${job.title} at ${job.company}`;
                    const evidence = matchEvidence(data.profile, job, match);
                    const checkCount = rowChecks.length;
                    const checkLabel = checkCount ? ` · ${checkCount} ${checkCount === 1 ? "thing" : "things"} to check` : "";
                    const preparing = busyJob === job.id && ["select", "startAutonomous", "preflightImportedPosting"].includes(busy);
                    return (
                      <article className="job-row" key={job.id} tabIndex={-1} aria-labelledby={`role-${job.id} company-${job.id}`}>
                        <div className="company-block">
                          <div className="company-mark">
                            {job.company.charAt(0)}
                          </div>
                          <div>
                            <strong id={`company-${job.id}`}>{job.company}</strong>
                            <small>{job.location}</small>
                            <small>
                              {job.salary ? `${job.salary} · ` : "Salary not listed · "}
                              {job.employmentType}
                            </small>
                          </div>
                        </div>
                        <div className="job-detail">
                          <h2 id={`role-${job.id}`}>{job.title}</h2>
                          <div className="badges">
                            <span
                              className={`match-badge ${match?.category ?? "uncertain"}`}
                            >
                              {match?.category === "strong"
                                ? "Strong fit"
                                : match?.category === "possible"
                                  ? "Possible fit"
                                  : match?.category === "excluded"
                                    ? "Search rule conflict"
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
                          <p className="fit-highlight">{evidence.headline}</p>
                          {rowChecks.length > 0 && <div className="job-review-note"><span><strong>{match?.category === "excluded" ? "Search rule conflict: " : "To review: "}</strong>{rowChecks[0]}</span></div>}
                          {job.importCheck && job.importCheck.status !== "verified" && <p className="job-review-note">{job.importCheck.message || "Posting details need verification on the employer site."}</p>}
                          <details className="fit-evidence">
                          <summary aria-label={`Review fit evidence for ${context}${checkLabel}`}>Review fit evidence{checkLabel}</summary>
                          {evidence.comparisons.length > 0 && <div className="evidence-comparison">
                            <strong>Posting terms found in confirmed facts</strong>
                            <p>Shared wording helps you compare. It does not establish that you meet a requirement.</p>
                            <dl>{evidence.comparisons.map(item => <div key={item.requirement}><dt>{item.requirement}</dt><dd>{item.fact}</dd></div>)}</dl>
                            <button className="text-button" onClick={() => navigateSection("profile")}>Review profile evidence</button>
                          </div>}
                          {!evidence.comparisons.length && evidence.listedSkills.length > 0 && <div className="evidence-comparison">
                            <p>This overlap comes from skills you listed. No confirmed fact excerpt is linked to these terms here.</p>
                            <button className="text-button" onClick={() => navigateSection("profile")}>Review profile evidence</button>
                          </div>}
                          <div className={`match-reasons ${evidence.detailedReasons.length ? "" : "only-checks"}`}>
                            {evidence.detailedReasons.length > 0 && <div>
                              <strong>Why it fits</strong>
                              <ul>
                                {evidence.detailedReasons.map((reason, i) => (
                                  <li key={i}>{reason}</li>
                                ))}
                              </ul>
                            </div>}
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
                          </details>
                        </div>
                        <div className="job-actions">
                          {collection === "dismissed" ? <button className="outline-action" data-match-action="restore" aria-keyshortcuts={shortcutsEnabled ? "d" : undefined} aria-label={`Restore role ${context}`} disabled={(Boolean(busy) || needsWorkspaceCheck)} onClick={async () => {
                            const next = await act("feedback", { jobId: job.id, kind: "clear" });
                            if (next) { continueAfterRemoval(job.id); setFeedbackNotice({ message: `${context} restored to your matches.` }); }
                          }}>{busy === "feedback" && busyJob === job.id ? "Restoring…" : "Restore role"}</button> : <>
                          <div className="small-actions">
                            <button
                              disabled={(Boolean(busy) || needsWorkspaceCheck)}
                              aria-label={`${feedback.get(job.id)?.kind === "saved" ? "Unsave" : "Save"} ${context}`}
                              data-match-action="save"
                              aria-keyshortcuts={shortcutsEnabled ? "s" : undefined}
                              aria-pressed={feedback.get(job.id)?.kind === "saved"}
                              onClick={async () => {
                                const saved = feedback.get(job.id)?.kind === "saved";
                                const next = await act("feedback", {
                                  jobId: job.id,
                                  kind: saved ? "clear" : "saved",
                                });
                                if (next) {
                                  if (saved && collection === "saved") continueAfterRemoval(job.id);
                                  else feedbackReturnFocus.current = job.id;
                                  setFeedbackNotice({ message: `${context} ${saved ? "removed from saved" : "saved"}.` });
                                }
                              }}
                            >
                              <Bookmark
                                size={17}
                                fill={
                                  feedback.get(job.id)?.kind === "saved"
                                    ? "currentColor"
                                    : "none"
                                }
                              />
                              {busy === "feedback" && busyJob === job.id ? "Updating…" : feedback.get(job.id)?.kind === "saved"
                                ? "Unsave"
                                : "Save"}
                            </button>
                            <button
                              disabled={(Boolean(busy) || needsWorkspaceCheck)}
                              data-match-action="dismiss"
                              aria-keyshortcuts={shortcutsEnabled ? "d" : undefined}
                              aria-label={`Dismiss ${context}`}
                              onClick={async () => {
                                const previousKind = feedback.get(job.id)?.kind === "saved" ? "saved" : "clear";
                                const next = await act("feedback", { jobId: job.id, kind: "dismissed" });
                                if (next) {
                                  continueAfterRemoval(job.id);
                                  setFeedbackNotice({ message: `${context} dismissed. Find it in Dismissed.`, compactMessage: `Dismissed: ${context}.`, undo: { jobId: job.id, kind: previousKind }, reasonFor: job.id });
                                }
                              }}
                            >
                              <X size={17} />
                              Dismiss
                            </button>
                          </div>
                          {application ? (
                            <button
                              className="dark-button"
                              aria-label={`View application for ${context}`}
                              onClick={() => openApplication(application.id)}
                            >
                              View application
                            </button>
                          ) : (
                            <button
                              className="dark-button"
                              aria-label={`${data.automation.enabled ? (importedPreflight ? "Verify and apply automatically for" : "Apply automatically for") : "Prepare application for"} ${context}`}
                              aria-describedby="application-mode-note"
                              disabled={
                                (Boolean(busy) || needsWorkspaceCheck) || match?.category === "excluded"
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
                                    openApplication(app.id);
                                  }
                                }
                              }}
                            >
                              {preparing ? "Preparing…" : data.automation.enabled ? (importedPreflight ? "Verify and apply automatically" : "Apply automatically") : "Prepare application"}
                            </button>
                          )}

                          </>}
                          <a
                            className="job-link"
                            aria-label={`View original posting for ${context} (opens in a new tab)`}
                            href={job.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            View original posting ↗
                          </a>
                          {activeError && busyJob === job.id && !dismissJobId && !importOpen && <div className="job-action-error" role="alert">
                            <p>{displayError}</p>
                            <p>Refresh to check the latest status for {context}. Your current view is preserved.</p>
                            <div className="workspace-recovery-actions">{error === "AUTH_REQUIRED" && <a href="/login">Sign in</a>}
                            <button className="text-button" disabled={Boolean(busy)} onClick={retryWorkspace}>{busy === "reload" ? "Refreshing…" : "Refresh workspace"}</button></div>
                          </div>}
                        </div>
                      </article>
                    );
                  })
                ) : (
                  <div className="empty">
                    <Search size={28} />
                    <h3>{search.trim() ? "No roles match your search" : filter !== "all" ? `No ${filter} fit roles in ${collection === "all" ? "all roles" : collection}` : collection === "saved" ? "Your shortlist starts here" : collection === "dismissed" ? "No dismissed roles" : !data.profile.demo && !personalSearchReadiness(data.profile).ready ? "Your personal search starts here" : !data.profile.demo && ["queued", "searching"].includes(data.personalSearch?.status ?? "") ? "Finding opportunities for you" : !data.profile.demo ? data.personalSearch?.status === "budget_limited" ? "Personal search is paused" : data.personalSearch?.status === "failed" ? "Your search needs another check" : data.personalSearch?.status === "complete" ? "No verified openings yet" : "Your profile is ready to search" : "No jobs in this view"}</h3>
                    {!emptyPersonalView && <p>{search.trim() ? "Try a different title or company, or clear your search." : filter !== "all" ? "Try another fit category, or show any fit in this collection." : collection === "saved" ? "Save roles from your matches to compare them here." : collection === "dismissed" ? "Roles you dismiss will appear here. You can restore them at any time." : !data.profile.demo && !personalSearchReadiness(data.profile).ready ? "Confirm your experience and save your search preferences. Your agent will start automatically." : !data.profile.demo && ["queued", "searching"].includes(data.personalSearch?.status ?? "") ? "Your agent is searching employer job boards using your profile and preferences. Results appear after the postings are verified." : !data.profile.demo && data.personalSearch?.status === "complete" ? "Your last search found no verified openings in this view. Your agent will search again every four hours. You can update your preferences or import a specific job link." : "Try another filter or import a job link."}</p>}
                    {emptyPersonalView && personalStatus}
                    {search.trim() && <button className="outline-action" onClick={() => setSearch("")}>Clear search</button>}
                    {filter !== "all" && <button className="outline-action" onClick={() => setFilter("all")}>Show any fit in this collection</button>}
                    {!search.trim() && (collection === "saved" || collection === "dismissed") && <button className="outline-action" onClick={() => { setCollection("all"); setFilter("all"); }}>Browse matches</button>}
                  </div>
                )}
              </div>
              <details className="search-status">
                <summary>Search status · {data.lastRefreshAt ? `workspace updated ${relative(data.lastRefreshAt)}` : "first check pending"}</summary>
              {!data.profile.demo && data.personalSearch?.completedAt && Number.isFinite(Date.parse(data.personalSearch.completedAt)) && <p>Personal search completed <time dateTime={data.personalSearch.completedAt}>{new Date(data.personalSearch.completedAt).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}</time>.</p>}
              {!data.profile.demo && data.personalSearch?.status === "complete" && !emptyPersonalView && personalStatus}
              <div className={`autonomy-strip ${data.automation.enabled ? "enabled" : data.automation.paused ? "paused" : "inactive"}`}>
                <div>
                  <strong>{data.automation.enabled ? "Applications can run automatically" : data.automation.paused ? "Automation is paused" : data.onboarding.complete ? "Automation is off" : "Finish setup before enabling automation"}</strong>
                  <p>{data.onboarding.complete ? "Your confirmed facts and saved settings are ready." : `Onboarding is incomplete: ${data.onboarding.missing.map(onboardingMissingLabel).join(", ")}.`}</p>
                </div>
                <button className="text-button" onClick={() => navigateSection("settings")}>Review settings <ArrowRight size={15} /></button>
              </div>
              {data.discovery && (data.profile.demo || data.personalSearch?.status === "complete") && (
                <section className="discovery-pulse" aria-label="Discovery freshness">
                  <div className="discovery-pulse-head">
                    <div>
                      <strong>{data.profile.demo ? "Public opportunity monitor" : "Your personal search"}</strong>
                      <p>{data.discovery.lastRefreshAt ? `Last checked ${relative(data.discovery.lastRefreshAt)}.` : "Waiting for your first personal search."}</p>
                    </div>
                    {data.profile.demo && <span>{data.discovery.sources.filter((source) => source.status === "available").length}/{data.discovery.sources.length || 0} sources available</span>}
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
              {(incompleteFacts > 0 || !data.profile.facts.some(fact => fact.verified)) && (
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
                    onClick={() => navigateSection("profile")}
                  >
                    Review profile
                  </button>
                </div>
              )}
              </details>
            </main>
            {!quietActivity && <aside className="activity-panel">{activityContent}</aside>}
            <aside id="matches-activity" popover="auto" className="activity-panel activity-popover">
              <button className="modal-close" aria-label="Close agent activity" popoverTarget="matches-activity" popoverTargetAction="hide"><X size={18} /></button>
              {activityContent}
            </aside>
          </div>
        )}
        {section === "applications" && (
          <main className="wide-panel applications-panel">
            <h1>Your applications</h1>
            <p className="subheading">
              {hasAutomaticApplications ? "Track your applications, review blocked items, and see saved employer confirmations." : "Review the details before the agent enters a form, then review the exact form before submission."}
            </p>
            <div className="application-utilities"><ApplicationHelp />
            {applications.length > 0 && <details className="collection-tools" id="application-collection-tools"><summary>Find or filter applications</summary><div className="application-tools">
              <label htmlFor="application-search">Search applications<input ref={applicationSearchInput} id="application-search" type="search" value={applicationSearch} maxLength={200} placeholder="Employer or role" disabled={Boolean(busy) || answersDirty || editingEssay !== null} onChange={event => setApplicationSearch(event.target.value)} /></label>
              <div className="application-filters" role="group" aria-label="Application collection">
                <button type="button" aria-pressed={!attentionOnly} disabled={Boolean(busy) || answersDirty || editingEssay !== null} onClick={() => setAttentionOnly(false)}>All applications ({applications.length})</button>
                <button type="button" aria-pressed={attentionOnly} disabled={Boolean(busy) || answersDirty || editingEssay !== null} onClick={() => setAttentionOnly(true)}>Needs your review ({needsAction.length})</button>
              </div>
              <p className="application-shortcuts">Outside a text field: <kbd>/</kbd> search · <kbd>j</kbd> next · <kbd>k</kbd> previous · <kbd>?</kbd> help</p>
            </div></details>}</div>
            {(applicationSearch.trim() || attentionOnly) && <div className="application-active-view" role="status">
              <span>{attentionOnly ? "Needs your review" : "All stages"}{applicationSearch.trim() && ` · Search: “${applicationSearch.trim()}”`} · {displayedApplications.length} of {applications.length} applications</span>
              <button type="button" className="text-button" disabled={Boolean(busy) || answersDirty || editingEssay !== null} onClick={() => { setApplicationSearch(""); setAttentionOnly(false); }}>Clear application filters</button>
            </div>}
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
                        {canRecheckImported ? <div className="blocker-resolution"><small>{importedPreflightHandoff(app)}</small>{job?.url && <a className="text-button" href={job.url} target="_blank" rel="noreferrer">Open employer posting</a>}<button className="outline-action" disabled={Boolean(busy) || blocker.progress === "resuming"} onClick={() => act("preflightImportedPosting", { jobId: app.jobId })}>{busy === "preflightImportedPosting" ? "Checking…" : "Check employer link again"}</button></div> : !blocker.reviewOnly && blocker.reason === "disabled_material" ? <button className="outline-action" disabled={Boolean(busy)} onClick={() => navigateSection("settings")}>Open search settings</button> : canAnswer ? <div className="blocker-resolution">
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
              <div className="application-collection" hidden={!applications.length}>
                <h2 className="application-count" role="status">{displayedApplications.length} of {applications.length} applications</h2>
                {(answersDirty || editingEssay !== null) && <p className="muted collection-change-note" role="status">Save or cancel your changes before switching applications.</p>}
                <ApplicationPicker options={displayedApplications.map(app => { const job = jobs.find(item => item.id === app.jobId); return { id: app.id, label: `${job?.title ?? "Application"} · ${job?.company ?? "Employer"} · ${statusLabel(app.status)}` }; })} selected={activeApp?.id ?? ""} blocked={Boolean(busy) || answersDirty || editingEssay !== null} onSelect={switchApplication} />
              <div className="app-list" ref={applicationList} hidden={!displayedApplications.length} aria-label="Your application list">
                {displayedApplications.length ? (
                  displayedApplications.map((app) => {
                    const job = jobs.find((item) => item.id === app.jobId);
                    return (
                      <button
                        key={app.id}
                        aria-pressed={activeApp?.id === app.id}
                        className={`app-list-item ${activeApp?.id === app.id ? "selected" : ""}`}
                        disabled={Boolean(busy) || answersDirty || editingEssay !== null}
                        onClick={() => switchApplication(app.id)}
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
                      onClick={() => navigateSection("matches")}
                    >
                      Browse matches →
                    </button>
                  </div>
                )}
              </div>
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
                    <span className="status-pill" role="status" aria-live="polite" tabIndex={-1}>
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
                    {!activeAppIsAutomatic && <ApplicationProgress key={activeApp.id} status={activeApp.status} />}
                    {activeApp.status === "cancelled" && <section className="step-card" aria-labelledby={`cancelled-${activeApp.id}`}>
                      <h3 id={`cancelled-${activeApp.id}`}>This attempt is cancelled</h3>
                      <p>Cancellation stopped this attempt before submission. {activeApp.packet ? "Your saved resume and answers remain available below." : "The role remains available in Matches."} Starting again creates a new attempt that needs a new review.</p>
                      {activeApp.browserReleasePending && <p role="status">Browser shutdown is still being confirmed. A new attempt must wait until that browser is released. Refresh the workspace to check its status.</p>}
                      <div className="action-row">
                        <button className="outline-action" disabled={Boolean(busy)} onClick={() => {
                          navigateSection("matches");
                          revealRole(appJob, "Your cancelled attempt is saved. Review this role before starting a new application.");
                        }}>Review this role in Matches</button>
                        <button className="text-button" disabled={Boolean(busy)} onClick={() => {
                          navigateSection("matches"); setCollection("all"); setFilter("all"); setSearch("");
                        }}>Browse other matches</button>
                      </div>
                    </section>}
                    {(activeApp.autonomousAuthorization || activeApp.importedOutcome) && <AutonomousApplicationStatus application={activeApp} busy={Boolean(busy)} checkResult={() => act("checkSubmissionResult", { applicationId: activeApp.id })} />}
                    {activeApp.queuedRun && (
                      <div className="step-card" role="status">
                        <h3>Application run queued</h3>
                        <p>{activeApp.queuedRun.reason === "budget" ? "The service spending limit is full. Your request is saved and will start when budget is available." : activeApp.queuedRun.reason === "active_run" ? "Finish or cancel your active browser session. This saved request will start afterward." : "Your saved request is waiting for a worker."}</p>
                      </div>
                    )}
                    {activeApp.status === "drafting" && <p role="status">Preparing your materials from confirmed facts…</p>}
                    {!activeAppIsAutomatic && activeApp.status === "selected" && !activeApp.queuedRun && (
                      <div className="step-card">
                        <h3>Prepare your application materials</h3>
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
                    {lastFactCorrection?.owner === data.profile.id && lastFactCorrection.applicationId === activeApp.id && <section className="fact-change-history" aria-label="Last source fact change">
                      <strong>Source facts saved</strong>
                      <p>You can undo this correction while these facts still match your saved changes. Other profile edits stay intact.</p>
                      <details><summary>Review your last source fact changes</summary>
                        {lastFactCorrection.before.map((fact, index) => <div key={fact.id}><p><strong>Before:</strong> {fact.text} · {fact.verified ? "confirmed" : "unconfirmed"}</p><p><strong>Saved:</strong> {lastFactCorrection.after[index]?.text} · {lastFactCorrection.after[index]?.verified ? "confirmed" : "unconfirmed"}</p></div>)}
                      </details>
                      <button className="text-button" disabled={Boolean(busy) || answersDirty || editingEssay !== null} onClick={async () => {
                        if (await act("profile", { factPatch: { expected: lastFactCorrection.after, updated: lastFactCorrection.before } })) {
                          setLastFactCorrection(null); setNotice("Source fact correction undone. Review your materials before approving.");
                        }
                      }}>Undo source fact changes</button>
                    </section>}
                    {!activeAppIsAutomatic && ["draft_review", "authorized_to_fill", "final_review", "approved_to_submit", "needs_user_action"].includes(activeApp.status) && activeApp.materialsStale && <section className="materials-update" role="status" id={`materials-update-${activeApp.id}`}>
                      <h3>Your profile changed</h3>
                      <p>The saved materials use earlier facts. Rebuild them, then review the new resume and essays before approving. Your personal answers stay with this application.</p>
                      {activeApp.status === "draft_review" ? <button className="dark-button" disabled={Boolean(busy) || Boolean(activeApp.queuedRun) || answersDirty || editingEssay !== null} onClick={() => act("draft", { applicationId: activeApp.id })}>Rebuild materials from updated facts</button> : <button className="dark-button" disabled={Boolean(busy) || !canReturnToMaterials(activeApp)} onClick={() => act("restartBrowser", { applicationId: activeApp.id })}>Return to materials review</button>}
                      {notice && <p>{notice}</p>}
                    </section>}
                    {activeApp.status === "draft_review" && <><PacketReadiness application={activeApp} stale={activeApp.materialsStale} pendingAnswers={answerDraft} dirty={answersDirty} busy={busy} notice={notice} editingEssay={editingEssay !== null} compact />{applicationMaterials}</>}
                    {!activeAppIsAutomatic && activeApp.status === "authorized_to_fill" && !activeApp.queuedRun && (
                      <div className="step-card">
                        <h3>Ready to fill the employer form</h3>
                        <p>
                          This opens a separate browser session and enters only the
                          materials you approved. You will review the filled form
                          before submission.
                        </p>
                        <button
                          className="dark-button"
                          disabled={Boolean(busy) || Boolean(activeApp.materialsStale)}
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
                          <p>{hasCurrentBrowser ? "The employer opened a CAPTCHA after your approved Submit click. Complete it in the browser below, then check the result. Do not click Submit again." : "The verification browser session ended. Check the employer confirmation or your email, then check the saved result. Do not start another submission while this attempt is unconfirmed."}</p>
                          <div className="action-row">
                            <button className="dark-button" disabled={Boolean(busy)} onClick={() => act("checkSubmissionResult", { applicationId: activeApp.id })}>
                              {busy === "checkSubmissionResult" ? "Checking confirmation…" : "I’m done · check result"}
                            </button>
                            {hasCurrentBrowser && activeApp.browserLiveUrl && <a className="text-button" href={activeApp.browserLiveUrl} target="_blank" rel="noreferrer">Open verification browser ↗</a>}
                            <button className="text-button" disabled={Boolean(busy)} onClick={() => act("stopSubmissionVerification", { applicationId: activeApp.id })}>Stop verification</button>
                          </div>
                          <p className="muted">Checking reads the existing attempt; it never submits again.{hasCurrentBrowser && activeApp.browserSessionExpiresAt && ` Browser available until ${new Date(activeApp.browserSessionExpiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`}</p>
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
                      {hasCurrentBrowser && hasUnreadableQuestionLabels(activeApp.form) ? <div className="step-card">
                        <h3>Update the form questions</h3>
                        <p>The employer’s question headings need to be read again before you answer. Your browser session and materials are saved.</p>
                        <button className="dark-button" disabled={Boolean(busy) || Boolean(activeApp.browserQuestionRun)} onClick={() => act("resumeBrowser", { applicationId: activeApp.id })}>Refresh questions</button>
                      </div> : !activeApp.materialsStale && hasCurrentBrowser && browserQuestions(activeApp.form).length > 0 && <BrowserQuestionsDialog key={`${activeApp.id}-${activeApp.browserSessionId}-${activeApp.form?.hash}`} application={activeApp} busy={busy} error={error} facts={data?.profile.facts ?? []} act={act} />}
                      <div className="step-card">
                        <h3>{!hasCurrentBrowser ? activeApp.browserSessionId ? "Your browser session ended" : "Start a fresh browser session" : browserTakeoverReasons(activeApp.form).length ? "Browser help needed" : "Your browser is saved"}</h3>
                        {hasCurrentBrowser && browserTakeoverReasons(activeApp.form).map((blocker) => <p key={blocker}>{blocker}</p>)}
                        <p>
                          {!hasCurrentBrowser ? "Your application materials are saved. Review them, then approve a new browser session to continue. Nothing will be submitted by restarting." : browserTakeoverReasons(activeApp.form).length ? "Complete the browser steps above, then refresh the form for review." : hasUnreadableQuestionLabels(activeApp.form) ? "Refresh the questions above to continue in this browser." : "You can inspect the browser at any time. Use the questions above to let the agent continue filling."}
                        </p>
                        {hasCurrentBrowser && activeApp.browserLiveUrl && (
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
                        {hasCurrentBrowser && <button
                          className="outline-action"
                          disabled={Boolean(busy)}
                          onClick={() =>
                            act("resumeBrowser", {
                              applicationId: activeApp.id,
                            })
                          }
                        >
                          Refresh form state
                        </button>}
                        {hasCurrentBrowser ? <details className="browser-restart-tools"><summary>Restart this browser instead</summary><p className="muted">This closes the current session. You will review your saved materials and approve another form fill before continuing.</p><button className="outline-action" disabled={Boolean(busy)} onClick={() => act("restartBrowser", { applicationId: activeApp.id })}>Review materials for a new session</button></details> : <button className="dark-button" disabled={Boolean(busy)} onClick={() => act("restartBrowser", { applicationId: activeApp.id })}>{busy === "restartBrowser" ? "Opening saved materials…" : "Review materials for a new browser session"}</button>}
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
                          <p>Your saved materials are available below whenever you need them.</p>
                          <button className="outline-action" onClick={() => navigateSection("matches")}>Browse more matches</button>
                          <details className="completion-feedback"><summary>Share time saved (optional)</summary><label>Minutes this application saved you<input type="number" min={0} max={240} defaultValue={activeApp.timeSavedMinutes ?? ""} onBlur={(event) => { if (event.target.value && Number(event.target.value) !== activeApp.timeSavedMinutes) act("timeSaved", { applicationId: activeApp.id, minutes: Number(event.target.value) }); }} /></label></details>
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
                            <>
                            <p className="approval-explanation">Approving authorizes this exact form for submission. It does not submit yet; next, you choose “Submit application once.”</p>
                            {activeApp.form.readyToSubmit === false && <div className="packet-readiness" role="status">
                              <h4>Complete the employer form before approving</h4>
                              <ul>{(activeApp.form.blockers?.length ? activeApp.form.blockers : ["Some employer fields still need attention. Check the browser, then refresh the form state."]).map((blocker, index) => <li key={index}>{blocker}</li>)}</ul>
                            </div>}
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
                                disabled={Boolean(busy) || Boolean(activeApp.materialsStale) || activeApp.form?.readyToSubmit === false}
                                onClick={() =>
                                  act("approveSubmit", {
                                    applicationId: activeApp.id,
                                    formHash: activeApp.form?.hash,
                                  })
                                }
                              >
                                Approve for submission
                              </button>
                            </div>
                            </>
                          )}
                          {activeApp.status === "approved_to_submit" && (
                            <div className="action-row">
                              <p>
                                Final approval recorded. The button below submits this application to {appJob?.company ?? "the employer"} once.
                              </p>
                              <button
                                className="dark-button"
                                disabled={Boolean(busy) || Boolean(activeApp.materialsStale)}
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
                            Review the employer’s instructions in your own browser. Your saved materials and confirmed essays are available below.{" "}
                            <a href={appJob.applyUrl} target="_blank" rel="noreferrer">Open employer application ↗</a>
                          </p>}
                          {activeApp.manualSubmissionReport && !activeApp.manualSubmissionReport.resolution && !activeApp.submissionAttemptedAt && <p>
                            The previous browser run has stopped. No new form fill has started.
                            Your saved materials and confirmed essays are available for review.
                          </p>}
                          {!activeApp.autonomousAuthorization && canReopenManualAttempt(activeApp) && <>
                            <p>Check the employer page or confirmation email first. Missing email alone does not confirm that an application failed.</p>
                            <label className="checkline">
                              <input type="checkbox" checked={confirmedUnacceptedId === activeApp.id} onChange={(event) => setConfirmedUnacceptedId(event.target.checked ? activeApp.id : null)} />
                              I confirmed this attempt did not submit an application.
                            </label>
                            <button className="outline-action" disabled={Boolean(busy) || confirmedUnacceptedId !== activeApp.id} onClick={() => act("reviewManualFailure", { applicationId: activeApp.id, confirmedNotAccepted: true })}>
                              Return to materials review
                            </button>
                            <p className="muted">This closes the old browser. Filling a new form requires your approval of its materials.</p>
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
                    {hasCurrentBrowser && <LiveBrowser key={`${activeApp.id}-${activeApp.browserSessionId || "pending"}`} application={activeApp} />}
                    {activeApp.status !== "draft_review" && applicationMaterials && (
                      <details className="packet-reference" key={`materials-${activeApp.id}-${activeApp.status}`}>
                        <summary>Saved application materials · version {activeApp.packet?.version}</summary>
                        {applicationMaterials}
                      </details>
                    )}
                    {activeApp.error && activeApp.status !== "uncertain" && !(activeApp.status === "needs_user_action" && !hasCurrentBrowser) && !activeAppIsAutomatic && (
                      <p className="inline-error">{activeApp.error}</p>
                    )}
                    {canCancelApplication(activeApp) ? (
                      <button
                        className="subtle-danger"
                        disabled={Boolean(busy)}
                        onClick={() => requestNavigation(() => setCancellationId(activeApp.id))}
                      >
                        Cancel this application
                      </button>
                    ) : null}
                  </>
                ) : (
                  <div className="empty" role="status">
                    <h2>{applications.length ? "No applications match this view" : "Start with a role you want"}</h2>
                    <p>{applications.length ? "Try another employer or role, or return to all applications." : "Choose a match to prepare your first application. You review the materials and the employer form before submission."}</p>
                    {applications.length ? <button className="outline-action" onClick={() => { setApplicationSearch(""); setAttentionOnly(false); }}>Show all applications</button> : <button className="dark-button" onClick={() => navigateSection("matches")}>Browse matches <ArrowRight size={16} /></button>}
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
                        id={`setup-basic-${key}`}
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
                <h3 id="search-preferences" tabIndex={-1}>Search preferences</h3>
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
                <p className="muted">Your personal search starts automatically once you save these preferences and confirm your experience. Leave titles and locations blank to let your agent use your confirmed experience.</p>
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
                    id="setup-workAuthorization"
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
                    id="setup-requiresSponsorship"
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
                <h3 id="confirmed-resume-facts" tabIndex={-1}>Resume and confirmed facts</h3>
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
            {section === "settings" && <AccountDeletionPanel demo={data.profile.demo} />}
          </main>
        )}
      </div>
      {dismissJobId && (
        <WorkspaceDialog labelledBy="dismiss-heading" describedBy="dismiss-role-context" onClose={() => setDismissJobId(null)}>
            <button
              className="modal-close"
              onClick={() => setDismissJobId(null)}
              aria-label="Close"
            >
              <X size={20} />
            </button>
            <h2 id="dismiss-heading">Add a dismissal reason</h2>
            <p id="dismiss-role-context" className="dismiss-role-context">{dismissedRole ? `${dismissedRole.title} at ${dismissedRole.company}` : "This role is no longer available."}</p>
            <p>Optional. Choose a reason only if it reflects your decision. It can guide the order of similar future matches.</p>
            <label>
              Reason
              <select
                value={dismissReason}
                disabled={busy === "feedback"}
                onChange={(event) => setDismissDraft({ owner: data.profile.id, jobId: dismissJobId, reason: event.target.value })}
              >
                {dismissalReasons.map(reason => <option key={reason} value={reason}>{reason || "No reason supplied"}</option>)}
              </select>
            </label>
            <button
              className="dark-button"
              disabled={Boolean(busy) || !dismissedRole || needsWorkspaceCheck}
              onClick={async () => {
                const next = await act("feedback", {
                  jobId: dismissJobId,
                  kind: "dismissed",
                  reason: dismissReason || undefined,
                });
                if (next) { setDismissJobId(null); setDismissDraft(null); }
                if (next) { pendingRoleFocus.current = feedbackReturnFocus.current ?? "__heading__"; setFeedbackNotice({ message: dismissedRole ? `Dismissal reason updated for ${dismissedRole.title} at ${dismissedRole.company}.` : "Dismissal reason updated.", undo: feedbackNotice?.undo }); }
              }}
            >
              {busy === "feedback" ? "Saving…" : "Save reason"}
            </button>
            {activeError && <div role="alert"><p>{displayError} Your selection is preserved. {requiresSignIn ? "Return here afterward to continue." : needsWorkspaceCheck ? "Refresh the workspace to check the latest status before trying again." : ""}</p><div className="workspace-recovery-actions">{requiresSignIn && <a className="dark-button" href="/login">Sign in</a>}<button className={needsWorkspaceCheck && !requiresSignIn ? "dark-button" : "text-button"} disabled={Boolean(busy)} onClick={retryWorkspace}>{busy === "reload" ? "Refreshing…" : "Refresh workspace"}</button></div></div>}
        </WorkspaceDialog>
      )}
      {factCorrection && <FactCorrectionDialog key={`${factCorrection.applicationId}-${factCorrection.claim}`} claim={factCorrection.claim}
        facts={factCorrection.facts} busy={Boolean(busy)} error={displayError}
        onCancel={() => { setFactCorrection(null); setError(""); }}
        onSave={async facts => {
          const next = await act("profile", { factPatch: { expected: factCorrection.facts, updated: facts } });
          if (next) {
            setLastFactCorrection({ owner: data.profile.id, applicationId: factCorrection.applicationId, before: factCorrection.facts, after: next.profile.facts.filter(fact => facts.some(item => item.id === fact.id)) });
            setFactCorrection(null);
            setNotice("Source facts saved. Rebuild the materials and review them before approving.");
          }
        }} />}
      {cancellation && <WorkspaceDialog labelledBy="cancel-application-heading" onClose={() => { if (!busy) setCancellationId(null); }}>
        <h2 id="cancel-application-heading">Cancel this application?</h2>
        <p>{jobs.find(job => job.id === cancellation.jobId)?.company} · {jobs.find(job => job.id === cancellation.jobId)?.title}</p>
        <p>This stops the attempt and closes its browser session. Your saved materials remain available. Starting again requires selecting the role and reviewing a new attempt.</p>
        {!canCancelApplication(cancellation) && <p role="alert">The application status changed. Close this dialog and review its current result.</p>}
        <div className="action-row">
          <button className="outline-action" disabled={Boolean(busy)} onClick={() => setCancellationId(null)}>Keep application</button>
          <button className="dark-button" disabled={Boolean(busy) || !canCancelApplication(cancellation)} onClick={async () => { if (await act("cancel", { applicationId: cancellation.id })) setCancellationId(null); }}>{busy === "cancel" ? "Cancelling…" : "Confirm cancellation"}</button>
        </div>
        {error && <p role="alert">{displayError}</p>}
      </WorkspaceDialog>}
      {pendingNavigation && activeApp?.packet && (
        <WorkspaceDialog labelledBy="unsaved-heading" onClose={() => { if (!busy) setPendingNavigation(null); }}>
          <h2 id="unsaved-heading">Keep your changes?</h2>
          <p>Your {editingEssay !== null ? "essay edit" : "personal answers"} for {appJob?.company ?? "this application"} {editingEssay !== null ? "has" : "have"} not been saved. Save before leaving, or discard only these changes.</p>
          <div className="action-row">
            <button className="dark-button" disabled={Boolean(busy) || (editingEssay !== null && !essayDraft?.text.trim())}
              onClick={async () => {
                const answer = essayDraft && activeApp.packet!.answers[essayDraft.answerIndex];
                const unchanged = answer && essayDraft!.text.trim() === answer.answer;
                const saved = unchanged || (editingEssay !== null && essayDraft?.applicationId === activeApp.id && answer
                  ? await act("reviseEssay", { applicationId: activeApp.id, packetHash: activeApp.packetHash, answerIndex: essayDraft.answerIndex, answerHash: answerReviewHash(answer), text: essayDraft.text })
                  : await act("editPacket", { applicationId: activeApp.id, answers: answerDraft }));
                if (saved) { setEditingEssay(null); setEssayDraft(null); setPendingNavigation(null); pendingNavigation.run(); }
              }}>{busy ? "Saving…" : "Save and continue"}</button>
            <button className="outline-action" disabled={Boolean(busy)} onClick={() => { setAnswerEdits(null); setEditingEssay(null); setEssayDraft(null); setPendingNavigation(null); pendingNavigation.run(); }}>Discard and continue</button>
            <button className="text-button" disabled={Boolean(busy)} onClick={() => setPendingNavigation(null)}>Stay here</button>
          </div>
          {error && <p role="alert">{displayError} Your changes are still here. Try saving again or stay in this application.</p>}
        </WorkspaceDialog>
      )}
      {importOpen && (
        <WorkspaceDialog labelledBy="import-heading" onClose={() => { setConfirmDiscardImport(false); setImportOpen(false); }}>
            <button
              className="modal-close"
              onClick={() => { setConfirmDiscardImport(false); setImportOpen(false); }}
              aria-label="Close"
            >
              <X size={20} />
            </button>
            <h2 id="import-heading">Import a job link</h2>
              {activeError && <div role="alert"><p>{displayError} Your entered details are preserved. {requiresSignIn && "Return here afterward to continue."}</p>
                <div className="workspace-recovery-actions">{requiresSignIn && <a className="dark-button" href="/login">Sign in</a>}
                {needsWorkspaceCheck && <button className={needsWorkspaceCheck && !requiresSignIn ? "dark-button" : "text-button"} type="button" disabled={Boolean(busy)} onClick={retryWorkspace}>{busy === "reload" ? "Refreshing…" : "Refresh workspace"}</button>}
                {existingImport?.active && <button className="outline-action" type="button" onClick={() => revealRole(existingImport, `Showing ${existingImport.title} at ${existingImport.company}, already in your list.`)}>Review existing role</button>}</div>
                {existingImport && !existingImport.active && <p>This posting is marked closed. <a href={existingImport.url} target="_blank" rel="noreferrer">Check the original posting ↗</a></p>}
              </div>}
            {!activeError && <p>Start with the employer’s job link. Supported Greenhouse, Lever and Ashby postings can supply their own details.</p>}
            <form className="job-import-form" onSubmit={async event => {
              event.preventDefault(); if (confirmDiscardImport) return; setImportTouched(true);
              if (!importReady || busy || needsWorkspaceCheck) return;
              const next = await act("import", importFields);
              if (next) {
                const added = importedRole(jobs, next.jobs, importFields.url);
                setImportOpen(false); setImportTouched(false);
                if (added?.active) {
                  revealRole(added, `Added ${added.title} at ${added.company}. Review the posting details and fit below.`, next.feedback.some(item => item.jobId === added.id && item.kind === "dismissed"));
                } else {
                  setFeedbackNotice({ message: added ? `${added.title} at ${added.company} was added, but the posting is closed. Your view is preserved.` : "Link added. Refresh your workspace to locate its posting details.", postingUrl: added?.url });
                }
                setImportFields(emptyImport);
              }
            }}>
              <label>Job URL (required)
                <input id="import-job-url" type="url" required disabled={busy === "import"} maxLength={2048} autoComplete="url" value={importFields.url} aria-describedby="import-url-help" aria-invalid={importTouched && Boolean(importCheck.error)} onBlur={() => setImportTouched(true)} onChange={event => { setConfirmDiscardImport(false); setImportFields({ ...importFields, url: event.target.value }); }} placeholder="https://company.com/careers/role" />
              </label>
              <p id="import-url-help" className="field-help" role="status">{importTouched && importCheck.error ? importCheck.error : importFields.url && !importCheck.error ? importCheck.manual ? "This link needs the company and job title entered below. Availability will need verification." : "We’ll check the provider for the job's details and availability." : "Use a complete HTTPS link to a public job posting."}</p>
              {!importCheck.error && importCheck.manual && <fieldset className="manual-import"><legend>Posting details</legend>
                {(["company", "title", "location"] as const).map(key => <label key={key}>{key === "company" ? "Company (required)" : key === "title" ? "Job title (required)" : "Location (optional)"}
                  <input required={key !== "location"} disabled={busy === "import"} maxLength={key === "company" ? 120 : 160} value={importFields[key]} onChange={event => { setConfirmDiscardImport(false); setImportFields({ ...importFields, [key]: event.target.value }); }} />
                </label>)}
              </fieldset>}

              {!confirmDiscardImport && <button className="dark-button" type="submit" disabled={Boolean(busy) || !importReady || needsWorkspaceCheck}>{busy === "import" ? "Checking and adding…" : error && !needsWorkspaceCheck && !existingImport ? "Try adding again" : "Add role"}</button>}
              {Object.values(importFields).some(value => value.trim()) && (confirmDiscardImport ? <div className="discard-confirmation" role="group" aria-labelledby="discard-import-prompt">
                <p id="discard-import-prompt" role="status">Discard your entered posting details? This clears this draft from your browser.</p>
                <button className="outline-action" type="button" ref={keepImportEditing} disabled={Boolean(busy)} onClick={() => { setConfirmDiscardImport(false); document.getElementById("import-job-url")?.focus(); }}>Keep editing</button>
                <button className="text-button discard-import" type="button" disabled={Boolean(busy)} onClick={() => { setImportFields(emptyImport); setImportTouched(false); setConfirmDiscardImport(false); setError(""); setImportOpen(false); }}>Confirm discard</button>
              </div> : <button className="text-button discard-import" type="button" disabled={Boolean(busy)} onClick={() => setConfirmDiscardImport(true)}>Discard draft</button>)}
            </form>
        </WorkspaceDialog>
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
function needsApplicationReview(application: Application) {
  return ["draft_review", "final_review", "needs_user_action", "awaiting_verification", "uncertain"].includes(application.status) || Boolean(application.blockers?.some(blocker => blocker.progress === "blocked"));
}

function canCancelApplication(application: Application) {
  return !["submitted", "submitting", "awaiting_verification", "uncertain", "cancelled"].includes(application.status) || Boolean(application.autonomousAuthorization && application.status === "submitting" && !application.submissionAttemptedAt);
}

function statusLabel(status: Application["status"]) {
  return {
    selected: "Selected",
    drafting: "Drafting",
    draft_review: "Review materials",
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
