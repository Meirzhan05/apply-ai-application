import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ files: new Map<string, Set<string>>(), failRemove: false }));
vi.mock("@/lib/supabase-admin", () => ({
  adminSupabase: () => ({ storage: { from: (bucket: string) => ({
    list: async (prefix: string, options: { limit: number; offset: number }) => {
      const all = [...(mock.files.get(bucket) ?? [])];
      const children = new Map<string, { name: string; id: string | null }>();
      for (const path of all) {
        if (!path.startsWith(`${prefix}/`)) continue;
        const remainder = path.slice(prefix.length + 1);
        const [name, ...tail] = remainder.split("/");
        if (name) children.set(name, { name, id: tail.length ? null : "object" });
      }
      return { data: [...children.values()].slice(options.offset, options.offset + options.limit), error: null };
    },
    remove: async (paths: string[]) => {
      if (mock.failRemove) { mock.failRemove = false; return { error: new Error("transient storage failure") }; }
      const objects = mock.files.get(bucket)!;
      for (const path of paths) objects.delete(path);
      return { data: paths.map((name) => ({ name })), error: null };
    },
  }) } }),
}));

import { removeAccountStorage } from "@/lib/account-deletion";

beforeEach(() => {
  mock.files = new Map(["resumes", "application-files", "form-shots"].map((bucket) => [bucket, new Set([
    "owner-a/root.pdf", "owner-a/nested/packet.pdf", "owner-a/nested/deep/screenshot.png", "owner-b/keep.pdf",
  ])]));
  mock.failRemove = false;
});

describe("recursive account storage erasure", () => {
  it("removes root and nested private objects from all account buckets without crossing owner prefixes", async () => {
    await removeAccountStorage("owner-a");
    for (const bucket of mock.files.values()) {
      expect([...bucket].filter((path) => path.startsWith("owner-a/")).sort()).toEqual([]);
      expect([...bucket]).toContain("owner-b/keep.pdf");
    }
  });

  it("fails closed on a storage error and supports a safe retry", async () => {
    mock.failRemove = true;
    await expect(removeAccountStorage("owner-a")).rejects.toThrow(/Deletion is locked; retry/);
    expect(mock.files.get("resumes")!.size).toBe(4);
    await removeAccountStorage("owner-a");
    expect([...mock.files.get("resumes")!]).toEqual(["owner-b/keep.pdf"]);
  });
});
