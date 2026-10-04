import { describe, expect, it, vi } from "vitest";
import { saveRoleBatch } from "./save-role-batch";

describe("filtered-view saving", () => {
  it("saves serially and reports completed roles", async () => {
    const calls: string[] = []; const progress = vi.fn();
    const result = await saveRoleBatch(["a", "b"], { save: async id => { calls.push(id); }, cancelled: () => false, onProgress: progress });
    expect(calls).toEqual(["a", "b"]); expect(result).toEqual({ savedIds: ["a", "b"], stopped: false });
    expect(progress.mock.calls).toEqual([[1], [2]]);
  });
  it("stops after failure and preserves successful saves for truthful recovery", async () => {
    const save = vi.fn(async (id: string) => { if (id === "b") throw new Error("Connection lost"); });
    expect(await saveRoleBatch(["a", "b", "c"], { save, cancelled: () => false, onProgress: () => {} })).toEqual({ savedIds: ["a"], stopped: false, error: "Connection lost" });
    expect(save.mock.calls).toEqual([["a"], ["b"]]);
  });
  it("finishes an in-flight save when stopped, without starting the next", async () => {
    let stopped = false;
    const save = vi.fn(async () => { stopped = true; });
    expect(await saveRoleBatch(["a", "b"], { save, cancelled: () => stopped, onProgress: () => {} })).toEqual({ savedIds: ["a"], stopped: true });
    expect(save).toHaveBeenCalledTimes(1);
  });
  it("does nothing when stopped before the first request", async () => {
    const save = vi.fn();
    expect(await saveRoleBatch(["a"], { save, cancelled: () => true, onProgress: () => {} })).toEqual({ savedIds: [], stopped: true });
    expect(save).not.toHaveBeenCalled();
  });
});
