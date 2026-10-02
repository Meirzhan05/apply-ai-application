import { expect, it } from "vitest";
import { createPdfMultiPageFixture } from "@/lib/fixtures/pdf-multi-page";
import { parsePdfSource } from "@/lib/pdf-source";
import { sourceWithCurrentEvidenceClaims } from "@/lib/source-plan-evidence";

it("supports multi-page PDF source while keeping a continued entry and repeated page furniture together", async () => {
  const source = await parsePdfSource(await createPdfMultiPageFixture());
  const firstBullet = source.anchors.find((anchor) => anchor.text === "Built a search index for 1,200 users.");
  const continuedBullet = source.anchors.find((anchor) => anchor.text === "Improved retrieval speed by 22%.");
  const repeatedHeader = source.anchors.filter((anchor) => anchor.text === "Avery Chen | Résumé");
  const repeatedFooter = source.anchors.filter((anchor) => anchor.text === "Avery Chen · Confidential");

  expect(source.support).toEqual({ status: "candidate" });
  expect(source.layout.pageCount).toBe(2);
  expect(source.text).toContain("Improved retrieval speed by 22%.");
  expect(continuedBullet?.pageNumber).toBe(2);
  expect(continuedBullet?.entryId).toBe(firstBullet?.entryId);
  expect(repeatedHeader).toHaveLength(2);
  expect(repeatedFooter).toHaveLength(2);
  expect([...repeatedHeader, ...repeatedFooter].every((anchor) => !anchor.candidateClaim && !anchor.editable)).toBe(true);
  expect(sourceWithCurrentEvidenceClaims(source).anchors.filter((anchor) => anchor.repeatedRole).every((anchor) => !anchor.candidateClaim)).toBe(true);
});

it("still requires evidence for substantive credentials repeated in a PDF header", async () => {
  const source = await parsePdfSource(await createPdfMultiPageFixture({ headerText: "AWS Certified Cloud Practitioner" }));
  const headers = sourceWithCurrentEvidenceClaims(source).anchors.filter((anchor) => anchor.repeatedRole === "header");

  expect(headers).toHaveLength(2);
  expect(headers.every((anchor) => anchor.candidateClaim)).toBe(true);
});
