// A response can be lost after a mutation commits. Never automatically retry;
// ask the user to refresh and check the latest workspace before another action.
const interrupted = "Connection interrupted. Refresh your workspace to check the latest status before trying again.";
const unreadable = "The action response could not be read. Refresh your workspace to check the latest status before trying again.";
const unfinished = "The action could not finish. Refresh your workspace before trying again.";
export const actionNeedsWorkspaceCheck = (error: string) => ["AUTH_REQUIRED", interrupted, unreadable, unfinished].includes(error);
export async function postWorkspaceAction(action: string, payload: Record<string, unknown>) {
  let response: Response;
  try { response = await fetch("/api/actions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, payload }) }); }
  catch { throw new Error(interrupted); }
  if (response.status === 401) throw new Error("AUTH_REQUIRED");
  const body = await response.json().catch(() => { throw new Error(unreadable); });
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(unreadable);
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : unfinished);
}
