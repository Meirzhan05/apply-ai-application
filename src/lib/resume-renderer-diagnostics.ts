export type RendererDiagnosticPayload =
  | { code: "unsupported_glyph" }
  | { code: "unembedded_font" }
  | { code: "changed_source_font" }
  | { code: "page_dimensions"; page?: number }
  | { code: "page_count" }
  | { code: "outside_edit_pixels"; page: number; at144Dpi: string; at300Dpi: string }
  | { code: "pdf_source_font_unidentified"; text: string }
  | { code: "docx_rendered_font_mismatch"; text: string; renderedFonts: string[]; sourceFont: string };

function safeFragment(value: string, maxLength: number): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength) || "unknown";
}

export function rendererDiagnosticMessage(diagnostic: RendererDiagnosticPayload): string {
  switch (diagnostic.code) {
    case "unsupported_glyph":
      return "The embedded PDF source font cannot render one or more requested characters. Use wording supported by the font or upload an editable DOCX; no font substitution will be used.";
    case "unembedded_font":
      return "The source font for an edited résumé bullet is not embedded as a supported outline font. Embed that font or upload an editable DOCX; no substitute font will be used.";
    case "changed_source_font":
      return "The PDF source font changed after inspection. Re-upload the original PDF and confirm its current text before drafting.";
    case "page_dimensions":
      return diagnostic.page === undefined
        ? "The PDF renderer changed page dimensions after editing."
        : `The PDF rewrite changed source page ${diagnostic.page} dimensions or mapping beyond 0.5 pt.`;
    case "page_count":
      return "The PDF rewrite changed the original page count; no content may be added or removed.";
    case "outside_edit_pixels":
      return `The PDF render changed page ${diagnostic.page} pixels outside edited text boxes (144 dpi: ${diagnostic.at144Dpi}, 300 dpi: ${diagnostic.at300Dpi}). No font substitution or overlay will be used.`;
    case "pdf_source_font_unidentified":
      return `The source font for “${safeFragment(diagnostic.text, 60)}” cannot be identified. Upload an editable DOCX rather than substituting a font.`;
    case "docx_rendered_font_mismatch":
      return `The rendered paragraph “${safeFragment(diagnostic.text, 70)}” uses ${diagnostic.renderedFonts.map((font) => safeFragment(font, 80)).join(", ") || "an unknown font"} instead of source font ${safeFragment(diagnostic.sourceFont, 80)}. Upload a DOCX using the pinned Noto Sans source font.`;
  }
}

export class ResumeRendererDiagnosticError extends Error {
  readonly diagnosticCode: RendererDiagnosticPayload["code"];

  constructor(readonly diagnostic: RendererDiagnosticPayload) {
    super(rendererDiagnosticMessage(diagnostic));
    this.name = "ResumeRendererDiagnosticError";
    this.diagnosticCode = diagnostic.code;
  }
}

export function isResumeRendererDiagnostic(error: unknown): error is ResumeRendererDiagnosticError {
  return error instanceof ResumeRendererDiagnosticError;
}
