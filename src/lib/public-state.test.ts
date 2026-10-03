import { describe, expect, it } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { selectApplication } from "@/lib/workflow";
import { packetProfileHash } from "@/lib/packet-profile";
import { publicState } from "@/lib/public-state";

describe("public material freshness", () => {
  function fixture() {
    const state = initialDemoState();
    const app = selectApplication(state, state.jobs[0].id, state.profile.id);
    app.packet = { schemaVersion: 1, version: 1, createdAt: new Date().toISOString(), model: "fixture", summary: "Freshness test", profileHash: packetProfileHash(state.profile), resumeLines: [], answers: [] };
    return { state, app };
  }
  it("blocks materials based on earlier verified facts without persisting a UI flag", () => {
    const { state, app } = fixture();
    expect(publicState(state).applications[0].materialsStale).toBe(false);
    state.profile.facts[0].text += " corrected";
    expect(publicState(state).applications[0].materialsStale).toBe(true);
    expect(app).not.toHaveProperty("materialsStale");
    app.packet!.profileHash = packetProfileHash(state.profile);
    expect(publicState(state).applications[0].materialsStale).toBe(false);
  });
  it("detects changes to contact data while allowing unrelated preference changes", () => {
    const { state } = fixture();
    state.profile.preferredTitles.push("Different search title");
    expect(publicState(state).applications[0].materialsStale).toBe(false);
    state.profile.phone = "555-0101";
    expect(publicState(state).applications[0].materialsStale).toBe(true);
  });
  it("allows selected applications with no packet", () => {
    const { state, app } = fixture();
    delete app.packet;
    expect(publicState(state).applications[0].materialsStale).toBe(false);
  });
});
