import type { PersonalSearchState, Profile } from "@/lib/types";
import { personalSearchReadiness } from "@/lib/personal-search-policy";

export function PersonalSearchStatus({ profile, search, onConfigure, onSearch, busy = false }: {
  profile: Profile; search?: PersonalSearchState; onConfigure: () => void; onSearch: () => void; busy?: boolean;
}) {
  const readiness = personalSearchReadiness(profile);
  const searching = search?.status === "queued" || search?.status === "searching";
  const message = !readiness.ready
    ? `Add ${readiness.missing.join(", ")} to start your personal search automatically.`
    : search?.status === "queued" ? "Your personal search is queued. Your agent will use your confirmed experience and saved preferences."
    : search?.status === "searching" ? "Your agent is searching for you and verifying the employer postings."
    : search?.status === "failed" ? "Your search could not finish. Your agent will try again on its next scheduled check."
    : search?.status === "budget_limited" ? "Your personal search is paused because the monthly search budget has been reached."
    : search?.status === "complete" ? "These results belong to your personal search. Your agent checks again every four hours."
    : "Your profile is ready. Your personal search will start on the next scheduled check.";
  return <div className="profile-context" role="status" aria-label="Personal search status">
    <span>{message}</span>
    <div className="personal-search-actions">
      <button className="outline-action" disabled={!readiness.ready || busy || searching} onClick={onSearch}>{searching ? "Searching…" : "Search jobs (test)"}</button>
      <button className="text-button" onClick={onConfigure}>{readiness.ready ? "Edit search preferences" : "Set up my profile"}</button>
    </div>
  </div>;
}
