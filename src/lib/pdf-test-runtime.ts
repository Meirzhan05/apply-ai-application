import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { threadId } from "node:worker_threads";

const execFile = promisify(execFileCallback);
const runtimeRoot = path.join(os.tmpdir(), `apply-ai-pdf-runtime-test-${process.pid}-${threadId}`);
const setupLock = `${runtimeRoot}.setup-lock`;
const runtimeLock = JSON.parse(readFileSync(path.join(process.cwd(), "runtime/pdf/pdf-runtime.lock.json"), "utf8")) as {
  java: { version: string; platform: string };
  pdfbox: { version: string; file: string; sha512: string };
};
let runtimePromise: Promise<void> | undefined;
let cleanupRegistered = false;

async function prepareProvidedRuntime(configuredRoot: string) {
  const root = path.resolve(configuredRoot);
  let manifest: { version?: number; java?: string; pdfbox?: string; architecture?: string };
  try {
    manifest = JSON.parse(readFileSync(path.join(root, "runtime-manifest.json"), "utf8")) as typeof manifest;
  } catch {
    throw new Error("The supplied PDFBox test runtime has no readable runtime manifest.");
  }
  if (manifest.version !== 1 || manifest.java !== runtimeLock.java.version || manifest.pdfbox !== runtimeLock.pdfbox.version
    || manifest.architecture !== runtimeLock.java.platform)
    throw new Error("The supplied PDFBox test runtime does not match the pinned Java/PDFBox versions or Linux architecture.");

  const jarPath = path.join(root, runtimeLock.pdfbox.file);
  let jar: Buffer;
  try { jar = readFileSync(jarPath); }
  catch { throw new Error("The supplied PDFBox test runtime's pinned PDFBox jar is missing or unreadable."); }
  if (createHash("sha512").update(jar).digest("hex") !== runtimeLock.pdfbox.sha512)
    throw new Error("The supplied PDFBox test runtime's PDFBox jar failed its pinned checksum.");
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("The supplied PDFBox test runtime can only run on its pinned Linux x64 platform.");

  const java = path.join(root, "jre", "bin", "java");
  const classes = path.join(root, "classes");
  const classFile = path.join(classes, "PdfSourceRewrite.class");
  try {
    const [javaInfo, classesInfo, classInfo] = await Promise.all([stat(java), stat(classes), stat(classFile)]);
    if (!javaInfo.isFile() || (javaInfo.mode & 0o111) === 0 || !classesInfo.isDirectory() || !classInfo.isFile()) throw new Error("missing runtime files");
  } catch {
    throw new Error("The supplied PDFBox test runtime is missing its executable Java runtime or compiled PdfSourceRewrite helper.");
  }

  let javaOutput: string;
  let helperOutput: string;
  try {
    const javaResult = await execFile(java, ["-version"], { timeout: 10_000, maxBuffer: 4096 });
    javaOutput = `${javaResult.stdout}\n${javaResult.stderr}`;
    const helperResult = await execFile(java, ["-cp", `${classes}${path.delimiter}${jarPath}`, "PdfSourceRewrite", "--version"], { timeout: 10_000, maxBuffer: 4096 });
    helperOutput = helperResult.stdout.trim();
  } catch {
    throw new Error("The supplied PDFBox test runtime's Java executable or compiled helper failed its version check.");
  }
  const major = Number(javaOutput.match(/version\s+"?(\d+)/i)?.[1]);
  const helper = helperOutput.match(/^pdfbox=([^\t\r\n]+)\tjava=([^\t\r\n]+)$/);
  const helperJavaVersion = helper?.[2].replace(/-LTS$/, "");
  if (major !== 21 || !helper || helper[1] !== runtimeLock.pdfbox.version || helperJavaVersion !== runtimeLock.java.version)
    throw new Error("The supplied PDFBox test runtime's Java or compiled helper version does not match its pinned manifest.");

  // Callers must freshly compile the checked-in runtime/pdf/PdfSourceRewrite.java into this directory before running tests.
  process.env.PDFBOX_RUNTIME_ROOT = root;
  process.env.PDFBOX_JAVA_BIN = java;
  process.env.PDFBOX_JAVA_MAJOR = String(major);
}

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
  const configuredRoot = process.env.PDFBOX_TEST_RUNTIME_ROOT;
  if (configuredRoot) {
    await prepareProvidedRuntime(configuredRoot);
    return;
  }
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
