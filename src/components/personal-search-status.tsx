import type { PersonalSearchState, Profile } from "@/lib/types";
import { personalSearchReadiness } from "@/lib/personal-search-policy";

export function PersonalSearchStatus({ profile, search, onConfigure, onImport }: {
  profile: Profile; search?: PersonalSearchState; onConfigure: () => void; onImport: () => void;
}) {
  const readiness = personalSearchReadiness(profile);
  const message = !readiness.ready
    ? `Add ${new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(readiness.missing)} to start your personal search automatically.`
    : search?.status === "queued" ? "Your personal search is queued. Your agent will use your confirmed experience and saved preferences."
    : search?.status === "searching" ? "Your agent is searching for you and verifying the employer postings."
    : search?.status === "failed" ? "Your search could not finish. Scheduled checks run every four hours. You can import a specific posting while you wait."
    : search?.status === "budget_limited" ? "Your personal search is paused at the monthly service budget limit. The budget resets at 00:00 UTC on the first day of each month. You can still review your existing roles."
    : search?.status === "complete" ? (search.jobs.length ? "Personal search completed. Scheduled checks run every four hours. Imported postings also appear in your list." : "Your last personal search found no verified openings. Scheduled checks run every four hours. You can update your preferences or import a specific posting.")
    : "Ready for personal search. Your search will start on the next scheduled check, which runs every four hours.";
  return <div className="profile-context personal-search-context" role="status" aria-label="Personal search status">
    <span>{message}</span>
    <div className="personal-search-actions">
      <button className={readiness.ready ? "text-button" : "dark-button"} onClick={onConfigure}>{readiness.ready ? "Edit search preferences" : "Set up my profile"}</button>
      {readiness.ready && search?.status === "failed" && <button className="text-button" onClick={onImport}>Import a posting</button>}
      {readiness.ready && search?.status === "budget_limited" && <a className="text-button" href="/usage">Review AI usage</a>}
    </div>
  </div>;
}
