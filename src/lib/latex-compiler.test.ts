import { afterEach, describe, expect, it, vi } from "vitest";
import { latexFixture } from "./latex-fixture";
import { compileLatex, fitResume } from "@/lib/latex-compiler";
import { validateResumeDocument } from "@/lib/resume-document";
afterEach(() => vi.unstubAllEnvs());
describe("bounded readable one-page fitting", () => {
  it("compacts before removing the least relevant complete claim and empty entry", async () => {
    const { profile, document } = latexFixture();
    document.experience[1].bullets[0].relevance = 1;
    const compile = vi.fn().mockResolvedValueOnce({ bytes: Buffer.from("overflow"), pages: 2 }).mockResolvedValueOnce({ bytes: Buffer.from("overflow"), pages: 2 }).mockResolvedValue({ bytes: Buffer.from("one page"), pages: 1 });
    const fitted = await fitResume(profile, document, Date.now() + 60_000, compile);
    expect(compile).toHaveBeenCalledTimes(3);
    expect(fitted.document.layout).toBe("compact");
    expect(fitted.document.experience).toHaveLength(1);
    expect(fitted.document.omitted.some((field) => field.reason === "page-length" && field.text.includes("RuboCop"))).toBe(true);
    expect(fitted.source).toContain("\\fontsize{10.5}{12}");
    expect(document.experience).toHaveLength(2);
    expect(() => validateResumeDocument(profile, fitted.document)).not.toThrow();
  });
  it("fails after at most eight compilations without clipping claims", async () => {
    const { profile, document } = latexFixture();
    const compile = vi.fn().mockResolvedValue({ bytes: Buffer.from("overflow"), pages: 2 });
    await expect(fitResume(profile, document, Date.now() + 60_000, compile)).rejects.toThrow(/one readable page/);
    expect(compile).toHaveBeenCalledTimes(8);
  });
  it("respects the shared run deadline", async () => {
    const { profile, document } = latexFixture(); const compile = vi.fn();
    await expect(fitResume(profile, document, Date.now() - 1, compile)).rejects.toThrow(/one readable page/);
    expect(compile).not.toHaveBeenCalled();
  });
  it("reports a missing compiler without exposing command output or credentials", async () => {
    vi.stubEnv("TECTONIC_BIN", "/missing/tectonic");
    await expect(compileLatex("test", Date.now() + 20_000)).rejects.toThrow(/runtime is missing/);
  });
  it("times out before starting a compiler after the shared deadline", async () => {
    await expect(compileLatex("test", Date.now() - 1)).rejects.toThrow(/timed out/);
  });
  it("does not hide compilation failures by producing the old PDF", async () => {
    const { profile, document } = latexFixture();
    await expect(fitResume(profile, document, Date.now() + 20_000, vi.fn().mockRejectedValue(new Error("No package cache")))).rejects.toThrow("No package cache");
  });
});
