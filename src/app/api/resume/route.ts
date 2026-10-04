import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { newId } from "@/lib/crypto";
import { adminSupabase } from "@/lib/supabase-admin";
import { currentUserId, isDemo, loadState, mutateState } from "@/lib/repository";
import { sameOrigin } from "@/lib/request-security";
import { parseDocxSource, suggestDocxFacts } from "@/lib/docx-source";
import { parsePdfSource, suggestPdfFacts } from "@/lib/pdf-source";
import { bumpAutomationVersion } from "@/lib/onboarding";
import { AccountDeletionInProgressError, withAccountOperation } from "@/lib/account-lifecycle";

import { originalResumeManifest, readOriginalResume, saveDemoOriginalResume } from "@/lib/original-resume";
import type { ResumeSourceDocument } from "@/lib/types";
import { resumeProfileBasics } from "@/lib/resume-profile-basics";
import { sourceWithCurrentEvidenceClaims } from "@/lib/source-plan-evidence";

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
    await mutateState(userId, (state) => {
      state.profile.resumeImport = { token: importToken, startedAt: new Date().toISOString() };
    });
    try {
    const buffer = original ? await readOriginalResume(userId, original) : Buffer.from(await file!.arrayBuffer());
    let extracted = "";
    let sourceDocument: ResumeSourceDocument;
    if (reuse && savedProfile.resumeSourceDocument && savedProfile.resumeSourceDocument.sourceHash === original?.sha256 && savedProfile.resumeSourceDocument.text.trim()) {
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
    await mutateState(userId, (state) => {
      if (state.profile.resumeImport?.token !== importToken)
        throw new Error("A newer resume import replaced this attempt. Review the latest import or retry.");
      const basics = resumeProfileBasics(sourceDocument);
      for (const key of ["name", "email", "phone"] as const)
        if (!reuse || !state.profile[key].trim()) state.profile[key] = basics[key];
      if (!reuse || !state.profile.links?.length) state.profile.links = basics.links;
      const currentSourceDocument = reuse ? sourceDocument : sourceWithCurrentEvidenceClaims(sourceDocument, state.profile.name);
      const suggestions: Array<{ text: string; sourceAnchorId?: string }> = currentSourceDocument.format === "docx"
        ? suggestDocxFacts(currentSourceDocument) : suggestPdfFacts(currentSourceDocument);
      state.profile.resumeFileName = name;
      state.profile.resumeText = extracted;
      state.profile.resumeSourceDocument = currentSourceDocument;
      state.profile.resumeSource = {
        ...(storageKey ? { storageKey } : {}),
        sha256,
        size: buffer.byteLength,
        mimeType: pdf
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      };
      bumpAutomationVersion(state.profile);
      state.profile.facts = state.profile.facts.map((fact) => {
        if (reuse) return fact;
        if (fact.source !== "resume" || !fact.sourceAnchorId) return fact;
        const { sourceAnchorId: _oldAnchor, ...withoutOldAnchor } = fact;
        void _oldAnchor;
        return withoutOldAnchor;
      });
      const existing = new Set(state.profile.facts.map((fact) => fact.text.toLowerCase()));
      for (const suggestion of suggestions)
        if (!existing.has(suggestion.text.toLowerCase())) {
          if (state.profile.facts.length < 80) {
            state.profile.facts.push({
              id: newId(),
              text: suggestion.text,
              verified: false,
              source: "resume",
              ...(suggestion.sourceAnchorId ? { sourceAnchorId: suggestion.sourceAnchorId } : {}),
            });
            existing.add(suggestion.text.toLowerCase());
          }
        } else if (suggestion.sourceAnchorId) {
          const existingFact = state.profile.facts.find((fact) => fact.text.toLowerCase() === suggestion.text.toLowerCase());
          if (existingFact?.source === "resume" && !existingFact.sourceAnchorId) existingFact.sourceAnchorId = suggestion.sourceAnchorId;
        }
      state.profile.updatedAt = new Date().toISOString();
      delete state.profile.resumeImport;
      state.matchCache = {};
      state.activity.unshift({
        id: newId(),
        at: new Date().toISOString(),
        label: "Resume imported",
        detail: "Review and confirm facts before using them in an application.",
      });
    });
    return NextResponse.json({ ok: true, extracted, reused: reuse, resumeHash: sha256, ...(sourceDocument ? { sourceStatus: sourceDocument.support } : {}) });
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
