"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, FileText, LogOut, RotateCcw, Upload } from "lucide-react";
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
      const resumed = state.profile.onboarding?.draftStage ?? "resume";
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
          name: snapshot.name, email: snapshot.email, phone: snapshot.phone, links: snapshot.links ?? [],
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

  async function resume(file?: File) {
    setBusy("import"); setError(""); retryFile.current = file;
    try {
      await saveQueue.current.catch(() => undefined);
      const body = new FormData();
      if (file) body.append("file", file); else body.append("reuse", "true");
      await requestJson("/api/resume", { method: "POST", body });
      const state = await load();
      currentDraft.current = state.profile; setDraft(state.profile); setDirty(false);
      currentStage.current = "profile"; editRevision.current += 1;
      await saveDraft(); setStage("profile"); setMissing([]);
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

  if (!data || !draft) return <main className={styles.shell}><h1>Onboarding</h1>{error ? <div role="alert"><p>{error}</p><button onClick={() => window.location.reload()}><RotateCcw size={16} /> Reload</button></div> : <div className={styles.skeleton} aria-label="Loading saved profile" />}</main>;
  const parsed = !data.onboarding.missing.includes("resume") && !data.profile.resumeImport;
  const imported = data.onboarding.importedFacts;
  const review = data.profile;
  const importedGroups = groupImportedFacts(imported, review.resumeSourceDocument?.anchors ?? []);
  const missingFields = [...new Set([...data.onboarding.missing, ...missing])];
  const location = draft.currentLocation ?? { city: "", region: "", country: "" };
  const nationwide = draft.preferredLocations.length === 1 && /^(united states|usa|us)$/i.test(draft.preferredLocations[0]);
  const stageIndex = stages.indexOf(stage);
  return <div className={styles.shell}>
    <header className={styles.header}><Link href="/onboarding" className={styles.brand}>Apply</Link><div><span role="status" aria-live="polite">{saveState}</span>{!data.demoMode && <button disabled={Boolean(busy)} onClick={() => void signOut()}><LogOut size={16} /> Sign out</button>}</div></header>
    <main>
      <h1>Complete your profile</h1>
      <nav className={styles.steps} aria-label="Onboarding stages">{stages.map((item, index) => <button key={item} aria-current={stage === item ? "step" : undefined} disabled={Boolean(busy) || (item !== "resume" && !parsed)} onClick={() => void go(item)}><span>{index < stageIndex ? <Check size={15} /> : index + 1}</span>{stageNames[item]}</button>)}</nav>
      {error && <div className={styles.error} role="alert"><p>{error}</p>{saveState === "Save failed" && <button disabled={Boolean(busy)} onClick={() => void saveDraft().catch(() => undefined)}><RotateCcw size={16} /> Retry save</button>}{stage === "resume" ? <button disabled={Boolean(busy)} onClick={() => void resume(retryFile.current)}><RotateCcw size={16} /> Retry import</button> : <button disabled={Boolean(busy)} onClick={() => void reviewLatest()}><RotateCcw size={16} /> Review latest saved profile</button>}</div>}
      {stage === "resume" && <section className={styles.section} aria-labelledby="resume-heading">
        <h2 id="resume-heading">Your resume</h2>
        {draft.resumeFileName && <div className={styles.resume}><FileText size={28} /><div><strong>{draft.resumeFileName}</strong><span>{draft.resumeImport ? "Import in progress" : parsed ? "Saved resume" : "Ready to import again"}</span></div><button disabled={Boolean(busy)} onClick={() => void resume()}>Use saved resume <ArrowRight size={16} /></button></div>}
        <div className={styles.upload}><label htmlFor="onboarding-resume"><Upload size={22} /><strong>{draft.resumeFileName ? "Replace resume" : "Upload resume"}</strong><span>PDF or DOCX · Up to 5 MB</span></label><input id="onboarding-resume" ref={fileInput} type="file" accept=".pdf,.docx" disabled={Boolean(busy)} onChange={event => { const file = event.target.files?.[0]; if (file) void resume(file); }} /></div>
        {busy === "import" && <p role="status">Uploading and reading your resume…</p>}
      </section>}
      {stage === "profile" && <section className={styles.section} aria-labelledby="profile-heading">
        <h2 id="profile-heading">Contact details</h2>
        <div className={styles.fields}><label>Full name<input required autoComplete="name" maxLength={200} value={draft.name} disabled={Boolean(busy)} onChange={event => edit({ name: event.target.value })} /></label><label>Email<input required type="email" autoComplete="email" maxLength={254} value={draft.email} disabled={Boolean(busy)} onChange={event => edit({ email: event.target.value })} /></label><label>Phone<input required type="tel" autoComplete="tel" maxLength={100} value={draft.phone} disabled={Boolean(busy)} onChange={event => edit({ phone: event.target.value })} /></label><label>Links <small>Optional</small><textarea rows={3} value={(draft.links ?? []).join("\n")} disabled={Boolean(busy)} onChange={event => edit({ links: event.target.value.split(/\r?\n/) })} /></label></div>
        <h2>Professional information</h2>
        <div className={styles.facts}>{importedGroups.map(group => <fieldset className={styles.factGroup} key={group.key}><legend>{group.heading}</legend>{group.facts.map((fact, index) => <label data-fact-id={fact.id} data-source-anchor-id={fact.sourceAnchorId ?? undefined} key={fact.id}><span className={styles.factSource}>Editable imported fact {index + 1}</span><textarea aria-label={`Professional information ${index + 1}`} maxLength={500} rows={3} disabled={Boolean(busy)} value={draft.facts.find(item => item.id === fact.id)?.text ?? fact.text} onChange={event => edit({ facts: draft.facts.map(item => item.id === fact.id ? { ...item, text: event.target.value } : item) })} /></label>)}</fieldset>)}</div>
        <details className={styles.source}><summary>Original resume text</summary><pre>{draft.resumeSourceDocument?.text}</pre></details>
      </section>}
      {stage === "answers" && <section className={styles.section} aria-labelledby="answers-heading">
        <h2 id="answers-heading">Current Location</h2>
        <div className={styles.fields}>{([["city", "Current city"], ["region", "State or region"], ["country", "Country"]] as const).map(([key, label]) => <label key={key}>{label}<input required maxLength={120} value={location[key]} disabled={Boolean(busy)} onChange={event => edit({ currentLocation: { ...location, [key]: event.target.value } })} /></label>)}</div>
        <h2>Preferred Job Locations</h2>
        <label className={styles.check}><input type="checkbox" checked={nationwide} disabled={Boolean(busy)} onChange={event => edit({ preferredLocations: event.target.checked ? ["United States"] : [] })} /> Anywhere in the United States</label>
        <label className={styles.destination}>Preferred US job locations<textarea rows={3} placeholder="New York, NY" value={nationwide ? "" : draft.preferredLocations.join("\n")} disabled={nationwide || Boolean(busy)} onChange={event => edit({ preferredLocations: event.target.value.split(/\r?\n/) })} /></label>
        <fieldset className={styles.arrangements}><legend>Work arrangements</legend>{(["remote", "hybrid", "on-site"] as const).map(arrangement => <label className={styles.check} key={arrangement}><input type="checkbox" checked={draft.workArrangements?.includes(arrangement) ?? false} disabled={Boolean(busy)} onChange={event => edit({ workArrangements: event.target.checked ? [...(draft.workArrangements ?? []), arrangement] : (draft.workArrangements ?? []).filter(item => item !== arrangement) })} />{arrangement === "on-site" ? "On-site" : arrangement === "remote" ? "Remote" : "Hybrid"}</label>)}</fieldset>
        <h2>US application answers</h2>
        <fieldset className={styles.fields} disabled={Boolean(busy)}><ImmigrationQuestionnaireFields questionnaire={draft.onboarding?.questionnaire ?? {}} onChange={questionnaire => edit({ onboarding: { ...draft.onboarding, questionnaire } })} /></fieldset>
        <h2>Timing and relocation <small>Optional</small></h2>
        <div className={styles.fields}><label>Willing to relocate<select value={draft.willingToRelocate === undefined ? "" : draft.willingToRelocate ? "yes" : "no"} disabled={Boolean(busy)} onChange={event => edit({ willingToRelocate: event.target.value === "" ? undefined : event.target.value === "yes" })}><option value="">Undecided</option><option value="yes">Yes</option><option value="no">No</option></select></label><label>Availability or start date<input maxLength={200} value={draft.onboarding?.questionnaire.availability ?? ""} disabled={Boolean(busy)} onChange={event => edit({ onboarding: { ...draft.onboarding, questionnaire: { ...draft.onboarding?.questionnaire, availability: event.target.value } } })} /></label></div>
      </section>}
      {stage === "review" && <section className={styles.section} aria-labelledby="review-heading">
        <h2 id="review-heading">Review your profile</h2>
        {missingFields.length > 0 && <div className={styles.error}><strong>Required information is missing</strong><ul>{missingFields.map(key => <li key={key}>{onboardingMissingLabel(key)}</li>)}</ul></div>}
        <div className={styles.reviewHeading}><h3>Contact details</h3><button disabled={Boolean(busy)} onClick={() => void go("profile")}>Edit</button></div>
        <dl className={styles.review}><div><dt>Name</dt><dd>{review.name || "Missing"}</dd></div><div><dt>Email</dt><dd>{review.email || "Missing"}</dd></div><div><dt>Phone</dt><dd>{review.phone || "Missing"}</dd></div>{review.links?.length ? <div><dt>Links</dt><dd>{review.links.join("\n")}</dd></div> : null}</dl>
        <h3>Imported professional information</h3><div className={styles.reviewFacts}>{importedGroups.map(group => <section data-source-context={group.key} key={group.key}><h4>{group.heading}</h4><ul>{group.facts.map(fact => <li data-fact-id={fact.id} data-source-anchor-id={fact.sourceAnchorId ?? undefined} key={fact.id}>{fact.text}</li>)}</ul></section>)}</div><details className={styles.source}><summary>Original resume text</summary><pre>{review.resumeSourceDocument?.text}</pre></details>
        <div className={styles.reviewHeading}><h3>Application answers</h3><button disabled={Boolean(busy)} onClick={() => void go("answers")}>Edit</button></div>
        <dl className={styles.review}><div><dt>Current Location</dt><dd>{review.currentLocation ? Object.values(review.currentLocation).join(", ") : "Missing"}</dd></div><div><dt>Preferred Job Locations</dt><dd>{review.preferredLocations.join("; ") || "Missing"}</dd></div><div><dt>Work arrangements</dt><dd>{review.workArrangements?.join(", ") || "Missing"}</dd></div><div><dt>US Immigration Status</dt><dd>{({ "us-citizen": "US citizen", "permanent-resident": "Permanent resident", "visa-holder": "Visa holder", other: "Another status" } as const)[review.onboarding?.questionnaire.immigrationStatus ?? "other"]}{review.onboarding?.questionnaire.visaType ? ` · ${review.onboarding.questionnaire.visaType}` : ""}{review.onboarding?.questionnaire.immigrationStatusDetails ? ` · ${review.onboarding.questionnaire.immigrationStatusDetails}` : ""}</dd></div>{([["workAuthorization", "Currently authorized to work in the US"], ["sponsorshipNow", "Employer sponsorship now"], ["sponsorshipFuture", "Employer sponsorship in the future"]] as const).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{review.onboarding?.questionnaire[key] === "yes" ? "Yes" : review.onboarding?.questionnaire[key] === "no" ? "No" : "Missing"}</dd></div>)}{review.willingToRelocate !== undefined && <div><dt>Willing to relocate</dt><dd>{review.willingToRelocate ? "Yes" : "No"}</dd></div>}{review.onboarding?.questionnaire.availability && <div><dt>Availability</dt><dd>{review.onboarding.questionnaire.availability}</dd></div>}</dl>
        <p className={styles.consent}>By finishing onboarding, I confirm the imported professional information shown here is accurate and may be used in my applications.</p>
      </section>}
      <footer className={styles.footer}>{stageIndex > 0 ? <button disabled={Boolean(busy)} onClick={() => void go(stages[stageIndex - 1])}><ArrowLeft size={16} /> Back</button> : <span />}{stage === "review" ? <button className={styles.primary} disabled={Boolean(busy) || dirty || saveState === "Save failed" || missingFields.length > 0} onClick={() => void finish()}>{busy === "finish" ? "Finishing…" : "Finish onboarding"}<Check size={16} /></button> : <button className={styles.primary} disabled={Boolean(busy) || !parsed} onClick={() => void go(stages[stageIndex + 1])}>{busy === "save" ? "Saving…" : "Continue"}<ArrowRight size={16} /></button>}</footer>
    </main>
  </div>;
}
