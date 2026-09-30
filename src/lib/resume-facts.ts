// These are source-text suggestions, never verified claims. Ambiguous or
// oversized blocks remain available in resumeText for manual review.
const sectionName = /^(?:education|academic background|publications|research|work experience|professional experience|experience|internship experience|open source experience|projects|personal projects|technical skills|skills|certifications|awards|leadership|volunteering|summary|profile)$/i;
const bullet = /^[•●▪◦‣*\-–]\s+/;
const action = /^(?:built|created|developed|designed|analyzed|managed|led|implemented|conducted|researched|improved|worked|used|organized|launched|integrated|shipped|collaborated|architected)\b/i;
const date = /\b(?:19|20)\d{2}\b|\b(?:present|current)\b/i;
const clean = (value: string) => value.replace(/\s+/g, " ").trim();

export function suggestResumeFacts(extracted: string): string[] {
  const sections: Array<{ name: string; lines: string[] }> = [{ name: "", lines: [] }];
  for (const raw of extracted.split(/\r?\n/)) {
    const line = clean(raw.replace(/\0/g, ""));
    if (/^(?:--\s*)?\d+\s+of\s+\d+(?:\s*--)?$/i.test(line)) continue;
    const heading = line.replace(/:$/, "");
    if (sectionName.test(heading)) sections.push({ name: heading, lines: [] });
    else sections.at(-1)!.lines.push(line);
  }
  const suggestions: string[] = [];
  const seen = new Set<string>();
  const add = (text: string) => {
    const value = clean(text);
    // Do not clip claims or omit the ending that qualifies a claim, such as
    // "expected" graduation or "manuscript in preparation".
    if (value.length < 25 || value.length > 500 || suggestions.length >= 30 ||
      /@|https?:\/\/|www\.|linkedin\.com\/|github\.com\//i.test(value) ||
      seen.has(value.toLowerCase())) return;
    seen.add(value.toLowerCase()); suggestions.push(value);
  };
  for (const section of sections) {
    const lines = section.lines.filter(Boolean);
    if (!lines.length) continue;
    const hasBullets = lines.some((line) => bullet.test(line));
    const isClaim = (line: string) => bullet.test(line) || (!hasBullets && action.test(line));
    // Keep education dates, skills lists, and publication status together.
    // In particular, a title alone must not imply a published manuscript.
    if (section.name && (!lines.some(isClaim) || /^(?:education|academic background|publications|research|technical skills|skills)$/i.test(section.name))) {
      add(`${section.name}: ${lines.map((line) => line.replace(bullet, "")).join(" ")}`);
      continue;
    }
    let context: string[] = [];
    let claim: string[] = [];
    const flush = () => {
      if (claim.length) add([...context, claim.join(" ")].join(" · "));
      claim = [];
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isClaim(line)) {
        flush(); claim = [line.replace(bullet, "")]; continue;
      }
      if (!claim.length) {
        if (section.name) context.push(line);
        continue;
      }
      const next = lines[i + 1] ?? "";
      const newEntry = section.name && !action.test(line) && !/[.!?]$/.test(line) &&
        (/\|/.test(line) || (!isClaim(next) && date.test(next) &&
          /\b(?:intern|engineer|developer|analyst|manager|contributor|assistant|researcher|consultant|designer|specialist)\b/i.test(next)) ||
          (isClaim(next) && /[.!?]$/.test(claim.at(-1)!) && /^[A-Z]/.test(line)));
      if (newEntry) { flush(); context = [line]; }
      else claim.push(line);
    }
    flush();
  }
  return suggestions;
}
