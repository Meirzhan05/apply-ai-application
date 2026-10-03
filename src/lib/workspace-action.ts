// A response can be lost after a mutation commits. Never automatically retry;
// ask the user to refresh and check the latest workspace before another action.
export async function postWorkspaceAction(action: string, payload: Record<string, unknown>) {
  let response: Response;
  try { response = await fetch("/api/actions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, payload }) }); }
  catch { throw new Error("Connection interrupted. Refresh your workspace to check the latest status before trying again."); }
  if (response.status === 401) throw new Error("AUTH_REQUIRED");
  const unreadable = "The action response could not be read. Refresh your workspace to check the latest status before trying again.";
  const body = await response.json().catch(() => { throw new Error(unreadable); });
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(unreadable);
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "The action could not finish. Refresh your workspace before trying again.");
}
