import assert from "node:assert/strict";
import { parseDocxSource } from "../src/lib/docx-source";
import { parsePdfSource } from "../src/lib/pdf-source";
import { createPdfSourceFixture } from "../src/lib/fixtures/pdf-source";
import { extractResumeProfile } from "../src/lib/resume-profile-extraction";
import { createResumeProfileFixture } from "../src/lib/fixtures/resume-profile";
import { extractResumeFacts } from "../src/lib/resume-fact-extraction";
import { isUsableFact } from "../src/lib/fact-evidence";
import { withModelUsageContext } from "../src/lib/model-usage";
import { sourceWithCurrentEvidenceClaims } from "../src/lib/source-plan-evidence";

async function main() {
  assert.equal(process.env.DEMO_MODE, "true", "This standalone provider smoke test uses local synthetic usage records only.");
  for (const format of ["docx", "pdf"] as const) {
    const source = format === "docx" ? await parseDocxSource(await createResumeProfileFixture(), "Riley Example")
      : await parsePdfSource(await createPdfSourceFixture({ qualificationText: "Python, scikit-learn, and PostgreSQL", wrappedBullet: true }), "Avery Chen");
    const details = await withModelUsageContext({ userId: "synthetic-resume-extraction", runId: `profile-${format}-${Date.now()}` }, () => extractResumeProfile(source, { userId: "synthetic-resume-extraction" }));
    assert.ok(details.some(detail => detail.key === "contactEmail"));
    assert.ok(details.some(detail => detail.key === (format === "docx" ? "githubUrl" : "linkedinUrl")));
    const facts = await withModelUsageContext({ userId: "synthetic-resume-extraction", runId: `smoke-${format}-${Date.now()}` }, () => extractResumeFacts(source, {
      userId: "synthetic-resume-extraction", trustedName: format === "docx" ? "Riley Example" : "Avery Chen",
    }));
    const covered = new Set(facts.flatMap(f => f.grounding!.evidence.filter(e => e.quote === source.anchors.find(a => a.id === e.anchorId)?.text).map(e => e.anchorId)));
    assert.ok(sourceWithCurrentEvidenceClaims(source, format === "docx" ? "Riley Example" : "Avery Chen").anchors.filter(a => a.candidateClaim).every(a => covered.has(a.id)));
    assert.ok(facts.every(isUsableFact)); assert.ok(facts.every(f => !f.verified));
    assert.ok(facts.some(f => f.text.includes(format === "docx" ? "92%" : "1,200")));
    console.log(JSON.stringify({ format, facts: facts.length, profileDetails: details.length, automaticAcceptance: true, fullCoverage: true, model: facts[0].grounding?.model }));
  }
}
main().catch(error => { if (error instanceof Error && "extractionFeedback" in error) console.error(JSON.stringify(error.extractionFeedback)); console.error(error instanceof Error ? error.message.replace(/sk-\S+/g, "[redacted]") : "Provider smoke test failed."); process.exitCode = 1; });
