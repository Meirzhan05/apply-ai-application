import { expect, it } from "vitest";
import { isTrustedIdentityOrContact } from "@/lib/resume-source-semantics";

it("does not treat a credential as a trusted name, including on a contact row", () => {
  expect(isTrustedIdentityOrContact("AWS Certified Developer", true)).toBe(false);
  expect(isTrustedIdentityOrContact("AWS Certified Developer | riley@example.com", true)).toBe(false);
  expect(isTrustedIdentityOrContact("Riley Example | Registered Nurse | Six Sigma Black Belt | riley@example.com", true, "Riley Example")).toBe(false);
  expect(isTrustedIdentityOrContact("Riley Example | riley@example.com", true, "Riley Example")).toBe(true);
  expect(isTrustedIdentityOrContact("Avery Chen | Résumé", true, "Avery Chen")).toBe(true);
  expect(isTrustedIdentityOrContact("Avery Chen · Confidential", true, "Avery Chen")).toBe(true);
  expect(isTrustedIdentityOrContact("Registered Nurse", true, "Riley Example")).toBe(false);
});
