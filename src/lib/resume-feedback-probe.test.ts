import { expect, it } from "vitest";
import { probeResumeFeedback } from "@/lib/resume-feedback-probe";

it("exercises DOCX and PDF feedback recovery without external effects", async () => {
  expect(await probeResumeFeedback()).toEqual(["docx", "pdf"].map((format) => ({ format, structuralRepair: true, checkerRetry: true,
    writerAttempts: 2, checkerAttempts: 2, repairAttempts: 1, evidencePolicyVersion: 3, sourcePreserved: true })));
});
