"use client";

import { useEffect, useId, useRef, useState } from "react";
import { X, LoaderCircle } from "lucide-react";
import { browserQuestions } from "@/lib/browser-questions";
import type { Application, VerifiedFact } from "@/lib/types";

export function BrowserQuestionsDialog({ application, busy, error, facts, act }: {
  application: Application;
  busy: string;
  error: string;
  facts: VerifiedFact[];
  act: (action: string, payload: Record<string, unknown>) => Promise<unknown | null>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const questions = browserQuestions(application.form);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(questions.map((question) => [question.id, question.value])));
  const [confirmed, setConfirmed] = useState<Record<string, string>>({});
  const storedDrafts = application.browserQuestionDrafts;
  const drafts = storedDrafts && storedDrafts.formHash === application.form?.hash &&
    storedDrafts.sessionId === application.browserSessionId &&
    storedDrafts.packetHash === application.packetHash ? storedDrafts.answers : {};
  const drafting = application.browserQuestionRun?.kind === "essays";
  const blocked = Boolean(busy) || Boolean(application.browserQuestionRun);
  const missingDraft = questions.some((question) => question.owner === "ai" && !drafts[question.id]?.aiDraft);
  const complete = questions.every((question) => question.owner === "ai" ? drafts[question.id]?.aiDraft && confirmed[question.id] === drafts[question.id].aiDraft!.contentHash : values[question.id]?.trim());
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!complete || blocked) return;
    const result = await act("answerBrowserQuestions", { applicationId: application.id, formHash: application.form!.hash,
      answers: questions.map((question) => question.owner === "ai" ? { questionId: question.id, confirmEssay: true, answerHash: confirmed[question.id] } :
        { questionId: question.id, value: values[question.id] }) });
    if (result) dialog.current?.close();
  };
  return <>
    <div className="step-card question-prompt">
      <h3>A few answers to keep going</h3>
      <p>The agent filled what it could. Answer the remaining questions here, and it will continue in the same browser.</p>
      <button className="dark-button" disabled={Boolean(busy)} onClick={() => dialog.current?.showModal()}>Answer {questions.length} {questions.length === 1 ? "question" : "questions"}</button>
    </div>
    <dialog ref={dialog} className="questions-dialog" aria-labelledby={heading} onCancel={(event) => { if (busy) event.preventDefault(); }}>
      <header>
        <div><h2 id={heading}>Help the agent keep going</h2><p>These questions come from the employer’s form. Answers are saved for this application.</p></div>
        <button type="button" className="question-close" aria-label="Close questions" disabled={Boolean(busy)} onClick={() => dialog.current?.close()}><X size={20} /></button>
      </header>
      <form onSubmit={submit}>
        <div className="question-list">
          {questions.map((question, index) => <section className="browser-question" key={question.id}>
            <label htmlFor={`${heading}-${index}`} className="question-label">{question.label}</label>
            {question.owner === "ai" ? <>
              <p className="question-hint">AI writes this answer using your confirmed facts. Review it before continuing.</p>
              {drafts[question.id]?.aiDraft ? <>
                <div className="question-essay" id={`${heading}-${index}`}>{drafts[question.id].answer}</div>
                <details className="question-sources"><summary>Facts used in this answer</summary><ul>{drafts[question.id].factIds.map((id) => <li key={id}>{facts.find((fact) => fact.id === id && fact.verified)?.text || "Source changed. Regenerate this AI answer."}</li>)}</ul></details>
                <label className="question-confirm"><input type="checkbox" disabled={blocked} checked={confirmed[question.id] === drafts[question.id].aiDraft!.contentHash} onChange={(event) => setConfirmed({ ...confirmed, [question.id]: event.target.checked ? drafts[question.id].aiDraft!.contentHash : "" })} />I reviewed and confirm this AI answer</label>
              </> : <p role="status" className="question-hint">{drafting ? "The agent is writing and checking this answer…" : "An AI draft is needed before you can confirm this answer."}</p>}
            </> : <>
              <p className="question-hint">{question.kind === "checkbox" ? "Check this only if you agree with the employer’s statement." : question.options.length ? "Choose one of the employer’s options." : "Your answer will be entered exactly as supplied."}</p>
              {question.kind === "checkbox" ? <input id={`${heading}-${index}`} type="checkbox" required disabled={blocked} checked={values[question.id] === "Yes"} onChange={(event) => setValues({ ...values, [question.id]: event.target.checked ? "Yes" : "" })} /> : question.options.length ? <select id={`${heading}-${index}`} required disabled={blocked} value={values[question.id] || ""} onChange={(event) => setValues({ ...values, [question.id]: event.target.value })}>
                <option value="" disabled>Choose an option</option>{question.options.map((option) => <option key={option} value={option}>{option}</option>)}
              </select> : question.kind === "textarea" ? <textarea id={`${heading}-${index}`} required maxLength={4000} rows={3} disabled={blocked} value={values[question.id] || ""} onChange={(event) => setValues({ ...values, [question.id]: event.target.value })} /> :
                <input id={`${heading}-${index}`} required maxLength={4000} type={["email", "tel", "url", "number", "date"].includes(question.kind) ? question.kind : "text"} disabled={blocked} value={values[question.id] || ""} onChange={(event) => setValues({ ...values, [question.id]: event.target.value })} />}
            </>}
          </section>)}
          {(error || application.error) && <p className="question-error" role="alert">{error || application.error}</p>}
        </div>
        <footer>
          <p>Continuing authorizes these answers to be filled. You’ll still review the completed form before submission.</p>
          {missingDraft && <button type="button" className="outline-action" disabled={blocked} onClick={() => act("draftBrowserEssays", { applicationId: application.id, formHash: application.form!.hash })}>{drafting ? "Writing AI answers…" : "Write answers with AI"}</button>}
          <button type="submit" className="dark-button" disabled={!complete || blocked}>{busy === "answerBrowserQuestions" ? <><LoaderCircle size={18} className="spin" /> Continuing…</> : "Save answers and continue"}</button>
        </footer>
      </form>
    </dialog>
  </>;
}
