import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ApplicationPacket } from "@/lib/types";
import { OriginalResumeInspection } from "@/components/original-resume-inspection";

describe("OriginalResumeInspection", () => {
  it.each([
    ["application/pdf", "original-resume.pdf", "PDF"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "original-resume.docx", "DOCX"],
  ] as const)("identifies the uploaded %s by its real filename and type", (mimeType, filename, label) => {
    const packet = {
      schemaVersion: 1,
      version: 2,
      summary: "Original résumé attached",
      resumeLines: [],
      resumeMode: "original",
      originalResume: { filename, mimeType, sha256: "a".repeat(64), size: 128 },
      answers: [],
      createdAt: "2026-10-01T00:00:00.000Z",
      model: "none",
    } satisfies ApplicationPacket;
    const markup = renderToStaticMarkup(createElement(OriginalResumeInspection, { packet, applicationId: "application-123" }));

    expect(markup).toContain("Original résumé used");
    expect(markup).toContain(filename);
    expect(markup).toContain(label);
    expect(markup).toContain("/api/applications/application-123/files/resume?download=1");
    expect(markup.toLowerCase()).not.toContain("tailored resume pdf");
    expect(markup).not.toContain("Each resume line comes from a confirmed profile fact");
  });
});
