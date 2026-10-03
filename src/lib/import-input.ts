// Presentation validation only. The server remains authoritative for permitted
// addresses, provider availability, duplicate links and posting verification.
import type { Job } from "./types";

export function importInput(raw: string) {
  if (!raw.trim()) return { error: "Paste the job's HTTPS link.", manual: false };
  let url: URL;
  try { url = new URL(raw.trim()); }
  catch { return { error: "Enter a complete link, such as https://company.com/careers/role.", manual: false }; }
  if (url.protocol !== "https:") return { error: "Use an HTTPS job link.", manual: false };
  if (url.username || url.password) return { error: "Remove the username or password from this link.", manual: false };
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".localhost") || host.includes(":") || /^\d+(\.\d+){3}$/.test(host))
    return { error: "Use a public employer or job-board link.", manual: false };
  const parts = url.pathname.split("/").filter(Boolean);
  const board = /^[a-zA-Z0-9_-]{1,80}$/.test(parts[0] || "");
  const id = /^[a-zA-Z0-9_-]{1,100}$/.test(parts[1] || "");
  const greenhouse = ["boards.greenhouse.io", "job-boards.greenhouse.io"].includes(host) && board && parts.length === 3 && parts[1] === "jobs" && /^\d+$/.test(parts[2]);
  const lever = host === "jobs.lever.co" && board && id && (parts.length === 2 || (parts.length === 3 && parts[2] === "apply"));
  const ashby = host === "jobs.ashbyhq.com" && board && id && (parts.length === 2 || (parts.length === 3 && parts[2] === "application"));
  return { error: "", manual: !(greenhouse || lever || ashby) };
}

// Display lookup only: identify the server-returned role, including provider
// redirect aliases and tracking parameters. This grants no import permission.
function postingIdentity(raw: string) {
  try {
    const url = new URL(raw.trim());
    if (url.hostname === "boards.greenhouse.io") url.hostname = "job-boards.greenhouse.io";
    if (["jobs.lever.co", "jobs.ashbyhq.com"].includes(url.hostname)) url.pathname = url.pathname.replace(/\/(apply|application)\/?$/, "");
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key) || ["gh_src", "lever-source"].includes(key.toLowerCase())) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    if (url.hash === "#app" && /(^|\.)greenhouse\.io$/i.test(url.hostname)) url.hash = "";
    return url.toString();
  } catch { return raw.trim(); }
}

export function importedRole(before: Job[], after: Job[], submittedUrl: string) {
  const known = new Set(before.map(job => job.id));
  const identity = postingIdentity(submittedUrl);
  return after.find(job => !known.has(job.id) && [job.importUrl, job.url].some(url => url && postingIdentity(url) === identity));
}
