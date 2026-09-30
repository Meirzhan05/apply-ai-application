import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { resumeLatex } from "@/lib/resume-latex";
import { sealResume } from "@/lib/resume-document";
import type { Profile, ResumeDocument, ResumeEntry } from "@/lib/types";

const execute = promisify(execFile);
export const tectonicBinary = () => process.env.TECTONIC_BIN || path.join(process.cwd(), ".data", "latex-runtime", "tectonic");
export const tectonicCache = () => process.env.TECTONIC_CACHE_DIR || path.join(process.cwd(), ".data", "latex-runtime", "cache");
export async function compileLatex(source: string, deadline: number): Promise<{ bytes: Buffer; pages: number }> {
  const dir = await mkdtemp(path.join(tmpdir(), "apply-resume-"));
  const timeout = () => Math.max(1, Math.min(20_000, deadline - Date.now()));
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production", PATH: process.env.PATH, HOME: dir, TECTONIC_CACHE_DIR: tectonicCache(), TECTONIC_UNTRUSTED_MODE: "1", SOURCE_DATE_EPOCH: "946684800" };
  try {
    if (deadline <= Date.now()) throw new Error("Resume compilation timed out. Retry the draft.");
    const version = await execute(tectonicBinary(), ["--version"], { timeout: timeout(), env, maxBuffer: 8192 });
    if (!/Tectonic 0\.17\.0\b/.test(version.stdout)) throw new Error("Resume compilation requires Tectonic 0.17.0. Run npm run setup:latex.");
    await writeFile(path.join(dir, "resume.tex"), source, { mode: 0o600 });
    await execute(tectonicBinary(), ["-X", "compile", "--untrusted", "--only-cached", "--keep-logs", "--outdir", dir, path.join(dir, "resume.tex")], { cwd: dir, env, timeout: timeout(), killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
    const log = await readFile(path.join(dir, "resume.log"), "utf8");
    if (/Overfull \\[hv]box|Missing character:/i.test(log)) throw new Error("The resume contains overflowing text or unsupported characters. Shorten long fields or correct the spelling in your profile, then rebuild.");
    const bytes = await readFile(path.join(dir, "resume.pdf"));
    const pdf = await PDFDocument.load(bytes);
    return { bytes, pages: pdf.getPageCount() };
  } catch (error) {
    const problem = error as Error & { code?: string; killed?: boolean };
    if (problem.code === "ENOENT") throw new Error("The LaTeX runtime is missing. Run npm run setup:latex, then retry; your existing packet is preserved.");
    if (problem.killed || deadline <= Date.now()) throw new Error("Resume compilation timed out. Retry the draft.");
    if (problem.message.startsWith("The resume") || problem.message.startsWith("Resume compilation")) throw problem;
    // Compiler diagnostics may contain applicant text or paths; never return
    // child-process command/environment output to the client.
    throw new Error("LaTeX compilation failed. Check the installed package cache and confirmed profile text, then retry; your existing packet is preserved.");
  } finally { await rm(dir, { recursive: true, force: true }); }
}

function removeLowestBullet(doc: ResumeDocument): boolean {
  const entries = [...doc.education, ...doc.experience, ...doc.projects];
  const candidates = entries.flatMap((entry) => entry.bullets.map((bullet, index) => ({ entry, bullet, index })));
  candidates.sort((a, b) => a.bullet.relevance - b.bullet.relevance);
  const candidate = candidates[0];
  if (!candidate) {
    const skill = doc.skills.pop();
    if (!skill) return false;
    doc.omitted.push({ ...skill, reason: "page-length" });
    return true;
  }
  candidate.entry.bullets.splice(candidate.index, 1);
  doc.omitted.push({ text: candidate.bullet.text, factIds: candidate.bullet.factIds, reason: "page-length" });
  // Education retains credentials even without GPA/award bullets. Empty
  // experience/project entries lose their headers along with the last bullet.
  const prune = (items: ResumeEntry[]) => items.filter((entry) => {
    if (entry.bullets.length) return true;
    for (const field of [entry.heading, entry.subheading, entry.dates, entry.location]) if (field.text) doc.omitted.push({ ...field, reason: "page-length" });
    return false;
  });
  doc.experience = prune(doc.experience); doc.projects = prune(doc.projects);
  return true;
}
export async function fitResume(profile: Profile, original: ResumeDocument, deadline = Date.now() + 90_000,
  compile = compileLatex): Promise<{ document: ResumeDocument; pdf: Buffer; source: string }> {
  const doc = structuredClone(original);
  const fitDeadline = Math.min(deadline, Date.now() + 90_000);
  for (let attempt = 0; attempt < 8 && Date.now() < fitDeadline; attempt++) {
    const source = resumeLatex(profile, doc);
    const result = await compile(source, fitDeadline);
    if (result.pages === 1) return { document: sealResume(profile, doc), pdf: result.bytes, source };
    if (attempt === 0) doc.layout = "compact";
    else if (!removeLowestBullet(doc)) break;
  }
  throw new Error("The resume cannot fit one readable page. Shorten long confirmed facts or remove lower-priority material in your profile, then rebuild.");
}
