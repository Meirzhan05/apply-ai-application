import { createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const execFile = promisify(execFileCallback);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(await readFile(path.join(projectRoot, "runtime/pdf/pdf-runtime.lock.json"), "utf8"));
const target = path.resolve(process.argv[2] ?? "/app/pdf-runtime");
const local = process.argv.includes("--local");
const maxArchiveBytes = 300 * 1024 * 1024;

function hash(bytes, algorithm) { return createHash(algorithm).update(bytes).digest("hex"); }
async function download(asset, algorithm, expected) {
  const destination = path.join(downloadDirectory, asset.file);
  const response = await fetch(asset.url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`Pinned runtime download failed with HTTP ${response.status}.`);
  const contentLength = Number(response.headers.get("content-length"));
  if (contentLength > maxArchiveBytes) throw new Error("Pinned runtime download exceeded the configured size cap.");
  let received = 0;
  const cap = new Transform({ transform(chunk, _encoding, callback) {
    received += chunk.length;
    callback(received > maxArchiveBytes ? new Error("Pinned runtime download exceeded the configured size cap.") : null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), cap, createWriteStream(destination, { mode: 0o600 }));
  const bytes = await readFile(destination);
  if (bytes.length > maxArchiveBytes || hash(bytes, algorithm) !== expected) throw new Error(`Pinned runtime checksum mismatch for ${asset.file}.`);
  return destination;
}
async function findFile(root, name) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isFile() && entry.name === name) return child;
    if (entry.isDirectory()) { const found = await findFile(child, name); if (found) return found; }
  }
  return undefined;
}

if (!local && (process.platform !== "linux" || process.arch !== "x64")) throw new Error("The deployable PDF runtime is pinned for Linux x64 only.");
await mkdir(target, { recursive: true, mode: 0o700 });
const temporary = await mkdtemp(path.join(os.tmpdir(), "resume-pdf-runtime-"));
const downloadDirectory = path.join(temporary, "downloads");
const extraction = path.join(temporary, "extracted");
await mkdir(downloadDirectory, { recursive: true, mode: 0o700 });
await mkdir(extraction, { recursive: true, mode: 0o700 });
try {
  const pdfboxAsset = { file: lock.pdfbox.file, url: lock.pdfbox.url };
  const downloadedJar = process.env.PDFBOX_JAR_PATH ? path.resolve(process.env.PDFBOX_JAR_PATH)
    : await download(pdfboxAsset, "sha512", lock.pdfbox.sha512);
  const jarBytes = await readFile(downloadedJar);
  if (hash(jarBytes, "sha512") !== lock.pdfbox.sha512) throw new Error("Pinned PDFBox jar checksum mismatch.");
  const jarPath = path.join(target, lock.pdfbox.file);
  if (downloadedJar !== jarPath) await copyFile(downloadedJar, jarPath);
  const classes = path.join(target, "classes");
  await rm(classes, { recursive: true, force: true });
  await mkdir(classes, { recursive: true, mode: 0o700 });

  let javaBin;
  let javacBin;
  let jarTool;
  let jreNoticeRoot;
  if (local) {
    javaBin = process.env.PDFBOX_JAVA_BIN || "java";
    javacBin = process.env.PDFBOX_JAVAC_BIN || "javac";
    jarTool = process.env.PDFBOX_JAR_TOOL || "jar";
  } else {
    const jreArchive = await download(lock.java.jre, "sha256", lock.java.jre.sha256);
    const jdkArchive = await download(lock.java.jdk, "sha256", lock.java.jdk.sha256);
    const jreRoot = path.join(extraction, "jre");
    const jdkRoot = path.join(extraction, "jdk");
    await mkdir(jreRoot, { recursive: true }); await mkdir(jdkRoot, { recursive: true });
    await execFile("tar", ["-xzf", jreArchive, "--no-same-owner", "--no-same-permissions", "-C", jreRoot], { timeout: 60_000, maxBuffer: 1024 * 1024 });
    await execFile("tar", ["-xzf", jdkArchive, "--no-same-owner", "--no-same-permissions", "-C", jdkRoot], { timeout: 90_000, maxBuffer: 1024 * 1024 });
    const javaArchiveBin = await findFile(jreRoot, "java");
    const javacArchiveBin = await findFile(jdkRoot, "javac");
    jarTool = await findFile(jdkRoot, "jar");
    if (!javaArchiveBin || !javacArchiveBin || !jarTool) throw new Error("The pinned Temurin runtime archive is missing Java tools.");
    const jreArchiveRoot = path.dirname(path.dirname(javaArchiveBin));
    const jdkArchiveRoot = path.dirname(path.dirname(javacArchiveBin));
    const runtimeRoot = path.join(target, "jre");
    await rm(runtimeRoot, { recursive: true, force: true });
    await cp(jreArchiveRoot, runtimeRoot, { recursive: true, preserveTimestamps: true });
    javaBin = path.join(runtimeRoot, "bin", "java");
    javacBin = javacArchiveBin;
    jreNoticeRoot = jreArchiveRoot;
    void jdkArchiveRoot;
  }

  const sourceFile = path.join(projectRoot, "runtime/pdf/PdfSourceRewrite.java");
  await execFile(javacBin, ["--release", "21", "-cp", jarPath, "-d", classes, sourceFile], { timeout: 90_000, maxBuffer: 2 * 1024 * 1024 });
  const licenses = path.join(target, "licenses");
  await mkdir(licenses, { recursive: true, mode: 0o700 });
  await execFile(jarTool, ["--extract", "--file", jarPath, "META-INF/LICENSE", "META-INF/NOTICE"], { cwd: temporary, timeout: 30_000, maxBuffer: 1024 * 1024 });
  await copyFile(path.join(temporary, "META-INF/LICENSE"), path.join(licenses, "PDFBox-app-LICENSE.txt"));
  await copyFile(path.join(temporary, "META-INF/NOTICE"), path.join(licenses, "PDFBox-app-NOTICE.txt"));
  if (jreNoticeRoot) for (const notice of ["NOTICE", "ADDITIONAL_LICENSE_INFO"]) {
    const noticePath = await findFile(jreNoticeRoot, notice);
    if (noticePath) await copyFile(noticePath, path.join(licenses, `Temurin-${notice}.txt`));
  }
  const version = await execFile(javaBin, ["-Djava.awt.headless=true", "-cp", `${classes}${path.delimiter}${jarPath}`, "PdfSourceRewrite", "--version"], { timeout: 20_000, maxBuffer: 4096 });
  if (!version.stdout.includes(`pdfbox=${lock.pdfbox.version}`) || (!local && !version.stdout.includes("java=21."))) throw new Error("The compiled PDF worker does not match the pinned Java/PDFBox versions.");
  await writeFile(path.join(target, "runtime-manifest.json"), JSON.stringify({ version: 1, java: lock.java.version, pdfbox: lock.pdfbox.version, architecture: local ? `${process.platform}-${process.arch}` : "linux-x64" }, null, 2) + "\n", { mode: 0o600 });
  if (!local) await chmod(javaBin, 0o755);
  process.stdout.write(JSON.stringify({ target, java: version.stdout.trim(), jarSha512: hash(jarBytes, "sha512"), local }) + "\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
