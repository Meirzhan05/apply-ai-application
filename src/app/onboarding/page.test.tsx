// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { publicState } from "@/lib/public-state";
import type { ResumeExtraction } from "@/lib/types";
import Onboarding from "./page";

const mocks = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => mocks }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a> }));
vi.mock("@/lib/supabase-browser", () => ({ browserSupabase: () => ({ auth: { signOut: vi.fn() } }) }));

type State = ReturnType<typeof publicState> & { demoMode?: boolean };
let container: HTMLDivElement;
let root: Root;

function state(status: ResumeExtraction["status"], attempts: number, error?: string): State {
  const value = initialDemoState();
  value.profile.resumeImport = undefined;
  value.profile.resumeExtraction = {
    id: "extract-1", status, attempts, filename: "resume.pdf", error,
    requestedAt: "2026-10-04T00:00:00.000Z", updatedAt: "2026-10-04T00:00:00.000Z",
  };
  if (status === "ready") value.profile.resumeDetailsVersion = 1;
  return { ...publicState(value), demoMode: true };
}

function json(value: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }));
}

async function renderWith(states: State[]) {
  const queue = [...states];
  vi.stubGlobal("fetch", vi.fn(() => json(queue.shift() ?? states.at(-1))));
  await act(async () => root.render(<Onboarding />));
  return vi.mocked(fetch);
}

async function advance(milliseconds: number) {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, milliseconds)); });
}

beforeEach(() => {
  mocks.replace.mockReset();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  window.scrollTo = vi.fn();
});

afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  vi.unstubAllGlobals();
});

describe("resume extraction polling", () => {
  it("keeps polling through the SDK's first failed attempt until its retry becomes ready", async () => {
    const fetchMock = await renderWith([
      state("queued", 0),
      state("failed", 1, "First worker attempt failed."),
      state("extracting", 2),
      state("ready", 2),
    ]);

    await advance(1000);
    const retry = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Retry extraction"));
    expect(retry).toBeTruthy(); expect(retry!.disabled).toBe(false);
    await advance(2000);
    expect(container.textContent).toContain("Reading and checking your resume");
    expect(container.textContent).not.toContain("First worker attempt failed.");
    await advance(2000);
    expect(container.querySelector("#profile-heading")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  }, 10_000);

  it("resumes polling after a reload captured the first failed attempt", async () => {
    const fetchMock = await renderWith([
      state("failed", 1, "First worker attempt failed."),
      state("ready", 2),
    ]);

    expect(container.textContent).toContain("Retry extraction");
    await advance(1000);
    expect(container.querySelector("#profile-heading")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [0, "Resume extraction couldn't start."],
    [2, "Resume extraction failed twice."],
  ])("stops polling at terminal failed attempt %i and leaves manual retry enabled", async (attempts, message) => {
    const fetchMock = await renderWith([state("failed", attempts, message)]);
    await advance(1100);
    const retry = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Retry extraction"));
    expect(container.textContent).toContain(message);
    expect(retry).toBeTruthy(); expect(retry!.disabled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
