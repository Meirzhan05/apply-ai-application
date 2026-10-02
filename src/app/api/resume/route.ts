import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { newId } from "@/lib/crypto";
import { adminSupabase } from "@/lib/supabase-admin";
import { currentUserId, isDemo, mutateState } from "@/lib/repository";
import { sameOrigin } from "@/lib/request-security";
import { parseDocxSource, suggestDocxFacts } from "@/lib/docx-source";
import { parsePdfSource, suggestPdfFacts } from "@/lib/pdf-source";
import { bumpAutomationVersion } from "@/lib/onboarding";

import { saveDemoOriginalResume } from "@/lib/original-resume";
import type { ResumeSourceDocument } from "@/lib/types";

export const runtime = "nodejs";
export async function POST(request: Request) {
  if (!sameOrigin(request))
    return NextResponse.json(
      { error: "Cross-origin request rejected." },
      { status: 403 },
    );
  try {
    const userId = await currentUserId();
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
    const buffer = Buffer.from(await file.arrayBuffer());
    let extracted = "";
    let sourceDocument: ResumeSourceDocument | undefined;
    if (pdf) {
      sourceDocument = await parsePdfSource(buffer);
      extracted = sourceDocument.text;
    } else {
      sourceDocument = await parseDocxSource(buffer);
      extracted = sourceDocument.text;
    }
    extracted = extracted.replace(/\0/g, "").trim();
    if (extracted.length > 20000)
      throw new Error("This resume contains more than 20,000 readable characters. Shorten the source or upload a supported version; no text was dropped.");
    if (!extracted && !pdf)
      throw new Error(
        "This resume has no readable text. Add facts manually in your profile.",
      );
    const suggestions: Array<{ text: string; sourceAnchorId?: string }> = sourceDocument?.format === "docx"
      ? suggestDocxFacts(sourceDocument)
      : sourceDocument?.format === "pdf" ? suggestPdfFacts(sourceDocument) : [];
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
    await mutateState(userId, (state) => {
      state.profile.resumeFileName = name;
      state.profile.resumeText = extracted;
      state.profile.resumeSourceDocument = sourceDocument;
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
          if (existingFact && !existingFact.sourceAnchorId) existingFact.sourceAnchorId = suggestion.sourceAnchorId;
        }
      state.profile.updatedAt = new Date().toISOString();
      state.activity.unshift({
        id: newId(),
        at: new Date().toISOString(),
        label: "Resume imported",
        detail: "Review and confirm facts before using them in an application.",
      });
    });
    return NextResponse.json({ ok: true, extracted, ...(sourceDocument ? { sourceStatus: sourceDocument.support } : {}) });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to read resume.",
      },
      { status: 400 },
    );
  }
}
