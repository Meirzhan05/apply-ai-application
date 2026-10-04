// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResumeFacts } from "@/components/resume-facts";
import { initialDemoState } from "@/lib/demo-data";
import type { Profile } from "@/lib/types";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const profile = () => {
  const profile = initialDemoState().profile;
  profile.facts = [{ id: "auto", text: "Built a recommender with 92% precision.", verified: false, source: "resume", status: "accepted", category: "experience", sourceAnchorId: "bullet",
    grounding: { version: 1, model: "test", sourceHash: "a".repeat(64), acceptedText: "Built a recommender with 92% precision.", evidence: [{ anchorId: "bullet", quote: "Built a recommender with 92% precision." }] } }];
  return profile;
};
async function render(p: Profile, onSave = vi.fn()) { await act(async () => root.render(<ResumeFacts profile={p} busy={false} onUploaded={vi.fn()} onSave={onSave} />)); }

it("shows grouped automatic facts and source excerpts with no confirmation control", async () => {
  await render(profile());
  expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  expect(container.textContent).toContain("Experience");
  expect(container.querySelector("blockquote")?.textContent).toBe("Built a recommender with 92% precision.");
  expect(container.textContent).not.toContain("Waiting for automatic extraction");
});

it("offers retry after a failed replacement and keeps the existing facts visible", async () => {
  const p = profile(); p.resumeExtraction = { id: "request", status: "failed", requestedAt: "2026-10-03", updatedAt: "2026-10-03", attempts: 2, filename: "replacement.pdf", error: "The provider couldn't finish." };
  await render(p);
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Resume extraction couldn't finish.");
  expect([...container.querySelectorAll("button")].some(button => button.textContent === "Retry extraction")).toBe(true);
  expect(container.textContent).toContain("Built a recommender with 92% precision.");
});

it("removes a fact against the exact displayed snapshot without a confirmation step", async () => {
  const p = profile(); const onSave = vi.fn().mockResolvedValue(true);
  await render(p, onSave);
  const remove = container.querySelector<HTMLButtonElement>('button[aria-label^="Remove "]')!;
  await act(async () => remove.click());
  expect(onSave).toHaveBeenCalledWith([], p.facts);
});
