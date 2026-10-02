import { answerNeedsAction, answerOwner } from "@/lib/answer-responsibility";
import type { Application } from "@/lib/types";

export function PacketReadiness({ application, dirty, busy, notice }: {
  application: Application; dirty: boolean; busy: string; notice: string;
}) {
  const answers = application.packet?.answers ?? [];
  const missing = answers.map((answer, index) => ({ answer, index })).filter(({ answer }) => answerNeedsAction(answer));
  const human = missing.filter(({ answer }) => answerOwner(answer.question) === "human");
  const essays = missing.filter(({ answer }) => answerOwner(answer.question) === "ai");
  const queued = Boolean(application.queuedRun);
  return <div className="packet-readiness" id={`readiness-${application.id}`}>
    <h4>{dirty || missing.length || queued ? "Before approving" : "Ready for your approval"}</h4>
    <div role="status" aria-live="polite">
      {busy ? <p>Updating this application…</p> : notice && <p>{notice}</p>}
      {queued && <p>Your request is saved. Approval becomes available after the queued work finishes.</p>}
      <ul>
        {dirty && <li><a href={`#save-answers-${application.id}`}>Save your changed answers</a> before confirming essays or approving.</li>}
        {human.length > 0 && <li><a href={`#screening-${application.id}-${human[0].index}`}>Answer {human.length} personal {human.length === 1 ? "question" : "questions"}</a>.</li>}
        {essays.length > 0 && <li><a href={`#screening-${application.id}-${essays[0].index}`}>Review and confirm {essays.length} {essays.length === 1 ? "essay" : "essays"}</a>{essays.some(({ answer }) => !answer.aiDraft) ? ". Use Write essays with AI if a draft is missing." : "."}</li>}
      </ul>
      {!dirty && !missing.length && !queued && <p>Answers are saved and confirmed. Approval permits form filling; submission needs a separate review.</p>}
    </div>
  </div>;
}
