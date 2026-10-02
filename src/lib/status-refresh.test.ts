import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), version: vi.fn(), load: vi.fn() }));
vi.mock("@/lib/repository", () => ({ currentUserId: mocks.user, loadState: mocks.load }));
vi.mock("@/lib/workspace-version", () => ({ workspaceVersion: mocks.version }));
vi.mock("@/lib/public-state", () => ({ publicState: (state: unknown) => state }));
import { GET } from "@/app/api/status/route";

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.user.mockResolvedValue("owner-a");
  mocks.version.mockResolvedValue('"v1"');
  mocks.load.mockResolvedValue({ matches: [], profile: { id: "owner-a" } });
});
afterEach(() => vi.useRealTimers());

it("checks tiny versions while idle and sends full state only after a change", async () => {
  const abort = new AbortController();
  const response = await GET(new Request("https://apply.example/api/status", { signal: abort.signal }));
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('id: "v1"\nevent: state');
  await vi.advanceTimersByTimeAsync(6000);
  expect(mocks.load).toHaveBeenCalledTimes(1);
  mocks.version.mockResolvedValue('"v2"');
  await vi.advanceTimersByTimeAsync(3000);
  expect(mocks.load).toHaveBeenCalledTimes(2);
  await reader.read();
  await reader.read();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('id: "v2"');
  abort.abort();
  await vi.advanceTimersByTimeAsync(6000);
  expect(mocks.load).toHaveBeenCalledTimes(2);
});

it("resumes a legacy client's connection without redownloading unchanged state", async () => {
  const abort = new AbortController();
  const response = await GET(new Request("https://apply.example/api/status", { signal: abort.signal, headers: { "Last-Event-ID": '"v1"' } }));
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(": keepalive\n\n");
  expect(mocks.load).not.toHaveBeenCalled();
  abort.abort();
});

it("does not enqueue a late database response after the connection is cancelled", async () => {
  let resolve: (version: string) => void = () => undefined;
  mocks.version.mockImplementationOnce(() => new Promise<string>((done) => { resolve = done; }));
  const response = await GET(new Request("https://apply.example/api/status"));
  const reader = response.body!.getReader();
  await reader.cancel();
  resolve('"v1"');
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.load).not.toHaveBeenCalled();
});
