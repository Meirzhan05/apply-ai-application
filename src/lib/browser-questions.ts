import { answerOwner } from "@/lib/answer-responsibility";
import type { BrowserQuestion, FormSnapshot } from "@/lib/types";

const writableKinds = new Set(["text", "email", "tel", "url", "number", "date", "textarea", "select", "radio", "checkbox"]);

// Use only the employer's inspected controls. Optional blanks, attachments,
// credentials, and ambiguous identifiers never become invented questions.
export function browserQuestions(form: FormSnapshot | undefined): BrowserQuestion[] {
  if (!form || form.readyToSubmit !== false) return [];
  const questions: BrowserQuestion[] = [];
  const seen = new Set<string>();
  for (const field of form.fields) {
    if (!field.identifier || /^\d+$/.test(field.identifier) || field.editable === false || !writableKinds.has(field.kind)) continue;
    const group = form.fields.filter((item) => item.identifier === field.identifier);
    if (field.kind !== "radio" && group.length !== 1) continue;
    if (seen.has(field.identifier)) continue;
    seen.add(field.identifier);
    if (field.kind === "radio" ? group.some((item) => item.checked) :
      field.kind === "checkbox" ? field.checked : field.value.trim() && field.valid !== false) continue;
    if (!group.some((item) => item.required) && !(field.valid === false && field.value.trim())) continue;
    const options = field.kind === "radio" ? group.map((item) => item.value) :
      field.kind === "checkbox" ? [] : field.options ?? [];
    questions.push({ id: JSON.stringify([field.identifier, field.kind, field.label]), identifier: field.identifier,
      label: field.label, kind: field.kind, options: [...new Set(options)],
      owner: field.kind === "checkbox" || options.length ? "human" : answerOwner(field.label), value: ["radio", "checkbox"].includes(field.kind) ? "" : field.value });
  }
  return questions.slice(0, 20);
}

export function browserTakeoverReasons(form: FormSnapshot | undefined): string[] {
  const labels = new Set(browserQuestions(form).map((question) => question.label));
  return (form?.blockers ?? []).filter((blocker) => ![
    "Correct or complete the field: ", "Choose an exact option for: ", "Select and confirm the option for: ",
  ].some((prefix) => blocker.startsWith(prefix) && labels.has(blocker.slice(prefix.length))));
}
