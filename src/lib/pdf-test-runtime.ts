import { execFile as execFileCallback } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { threadId } from "node:worker_threads";

const execFile = promisify(execFileCallback);
const runtimeRoot = path.join(os.tmpdir(), `apply-ai-pdf-runtime-test-${process.pid}-${threadId}`);
const setupLock = `${runtimeRoot}.setup-lock`;
let runtimePromise: Promise<void> | undefined;
let cleanupRegistered = false;

async function setupRuntime() {
  if (existsSync(path.join(runtimeRoot, "runtime-manifest.json"))) {
    const manifest = JSON.parse(readFileSync(path.join(runtimeRoot, "runtime-manifest.json"), "utf8")) as { pdfbox?: string };
    if (manifest.pdfbox === "3.0.8") return;
  }
  await mkdir(path.dirname(runtimeRoot), { recursive: true });
  const deadline = Date.now() + 150_000;
  let ownsLock = false;
  while (!ownsLock && Date.now() < deadline) {
    try { mkdirSync(setupLock); ownsLock = true; }
    catch {
      if (existsSync(path.join(runtimeRoot, "runtime-manifest.json"))) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  if (!ownsLock) throw new Error("Timed out waiting for the shared PDFBox test runtime setup.");
  try {
    await execFile("node", ["scripts/setup-pdf-runtime.mjs", runtimeRoot, "--local"], { cwd: process.cwd(), timeout: 120_000, maxBuffer: 8192 });
  } finally {
    rmSync(setupLock, { recursive: true, force: true });
  }
}

export async function ensurePdfTestRuntime() {
  runtimePromise ??= setupRuntime();
  await runtimePromise;
  const manifest = JSON.parse(readFileSync(path.join(runtimeRoot, "runtime-manifest.json"), "utf8")) as { pdfbox?: string; architecture?: string };
  if (manifest.pdfbox !== "3.0.8") throw new Error("The PDFBox test runtime does not match the pinned worker version.");
  let java = process.env.PDFBOX_JAVA_BIN && existsSync(process.env.PDFBOX_JAVA_BIN) ? process.env.PDFBOX_JAVA_BIN : undefined;
  if (!java) {
    for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
      const candidate = path.join(directory, "java");
      if (existsSync(candidate)) { java = candidate; break; }
    }
  }
  java ??= "java";
  const { stdout, stderr } = await execFile(java, ["-version"], { timeout: 10_000, maxBuffer: 4096 });
  const major = `${stdout}\n${stderr}`.match(/version "(\d+)/)?.[1];
  if (!major) throw new Error("The PDFBox test runtime could not identify the local Java version.");
  process.env.PDFBOX_JAVA_MAJOR = major;
  process.env.PDFBOX_RUNTIME_ROOT = runtimeRoot;
  process.env.PDFBOX_JAVA_BIN = java;
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.on("exit", () => { rmSync(runtimeRoot, { recursive: true, force: true }); rmSync(setupLock, { recursive: true, force: true }); });
  }
}
