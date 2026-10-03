import { expect, it } from "vitest";
import { emptyImport, readMatchesSession, writeMatchesSession } from "./matches-session";

const store = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
};

it("restores an interrupted import and view only for the same applicant", () => {
  const storage = store();
  const session = { view: { collection: "saved" as const, filter: "strong" as const, search: "Cedar", sort: "newest" as const }, draft: { ...emptyImport, url: "https://company.example/role", company: "Example" }, importOpen: true };
  writeMatchesSession(storage, "alice", session);
  expect(readMatchesSession(storage, "alice")).toEqual(session);
  expect(readMatchesSession(storage, "bob")).toBeNull();
  writeMatchesSession(storage, "alice", { ...session, draft: emptyImport, importOpen: false });
  expect(readMatchesSession(storage, "alice")).toEqual({ ...session, draft: emptyImport, importOpen: false });
  expect(storage.getItem("apply-ai:matches:alice")).not.toContain("company.example");
});

it("ignores corrupt or unsupported storage and constrains restored values", () => {
  const storage = store();
  storage.setItem("apply-ai:matches:alice", "broken");
  expect(readMatchesSession(storage, "alice")).toBeNull();
  storage.setItem("apply-ai:matches:alice", JSON.stringify({ version: 99 }));
  expect(readMatchesSession(storage, "alice")).toBeNull();
  storage.setItem("apply-ai:matches:alice", JSON.stringify({ version: 1, view: { collection: "invalid", filter: "invalid", sort: "invalid", search: 5 }, draft: { url: "x".repeat(3000) }, importOpen: true }));
  const restored = readMatchesSession(storage, "alice");
  expect(restored?.view).toEqual({ collection: "all", filter: "all", sort: "relevant", search: "" });
  expect(restored?.draft.url).toHaveLength(2048);
  const unavailable = { getItem: () => { throw new Error("unavailable"); }, setItem: () => { throw new Error("unavailable"); } };
  expect(readMatchesSession(unavailable, "alice")).toBeNull();
  expect(() => writeMatchesSession(unavailable, "alice", { view: restored!.view, draft: emptyImport, importOpen: false })).not.toThrow();
});
