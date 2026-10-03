import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { adminSupabase } from "@/lib/supabase-admin";
import { isDemo } from "@/lib/demo-mode";
import { bytesHash } from "@/lib/resume-artifacts";
import type { Profile, ResumeSource } from "@/lib/types";

export type OriginalResume = ResumeSource & { filename: string };
export function originalResumeManifest(profile: Profile): OriginalResume {
  if (!profile.resumeSource || !profile.resumeFileName) throw new Error("Upload and confirm your original résumé before applying with tailoring disabled.");
  const original = { ...profile.resumeSource, filename: profile.resumeFileName };
  validateOriginalResume(profile.id, original); return original;
}
export function validateOriginalResume(owner: string, original: OriginalResume): void {
  const extension = original.mimeType === "application/pdf" ? "pdf" : original.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ? "docx" : null;
  if (!extension || !/^[a-zA-Z0-9-]+$/.test(owner) || !original.storageKey || !new RegExp(`^${owner}/[a-f0-9-]{36}\\.${extension}$`).test(original.storageKey) ||
      !/^[a-f0-9]{64}$/.test(original.sha256) || !Number.isInteger(original.size) || original.size < 1 || original.size > 5 * 1024 * 1024 ||
      (!original.filename || /[\x00-\x1f\x7f/\\]/.test(original.filename)) || !original.filename.toLowerCase().endsWith(`.${extension}`)) throw new Error("The original résumé manifest is invalid or belongs to another applicant.");
}
export async function readOriginalResume(owner: string, original: OriginalResume): Promise<Buffer> {
  validateOriginalResume(owner, original);
  let bytes: Buffer;
  if (isDemo()) bytes = await readFile(path.join(process.cwd(), ".data", "resumes", original.storageKey!));
  else {
    const { data, error } = await adminSupabase().storage.from("resumes").download(original.storageKey!);
    if (error || !data) throw new Error("The confirmed original résumé is unavailable. Upload and confirm it again.");
    bytes = Buffer.from(await data.arrayBuffer());
  }
  if (bytes.length !== original.size || bytesHash(bytes) !== original.sha256) throw new Error("The confirmed original résumé bytes changed. No replacement or conversion is allowed.");
  return bytes;
}
export async function saveDemoOriginalResume(key: string, bytes: Buffer): Promise<void> {
  const file = path.join(process.cwd(), ".data", "resumes", key);
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes, { mode: 0o600, flag: "wx" });
}
