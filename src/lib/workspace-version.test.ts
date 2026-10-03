import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ revision: 1, catalog: vi.fn(), error: null as null | Error, columns: [] as string[], owners: [] as string[] }));
vi.mock("@/lib/demo-mode", () => ({ isDemo: () => false }));
vi.mock("@/lib/catalog", () => ({ readCatalogRevision: mocks.catalog }));
vi.mock("@/lib/supabase-admin", () => ({ adminSupabase: () => ({ from: () => ({ select: (columns: string) => {
  mocks.columns.push(columns);
  return { eq: (_column: string, owner: string) => {
    mocks.owners.push(owner);
    return { maybeSingle: async () => ({ data: { revision: mocks.revision }, error: mocks.error }) };
  } };
} }) }) }));
import { workspaceVersion } from "@/lib/workspace-version";
beforeEach(() => { mocks.revision = 1; mocks.error = null; mocks.columns = []; mocks.owners = []; mocks.catalog.mockResolvedValue("1"); });

it("only reads revisions and changes the owner-scoped validator for workspace or catalog updates", async () => {
  const first = await workspaceVersion("owner-a");
  expect(await workspaceVersion("owner-a")).toBe(first);
  expect(await workspaceVersion("owner-b")).not.toBe(first);
  mocks.revision = 2;
  const updated = await workspaceVersion("owner-a");
  expect(updated).not.toBe(first);
  mocks.catalog.mockResolvedValue("2");
  expect(await workspaceVersion("owner-a")).not.toBe(updated);
  expect(new Set(mocks.columns)).toEqual(new Set(["revision"]));
  expect(mocks.owners).toContain("owner-a");
});

it("propagates a failed version read instead of accepting a stale validator", async () => {
  mocks.error = new Error("Database unavailable");
  await expect(workspaceVersion("owner-a")).rejects.toThrow("Database unavailable");
});
