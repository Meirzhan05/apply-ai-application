import { expect, it, vi } from "vitest";
import { parsePdfSource } from "@/lib/pdf-source";

const mocks = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock("@/lib/pdfjs-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdfjs-runtime")>();
  return { ...actual, getDocument: mocks.getDocument };
});

import { OPS } from "@/lib/pdfjs-runtime";

it("returns font guidance from a typed support diagnostic", async () => {
  const text = "Avery Chen";
  const item = { str: text, dir: "ltr", transform: [10, 0, 0, 10, 72, 744], width: 60, height: 10, fontName: "unresolved-font" };
  const page = {
    rotate: 0,
    getViewport: () => ({ width: 612, height: 792 }),
    getTextContent: async () => ({ items: [item], styles: { "unresolved-font": { fontFamily: "" } } }),
    getOperatorList: async () => ({ fnArray: [OPS.showText], argsArray: [[[{ unicode: text }]]] }),
    commonObjs: { get: () => { throw new Error("font descriptor is unavailable"); } },
    cleanup: vi.fn(),
  };
  const pdf = { numPages: 1, isPureXfa: false, getPage: async () => page };
  mocks.getDocument.mockReturnValueOnce({ promise: Promise.resolve(pdf), destroy: vi.fn() });

  const source = await parsePdfSource(Buffer.from("synthetic PDF bytes"));

  expect(source.support).toEqual({ status: "blocked", reason: "The source font for “Avery Chen” cannot be identified. Upload an editable DOCX rather than substituting a font.",
    diagnostic: { code: "pdf_source_font_unidentified", text } });
});
