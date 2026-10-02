import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let runtimeDirectory: string | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  if (runtimeDirectory) await rm(runtimeDirectory, { recursive: true, force: true });
  runtimeDirectory = undefined;
});

it("rejects a supplied runtime with the wrong pinned Java version without mutating it", async () => {
  runtimeDirectory = await mkdtemp(path.join(os.tmpdir(), "pdf-test-runtime-invalid-"));
  await writeFile(path.join(runtimeDirectory, "runtime-manifest.json"), JSON.stringify({ version: 1, java: "99.0.0", pdfbox: "3.0.8", architecture: "linux-x64" }));
  const before = await readdir(runtimeDirectory);
  vi.stubEnv("PDFBOX_TEST_RUNTIME_ROOT", runtimeDirectory);

  const runtime = await import("@/lib/pdf-test-runtime");

  await expect(runtime.ensurePdfTestRuntime()).rejects.toThrow(/supplied .* pinned Java\/PDFBox versions/i);
  expect(await readdir(runtimeDirectory)).toEqual(before);
});

it("rejects a supplied runtime missing the pinned PDFBox jar without attempting setup", async () => {
  runtimeDirectory = await mkdtemp(path.join(os.tmpdir(), "pdf-test-runtime-incomplete-"));
  await writeFile(path.join(runtimeDirectory, "runtime-manifest.json"), JSON.stringify({ version: 1, java: "21.0.12.1+1", pdfbox: "3.0.8", architecture: "linux-x64" }));
  const before = await readdir(runtimeDirectory);
  vi.stubEnv("PDFBOX_TEST_RUNTIME_ROOT", runtimeDirectory);

  const runtime = await import("@/lib/pdf-test-runtime");

  await expect(runtime.ensurePdfTestRuntime()).rejects.toThrow(/pinned PDFBox jar is missing/i);
  expect(await readdir(runtimeDirectory)).toEqual(before);
});

it("rejects a supplied runtime with a jar that fails the pinned checksum", async () => {
  runtimeDirectory = await mkdtemp(path.join(os.tmpdir(), "pdf-test-runtime-checksum-"));
  await writeFile(path.join(runtimeDirectory, "runtime-manifest.json"), JSON.stringify({ version: 1, java: "21.0.12.1+1", pdfbox: "3.0.8", architecture: "linux-x64" }));
  await writeFile(path.join(runtimeDirectory, "pdfbox-app-3.0.8.jar"), "not the pinned PDFBox jar");
  const before = await readdir(runtimeDirectory);
  vi.stubEnv("PDFBOX_TEST_RUNTIME_ROOT", runtimeDirectory);

  const runtime = await import("@/lib/pdf-test-runtime");

  await expect(runtime.ensurePdfTestRuntime()).rejects.toThrow(/failed its pinned checksum/i);
  expect(await readdir(runtimeDirectory)).toEqual(before);
});
