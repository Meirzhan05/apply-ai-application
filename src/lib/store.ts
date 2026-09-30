import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { initialDemoState } from "@/lib/demo-data";
import type { AppState } from "@/lib/types";

const dataDir = path.join(process.cwd(), ".data");
const statePath = path.join(dataDir, "demo-state.json");

let writeQueue: Promise<unknown> = Promise.resolve();

export async function readState(): Promise<AppState> {
  try {
    return JSON.parse(await readFile(statePath, "utf8")) as AppState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return initialDemoState();
  }
}

export async function updateState<T>(
  change: (state: AppState) => T | Promise<T>,
): Promise<T> {
  const operation = writeQueue.then(async () => {
    const state = await readState();
    const result = await change(state);
    await mkdir(dataDir, { recursive: true });
    await writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    return result;
  });
  writeQueue = operation.catch(() => undefined);
  return operation;
}

export function requireDemoMode(): void {
  if (process.env.DEMO_MODE !== "true") {
    throw new Error(
      "Local demo storage is disabled. Configure Supabase before using production mode.",
    );
  }
}
