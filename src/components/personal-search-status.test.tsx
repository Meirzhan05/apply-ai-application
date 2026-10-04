import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { expect, it, vi } from "vitest";
import { PersonalSearchStatus } from "./personal-search-status";
import { initialDemoState } from "@/lib/demo-data";
const render = (options: Partial<Parameters<typeof PersonalSearchStatus>[0]> = {}) => {
  const html = renderToStaticMarkup(createElement(PersonalSearchStatus, { profile: initialDemoState().profile, onConfigure: vi.fn(), onImport: vi.fn(), onSearch: vi.fn(), ...options }));
  return new JSDOM(html).window.document;
};
it("offers a test search button for a ready profile", () => {
  const button = render().querySelector("button")!;
  expect(button.textContent).toBe("Search jobs (test)"); expect(button.disabled).toBe(false);
});
it("disables manual search until resume experience is available", () => {
  const profile = initialDemoState().profile; profile.facts = [];
  const document = render({ profile }); expect(document.querySelector("button")!.disabled).toBe(true);
  expect(document.body.textContent).toContain("resume experience");
});
it.each(["queued", "searching"] as const)("disables repeat clicks while %s", status => {
  const document = render({ search: { status, requestId: "request", requestedAt: new Date().toISOString(), profileKey: "key", jobs: [] } });
  expect(document.querySelector("button")!.disabled).toBe(true); expect(document.querySelector("button")!.textContent).toBe("Searching…");
});
it("allows retry after failure or a completed search", () => {
  for (const status of ["failed", "complete"] as const) expect(render({ search: { status, requestId: "request", requestedAt: new Date().toISOString(), profileKey: "key", jobs: [] } }).querySelector("button")!.disabled).toBe(false);
});
