import { answerNeedsAction, answerOwner, answerReviewHash } from "@/lib/answer-responsibility";
import type { Application, ScreeningAnswer } from "@/lib/types";

export function PacketReadiness({ application, dirty, busy, notice, editingEssay, pendingAnswers, compact, stale }: {
  application: Application; dirty: boolean; busy: string; notice: string; editingEssay?: boolean;
  pendingAnswers?: ScreeningAnswer[]; compact?: boolean;
  stale?: boolean;
}) {
  const answers = pendingAnswers?.length ? pendingAnswers : application.packet?.answers ?? [];
  const missing = answers.map((answer, index) => ({ answer, index })).filter(({ answer }) => answerNeedsAction(answer));
  const human = missing.filter(({ answer }) => answerOwner(answer.question) === "human");
  const essays = missing.filter(({ answer }) => answerOwner(answer.question) === "ai");
  const queued = Boolean(application.queuedRun);
  if (compact) {
    const count = human.length + essays.length + Number(dirty) + Number(editingEssay) + Number(queued) + Number(stale);
    return <section className="packet-orientation" aria-labelledby={`review-tasks-${application.id}`}>
      <h3 id={`review-tasks-${application.id}`}>{count ? `${count} ${count === 1 ? "thing" : "things"} before approval` : "Review your materials, then approve"}</h3>
      <div className="packet-task-links" aria-live="polite">
        {stale && <a href={`#materials-update-${application.id}`}>Rebuild after profile changes</a>}
        {editingEssay && <a href={`#readiness-${application.id}`}>Finish your essay edit</a>}
        {dirty && <a href={`#save-answers-${application.id}`}>Save answer changes</a>}
        {human.length > 0 && <a href={`#screening-${application.id}-${human[0].index}`}>{human.length} personal {human.length === 1 ? "answer" : "answers"}</a>}
        {essays.length > 0 && <a href={`#screening-${application.id}-${essays[0].index}`}>{essays.length} {essays.length === 1 ? "essay" : "essays"} to confirm</a>}
        {queued && <span>Queued work must finish</span>}
        {!count && <><a href={`#resume-review-${application.id}`}>Review resume</a><a href={`#screening-answers-${application.id}`}>Review answers</a><a href={`#packet-approval-${application.id}`}>Approve form filling</a></>}
      </div>
    </section>;
  }
  return <div className="packet-readiness" id={`readiness-${application.id}`} tabIndex={-1} aria-labelledby={`readiness-heading-${application.id}`}>
    <h4 id={`readiness-heading-${application.id}`}>{dirty || missing.length || queued || editingEssay || stale ? "Before approving" : "Ready for your approval"}</h4>
    <div role="status" aria-live="polite">
      {busy ? <p>Updating this application…</p> : notice && <p>{notice}</p>}
      {queued && <p>Your request is saved. Approval becomes available after the queued work finishes.</p>}
      <ul>
        {stale && <li><a href={`#materials-update-${application.id}`}>Rebuild from your updated profile</a>, then review and confirm the new materials.</li>}
        {editingEssay && <li>Save or cancel your essay revision before approving.</li>}
        {dirty && <li><a href={`#save-answers-${application.id}`}>Save your changed answers</a> before confirming essays or approving.</li>}
        {human.length > 0 && <li><a href={`#screening-${application.id}-${human[0].index}`}>Answer {human.length} personal {human.length === 1 ? "question" : "questions"}</a>.</li>}
        {essays.length > 0 && <li><a href={`#screening-${application.id}-${essays[0].index}`}>Review and confirm {essays.length} {essays.length === 1 ? "essay" : "essays"}</a>{essays.some(({ answer }) => !answerReviewHash(answer)) ? ". Use Write essays with AI if a draft is missing." : "."}</li>}
      </ul>
      {!dirty && !missing.length && !queued && !editingEssay && !stale && <p>{!notice && "Answers are saved and confirmed. "}Approval permits form filling; submission needs a separate review.</p>}
    </div>
  </div>;
}
