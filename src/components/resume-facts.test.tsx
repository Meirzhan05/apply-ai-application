// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResumeFacts } from "@/components/resume-facts";
import { initialDemoState } from "@/lib/demo-data";
import type { Profile } from "@/lib/types";
import { createDocxSourceFixture } from "@/lib/fixtures/docx-source";
import { parseDocxSource } from "@/lib/docx-source";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
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

it("exposes re-extraction for missing source evidence even when the saved extraction is ready", async () => {
  const p = profile();
  p.resumeSourceDocument = await parseDocxSource(await createDocxSourceFixture(), p.name);
  p.resumeFileName = "saved.docx";
  p.resumeExtraction = { id: "legacy-ready", status: "ready", requestedAt: "2026-10-03", updatedAt: "2026-10-03", attempts: 1, filename: "saved.docx" };
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "queued" }), { status: 202 }));
  vi.stubGlobal("fetch", fetchMock);
  const onUploaded = vi.fn().mockResolvedValue(true);
  await act(async () => root.render(<ResumeFacts profile={p} busy={false} onUploaded={onUploaded} onSave={vi.fn()} />));
  expect(container.textContent).toContain("source details are missing evidence");
  expect(container.textContent).toContain("replaces resume-derived facts");
  const button = [...container.querySelectorAll("button")].find(item => item.textContent === "Re-extract saved resume");
  expect(button).toBeTruthy();
  await act(async () => button!.click());
  expect(fetchMock).toHaveBeenCalledWith("/api/resume", expect.objectContaining({ method: "POST" }));
  const body = fetchMock.mock.calls[0][1].body as FormData;
  expect(body.get("reuse")).toBe("true"); expect(body.get("reextract")).toBe("true");
  expect(onUploaded).toHaveBeenCalledOnce();
});

it("removes a fact against the exact displayed snapshot without a confirmation step", async () => {
  const p = profile(); const onSave = vi.fn().mockResolvedValue(true);
  await render(p, onSave);
  const remove = container.querySelector<HTMLButtonElement>('button[aria-label^="Remove "]')!;
  await act(async () => remove.click());
  expect(onSave).toHaveBeenCalledWith([], p.facts);
});

it("keeps facts visible and reports an unsuccessful re-extraction request", async () => {
  const p = profile();
  p.resumeSourceDocument = await parseDocxSource(await createDocxSourceFixture(), p.name);
  const before = structuredClone(p.facts);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Saved resume is unavailable. Upload it again." }), { status: 400 })));
  const onUploaded = vi.fn();
  await act(async () => root.render(<ResumeFacts profile={p} busy={false} onUploaded={onUploaded} onSave={vi.fn()} />));
  const button = [...container.querySelectorAll("button")].find(item => item.textContent === "Re-extract saved resume")!;
  await act(async () => button.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Saved resume is unavailable. Upload it again.");
  expect(onUploaded).not.toHaveBeenCalled();
  expect(p.facts).toEqual(before);
  expect(button.disabled).toBe(false);
});

it("does not offer a second extraction while one is already processing", async () => {
  const p = profile();
  p.resumeSourceDocument = await parseDocxSource(await createDocxSourceFixture(), p.name);
  p.resumeExtraction = { id: "queued", status: "queued", requestedAt: "2026-10-03", updatedAt: "2026-10-03", attempts: 0, filename: "saved.docx" };
  await render(p);
  expect(container.textContent).not.toContain("Re-extract saved resume");
});

it("does not offer recovery when every required source detail has evidence", async () => {
  const p = profile();
  const source = await parseDocxSource(await createDocxSourceFixture(), p.name);
  p.resumeSourceDocument = source;
  p.facts = source.anchors.map(anchor => ({ id: anchor.id, text: anchor.text, verified: false, source: "resume", status: "accepted", sourceAnchorId: anchor.id,
    grounding: { version: 1, model: "test", sourceHash: source.sourceHash, acceptedText: anchor.text, evidence: [{ anchorId: anchor.id, quote: anchor.text }] } }));
  await render(p);
  expect(container.textContent).not.toContain("Re-extract saved resume");
});
