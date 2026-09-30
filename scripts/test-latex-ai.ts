import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { initialDemoState } from "../src/lib/demo-data";
import { draftPacket, validatePacket } from "../src/lib/drafting";
import { reviewedPacketFile, reviewedResumeSource, withPacketFiles } from "../src/lib/packet-files";
import { latexFixture } from "../src/lib/fixtures/latex-resume";

async function main() {
  assert.equal(process.env.DEMO_MODE, "true", "Use local fixture artifact storage only");
  const { profile } = latexFixture();
  const packet = await draftPacket(profile, initialDemoState().jobs[1], undefined, { resumeFormat: "latex", deadline: Date.now() + 540_000 });
  validatePacket(profile, packet); assert.equal(packet.schemaVersion, 2);
  const pdf = await reviewedPacketFile(profile, packet, "resume");
  const source = await reviewedResumeSource(profile, packet);
  const revised = await withPacketFiles(profile, { ...packet, version: packet.version + 1 });
  assert.deepEqual(revised.resumeArtifact, packet.resumeArtifact);
  assert.ok((await reviewedPacketFile(profile, revised, "resume")).bytes.equals(pdf.bytes));
  await writeFile(".data/latex-check/ai-resume.pdf", pdf.bytes);
  await writeFile(".data/latex-check/ai-resume.tex", source.bytes);
  await writeFile(".data/latex-check/ai-packet.json", JSON.stringify(packet, null, 2));
  assert.ok((await readFile(".data/latex-check/ai-resume.pdf")).length > 1000);
  console.log("PASS real AI + audit + LaTeX + saved PDF/source + revision reuse (synthetic applicant only)");
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
