import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createWorkspaceRefresh } from "@/lib/workspace-refresh";

let visibility: EventTarget & { hidden: boolean };
let refresh: ReturnType<typeof createWorkspaceRefresh<{ revision: number }>>;
const fetchState = vi.fn<typeof fetch>();
const onState = vi.fn();
const changed = (revision: number) => Response.json({ revision }, { headers: { etag: `"v${revision}"` } });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  visibility = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal("document", visibility);
  vi.stubGlobal("fetch", fetchState);
  refresh = createWorkspaceRefresh(onState);
  refresh.start();
});
afterEach(() => { refresh.stop(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("loads once, sends a validator on later polls, and preserves state on an empty 304", async () => {
  fetchState.mockResolvedValueOnce(changed(1)).mockResolvedValue(new Response(null, { status: 304 }));
  await refresh.reload();
  await vi.advanceTimersByTimeAsync(45_000);
  expect(fetchState).toHaveBeenCalledTimes(4);
  expect(fetchState.mock.calls[1][1]?.headers).toEqual({ "If-None-Match": '"v1"' });
  expect(onState).toHaveBeenCalledTimes(1);
});

it("pauses while hidden and checks for changes immediately on return", async () => {
  fetchState.mockResolvedValueOnce(changed(1)).mockResolvedValue(changed(2));
  await refresh.reload();
  visibility.hidden = true;
  visibility.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(90_000);
  expect(fetchState).toHaveBeenCalledTimes(1);
  visibility.hidden = false;
  visibility.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchState).toHaveBeenCalledTimes(2);
  expect(onState).toHaveBeenLastCalledWith({ revision: 2 });
});

it("does not overlap slow polls and performs an explicit reload after the older response", async () => {
  fetchState.mockResolvedValueOnce(changed(1));
  await refresh.reload();
  let resolve: (response: Response) => void = () => undefined;
  fetchState.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; })).mockResolvedValue(changed(3));
  await vi.advanceTimersByTimeAsync(15_000);
  const explicit = refresh.reload();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetchState).toHaveBeenCalledTimes(2);
  resolve(changed(2));
  expect(await explicit).toEqual({ revision: 3 });
  expect(fetchState).toHaveBeenCalledTimes(3);
  expect(fetchState.mock.calls[2][1]?.headers).toEqual({});
});

it("retries a failed poll and does not publish a response after stopping", async () => {
  fetchState.mockResolvedValueOnce(changed(1)).mockRejectedValueOnce(new Error("Temporary network failure")).mockResolvedValue(changed(2));
  await refresh.reload();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(onState).toHaveBeenLastCalledWith({ revision: 2 });
  let resolve: (response: Response) => void = () => undefined;
  fetchState.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
  const late = refresh.reload();
  refresh.stop();
  resolve(changed(3));
  await late;
  expect(onState).toHaveBeenCalledTimes(2);
});
