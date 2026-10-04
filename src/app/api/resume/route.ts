import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { newId } from "@/lib/crypto";
import { adminSupabase } from "@/lib/supabase-admin";
import { currentUserId, isDemo, loadState, mutateState } from "@/lib/repository";
import { sameOrigin } from "@/lib/request-security";
import { parseDocxSource } from "@/lib/docx-source";
import { parsePdfSource } from "@/lib/pdf-source";
import { dispatchResumeExtraction, queuedResumeExtraction, retryResumeExtraction } from "@/lib/resume-extraction-jobs";
import { AccountDeletionInProgressError, withAccountOperation } from "@/lib/account-lifecycle";

import { saveDemoOriginalResume } from "@/lib/original-resume";
import type { ResumeSourceDocument } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;
export async function POST(request: Request) {
  if (!sameOrigin(request))
    return NextResponse.json(
      { error: "Cross-origin request rejected." },
      { status: 403 },
    );
  try {
    const userId = await currentUserId();
    return await withAccountOperation(userId, "upload", async () => {
    const trustedName = (await loadState(userId)).profile.name;
    const data = await request.formData();
    const file = data.get("file");
    if (!(file instanceof File) || file.size < 1 || file.size > 5 * 1024 * 1024)
      throw new Error("Choose a PDF or DOCX up to 5 MB.");
    const name = file.name.slice(0, 180);
    const pdf = /\.pdf$/i.test(name) && file.type === "application/pdf";
    const docx =
      /\.docx$/i.test(name) &&
      (file.type ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        file.type === "application/octet-stream");
    if (!pdf && !docx)
      throw new Error("Only PDF and DOCX resumes are supported.");
    const uploadSequence = await mutateState(userId, state => {
      state.profile.resumeUploadSequence = (state.profile.resumeUploadSequence ?? 0) + 1;
      return state.profile.resumeUploadSequence;
    });
    const buffer = Buffer.from(await file.arrayBuffer());
    let extracted = "";
    let sourceDocument: ResumeSourceDocument | undefined;
    if (pdf) {
      sourceDocument = await parsePdfSource(buffer, trustedName);
      extracted = sourceDocument.text;
    } else {
      sourceDocument = await parseDocxSource(buffer, trustedName);
      extracted = sourceDocument.text;
    }
    extracted = extracted.replace(/\0/g, "").trim();
    if (extracted.length > 20000)
      throw new Error("This resume contains more than 20,000 readable characters. Shorten the source or upload a supported version; no text was dropped.");
    if (!extracted && !pdf)
      throw new Error(
        "This resume has no readable text. Add facts manually in your profile.",
      );
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    let storageKey: string | undefined;
    if (isDemo()) { storageKey = `${userId}/${newId()}.${pdf ? "pdf" : "docx"}`; await saveDemoOriginalResume(storageKey, buffer); }
    if (!isDemo()) {
      const client = adminSupabase();
      const key = `${userId}/${newId()}.${pdf ? "pdf" : "docx"}`;
      const { error } = await client.storage
        .from("resumes")
        .upload(key, buffer, {
          contentType: pdf
            ? "application/pdf"
            : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          upsert: false,
        });
      if (error) throw error;
      storageKey = key;
    }
    const extraction = queuedResumeExtraction(name, { source: {
      ...(storageKey ? { storageKey } : {}), sha256, size: buffer.byteLength,
      mimeType: pdf ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }, document: sourceDocument });
    extraction.uploadSequence = uploadSequence;
    const current = await mutateState(userId, state => {
      if ((state.profile.resumeExtraction?.uploadSequence ?? 0) > uploadSequence) return false;
      state.profile.resumeExtraction = extraction;
      return true;
    });
    if (!current) return NextResponse.json({ ok: true, status: "superseded" }, { status: 202 });
    await dispatchResumeExtraction(userId, extraction.id);
    return NextResponse.json({ ok: true, requestId: extraction.id, status: "queued" }, { status: 202 });
    }, "api/resume");
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to read resume.",
      },
      { status: error instanceof AccountDeletionInProgressError ? 409 : 400 },
    );
  }
}

export async function PATCH(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  try {
    const userId = await currentUserId();
    await withAccountOperation(userId, "request", () => retryResumeExtraction(userId), "resume-extraction-retry");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Extraction retry failed." }, { status: error instanceof AccountDeletionInProgressError ? 409 : 400 });
  }
}
