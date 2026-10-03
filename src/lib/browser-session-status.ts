import type { Application } from "@/lib/types";

export function browserSessionAvailable(application: Pick<Application, "browserSessionId" | "browserSessionExpiresAt"> | undefined, now = Date.now()): boolean {
  if (!application?.browserSessionId) return false;
  if (!application.browserSessionExpiresAt) return true;
  return Date.parse(application.browserSessionExpiresAt) > now;
}
