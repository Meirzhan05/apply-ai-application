import { expect, it } from "vitest";
import JSZip from "jszip";
import { applyDocxEdits, parseDocxSource, suggestDocxFacts } from "@/lib/docx-source";
import { createDocxSourceFixture as fixture } from "@/lib/fixtures/docx-source";
import { evidenceRequiredAnchorIds } from "@/lib/resume-source-semantics";

it("captures full DOCX text, stable anchored structure, and paragraph styling without truncation", async () => {
  const bytes = await fixture();
  const source = await parseDocxSource(bytes);
  const bullet = source.anchors.find((anchor) => anchor.text.startsWith("Built a recommender"));

  expect(source).toMatchObject({ version: 1, format: "docx", support: { status: "candidate" }, layout: { columns: 1, pageSizePt: { width: 612, height: 792 }, marginsPt: { top: 36, right: 36, bottom: 36, left: 36 } } });
  expect(source.text).toBe("Riley Example | riley@example.com\nExperience\nOrbit Labs — ML Intern | June–August 2026\nBuilt a recommender with 92% precision.\nEducation\nState University — B.S. Computer Science");
  expect(source.sections.map((section) => section.heading)).toEqual(["Experience", "Education"]);
  expect(bullet).toMatchObject({ kind: "bullet", editable: true, font: { family: "Noto Sans", sizePt: 10, color: "222222" } });
  expect(bullet?.entryId).toBeTruthy();
  expect((await parseDocxSource(bytes)).anchors.map((anchor) => anchor.id)).toEqual(source.anchors.map((anchor) => anchor.id));
  expect(suggestDocxFacts(source)).toContainEqual(expect.objectContaining({ text: expect.stringContaining("Built a recommender with 92% precision."), sourceAnchorId: bullet!.id }));
});

it("treats unbulleted qualifications and language proficiency as source claims, while sharing section semantics with PDFs", async () => {
  const source = await parseDocxSource(await fixture({ languages: true, skillsText: "Python, scikit-learn, and PostgreSQL" }));
  const degree = source.anchors.find((anchor) => anchor.text === "State University — B.S. Computer Science");
  const skills = source.anchors.find((anchor) => anchor.text === "Python, scikit-learn, and PostgreSQL");
  const languageHeading = source.anchors.find((anchor) => anchor.text === "Languages");
  const languages = source.anchors.find((anchor) => anchor.text === "English and Spanish");

  expect(degree?.candidateClaim).toBe(true);
  expect(skills?.candidateClaim).toBe(true);
  expect(languageHeading).toMatchObject({ kind: "section", candidateClaim: false });
  expect(languages?.candidateClaim).toBe(true);
  expect(suggestDocxFacts(source).map((suggestion) => suggestion.sourceAnchorId)).toEqual(expect.arrayContaining([degree!.id, skills!.id, languages!.id]));

  const styledCredentialSource = await parseDocxSource(await fixture({ skillsText: "AWS Certified Cloud Practitioner", skillsAsHeading: true }));
  expect(styledCredentialSource.anchors.find((anchor) => anchor.text === "AWS Certified Cloud Practitioner")).toMatchObject({ kind: "section", candidateClaim: true });
});

it("includes visible header source text as repeated, stable, non-editable furniture", async () => {
  const source = await parseDocxSource(await fixture({ headerText: "Confidential candidate record" }));
  const header = source.anchors.find((anchor) => anchor.partName === "word/header1.xml");

  expect(source.text).toContain("Confidential candidate record");
  expect(source.support).toMatchObject({ status: "candidate" });
  expect(header).toMatchObject({ text: "Confidential candidate record", candidateClaim: false, editable: false, repeatedRole: "header", font: { family: "Noto Sans", sizePt: 10 } });
  expect(suggestDocxFacts(source)).not.toContainEqual(expect.objectContaining({ sourceAnchorId: header?.id }));
  const credentialHeader = await parseDocxSource(await fixture({ headerText: "AWS Certified Cloud Practitioner" }));
  expect(credentialHeader.anchors.find((anchor) => anchor.partName === "word/header1.xml")?.candidateClaim).toBe(true);
});

it("uses the profile identity for contact handling and still surfaces qualifications on the first visible row", async () => {
  const blankFirstParagraph = await parseDocxSource(await fixture({ emptyFirstParagraph: true }), "Riley Example");
  const identity = blankFirstParagraph.anchors.find((anchor) => anchor.text.startsWith("Riley Example"))!;
  const mixedContact = await parseDocxSource(await fixture({ identityText: "Riley Example | Certified Kubernetes Administrator | riley@example.com" }), "Riley Example");
  const credentialRow = mixedContact.anchors.find((anchor) => anchor.text.includes("Certified Kubernetes Administrator"))!;

  expect(identity.paragraphIndex).toBeGreaterThan(0);
  expect(evidenceRequiredAnchorIds(blankFirstParagraph, "Riley Example").has(identity.id)).toBe(false);
  expect(credentialRow.candidateClaim).toBe(true);
  expect(evidenceRequiredAnchorIds(mixedContact, "Riley Example").has(credentialRow.id)).toBe(true);
  expect(suggestDocxFacts(mixedContact)).toContainEqual(expect.objectContaining({ sourceAnchorId: credentialRow.id }));
});

it("keeps a page-break continuation in its original entry for rendered page mapping", async () => {
  const source = await parseDocxSource(await fixture({ multiPage: true }));
  const bullets = source.anchors.filter((anchor) => anchor.kind === "bullet");

  expect(source.support).toMatchObject({ status: "candidate" });
  expect(bullets.map((anchor) => anchor.text)).toEqual(["Built a recommender with 92% precision.", "Improved model recall to 94%."]);
  expect(bullets[1].entryId).toBe(bullets[0].entryId);
});

it("updates only an authorized source text node and retains untouched package content and paragraph styles", async () => {
  const bytes = await fixture();
  const source = await parseDocxSource(bytes);
  const target = source.anchors.find((anchor) => anchor.kind === "bullet")!;
  const revised = await applyDocxEdits(bytes, source, [{ anchorId: target.id, text: "Built an explainable recommender with 92% precision.", factIds: ["confirmed-bullet"] }], [{ id: "confirmed-bullet", text: "Built a recommender with 92% precision.", verified: true, source: "resume", sourceAnchorId: target.id }]);
  const originalZip = await JSZip.loadAsync(bytes);
  const revisedZip = await JSZip.loadAsync(revised);
  const xml = await revisedZip.file("word/document.xml")!.async("string");

  expect(xml).toContain("Built an explainable recommender with 92% precision.");
  expect(xml).toContain("<w:numId w:val=\"1\"/>");
  expect(await revisedZip.file("customXml/item1.xml")!.async("string")).toBe(await originalZip.file("customXml/item1.xml")!.async("string"));
  expect((await revisedZip.file("word/styles.xml")!.async("string"))).toBe(await originalZip.file("word/styles.xml")!.async("string"));
  expect(await revisedZip.file("word/document.xml")!.async("string")).not.toContain("Built a recommender with 92% precision.");
});

it("reports structurally unsupported DOCX layouts and rejects cross-entry or unconfirmed edits", async () => {
  const tableSource = await parseDocxSource(await fixture({ table: true }));
  const columnSource = await parseDocxSource(await fixture({ columns: 3 }));
  const fontSource = await parseDocxSource(await fixture({ font: "Aptos" }));
  const externalSource = await parseDocxSource(await fixture({ externalResource: true }));
  const bytes = await fixture();
  const source = await parseDocxSource(bytes);
  const bullet = source.anchors.find((anchor) => anchor.kind === "bullet")!;

  expect(tableSource.support).toMatchObject({ status: "blocked", reason: expect.stringMatching(/table/i) });
  expect(columnSource.support).toMatchObject({ status: "blocked", reason: expect.stringMatching(/more than two columns/i) });
  expect(fontSource.support).toMatchObject({ status: "blocked", reason: expect.stringMatching(/Aptos.*not in the pinned supported font set/i) });
  expect(externalSource.support).toMatchObject({ status: "blocked", reason: expect.stringMatching(/external package resource/i) });
  await expect(applyDocxEdits(bytes, source, [{ anchorId: bullet.id, text: "Changed wording.", factIds: ["other-entry-fact"] }], [{ id: "other-entry-fact", text: "Managed the entire department.", verified: true, source: "resume", sourceAnchorId: source.anchors.find((anchor) => anchor.kind === "entry")!.id }])).rejects.toThrow(/different source entry/i);
  await expect(applyDocxEdits(bytes, source, [{ anchorId: bullet.id, text: "Changed wording.", factIds: ["unconfirmed"] }], [{ id: "unconfirmed", text: "Built a recommender with 92% precision.", verified: false, source: "resume", sourceAnchorId: bullet.id }])).rejects.toThrow(/confirmed/i);
});

it("rejects XML entity declarations and packages whose expanded size exceeds the inspection bound", async () => {
  const unsafe = await fixture();
  const unsafeZip = await JSZip.loadAsync(unsafe);
  unsafeZip.file("word/styles.xml", `<!DOCTYPE styles [<!ENTITY x SYSTEM "file:///etc/passwd">]>` + await unsafeZip.file("word/styles.xml")!.async("string"));
  await expect(parseDocxSource(await unsafeZip.generateAsync({ type: "nodebuffer" }))).rejects.toThrow(/XML declarations outside the supported DOCX profile/i);
  const tooLarge = await fixture({ expandedPayload: "expanded ".repeat(2_800_000) });
  await expect(parseDocxSource(tooLarge)).rejects.toThrow(/too complex to inspect safely/i);
});

it("rejects an oversized readable source instead of truncating its context", async () => {
  const bytes = await fixture({ longText: `Built a recommender. ${"context ".repeat(2600)}` });
  await expect(parseDocxSource(bytes)).rejects.toThrow(/20,000-character source-context limit/i);
});
