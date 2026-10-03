import { existsSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { runDocxRuntimeProbe } from "@/lib/docx-runtime-probe";

const nativeRenderer = [
  process.env.TEST_DOCX_SOFFICE_BIN,
  process.env.SOFFICE_BIN,
  process.platform === "linux" ? "/usr/bin/soffice" : undefined,
].find((candidate) => candidate && existsSync(candidate));

afterEach(() => vi.unstubAllEnvs());

it.skipIf(!nativeRenderer)("runs the DOCX runtime probe through the pinned renderer and checks its untouched baseline", async () => {
  vi.stubEnv("SOFFICE_BIN", nativeRenderer!);
  const result = await runDocxRuntimeProbe();

  expect(result).toMatchObject({
    renderer: "libreoffice-26.8.0.3",
    rendererVersion: expect.stringMatching(/^LibreOffice 26\.8\.0\.3/),
    pageCount: 1,
    pageWidthPt: 612,
    pageHeightPt: 792,
    visualOutsideEditDifference: 0,
  });
  expect(result.originalSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.baselinePdfSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.editedDocxSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.pdfSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.editedDocxSha256).not.toBe(result.originalSha256);
  expect(result.pdfSha256).not.toBe(result.baselinePdfSha256);
}, 175_000);
