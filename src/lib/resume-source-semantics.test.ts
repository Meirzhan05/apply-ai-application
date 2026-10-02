import { expect, it } from "vitest";
import { isTrustedIdentityOrContact } from "@/lib/resume-source-semantics";

it("does not treat a credential as a trusted name, including on a contact row", () => {
  expect(isTrustedIdentityOrContact("AWS Certified Developer", true)).toBe(false);
  expect(isTrustedIdentityOrContact("AWS Certified Developer | riley@example.com", true)).toBe(false);
  expect(isTrustedIdentityOrContact("Riley Example | riley@example.com", true)).toBe(true);
  expect(isTrustedIdentityOrContact("Avery Chen | Résumé", true)).toBe(true);
  expect(isTrustedIdentityOrContact("Avery Chen · Confidential", true)).toBe(true);
});
