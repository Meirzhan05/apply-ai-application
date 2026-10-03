// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Login from "./page";

const auth = vi.hoisted(() => ({ signInWithPassword: vi.fn(), signUp: vi.fn(), signInWithOtp: vi.fn() }));
const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/supabase-browser", () => ({ browserSupabase: () => ({ auth }) }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.resetAllMocks();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Login />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function fill(name: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  await act(async () => input.dispatchEvent(new Event("input", { bubbles: true })));
}
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent === text)!;
  await act(async () => button.click());
}
async function submit() {
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}

describe("email and password login", () => {
  it("signs in with the password unchanged and navigates only after a session exists", async () => {
    auth.signInWithPassword.mockResolvedValue({ data: { session: { access_token: "fixture" } }, error: null });
    await fill("email", "person@example.com");
    await fill("password", " secret password ");
    await submit();
    expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: "person@example.com", password: " secret password " });
    expect(auth.signUp).not.toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledWith("/");
    expect(router.refresh).toHaveBeenCalledOnce();
  });

  it("creates an account and enters immediately when email confirmation is disabled", async () => {
    auth.signUp.mockResolvedValue({ data: { session: { access_token: "fixture" } }, error: null });
    await click("Create an account");
    await fill("email", "person@example.com");
    await fill("password", "secret password");
    await submit();
    expect(auth.signUp).toHaveBeenCalledWith({ email: "person@example.com", password: "secret password", options: { emailRedirectTo: `${window.location.origin}/auth/callback` } });
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledWith("/");
  });

  it("does not claim the user is signed in if Supabase still requires confirmation", async () => {
    auth.signUp.mockResolvedValue({ data: { session: null }, error: null });
    await click("Create an account");
    await fill("email", "person@example.com");
    await fill("password", "secret password");
    await submit();
    expect(router.replace).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Check your email to confirm");
  });

  it.each([
    [504, "HTTP 504", "temporarily unavailable"],
    [429, "Too many requests", "wait a minute"],
    [400, "Invalid login credentials", "email or password is incorrect"],
  ])("makes authentication error %s actionable without navigating", async (status, message, expected) => {
    auth.signInWithPassword.mockResolvedValue({ data: { session: null }, error: Object.assign(new Error(message), { status }) });
    await fill("email", "person@example.com");
    await fill("password", "secret password");
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(expected);
    expect(router.replace).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  });

  it("lets existing magic-link users sign in without a password or creating an account", async () => {
    auth.signInWithOtp.mockResolvedValue({ error: null });
    await fill("email", "person@example.com");
    await click("Email me a sign-in link instead");
    expect(auth.signInWithOtp).toHaveBeenCalledWith({ email: "person@example.com", options: { shouldCreateUser: false, emailRedirectTo: `${window.location.origin}/auth/callback` } });
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Check your email for a sign-in link");
  });

  it("prevents duplicate submissions and mode changes while signing in", async () => {
    let complete!: (value: unknown) => void;
    auth.signInWithPassword.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    await fill("email", "person@example.com");
    await fill("password", "secret password");
    await submit();
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    expect(container.textContent).toContain("Signing in…");
    await submit();
    await click("Create an account");
    expect(auth.signInWithPassword).toHaveBeenCalledOnce();
    expect(container.querySelector("h1")?.textContent).toBe("Welcome back");
    await act(async () => complete({ data: { session: null }, error: new Error("HTTP 504") }));
  });
});
