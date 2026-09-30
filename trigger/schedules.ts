import { schedules } from "@trigger.dev/sdk";

async function invoke(path: string) {
  const origin = process.env.APP_ORIGIN;
  const secret = process.env.INTERNAL_TASK_SECRET;
  if (!origin || !secret)
    throw new Error("Set APP_ORIGIN and INTERNAL_TASK_SECRET in Trigger.dev.");
  const response = await fetch(new URL(path, origin), {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  });
  if (!response.ok)
    throw new Error(
      `${path} returned ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  return response.json();
}

export const refreshJobs = schedules.task({
  id: "refresh-public-job-boards",
  cron: { pattern: "0 */4 * * *", timezone: "America/New_York" },
  run: async () => invoke("/api/internal/refresh"),
});

export const dailyDigest = schedules.task({
  id: "send-daily-job-digest",
  cron: { pattern: "0 9 * * *", timezone: "America/New_York" },
  run: async () => invoke("/api/internal/digest"),
});

export const reconcileBrowserRuns = schedules.task({
  id: "reconcile-stale-browser-runs",
  cron: { pattern: "*/15 * * * *", timezone: "America/New_York" },
  run: async () => invoke("/api/internal/reconcile"),
});

export const dispatchApplicationQueue = schedules.task({
  id: "dispatch-application-queue",
  cron: { pattern: "*/5 * * * *", timezone: "America/New_York" },
  run: async () => invoke("/api/internal/queue"),
});
