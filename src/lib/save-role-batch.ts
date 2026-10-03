// Each save is an independent, reversible bookmark. Stop after an error or
// cancellation; never pretend the already completed saves were rolled back.
export async function saveRoleBatch(ids: string[], options: {
  save: (id: string) => Promise<void>;
  cancelled: () => boolean;
  onProgress: (done: number) => void;
}) {
  const savedIds: string[] = [];
  for (const id of ids) {
    if (options.cancelled()) return { savedIds, stopped: true };
    try { await options.save(id); }
    catch (error) { return { savedIds, stopped: false, error: error instanceof Error ? error.message : "A role could not be saved. Try again." }; }
    savedIds.push(id);
    options.onProgress(savedIds.length);
  }
  return { savedIds, stopped: false };
}
