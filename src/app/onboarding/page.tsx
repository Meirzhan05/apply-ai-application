"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowLeft, ArrowRight, Check, CircleDot, FileText, LoaderCircle, LogOut, Pencil, RotateCcw, Upload } from "lucide-react";
import { ImmigrationQuestionnaireFields } from "@/components/immigration-questionnaire-fields";
import { onboardingMissingLabel } from "@/lib/onboarding";
import { browserSupabase } from "@/lib/supabase-browser";
import type { publicState } from "@/lib/public-state";
import type { Profile } from "@/lib/types";
import styles from "./onboarding.module.css";

type ViewState = ReturnType<typeof publicState> & { demoMode?: boolean };
type Stage = NonNullable<Profile["onboarding"]>["draftStage"];
const stages = ["resume", "profile", "answers", "review"] as const;
const stageNames = { resume: "Resume", profile: "Profile", answers: "Application answers", review: "Review" };
function resumePending(profile: Profile): boolean {
  return Boolean(profile.resumeImport) || ["queued", "extracting", "checking"].includes(profile.resumeExtraction?.status ?? "");
}
type ImportedFact = ViewState["onboarding"]["importedFacts"][number];
type FactGroup = { key: string; heading: string; facts: ImportedFact[] };

function groupImportedFacts(facts: ImportedFact[], anchors: NonNullable<Profile["resumeSourceDocument"]>["anchors"]): FactGroup[] {
  const groups = new Map<string, FactGroup>();
  for (const fact of facts) {
    const anchor = anchors.find((item) => item.id === fact.sourceAnchorId);
    const section = anchor?.sectionHeading?.trim() || "Imported professional information";
    const entry = anchor?.entryHeading?.trim();
    const key = anchor ? `${anchor.sectionId}:${anchor.entryId}` : `fact:${fact.id}`;
    const heading = entry && entry !== section ? `${section} · ${entry}` : section;
    const group = groups.get(key) ?? { key, heading, facts: [] };
    group.facts.push(fact);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function displayImportedFact(fact: ImportedFact, anchors: NonNullable<Profile["resumeSourceDocument"]>["anchors"]): string {
  const raw = fact.text.trim();
  const anchor = anchors.find((item) => item.id === fact.sourceAnchorId);
  if (!anchor) return fact.text;
  const prefixes = [
    `${anchor.sectionHeading} · ${anchor.entryHeading} · `,
    `${anchor.entryHeading} · `,
    `${anchor.sectionHeading} · `,
  ];
  for (const prefix of prefixes) {
    if (!raw.startsWith(prefix)) continue;
    const claim = raw.slice(prefix.length).trim();
    if (claim) return claim;
  }
  return fact.text;
}

async function requestJson(url: string, options?: RequestInit) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error ?? "Your changes could not be saved. Retry.") as Error & { status?: number; missing?: string[] };
    error.status = response.status; error.missing = body.missing; throw error;
  }
  return body;
}

export default function Onboarding() {
  const router = useRouter();
  const [data, setData] = useState<ViewState | null>(null);
  const [draft, setDraft] = useState<Profile | null>(null);
  const [stage, setStage] = useState<NonNullable<Stage>>("resume");
  const [busy, setBusy] = useState("");
  const [saveState, setSaveState] = useState("Saved");
  const [error, setError] = useState("");
  const [missing, setMissing] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const saved = useRef<ViewState | null>(null);
  const currentDraft = useRef<Profile | null>(null);
  const currentStage = useRef<NonNullable<Stage>>("resume");
  const editRevision = useRef(0);
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const retryFile = useRef<File | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);
  const stageHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    stageHeading.current?.focus({ preventScroll: true });
  }, [stage]);

  const showError = useCallback((failure: unknown) => {
    const caught = failure as Error & { status?: number; missing?: string[] };
    if (caught.status === 401) { router.replace("/login?next=/onboarding"); return; }
    setError(caught.message || "Your changes could not be saved. Retry.");
    if (caught.missing) setMissing(caught.missing);
  }, [router]);

  const load = useCallback(async () => {
    const state: ViewState = await requestJson("/api/state");
    saved.current = state; setData(state); return state;
  }, []);

  useEffect(() => {
    let active = true;
    void requestJson("/api/state").then((state: ViewState) => {
      if (!active) return;
      if (state.onboarding.complete) { router.replace("/"); return; }
      saved.current = state; currentDraft.current = state.profile; setData(state); setDraft(state.profile);
      const resumed = resumePending(state.profile) || (state.profile.resumeExtraction && state.profile.resumeExtraction.status !== "ready")
        ? "resume" : state.profile.onboarding?.draftStage ?? "resume";
      currentStage.current = resumed; setStage(resumed);
    }).catch(showError);
    return () => { active = false; };
  }, [showError, router]);

  const edit = (change: Partial<Profile>) => {
    if (!currentDraft.current) return;
    const updated = { ...currentDraft.current, ...change };
    currentDraft.current = updated; setDraft(updated); editRevision.current += 1;
    setDirty(true); setSaveState("Unsaved changes"); setError(""); setMissing([]);
  };

  const saveDraft = useCallback(() => {
    const snapshot = currentDraft.current;
    const draftStage = currentStage.current;
    const revision = editRevision.current;
    if (!snapshot) return Promise.reject(new Error("Profile is still loading."));
    setSaveState("Saving…");
    const operation = saveQueue.current.catch(() => undefined).then(async () => {
      const base = saved.current;
      if (!base) throw new Error("Reload your saved profile before continuing.");
      const expected = base.onboarding.importedFacts;
      const updated = expected.map(fact => ({ ...fact, text: snapshot.facts.find(item => item.id === fact.id)?.text ?? fact.text }));
      const factPatch = expected.some((fact, index) => fact.text !== updated[index].text) ? { expected, updated } : undefined;
      await requestJson("/api/actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        action: "onboardingDraft", payload: {
          name: snapshot.name, contactEmail: snapshot.contactEmail ?? snapshot.email, phone: snapshot.phone, links: snapshot.links ?? [],
          currentLocation: snapshot.currentLocation, preferredLocations: snapshot.preferredLocations,
          workArrangements: snapshot.workArrangements ?? [], willingToRelocate: snapshot.willingToRelocate ?? null,
          questionnaire: snapshot.onboarding?.questionnaire ?? {}, stage: draftStage,
          expectedReviewHash: base.onboarding.reviewHash, ...(factPatch ? { factPatch } : {}),
        },
      }) });
      const state = await load();
      setMissing([]);
      if (editRevision.current === revision) {
        currentDraft.current = state.profile; setDraft(state.profile); setDirty(false); setSaveState("Saved");
      }
      return state;
    });
    saveQueue.current = operation;
    return operation.catch(failure => { setSaveState("Save failed"); showError(failure); throw failure; });
  }, [load, showError]);

  const waitingForResume = data ? resumePending(data.profile) : false;
  useEffect(() => {
    if (!waitingForResume || busy === "import") return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const state: ViewState = await requestJson("/api/state");
        if (!active) return;
        saved.current = state; setData(state);
        currentDraft.current = state.profile; setDraft(state.profile);
        if (!resumePending(state.profile)) {
          if (state.profile.resumeExtraction?.status === "ready") {
            setError(""); setMissing([]);
            currentStage.current = "profile"; setStage("profile");
            editRevision.current += 1; setDirty(true); setSaveState("Unsaved changes");
          } else setError(state.profile.resumeExtraction?.error || "Resume extraction did not finish. Retry extraction.");
          return;
        }
      } catch (failure) {
        if (!active) return;
        showError(failure);
        if ((failure as Error & { status?: number }).status === 401) return;
      }
      timer = setTimeout(() => void poll(), 2000);
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => { active = false; clearTimeout(timer); };
  }, [waitingForResume, busy, showError]);

  useEffect(() => {
    if (!dirty || busy) return;
    const timer = window.setTimeout(() => { void saveDraft().catch(() => undefined); }, 650);
    return () => window.clearTimeout(timer);
  }, [dirty, draft, stage, busy, saveDraft]);

  async function go(next: NonNullable<Stage>) {
    setBusy("save"); setError("");
    currentStage.current = next; editRevision.current += 1;
    try { await saveDraft(); setStage(next); window.scrollTo({ top: 0 }); }
    catch { currentStage.current = stage; }
    finally { setBusy(""); }
  }

  async function resume(file?: File, retryExtraction = false) {
    setBusy("import"); setError(""); retryFile.current = file;
    try {
      await saveQueue.current.catch(() => undefined);
      if (retryExtraction) await requestJson("/api/resume", { method: "PATCH" });
      else {
        const body = new FormData();
        if (file) body.append("file", file); else body.append("reuse", "true");
        await requestJson("/api/resume", { method: "POST", body });
      }
      const state = await load();
      currentDraft.current = state.profile; setDraft(state.profile); setDirty(false);
      if (resumePending(state.profile)) {
        currentStage.current = "resume"; setStage("resume");
      } else if (state.profile.resumeExtraction?.status === "ready") {
        currentStage.current = "profile"; editRevision.current += 1;
        await saveDraft(); setStage("profile"); setMissing([]);
      } else throw new Error(state.profile.resumeExtraction?.error || "Resume extraction did not finish. Retry extraction.");
    } catch (failure) { showError(failure); }
    finally { setBusy(""); if (fileInput.current) fileInput.current.value = ""; }
  }

  async function finish() {
    setBusy("finish"); setError("");
    try {
      await saveQueue.current;
      const review = saved.current;
      if (!review || dirty) throw new Error("Save your changes before finishing onboarding.");
      await requestJson("/api/actions", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "finishOnboarding", payload: { reviewHash: review.onboarding.reviewHash } }) });
      const completed = await load();
      if (!completed.onboarding.complete) throw new Error("Completion was not saved. Retry Finish onboarding.");
      router.replace("/");
    } catch (failure) { showError(failure); }
    finally { setBusy(""); }
  }

  async function signOut() {
    setBusy("signout");
    try { await saveQueue.current.catch(() => undefined); const result = await browserSupabase().auth.signOut(); if (result.error) throw result.error; router.replace("/login"); }
    catch (failure) { showError(failure); }
    finally { setBusy(""); }
  }

  async function reviewLatest() {
    setBusy("reload");
    try {
      await saveQueue.current.catch(() => undefined);
      const state = await load();
      if (state.onboarding.complete) { router.replace("/"); return; }
      currentDraft.current = state.profile; setDraft(state.profile);
      editRevision.current += 1; setDirty(false); setSaveState("Saved"); setError(""); setMissing([]);
    } catch (failure) { showError(failure); }
    finally { setBusy(""); }
  }

  const status = data ? saveState : error ? "Load failed" : "Loading…";
  const statusError = status === "Save failed" || status === "Load failed";
  const StatusIcon = statusError ? AlertCircle : status === "Saving…" || status === "Loading…" ? LoaderCircle : status === "Saved" ? Check : CircleDot;
  const header = <header className={styles.header}><Link href="/onboarding" className={styles.brand}>Apply<span>.</span></Link><div className={styles.headerControls}><span className={`${styles.saveStatus} ${statusError ? styles.statusError : ""}`} role="status" aria-live="polite"><StatusIcon size={15} aria-hidden="true" className={status === "Saving…" || status === "Loading…" ? styles.spinning : undefined} /><span>{status}</span></span>{data && !data.demoMode && <button disabled={Boolean(busy)} onClick={() => void signOut()}><LogOut size={16} aria-hidden="true" /> Sign out</button>}</div></header>;
  if (!data || !draft) return <div className={styles.shell}>{header}<main aria-busy={!error}><h1>Complete your profile</h1>{error ? <div className={styles.error} role="alert"><p>{error}</p><button onClick={() => window.location.reload()}><RotateCcw size={16} /> Reload</button></div> : <div className={styles.skeleton} role="status" aria-label="Loading saved profile"><span /><span /><span /></div>}</main></div>;
  const parsed = !data.onboarding.missing.some(key => ["resume", "resumeImport", "resumeExtraction"].includes(key));
  const extractionFailed = ["failed", "budget_limited"].includes(data.profile.resumeExtraction?.status ?? "");
  const imported = data.onboarding.importedFacts;
  const review = data.profile;
  const importedGroups = groupImportedFacts(imported, review.resumeSourceDocument?.anchors ?? []);
  const missingFields = [...new Set([...data.onboarding.missing, ...missing])];
  const location = draft.currentLocation ?? { city: "", region: "", country: "" };
  const nationwide = draft.preferredLocations.length === 1 && /^(united states|usa|us)$/i.test(draft.preferredLocations[0]);
  const stageIndex = stages.indexOf(stage);
  return <div className={styles.shell}>
    {header}
    <main>
      <h1>Complete your profile</h1>
      <nav className={styles.steps} aria-label="Onboarding stages">{stages.map((item, index) => <button key={item} aria-current={stage === item ? "step" : undefined} disabled={Boolean(busy) || waitingForResume || (item !== "resume" && !parsed)} onClick={() => void go(item)}><span className={styles.stepNumber} aria-hidden="true">{index < stageIndex ? <Check size={15} /> : index + 1}</span><span className={styles.stepLabel}>{stageNames[item]}</span></button>)}</nav>
      {(error || extractionFailed) && <div className={styles.error} role="alert"><p>{error || data.profile.resumeExtraction?.error || "Resume extraction did not finish."}</p>{saveState === "Save failed" && <button disabled={Boolean(busy)} onClick={() => void saveDraft().catch(() => undefined)}><RotateCcw size={16} /> Retry save</button>}{stage === "resume" ? <button disabled={Boolean(busy)} onClick={() => void resume(extractionFailed ? undefined : retryFile.current, extractionFailed)}><RotateCcw size={16} /> {extractionFailed ? "Retry extraction" : "Retry import"}</button> : <button disabled={Boolean(busy)} onClick={() => void reviewLatest()}><RotateCcw size={16} /> Review latest saved profile</button>}</div>}
      {stage === "resume" && <section className={styles.section} aria-labelledby="resume-heading">
        <h2 id="resume-heading" ref={stageHeading} tabIndex={-1}>Your resume</h2>
        {(draft.resumeFileName || draft.resumeExtraction?.filename) && <div className={styles.resume}><FileText size={28} /><div><strong>{draft.resumeExtraction?.filename || draft.resumeFileName}</strong><span>{waitingForResume ? "Reading resume" : parsed ? "Saved resume" : "Ready to import again"}</span></div><button disabled={Boolean(busy) || waitingForResume || extractionFailed} onClick={() => void resume()}>Use saved resume <ArrowRight size={16} /></button></div>}
        <div className={styles.upload}><label htmlFor="onboarding-resume"><Upload size={22} /><strong>{draft.resumeFileName ? "Replace resume" : "Upload resume"}</strong><span>PDF or DOCX · Up to 5 MB</span></label><input id="onboarding-resume" ref={fileInput} type="file" accept=".pdf,.docx" disabled={Boolean(busy) || waitingForResume} onChange={event => { const file = event.target.files?.[0]; if (file) void resume(file); }} /></div>
        {(busy === "import" || waitingForResume) && <p role="status"><LoaderCircle size={16} className={styles.spinning} aria-hidden="true" /> {busy === "import" ? "Uploading your resume…" : "Reading and checking your resume…"}</p>}
      </section>}
      {stage === "profile" && <section className={styles.section} aria-labelledby="profile-heading">
        <h2 id="profile-heading" ref={stageHeading} tabIndex={-1}>Contact details</h2>
        <div className={styles.fields}><label>Full name<input required autoComplete="name" maxLength={200} value={draft.name} disabled={Boolean(busy)} onChange={event => edit({ name: event.target.value })} /></label><label>Email<input required type="email" autoComplete="email" maxLength={254} value={draft.contactEmail ?? draft.email} disabled={Boolean(busy)} onChange={event => edit({ contactEmail: event.target.value })} /></label><label>Phone<input required type="tel" autoComplete="tel" maxLength={100} value={draft.phone} disabled={Boolean(busy)} onChange={event => edit({ phone: event.target.value })} /></label><label>Links <small>Optional</small><textarea rows={3} value={(draft.links ?? []).join("\n")} disabled={Boolean(busy)} onChange={event => edit({ links: event.target.value.split(/\r?\n/) })} /></label></div>
        <h2>Professional information</h2>
        <div className={styles.facts}>{importedGroups.map(group => <fieldset className={styles.factGroup} key={group.key}><legend>{group.heading}</legend>{group.facts.map((fact, index) => <div data-fact-id={fact.id} data-source-anchor-id={fact.sourceAnchorId ?? undefined} key={fact.id}><span className={styles.factSource}>Imported fact {index + 1}</span><p className={styles.factClaim}>{displayImportedFact(fact, review.resumeSourceDocument?.anchors ?? [])}</p><details className={styles.factRaw}><summary>Edit imported wording</summary><textarea aria-label={`Professional information ${index + 1}`} maxLength={500} rows={3} disabled={Boolean(busy)} value={draft.facts.find(item => item.id === fact.id)?.text ?? fact.text} onChange={event => edit({ facts: draft.facts.map(item => item.id === fact.id ? { ...item, text: event.target.value } : item) })} /></details></div>)}</fieldset>)}</div>
        <details className={styles.source}><summary>Original resume text</summary><pre>{draft.resumeSourceDocument?.text}</pre></details>
      </section>}
      {stage === "answers" && <section className={styles.section} aria-labelledby="answers-heading">
        <h2 id="answers-heading" ref={stageHeading} tabIndex={-1}>Current Location</h2>
        <div className={styles.fields}>{([["city", "Current city"], ["region", "State or region"], ["country", "Country"]] as const).map(([key, label]) => <label key={key}>{label}<input required maxLength={120} value={location[key]} disabled={Boolean(busy)} onChange={event => edit({ currentLocation: { ...location, [key]: event.target.value } })} /></label>)}</div>
        <h2>Preferred Job Locations</h2>
        <label className={styles.check}><input type="checkbox" checked={nationwide} disabled={Boolean(busy)} onChange={event => edit({ preferredLocations: event.target.checked ? ["United States"] : [] })} /> Anywhere in the United States</label>
        <label className={styles.destination}>Preferred US job locations<textarea rows={3} placeholder="New York, NY" value={nationwide ? "" : draft.preferredLocations.join("\n")} disabled={nationwide || Boolean(busy)} onChange={event => edit({ preferredLocations: event.target.value.split(/\r?\n/) })} /></label>
        <fieldset className={styles.arrangements}><legend>Work arrangements</legend>{(["remote", "hybrid", "on-site"] as const).map(arrangement => <label className={styles.check} key={arrangement}><input type="checkbox" checked={draft.workArrangements?.includes(arrangement) ?? false} disabled={Boolean(busy)} onChange={event => edit({ workArrangements: event.target.checked ? [...(draft.workArrangements ?? []), arrangement] : (draft.workArrangements ?? []).filter(item => item !== arrangement) })} />{arrangement === "on-site" ? "On-site" : arrangement === "remote" ? "Remote" : "Hybrid"}</label>)}</fieldset>
        <h2 id="us-answers-heading">US application answers</h2>
        <fieldset className={`${styles.fields} ${styles.answerFields}`} aria-labelledby="us-answers-heading" disabled={Boolean(busy)}><ImmigrationQuestionnaireFields questionnaire={draft.onboarding?.questionnaire ?? {}} onChange={questionnaire => edit({ onboarding: { ...draft.onboarding, questionnaire } })} /></fieldset>
        <h2>Timing and relocation <small>Optional</small></h2>
        <div className={styles.fields}><label>Willing to relocate<select value={draft.willingToRelocate === undefined ? "" : draft.willingToRelocate ? "yes" : "no"} disabled={Boolean(busy)} onChange={event => edit({ willingToRelocate: event.target.value === "" ? undefined : event.target.value === "yes" })}><option value="">Undecided</option><option value="yes">Yes</option><option value="no">No</option></select></label><label>Availability or start date<input maxLength={200} value={draft.onboarding?.questionnaire.availability ?? ""} disabled={Boolean(busy)} onChange={event => edit({ onboarding: { ...draft.onboarding, questionnaire: { ...draft.onboarding?.questionnaire, availability: event.target.value } } })} /></label></div>
      </section>}
      {stage === "review" && <section className={styles.section} aria-labelledby="review-heading">
        <h2 id="review-heading" ref={stageHeading} tabIndex={-1}>Review your profile</h2>
        {missingFields.length > 0 && <div className={styles.error}><strong>Required information is missing</strong><ul>{missingFields.map(key => <li key={key}>{onboardingMissingLabel(key)}</li>)}</ul></div>}
        <div className={styles.reviewHeading}><h3>Contact details</h3><button aria-label="Edit contact details" disabled={Boolean(busy)} onClick={() => void go("profile")}><Pencil size={14} aria-hidden="true" /> Edit</button></div>
        <dl className={styles.review}><div><dt>Name</dt><dd>{review.name || "Missing"}</dd></div><div><dt>Email</dt><dd>{(review.contactEmail ?? review.email) || "Missing"}</dd></div><div><dt>Phone</dt><dd>{review.phone || "Missing"}</dd></div>{review.links?.length ? <div><dt>Links</dt><dd>{review.links.join("\n")}</dd></div> : null}</dl>
        <div className={styles.reviewHeading}><h3>Imported professional information</h3><button aria-label="Edit professional information" disabled={Boolean(busy)} onClick={() => void go("profile")}><Pencil size={14} aria-hidden="true" /> Edit</button></div><div className={styles.reviewFacts}>{importedGroups.map(group => <section data-source-context={group.key} key={group.key}><h4>{group.heading}</h4><ul>{group.facts.map(fact => <li data-fact-id={fact.id} data-source-anchor-id={fact.sourceAnchorId ?? undefined} key={fact.id}><span>{displayImportedFact(fact, review.resumeSourceDocument?.anchors ?? [])}</span><details className={styles.factRaw}><summary>View imported wording</summary><p>{fact.text}</p></details></li>)}</ul></section>)}</div><details className={styles.source}><summary>Original resume text</summary><pre>{review.resumeSourceDocument?.text}</pre></details>
        <div className={styles.reviewHeading}><h3>Application answers</h3><button aria-label="Edit application answers" disabled={Boolean(busy)} onClick={() => void go("answers")}><Pencil size={14} aria-hidden="true" /> Edit</button></div>
        <dl className={styles.review}><div><dt>Current Location</dt><dd>{review.currentLocation ? Object.values(review.currentLocation).join(", ") : "Missing"}</dd></div><div><dt>Preferred Job Locations</dt><dd>{review.preferredLocations.join("; ") || "Missing"}</dd></div><div><dt>Work arrangements</dt><dd>{review.workArrangements?.join(", ") || "Missing"}</dd></div><div><dt>US Immigration Status</dt><dd>{({ "us-citizen": "US citizen", "permanent-resident": "Permanent resident", "visa-holder": "Visa holder", other: "Another status" } as const)[review.onboarding?.questionnaire.immigrationStatus ?? "other"]}{review.onboarding?.questionnaire.visaType ? ` · ${review.onboarding.questionnaire.visaType}` : ""}{review.onboarding?.questionnaire.immigrationStatusDetails ? ` · ${review.onboarding.questionnaire.immigrationStatusDetails}` : ""}</dd></div>{([["workAuthorization", "Currently authorized to work in the US"], ["sponsorshipNow", "Employer sponsorship now"], ["sponsorshipFuture", "Employer sponsorship in the future"]] as const).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{review.onboarding?.questionnaire[key] === "yes" ? "Yes" : review.onboarding?.questionnaire[key] === "no" ? "No" : "Missing"}</dd></div>)}{review.willingToRelocate !== undefined && <div><dt>Willing to relocate</dt><dd>{review.willingToRelocate ? "Yes" : "No"}</dd></div>}{review.onboarding?.questionnaire.availability && <div><dt>Availability</dt><dd>{review.onboarding.questionnaire.availability}</dd></div>}</dl>
        <p className={styles.consent}>By finishing onboarding, I confirm the imported professional information shown here is accurate and may be used in my applications.</p>
      </section>}
      <footer className={styles.footer}>{stageIndex > 0 ? <button disabled={Boolean(busy)} onClick={() => void go(stages[stageIndex - 1])}><ArrowLeft size={16} /> Back</button> : <span />}{stage === "review" ? <button className={styles.primary} disabled={Boolean(busy) || dirty || saveState === "Save failed" || missingFields.length > 0} onClick={() => void finish()}>{busy === "finish" ? "Finishing…" : "Finish onboarding"}<Check size={16} /></button> : <button className={styles.primary} disabled={Boolean(busy) || !parsed} onClick={() => void go(stages[stageIndex + 1])}>{busy === "save" ? "Saving…" : "Continue"}<ArrowRight size={16} /></button>}</footer>
    </main>
  </div>;
}
