import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function writeUsageLedger<T extends { id: string; userId: string }>(options: {
  file: string;
  record: T;
  merge: (previous: T | undefined, incoming: T) => T;
  validatePrevious?: (previous: T, incoming: T) => void;
}): Promise<void> {
  let records: T[];
  try { records = JSON.parse(await readFile(options.file, "utf8")) as T[]; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    records = [];
  }
  const previous = records.find((item) => item.id === options.record.id);
  if (previous && previous.userId !== options.record.userId) throw new Error("Usage record belongs to another owner.");
  if (previous) options.validatePrevious?.(previous, options.record);
  const next = [...records.filter((item) => item.id !== options.record.id), options.merge(previous, options.record)];
  await mkdir(path.dirname(options.file), { recursive: true });
  const temporary = `${options.file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
  await rename(temporary, options.file);
}
