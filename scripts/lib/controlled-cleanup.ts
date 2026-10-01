import type { BrowserProvider } from "../../src/lib/types";

export interface CleanupSession { provider: BrowserProvider; sessionId: string; runId: string; applicationId?: string; jobId?: string }
export class ControlledCleanupBlocked extends Error {
  constructor(public readonly reason: "worker_in_flight" | "allocation_unknown" | "provider_release" | "storage_list" | "storage_remove" | "owner_delete") {
    super(`Synthetic cleanup blocked: ${reason}. Owner and usage evidence retained.`);
  }
}
interface CleanupDependencies {
  sessions: CleanupSession[];
  workerInFlight: boolean;
  allocationUnknown: boolean;
  stopAndConfirm(session: CleanupSession): Promise<void>;
  list(bucket: string, prefix: string, offset: number): Promise<{ name: string; id: string | null }[]>;
  remove(bucket: string, keys: string[]): Promise<void>;
  deleteOwner(): Promise<void>;
}

// Test-only cleanup. Delete the owner last: its FK cascade removes usage evidence.
export async function cleanupControlledOwner(ownerId: string, dependencies: CleanupDependencies): Promise<void> {
  for (const session of dependencies.sessions) {
    try { await dependencies.stopAndConfirm(session); }
    catch { throw new ControlledCleanupBlocked("provider_release"); }
  }
  if (dependencies.workerInFlight) throw new ControlledCleanupBlocked("worker_in_flight");
  if (dependencies.allocationUnknown) throw new ControlledCleanupBlocked("allocation_unknown");
  for (const bucket of ["application-files", "form-shots"]) {
    const collect = async (prefix: string): Promise<string[]> => {
      const keys: string[] = [];
      for (let offset = 0; ; offset += 100) {
        let entries;
        try { entries = await dependencies.list(bucket, prefix, offset); }
        catch { throw new ControlledCleanupBlocked("storage_list"); }
        for (const entry of entries) {
          if (!entry.name || entry.name.includes("/") || entry.name === "." || entry.name === "..") throw new ControlledCleanupBlocked("storage_list");
          const key = `${prefix}/${entry.name}`;
          if (!key.startsWith(`${ownerId}/`)) throw new ControlledCleanupBlocked("storage_list");
          if (entry.id === null) keys.push(...await collect(key)); else keys.push(key);
        }
        if (entries.length < 100) return keys;
      }
    };
    const keys = await collect(ownerId);
    for (let start = 0; start < keys.length; start += 100) {
      try { await dependencies.remove(bucket, keys.slice(start, start + 100)); }
      catch { throw new ControlledCleanupBlocked("storage_remove"); }
    }
    if ((await collect(ownerId)).length) throw new ControlledCleanupBlocked("storage_remove");
  }
  try { await dependencies.deleteOwner(); }
  catch { throw new ControlledCleanupBlocked("owner_delete"); }
}
