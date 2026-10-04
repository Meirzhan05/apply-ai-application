import { expect, it } from "vitest";
import { readWorkspaceNavigation, writeWorkspaceNavigation, type WorkspaceNavigation } from "./workspace-navigation";

const store = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
};

it("restores the applicant's place without transferring it to another account", () => {
  const storage = store();
  const navigation: WorkspaceNavigation = { section: "applications", applicationId: "cedar", search: "Cedar", attentionOnly: true };
  writeWorkspaceNavigation(storage, "alice", navigation);
  expect(readWorkspaceNavigation(storage, "alice", ["cedar"])).toEqual(navigation);
  expect(readWorkspaceNavigation(storage, "bob", ["cedar"])).toBeNull();
  expect(readWorkspaceNavigation(storage, "alice", ["northstar"])?.applicationId).toBeNull();
});

it("handles removed applications, malformed values, and disabled storage", () => {
  const storage = store();
  storage.setItem("apply-ai:navigation:alice", "broken");
  expect(readWorkspaceNavigation(storage, "alice", [])).toBeNull();
  storage.setItem("apply-ai:navigation:alice", JSON.stringify({ version: 99, section: "applications" }));
  expect(readWorkspaceNavigation(storage, "alice", [])).toBeNull();
  storage.setItem("apply-ai:navigation:alice", JSON.stringify({ version: 1, section: "foreign-section" }));
  expect(readWorkspaceNavigation(storage, "alice", [])).toBeNull();
  storage.setItem("apply-ai:navigation:alice", JSON.stringify({ version: 1, section: "applications", applicationId: 3, search: "x".repeat(300), attentionOnly: "true" }));
  expect(readWorkspaceNavigation(storage, "alice", [])).toEqual({ section: "applications", applicationId: null, search: "x".repeat(200), attentionOnly: false });
  const unavailable = { getItem: () => { throw new Error("unavailable"); }, setItem: () => { throw new Error("unavailable"); } };
  expect(readWorkspaceNavigation(unavailable, "alice", [])).toBeNull();
  expect(() => writeWorkspaceNavigation(unavailable, "alice", { section: "matches", applicationId: null, search: "", attentionOnly: false })).not.toThrow();
});

it("restores the chosen application order with account-scoped navigation", () => {
  const storage = store();
  const navigation: WorkspaceNavigation = { section: "applications", applicationId: "cedar", search: "", attentionOnly: false, applicationOrder: "recent" };
  writeWorkspaceNavigation(storage, "alice", navigation);
  expect(readWorkspaceNavigation(storage, "alice", ["cedar"])).toEqual(navigation);
  expect(readWorkspaceNavigation(storage, "bob", ["cedar"])).toBeNull();
});
