import { expect, it } from "vitest";
import { createTwoColumnDocxFixture, createTwoColumnPdfFixture } from "@/lib/fixtures/two-column-resume";
import { parseDocxSource } from "@/lib/docx-source";
import { parsePdfSource } from "@/lib/pdf-source";

it("builds a text PDF with sidebar content and a continuation on its second page", async () => {
  const source = await parsePdfSource(await createTwoColumnPdfFixture({ pages: 2 }));

  expect(source.text).toContain("Orbit Labs — Search Engineer, 2023–2024");
  expect(source.text).toContain("Campus Access Checker");
  expect(source.text).toContain("Technical Skills");
  expect(source.text).toContain("Maintained the ranking service through peak traffic.");
  expect(source.layout).toMatchObject({ columns: 2, pageCount: 2 });
});

it("builds an ordinary two-column DOCX with distinct entries and the same continuation", async () => {
  const source = await parseDocxSource(await createTwoColumnDocxFixture({ pages: 2 }));

  expect(source.text).toContain("Orbit Labs — Search Engineer, 2023–2024");
  expect(source.text).toContain("Campus Access Checker");
  expect(source.text).toContain("Technical Skills");
  expect(source.text).toContain("Maintained the ranking service through peak traffic.");
  expect(source.layout).toMatchObject({ columns: 2 });
});
