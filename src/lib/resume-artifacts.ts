import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { adminSupabase } from "@/lib/supabase-admin";
import { isDemo } from "@/lib/demo-mode";

export const bytesHash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const bucket = "application-files";
function assertOwnerKey(userId: string, key: string) {
  if (!/^[a-zA-Z0-9-]+$/.test(userId) || !new RegExp(`^${userId}/[a-f0-9]{64}/[a-f0-9]{64}\\.(pdf|tex)$`).test(key)) throw new Error("The application artifact does not belong to this profile.");
}
const localPath = (key: string) => path.join(process.cwd(), ".data", bucket, key);
export async function readArtifact(userId: string, key: string, sha256: string, size: number): Promise<Buffer> {
  assertOwnerKey(userId, key);
  let bytes: Buffer;
  if (isDemo()) bytes = await readFile(localPath(key));
  else {
    const { data, error } = await adminSupabase().storage.from(bucket).download(key);
    if (error || !data) throw new Error("The saved application file is unavailable. Rebuild and review the packet.");
    bytes = Buffer.from(await data.arrayBuffer());
  }
  if (bytes.length !== size || bytesHash(bytes) !== sha256) throw new Error("The application file changed. Rebuild and review the packet before filling.");
  return bytes;
}
export async function saveArtifact(userId: string, inputHash: string, bytes: Buffer, extension: "pdf" | "tex") {
  const sha256 = bytesHash(bytes);
  const storageKey = `${userId}/${inputHash}/${sha256}.${extension}`;
  assertOwnerKey(userId, storageKey);
  if (bytes.length < 1 || bytes.length > 5 * 1024 * 1024) throw new Error("The generated application file must be between 1 byte and 5 MB.");
  if (isDemo()) {
    const file = localPath(storageKey);
    await mkdir(path.dirname(file), { recursive: true });
    try { await writeFile(file, bytes, { mode: 0o600, flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } else {
    const { error } = await adminSupabase().storage.from(bucket).upload(storageKey, bytes, { contentType: extension === "pdf" ? "application/pdf" : "text/plain", upsert: false });
    if (error && !["409", "400"].includes(String((error as { statusCode?: string }).statusCode))) throw new Error("Saving the application file failed. Retry the draft; your existing packet is preserved.");
  }
  // Verify both freshly saved files and concurrent identical uploads. A
  // duplicate-object response alone is not evidence of identical bytes.
  await readArtifact(userId, storageKey, sha256, bytes.length);
  return { storageKey, sha256, size: bytes.length };
}
