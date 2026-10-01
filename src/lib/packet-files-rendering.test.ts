import { afterEach, expect, it, vi } from "vitest";
import { latexFixture } from "@/lib/latex-fixture";
import { withPacketFiles } from "@/lib/packet-files";
import { resumeFields, sealResume } from "@/lib/resume-document";

afterEach(() => vi.unstubAllEnvs());

it("reports a compiler process failure as a renderer diagnostic and preserves the completed audit count", async () => {
  const { profile, document } = latexFixture();
  document.grounding = { version: 1, writerAttempts: 2, checkerAttempts: 2, repairAttempts: 1, findings: [] };
  const sealed = sealResume(profile, document);
  const packet = {
    schemaVersion: 2 as const,
    version: 1,
    summary: "Resume repair",
    resumeLines: resumeFields(sealed).map(({ text, factIds }) => ({ text, factIds })),
    resumeDocument: sealed,
    answers: [],
    createdAt: new Date().toISOString(),
    model: "gpt-6-sol",
  };

  // Exercise withPacketFiles -> fitResume -> compileLatex -> execFile. The
  // compiler is an external process boundary, so fail it without mocking the
  // internal renderer collaborator.
  vi.stubEnv("TECTONIC_BIN", "/missing-test-binary/tectonic");

  await expect(withPacketFiles(profile, packet, Date.now() + 60_000)).rejects.toMatchObject({
    diagnostics: { outcome: "technical_failure", technicalFailure: "renderer", writerAttempts: 2, checkerAttempts: 2, repairAttempts: 1 },
    message: expect.stringContaining("Resume compilation is temporarily unavailable"),
  });
});
