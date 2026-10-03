// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountDeletionPanel } from "@/components/account-deletion";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("account deletion settings", () => {
  it("keeps deletion unavailable in demo mode", async () => {
    await act(async () => root.render(<AccountDeletionPanel demo />));
    expect(container.textContent).toContain("unavailable in demo mode");
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("input")).toBeNull();
  });

  it("requires typed DELETE, shows retryable failures, and submits only the confirmation", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "Storage cleanup is still pending." }) });
    vi.stubGlobal("fetch", fetch);
    await act(async () => root.render(<AccountDeletionPanel demo={false} />));
    const input = container.querySelector("input")!;
    const button = container.querySelector("button")!;
    expect(button.disabled).toBe(true);
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    valueSetter.call(input, "DELETE");
    await act(async () => input.dispatchEvent(new Event("input", { bubbles: true })));
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(fetch).toHaveBeenCalledWith("/api/account/delete", expect.objectContaining({
      method: "DELETE", body: JSON.stringify({ confirmation: "DELETE" }),
    }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Storage cleanup is still pending.");
    expect(button.disabled).toBe(false);
  });
});
