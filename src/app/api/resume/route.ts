import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import { newId } from "@/lib/crypto";
import { adminSupabase } from "@/lib/supabase-admin";
import { currentUserId, isDemo, mutateState } from "@/lib/repository";
import { sameOrigin } from "@/lib/request-security";
import { suggestResumeFacts } from "@/lib/resume-facts";
import { bumpAutomationVersion } from "@/lib/onboarding";

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
    if (pdf) {
      const parser = new PDFParse({ data: buffer });
      try {
        extracted = (await parser.getText()).text;
      } finally {
        await parser.destroy();
      }
    } else extracted = (await mammoth.extractRawText({ buffer })).value;
    extracted = extracted.replace(/\0/g, "").trim().slice(0, 20000);
    if (!extracted)
      throw new Error(
        "This resume has no readable text. Add facts manually in your profile.",
      );
    const suggestions = suggestResumeFacts(extracted);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    let storageKey: string | undefined;
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
      state.profile.resumeSource = {
        ...(storageKey ? { storageKey } : {}),
        sha256,
        size: buffer.byteLength,
        mimeType: pdf
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      };
      bumpAutomationVersion(state.profile);
      const existing = new Set(
        state.profile.facts.map((fact) => fact.text.toLowerCase()),
      );
      for (const suggestion of suggestions)
        if (!existing.has(suggestion.toLowerCase()) && state.profile.facts.length < 80) {
          state.profile.facts.push({
            id: newId(),
            text: suggestion,
            verified: false,
            source: "resume",
          });
          existing.add(suggestion.toLowerCase());
        }
      state.profile.updatedAt = new Date().toISOString();
      state.activity.unshift({
        id: newId(),
        at: new Date().toISOString(),
        label: "Resume imported",
        detail: "Review and confirm facts before using them in an application.",
      });
    });
    return NextResponse.json({ ok: true, extracted });
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
