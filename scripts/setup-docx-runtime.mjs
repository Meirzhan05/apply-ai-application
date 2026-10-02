import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, "..");
const lock = JSON.parse(await readFile(path.join(repository, "runtime/docx-runtime.lock.json"), "utf8"));
if (process.arch !== "x64") throw new Error("The DOCX runtime is pinned for Linux x86_64 only.");
const root = path.resolve(process.argv[2] || "/app/docx-runtime");
const temporary = await mkdtemp(path.join(os.tmpdir(), "docx-runtime-build-"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const version = (binary) => execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim().split("\n")[0];

try {
  const archiveOverride = process.env.DOCX_RUNTIME_ARCHIVE_PATH?.trim();
  let archive;
  if (archiveOverride) {
    archive = await readFile(path.resolve(archiveOverride));
  } else {
    const response = await fetch(lock.archiveUrl, { signal: AbortSignal.timeout(180_000), redirect: "follow" });
    if (!response.ok) throw new Error(`The pinned LibreOffice archive returned HTTP ${response.status}.`);
    archive = Buffer.from(await response.arrayBuffer());
  }
  if (sha256(archive) !== lock.archiveSha256) throw new Error("The pinned LibreOffice archive checksum does not match.");
  const archivePath = path.join(temporary, "libreoffice.tar.gz");
  await writeFile(archivePath, archive, { mode: 0o600 });
  execFileSync("tar", ["-xzf", archivePath, "-C", temporary], { timeout: 180_000, stdio: "inherit" });
  const debs = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.name.endsWith(".deb")) debs.push(target);
    }
  };
  await visit(temporary);
  const installPackages = new Set(lock.libreOfficePackageNames);
  const selected = new Map();
  for (const deb of debs) {
    const name = execFileSync("dpkg-deb", ["--field", deb, "Package"], { encoding: "utf8", timeout: 10_000 }).trim();
    if (installPackages.has(name)) selected.set(name, deb);
  }
  const missing = lock.libreOfficePackageNames.filter((name) => !selected.has(name));
  if (missing.length) throw new Error(`The pinned LibreOffice archive does not include expected packages: ${missing.join(", ")}.`);
  execFileSync("apt-get", ["install", "-y", "--no-install-recommends", ...lock.libreOfficePackageNames.map((name) => selected.get(name))], { timeout: 240_000, stdio: "inherit" });

  await mkdir(path.join(root, "fonts"), { recursive: true });
  for (const [file, expectedHash] of Object.entries(lock.fonts)) {
    const source = path.join(repository, "src/assets/fonts", file);
    const bytes = await readFile(source);
    if (sha256(bytes) !== expectedHash) throw new Error(`The bundled ${file} checksum does not match the DOCX runtime lock.`);
    await copyFile(source, path.join(root, "fonts", file));
  }
  await copyFile(path.join(repository, "src/assets/fonts/LICENSE"), path.join(root, "fonts/LICENSE"));
  await mkdir("/usr/local/share/fonts/apply-resume", { recursive: true });
  for (const file of Object.keys(lock.fonts)) await copyFile(path.join(root, "fonts", file), path.join("/usr/local/share/fonts/apply-resume", file));
  execFileSync("fc-cache", ["-f", "/usr/local/share/fonts/apply-resume"], { timeout: 30_000, stdio: "inherit" });
  const installed = version(lock.sofficeBinaryPath);
  if (!installed.startsWith(`LibreOffice ${lock.libreOfficeVersion} `) && installed !== `LibreOffice ${lock.libreOfficeVersion}`) throw new Error(`Installed LibreOffice version mismatch: ${installed}`);
  const font = execFileSync("fc-match", ["--format", "%{family}\n", "Noto Sans"], { encoding: "utf8", timeout: 10_000 }).trim();
  if (!font.toLowerCase().split(",").map((family) => family.trim()).includes("noto sans")) throw new Error(`Noto Sans did not resolve to its pinned font family: ${font}`);
  await writeFile(path.join(root, "runtime.json"), JSON.stringify({ ...lock, fontFamily: "Noto Sans", fontMatch: font, installedVersion: installed }, null, 2), { mode: 0o600 });
  console.log(`Installed ${installed}; ${font}; archive SHA-256 ${lock.archiveSha256}.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
