import { afterEach, expect, it, vi } from "vitest";
import { actionNeedsWorkspaceCheck, postWorkspaceAction } from "./workspace-action";
afterEach(() => vi.unstubAllGlobals());
it("requires status recovery for authentication and ambiguous outcomes, while preserving specific domain retry guidance", async () => {
  expect(actionNeedsWorkspaceCheck("AUTH_REQUIRED")).toBe(true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response('<html>gateway</html>', { status: 502 })));
  try { await postWorkspaceAction("import", {}); throw new Error("Expected unreadable response"); }
  catch (error) { if (!(error instanceof Error)) throw error; expect(actionNeedsWorkspaceCheck(error.message)).toBe(true); }
  expect(actionNeedsWorkspaceCheck("Posting unavailable. Check the link or try later.")).toBe(false);
});
it("sends one JSON action and accepts a successful response", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{"ok":true}')); vi.stubGlobal("fetch", fetch);
  await postWorkspaceAction("feedback", { jobId: "a", kind: "saved" });
  expect(fetch).toHaveBeenCalledOnce();
  const body = fetch.mock.calls[0][1]?.body;
  if (typeof body !== "string") throw new Error("Expected a JSON request body");
  expect(JSON.parse(body)).toEqual({ action: "feedback", payload: { jobId: "a", kind: "saved" } });
});
it("gives safe recovery for malformed success or failure without retrying", async () => {
  for (const status of [200, 502]) {
    const fetch = vi.fn(async () => new Response('<html>gateway response</html>', { status })); vi.stubGlobal("fetch", fetch);
    await expect(postWorkspaceAction("feedback", {})).rejects.toThrow("Refresh your workspace to check the latest status");
    expect(fetch).toHaveBeenCalledOnce();
  }
});
it("keeps expired authentication distinguishable even when its body is malformed", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response('not json', { status: 401 })));
  await expect(postWorkspaceAction("feedback", {})).rejects.toThrow("AUTH_REQUIRED");
});
it("preserves specific server guidance", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"This role’s collection changed."}', { status: 409 })));
  await expect(postWorkspaceAction("feedback", {})).rejects.toThrow("This role’s collection changed.");
});
it("handles network failure or invalid JSON shape with one request and no parser jargon", async () => {
  const fetch = vi.fn(async () => { throw new TypeError("Failed to fetch"); }); vi.stubGlobal("fetch", fetch);
  await expect(postWorkspaceAction("feedback", {})).rejects.toThrow("Connection interrupted"); expect(fetch).toHaveBeenCalledOnce();
  vi.stubGlobal("fetch", vi.fn(async () => new Response('null')));
  await expect(postWorkspaceAction("feedback", {})).rejects.toThrow("The action response could not be read.");
});
