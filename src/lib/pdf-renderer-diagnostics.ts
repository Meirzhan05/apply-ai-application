export type PdfRendererDiagnosticCode =
  | "unsupported_glyph"
  | "unembedded_font"
  | "changed_source_font"
  | "page_dimensions"
  | "page_count"
  | "outside_edit_pixels";

type DiagnosticDetails = { page?: number; at144Dpi?: string; at300Dpi?: string };

const messages: Record<PdfRendererDiagnosticCode, (details: DiagnosticDetails) => string> = {
  unsupported_glyph: () => "The embedded PDF source font cannot render one or more requested characters. Use wording supported by the font or upload an editable DOCX; no font substitution will be used.",
  unembedded_font: () => "The source font for an edited résumé bullet is not embedded as a supported outline font. Embed that font or upload an editable DOCX; no substitute font will be used.",
  changed_source_font: () => "The PDF source font changed after inspection. Re-upload the original PDF and confirm its current text before drafting.",
  page_dimensions: ({ page }) => page === undefined
    ? "The PDF renderer changed page dimensions after editing."
    : `The PDF rewrite changed source page ${page} dimensions or mapping beyond 0.5 pt.`,
  page_count: () => "The PDF rewrite changed the original page count; no content may be added or removed.",
  outside_edit_pixels: ({ page, at144Dpi, at300Dpi }) => `The PDF render changed page ${page} pixels outside edited text boxes (144 dpi: ${at144Dpi}, 300 dpi: ${at300Dpi}). No font substitution or overlay will be used.`,
};

export class PdfRendererDiagnosticError extends Error {
  readonly diagnosticCode: PdfRendererDiagnosticCode;

  constructor(code: PdfRendererDiagnosticCode, details: DiagnosticDetails = {}) {
    super(messages[code](details));
    this.name = "PdfRendererDiagnosticError";
    this.diagnosticCode = code;
  }
}

export function isPdfRendererDiagnostic(error: unknown): error is PdfRendererDiagnosticError {
  return error instanceof PdfRendererDiagnosticError;
}
