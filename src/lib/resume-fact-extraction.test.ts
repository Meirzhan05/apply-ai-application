import { expect, it } from "vitest";
import OpenAI from "openai";
import { parseDocxSource, applyDocxEdits } from "@/lib/docx-source";
import { parsePdfSource } from "@/lib/pdf-source";
import { createPdfSourceFixture } from "@/lib/fixtures/pdf-source";
import { createDocxSourceFixture } from "@/lib/fixtures/docx-source";
import { extractResumeFacts, type ResumeFactModel } from "@/lib/resume-fact-extraction";
import { isUsableFact } from "@/lib/fact-evidence";
import { assertSourceInformationComplete } from "@/lib/resume-source-draft";
import { initialDemoState } from "@/lib/demo-data";
import { parseEditableFacts } from "@/lib/fact-corrections";

async function fixture() {
  const bytes = await createDocxSourceFixture();
  const source = await parseDocxSource(bytes, "Riley Example");
  const facts = [
    { anchorId: source.anchors.find(a => a.text === "Orbit Labs — ML Intern | June–August 2026")!.id,
      text: "Worked at Orbit Labs as an ML intern from June–August 2026.", category: "experience", context: "Orbit Labs", evidence: [] as Array<{ anchorId: string; quote: string }> },
    { anchorId: source.anchors.find(a => a.text === "Built a recommender with 92% precision.")!.id,
      text: "At Orbit Labs, built a recommender with 92% precision during an ML internship.", category: "experience", context: "Orbit Labs", evidence: [] as Array<{ anchorId: string; quote: string }> },
    { anchorId: source.anchors.find(a => a.text === "State University — B.S. Computer Science")!.id,
      text: "State University — B.S. Computer Science", category: "education", context: "State University", evidence: [] as Array<{ anchorId: string; quote: string }> },
  ];
  for (const fact of facts) fact.evidence = [{ anchorId: fact.anchorId, quote: source.anchors.find(a => a.id === fact.anchorId)!.text }];
  facts[1].evidence.push(facts[0].evidence[0]);
  const audit = { findings: facts.map(fact => ({ anchorId: fact.anchorId, supported: true, reason: "The cited resume text supports the complete statement." })) };
  return { source, facts, audit, bytes };
}

it("makes grounded facts usable without user confirmation and satisfies resume tailoring coverage", async () => {
  const { source, facts, audit } = await fixture();
  const modelCall: ResumeFactModel = async request => request.operation === "resume-fact-extraction" ? { facts } : audit;
  const extracted = await extractResumeFacts(source, { userId: "owner", trustedName: "Riley Example", modelCall });
  expect(extracted).toHaveLength(3);
  expect(extracted[1]).toMatchObject({ text: "At Orbit Labs, built a recommender with 92% precision during an ML internship.", verified: false, status: "accepted", category: "experience" });
  expect(extracted.every(isUsableFact)).toBe(true);
  const profile = initialDemoState().profile;
  profile.name = "Riley Example"; profile.facts = extracted;
  expect(() => assertSourceInformationComplete(source, profile)).not.toThrow();
  expect(isUsableFact({ ...extracted[1], text: "Built a recommender with 99% precision." })).toBe(false);
});

it("repairs unsupported metrics before accepting the complete snapshot", async () => {
  const { source, facts, audit } = await fixture();
  let extractions = 0;
  const modelCall: ResumeFactModel = async request => {
    if (request.operation === "resume-fact-extraction") {
      extractions++; return { facts: extractions === 1 ? facts.map((f, i) => i === 1 ? { ...f, text: "Built a recommender with 99% precision." } : f) : facts };
    }
    return extractions === 1 ? { findings: audit.findings.map((f, i) => i === 1 ? { ...f, supported: false, reason: "Source says 92%, not 99%." } : f) } : audit;
  };
  const result = await extractResumeFacts(source, { userId: "owner", trustedName: "Riley Example", modelCall });
  expect(extractions).toBe(2);
  expect(result[1].text).toContain("92% precision");
});

it("recovers from a provider timeout without asking the applicant to retry", async () => {
  const { source, facts, audit } = await fixture();
  let timedOut = false;
  const result = await extractResumeFacts(source, { userId: "owner", trustedName: "Riley Example", modelCall: async request => {
    if (!timedOut) { timedOut = true; throw new OpenAI.APIConnectionTimeoutError(); }
    return request.operation === "resume-fact-extraction" ? { facts } : audit;
  } });
  expect(result.map(f => f.text)).toEqual(facts.map(f => f.text));
  expect(result.every(isUsableFact)).toBe(true);
});

it("retries a transient grounding failure without regenerating accepted extraction output", async () => {
  const { source, facts, audit } = await fixture();
  let checks = 0;
  let extractions = 0;
  const result = await extractResumeFacts(source, { userId: "owner", trustedName: "Riley Example", modelCall: async request => {
    if (request.operation === "resume-fact-extraction") { extractions++; return { facts }; }
    if (++checks === 1) throw new OpenAI.APIConnectionTimeoutError();
    return audit;
  } });
  expect(result.every(isUsableFact)).toBe(true);
  expect(extractions).toBe(1);
});

it("bounds repeated provider timeouts and does not retry authorization errors", async () => {
  const { source } = await fixture();
  for (const [error, expected] of [[new OpenAI.APIConnectionTimeoutError(), 2], [new OpenAI.AuthenticationError(401, {}, "unauthorized", new Headers()), 1]] as const) {
    let calls = 0;
    await expect(extractResumeFacts(source, { userId: "owner", modelCall: async () => { calls++; throw error; } })).rejects.toThrow(error.message);
    expect(calls).toBe(expected);
  }
});

it("rejects fabricated excerpts, missing source claims, and evidence from another entry", async () => {
  const { source, facts, audit } = await fixture();
  const invalid = [
    facts.map((f, i) => i === 1 ? { ...f, evidence: [{ anchorId: f.anchorId, quote: "Built a recommender with 99% precision." }] } : f),
    facts.slice(0, 2),
    facts.map((f, i) => i === 1 ? { ...f, evidence: [...f.evidence, facts[2].evidence[0]] } : f),
  ];
  for (const proposed of invalid) {
    await expect(extractResumeFacts(source, { userId: "owner", trustedName: "Riley Example",
      modelCall: async request => request.operation === "resume-fact-extraction" ? { facts: proposed } : audit,
    })).rejects.toThrow("couldn't reliably extract all resume facts");
  }
});

it("rejects incomplete or uncertain grounding checks", async () => {
  const { source, facts, audit } = await fixture();
  for (const findings of [audit.findings.slice(0, 2), audit.findings.map(f => ({ ...f, supported: false }))]) {
    await expect(extractResumeFacts(source, { userId: "owner", trustedName: "Riley Example",
      modelCall: async request => request.operation === "resume-fact-extraction" ? { facts } : { findings },
    })).rejects.toThrow("couldn't reliably extract all resume facts");
  }
});

it("preserves server-owned acceptance on unchanged profile saves and prevents client-forged acceptance", async () => {
  const { source, facts, audit } = await fixture();
  const current = await extractResumeFacts(source, { userId: "owner", trustedName: "Riley Example", modelCall: async request => request.operation === "resume-fact-extraction" ? { facts } : audit });
  expect(parseEditableFacts(current, current)).toEqual(current);
  const forged = { ...current[0], id: "fake", text: "Worked at NASA." };
  expect(isUsableFact(parseEditableFacts([forged], current)[0])).toBe(false);
  expect(isUsableFact(parseEditableFacts([{ ...current[0], text: "Worked at NASA." }], current)[0])).toBe(false);
  expect(() => parseEditableFacts(current, current.slice(0, 1), current)).toThrow("resume facts changed");
});


it("combines source fragments into complete facts without requiring a fact per raw anchor", async () => {
  const { source, facts } = await fixture();
  const combined = [facts[1], facts[2]];
  const result = await extractResumeFacts(source, { userId: "owner", trustedName: "Riley Example",
    modelCall: async request => request.operation === "resume-fact-extraction" ? { facts: combined } : { findings: combined.map(f => ({ anchorId: f.anchorId, supported: true, reason: "Complete cited evidence." })) },
  });
  expect(result).toHaveLength(2);
  const profile = initialDemoState().profile; profile.name = "Riley Example"; profile.facts = result;
  expect(() => assertSourceInformationComplete(source, profile)).not.toThrow();
});

it("covers more than 80 source spans using complete grouped facts", async () => {
  const { source } = await fixture();
  const template = source.anchors.find(a => a.kind === "bullet")!;
  source.anchors = Array.from({ length: 90 }, (_, i) => ({ ...template, id: `fragment-${i}`, text: `Built component ${i}.`, sourceText: `Built component ${i}.`, candidateClaim: true }));
  source.text = source.anchors.map(a => a.text).join("\n");
  const facts = Array.from({ length: 9 }, (_, i) => ({ anchorId: source.anchors[i * 10].id, category: "project", context: null,
    text: source.anchors.slice(i * 10, i * 10 + 10).map(a => a.text).join(" "),
    evidence: source.anchors.slice(i * 10, i * 10 + 10).map(a => ({ anchorId: a.id, quote: a.text })),
  }));
  const result = await extractResumeFacts(source, { userId: "owner", modelCall: async request => {
    const input = request.input as { anchors: Array<{ id: string; candidateClaim: boolean }>; facts?: typeof facts };
    // A large entry is processed in bounded pieces, retaining complete evidence.
    expect(input.anchors.filter(a => a.candidateClaim).length).toBeLessThanOrEqual(10);
    const ids = new Set(input.anchors.filter(a => a.candidateClaim).map(a => a.id));
    const selected = facts.filter(f => ids.has(f.anchorId));
    return request.operation === "resume-fact-extraction" ? { facts: selected } : { findings: input.facts!.map(f => ({ anchorId: f.anchorId, supported: true, reason: "All components are cited." })) };
  } });
  expect(result).toHaveLength(9);
});

it("retains a wrapped PDF achievement when its continuation crosses a batch boundary", async () => {
  const source = await parsePdfSource(await createPdfSourceFixture({ wrappedBullet: true }), "Avery Chen");
  const section = source.anchors.find(a => a.text === "Work Experience")!;
  const employer = source.anchors.find(a => a.text.startsWith("Orbit Labs"))!;
  const head = source.anchors.find(a => a.text === "Built a search index")!;
  const tail = source.anchors.find(a => a.text === "for 1,200 users.")!;
  source.anchors = [section, employer, ...Array.from({ length: 8 }, (_, i) => ({ ...head, id: `filler-${i}`, text: `Built component ${i}.`, sourceText: `Built component ${i}.` })), head, tail];
  source.text = source.anchors.map(a => a.text).join("\n");
  let checkedContinuation = false;
  const facts = await extractResumeFacts(source, { userId: "owner", trustedName: "Avery Chen", modelCall: async request => {
    const input = request.input as { anchors: Array<{ id: string; text: string; candidateClaim: boolean }>; facts?: Array<{ anchorId: string }> };
    if (request.operation === "resume-fact-grounding") return { findings: input.facts!.map(f => ({ anchorId: f.anchorId, supported: true, reason: "Complete original text." })) };
    if (input.anchors.some(a => a.id === tail.id && a.candidateClaim)) {
      checkedContinuation = true;
      expect(input.anchors.find(a => a.id === head.id)).toMatchObject({ text: "Built a search index", candidateClaim: false });
      expect(input.anchors.some(a => a.id === employer.id)).toBe(true);
    }
    return { facts: input.anchors.filter(a => a.candidateClaim).map(a => ({ anchorId: a.id, category: "experience", context: "Orbit Labs",
      text: a.id === tail.id ? "Built a search index for 1,200 users." : a.text,
      evidence: [{ anchorId: a.id, quote: a.text }, ...(a.id === tail.id ? [{ anchorId: head.id, quote: head.text }] : [])],
    })) };
  } });
  expect(checkedContinuation).toBe(true);
  expect(facts.some(f => f.text === "Built a search index for 1,200 users." && isUsableFact(f))).toBe(true);
});


it("accepts same-section headings as category evidence and rejects unrelated headings", async () => {
  const { source, facts, bytes } = await fixture();
  const heading = source.anchors.find(a => a.kind === "section" && a.sectionHeading === "Experience")!;
  const otherHeading = source.anchors.find(a => a.kind === "section" && a.sectionHeading === "Education")!;
  const augmented = facts.map((f, i) => i === 1 ? { ...f, evidence: [...f.evidence, { anchorId: heading.id, quote: heading.text }] } : f);
  const modelCall: ResumeFactModel = async request => request.operation === "resume-fact-extraction" ? { facts: augmented } : { findings: augmented.map(f => ({ anchorId: f.anchorId, supported: true, reason: "Correct section context." })) };
  const result = await extractResumeFacts(source, { userId: "owner", trustedName: "Riley Example", modelCall });
  const profile = initialDemoState().profile; profile.name = "Riley Example"; profile.facts = result;
  expect(() => assertSourceInformationComplete(source, profile)).not.toThrow();
  const revised = await applyDocxEdits(bytes, source, [{ anchorId: augmented[1].anchorId, text: "Built a recommender achieving 92% precision.", factIds: [result[1].id] }], result);
  expect((await parseDocxSource(revised)).text).toContain("Built a recommender achieving 92% precision.");
  augmented[1].evidence = [...facts[1].evidence, { anchorId: otherHeading.id, quote: otherHeading.text }];
  await expect(extractResumeFacts(source, { userId: "owner", trustedName: "Riley Example", modelCall })).rejects.toThrow("couldn't reliably extract all resume facts");
});
