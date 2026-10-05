import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { newId } from "@/lib/crypto";
import { adminSupabase } from "@/lib/supabase-admin";
import { currentUserId, isDemo, loadState, mutateState } from "@/lib/repository";
import { sameOrigin } from "@/lib/request-security";
import { parseDocxSource } from "@/lib/docx-source";
import { parsePdfSource } from "@/lib/pdf-source";
import { dispatchResumeExtraction, fillReusedOnboardingBasics, queuedResumeExtraction, retryResumeExtraction } from "@/lib/resume-extraction-jobs";
import { AccountDeletionInProgressError, withAccountOperation } from "@/lib/account-lifecycle";

import { originalResumeManifest, readOriginalResume, saveDemoOriginalResume } from "@/lib/original-resume";
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
    const savedProfile = (await loadState(userId)).profile;
    const trustedName = savedProfile.name;
    const data = await request.formData();
    const reuse = data.get("reuse") === "true";
    const reextract = reuse && data.get("reextract") === "true";
    const original = reuse ? originalResumeManifest(savedProfile) : undefined;
    const suppliedFile = data.get("file");
    const file = suppliedFile instanceof File ? suppliedFile : undefined;
    const size = original?.size ?? file?.size ?? 0;
    if ((!original && !file) || size < 1 || size > 5 * 1024 * 1024)
      throw new Error("Choose a PDF or DOCX up to 5 MB.");
    const name = (original?.filename ?? file!.name).slice(0, 180);
    const mimeType = original?.mimeType ?? file!.type;
    const pdf = /\.pdf$/i.test(name) && mimeType === "application/pdf";
    const docx =
      /\.docx$/i.test(name) &&
      (mimeType ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        mimeType === "application/octet-stream");
    if (!pdf && !docx)
      throw new Error("Only PDF and DOCX resumes are supported.");
    const importToken = newId();
    const uploadSequence = await mutateState(userId, state => {
      state.profile.resumeUploadSequence = (state.profile.resumeUploadSequence ?? 0) + 1;
      state.profile.resumeImport = { token: importToken, startedAt: new Date().toISOString() };
      return state.profile.resumeUploadSequence;
    });
    try {
    const buffer = original ? await readOriginalResume(userId, original) : Buffer.from(await file!.arrayBuffer());
    let extracted = "";
    let sourceDocument: ResumeSourceDocument;
    if (reuse && !reextract && savedProfile.resumeSourceDocument && savedProfile.resumeSourceDocument.sourceHash === original?.sha256 && savedProfile.resumeSourceDocument.text.trim()) {
      sourceDocument = savedProfile.resumeSourceDocument;
      extracted = sourceDocument.text;
    } else if (pdf) {
      sourceDocument = await parsePdfSource(buffer, trustedName);
      extracted = sourceDocument.text;
    } else {
      sourceDocument = await parseDocxSource(buffer, trustedName);
      extracted = sourceDocument.text;
    }
    extracted = extracted.replace(/\0/g, "").trim();
    if (extracted.length > 20000)
      throw new Error("This resume contains more than 20,000 readable characters. Shorten the source or upload a supported version; no text was dropped.");
    if (!extracted)
      throw new Error(
        "This resume has no readable text. Retry with a readable PDF or replace it with a DOCX.",
      );
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    let storageKey: string | undefined = original?.storageKey;
    if (!reuse && isDemo()) { storageKey = `${userId}/${newId()}.${pdf ? "pdf" : "docx"}`; await saveDemoOriginalResume(storageKey, buffer); }
    if (!reuse && !isDemo()) {
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
    }, document: sourceDocument, onboardingImport: { token: importToken, reused: reuse,
      baseline: {
        name: savedProfile.name, contactEmail: savedProfile.contactEmail, phone: savedProfile.phone, links: savedProfile.links,
        linkedinUrl: savedProfile.linkedinUrl, githubUrl: savedProfile.githubUrl, portfolioUrl: savedProfile.portfolioUrl,
      } } });
    extraction.uploadSequence = uploadSequence;
    const current = await mutateState(userId, state => {
      if ((state.profile.resumeExtraction?.uploadSequence ?? 0) > uploadSequence || state.profile.resumeImport?.token !== importToken) return false;
      // A reviewed, current extraction can be reused without discarding its corrections.
      if (reuse && !reextract && state.profile.resumeExtraction?.status === "ready" && state.profile.resumeDetailsVersion === 1 && state.profile.resumeSource?.sha256 === sha256) {
        fillReusedOnboardingBasics(state.profile, sourceDocument);
        delete state.profile.resumeImport;
        return "ready";
      }
      state.profile.resumeExtraction = extraction;
      delete state.profile.resumeImport;
      return "queued";
    });
    if (!current) return NextResponse.json({ ok: true, status: "superseded" }, { status: 202 });
    if (current === "ready") return NextResponse.json({ ok: true, requestId: savedProfile.resumeExtraction?.id, status: "ready", reused: true, resumeHash: sha256 }, { status: 202 });
    await dispatchResumeExtraction(userId, extraction.id);
    return NextResponse.json({ ok: true, requestId: extraction.id, status: "queued", reused: reuse, resumeHash: sha256, sourceStatus: sourceDocument.support }, { status: 202 });
    } catch (error) {
      await mutateState(userId, (state) => {
        if (state.profile.resumeImport?.token === importToken) delete state.profile.resumeImport;
      });
      throw error;
    }
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
