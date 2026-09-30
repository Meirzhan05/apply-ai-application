import type { AppState, Job } from "@/lib/types";
import { hashJson } from "@/lib/crypto";
import { publicState } from "@/lib/public-state";
import { compareRankedJobs } from "@/lib/ranking";
import { dedupeJobs } from "@/lib/sources";
import { digestDay } from "@/lib/digest-time";

async function send(to: string, subject: string, html: string, idempotencyKey: string): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!key || !from) throw new Error("Resend email is not configured.");
  if (process.env.EMAIL_TEST_RECIPIENT && to.toLowerCase() !== process.env.EMAIL_TEST_RECIPIENT.toLowerCase()) throw new Error("Email is limited to the authorized test inbox until a verified beta sender is configured.");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "Idempotency-Key": hashJson(idempotencyKey),
    },
    body: JSON.stringify({ from, to, subject, html }),
  });
  if (!response.ok)
    throw new Error(
      `Email provider rejected the message (${response.status}).`,
    );
}

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
const appUrl = () =>
  process.env.NEXT_PUBLIC_APP_URL ||
  process.env.APP_ORIGIN ||
  "http://localhost:3000";

export async function sendActionNeeded(
  state: AppState,
  label: string,
): Promise<void> {
  if (state.profile.demo || !state.profile.email) return;
  await send(
    state.profile.email,
    `Apply: ${label}`,
    `<p>${escape(label)}</p><p><a href="${escape(appUrl())}">Open your application workspace</a></p>`,
    `action:${state.profile.id}:${state.applications.map((app) => `${app.id}:${app.status}:${app.updatedAt}`).join("|")}:${label}`,
  );
}

export async function sendDigest(
  state: AppState,
  jobs: Job[],
  asOf = new Date(),
): Promise<boolean> {
  if (state.profile.demo || !state.profile.email) return false;
  const allJobs = dedupeJobs([...(state.importedJobs ?? []), ...jobs]);
  const assessments = new Map(publicState({ ...state, jobs: allJobs }).matches.map((entry) => [entry.jobId, entry.assessment]));
  const previousDigest = new Date(state.lastDigestAt ?? "").getTime();
  const since = Number.isFinite(previousDigest) && previousDigest <= asOf.getTime()
    ? previousDigest : asOf.getTime() - 24 * 60 * 60 * 1000;
  const matches = allJobs
    .filter(
      (job) =>
        job.active &&
        state.feedback.find((item) => item.jobId === job.id)?.kind !== "dismissed" &&
        new Date(job.discoveredAt).getTime() > since &&
        new Date(job.discoveredAt).getTime() <= asOf.getTime() &&
        assessments.get(job.id)?.category !== "excluded",
    )
    .sort((a, b) => compareRankedJobs(a, b, assessments, state.feedback, allJobs))
    .slice(0, 8);
  const pending = state.applications.filter((app) =>
    ["draft_review", "needs_user_action", "final_review", "uncertain"].includes(
      app.status,
    ),
  );
  if (!matches.length && !pending.length) return false;
  const items = matches
    .map(
      (job) =>
        `<li><a href="${escape(job.url)}">${escape(job.title)}</a> at ${escape(job.company)} · ${escape(job.location)} · ${{ strong: "Strong match", possible: "Possible match", uncertain: "Uncertain", excluded: "Excluded" }[assessments.get(job.id)!.category]}</li>`,
    )
    .join("");
  await send(
    state.profile.email,
    `Apply: ${matches.length ? `${matches.length} new role${matches.length === 1 ? "" : "s"}${pending.length ? ", " : ""}` : ""}${pending.length ? `${pending.length} action${pending.length === 1 ? "" : "s"} needed` : ""}`,
    `${matches.length ? `<h2>New opportunities</h2><ul>${items}</ul>` : ""}${pending.length ? `<p>${pending.length} application${pending.length === 1 ? " needs" : "s need"} your review.</p>` : ""}<p><a href="${escape(appUrl())}">Open Apply</a></p>`,
    `digest:${state.profile.id}:${digestDay(asOf)}`,
  );
  return true;
}
