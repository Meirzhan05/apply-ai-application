import { expect, it } from "vitest";
import { readFactCorrectionHistory, writeFactCorrectionHistory, type FactCorrectionHistory } from "./fact-correction-history";
const before = { id: "education", text: "May 2027", verified: true, source: "user" as const };
const after = { ...before, text: "June 2027", verified: false };
const history: FactCorrectionHistory = { owner: "alice", applicationId: "cedar", before: [before], after: [after] };
const store = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
};
it("restores across reloads only for the same account and unchanged corrected facts", () => {
  const storage = store(); writeFactCorrectionHistory(storage, "alice", history);
  expect(readFactCorrectionHistory(storage, "alice", ["cedar"], [after, { ...before, id: "unrelated" }])).toEqual(history);
  expect(readFactCorrectionHistory(storage, "bob", ["cedar"], [after])).toBeNull();
  expect(readFactCorrectionHistory(storage, "alice", [], [after])).toBeNull();
  expect(readFactCorrectionHistory(storage, "alice", ["cedar"], [before])).toBeNull();
  writeFactCorrectionHistory(storage, "alice", null);
  expect(readFactCorrectionHistory(storage, "alice", ["cedar"], [after])).toBeNull();
});
it("rejects malformed history and gracefully handles disabled storage", () => {
  const storage = store();
  for (const value of ["broken", JSON.stringify({ ...history, version: 1, before: [{}] }), JSON.stringify({ ...history, version: 1, before: [before, before], after: [after, after] })]) {
    storage.setItem("apply-ai:fact-correction:alice", value);
    expect(readFactCorrectionHistory(storage, "alice", ["cedar"], [after])).toBeNull();
  }
  const unavailable = { getItem: () => { throw Error("disabled"); }, setItem: () => { throw Error("disabled"); } };
  expect(readFactCorrectionHistory(unavailable, "alice", ["cedar"], [after])).toBeNull();
  expect(() => writeFactCorrectionHistory(unavailable, "alice", history)).not.toThrow();
});
