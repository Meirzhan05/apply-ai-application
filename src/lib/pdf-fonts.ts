export function readablePdfFontFamily(name: string) {
  return name.replace(/^[A-Z]{6}\+/, "").replace(/[-_](?:Bold|Italic|Oblique|Regular|Medium|Light|Book|Roman|Semibold|Demi|Black)(?:[-_]\d+)?/gi, "").replace(/[-_]\d+$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
}
