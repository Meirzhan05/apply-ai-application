import { beforeEach, expect, it, vi } from "vitest";
import { latexFixture } from "@/lib/latex-fixture";

const compiler = vi.hoisted(() => ({ fitResume: vi.fn() }));
vi.mock("@/lib/latex-compiler", () => ({ fitResume: compiler.fitResume }));

import { withPacketFiles } from "@/lib/packet-files";
import { resumeFields, sealResume } from "@/lib/resume-document";

beforeEach(() => compiler.fitResume.mockReset());

it("retains renderer failures as technical résumé diagnostics with the completed audit count", async () => {
  const { profile, document } = latexFixture();
  document.grounding = { version: 1, writerAttempts: 2, checkerAttempts: 2, repairAttempts: 1, findings: [] };
  const sealed = sealResume(profile, document);
  compiler.fitResume.mockRejectedValueOnce(new Error("The resume cannot fit one readable page. Shorten long confirmed facts or remove lower-priority material in your profile, then rebuild."));
  const packet = { schemaVersion: 2 as const, version: 1, summary: "Resume repair", resumeLines: resumeFields(sealed).map(({ text, factIds }) => ({ text, factIds })), resumeDocument: sealed, answers: [], createdAt: new Date().toISOString(), model: "gpt-6-sol" };
  await expect(withPacketFiles(profile, packet, Date.now() + 60_000)).rejects.toMatchObject({
    diagnostics: { outcome: "technical_failure", technicalFailure: "renderer", writerAttempts: 2, checkerAttempts: 2, repairAttempts: 1 },
    message: expect.stringContaining("cannot fit one readable page"),
  });
  expect(compiler.fitResume).toHaveBeenCalledOnce();
});
