import { describe, expect, it } from "vitest";
import { hashJson } from "@/lib/crypto";
import { initialDemoState } from "@/lib/demo-data";
import { packetProfileHash } from "@/lib/drafting";

function jsonbRoundTrip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonbRoundTrip);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, jsonbRoundTrip(child)]));
  return value;
}
describe("approval hashes across JSON storage", () => {
  it("ignores object key order but binds array order and field values", () => {
    const value = { packet: { answers: [{ question: "Role", answer: "Confirmed fact", factIds: ["a", "b"] }] }, userId: "owner" };
    expect(hashJson(jsonbRoundTrip(value))).toBe(hashJson(value));
    expect(hashJson({ ...value, userId: "other" })).not.toBe(hashJson(value));
    expect(hashJson(["a", "b"])).not.toBe(hashJson(["b", "a"]));
  });
  it("keeps the profile fingerprint after JSONB reorders nested fact keys", () => {
    const profile = initialDemoState().profile;
    expect(packetProfileHash(jsonbRoundTrip(profile) as typeof profile)).toBe(packetProfileHash(profile));
  });
});
