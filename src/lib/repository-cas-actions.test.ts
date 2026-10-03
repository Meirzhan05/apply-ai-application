import { beforeEach, expect, it, vi } from "vitest";
import { initialDemoState } from "@/lib/demo-data";
import { enrollPilot } from "@/lib/pilot";
import { selectApplication } from "@/lib/workflow";

const mocks = vi.hoisted(() => ({
  state: undefined as ReturnType<typeof initialDemoState> | undefined,
  revision: 1,
  conflicts: 0,
  writes: [] as Array<{ revision: number; data: string }>,
  user: vi.fn(),
  search: vi.fn(),
  catalog: vi.fn(),
}));

const db = {
  async rpc(name: string, args: Record<string, unknown>) {
    if (name === "acquire_account_operation" || name === "release_account_operation") return { data: true, error: null };
    if (name !== "save_account_state") throw new Error(`Unexpected RPC ${name}`);
    if (mocks.conflicts > 0) { mocks.conflicts -= 1; return { data: null, error: null }; }
    if (args.p_expected_revision !== mocks.revision) return { data: null, error: null };
    mocks.revision += 1;
    mocks.state = structuredClone(args.p_data as ReturnType<typeof initialDemoState>);
    mocks.writes.push({ revision: mocks.revision, data: JSON.stringify(mocks.state) });
    return { data: mocks.revision, error: null };
  },
  from(table: string) {
    if (table !== "app_states") throw new Error(`Unexpected table ${table}`);
    return {
      select() {
        const chain = {
          eq() { return chain; },
          async maybeSingle() { return { data: mocks.state ? { data: structuredClone(mocks.state), revision: mocks.revision } : null, error: null }; },
        };
        return chain;
      },
      update(payload: { data: ReturnType<typeof initialDemoState> }) {
        let expectedRevision: number | undefined;
        const chain = {
          eq(column: string, value: string | number) { if (column === "revision") expectedRevision = Number(value); return chain; },
          async select() {
            if (mocks.conflicts > 0) { mocks.conflicts -= 1; return { data: [], error: null }; }
            if (expectedRevision !== mocks.revision) return { data: [], error: null };
            mocks.revision += 1;
            mocks.state = structuredClone(payload.data);
            mocks.writes.push({ revision: mocks.revision, data: JSON.stringify(mocks.state) });
            return { data: [{ revision: mocks.revision }], error: null };
          },
        };
        return chain;
      },
      async insert(row: { data: ReturnType<typeof initialDemoState> }) { mocks.state = structuredClone(row.data); mocks.revision = 1; return { error: null }; },
    };
  },
  auth: { admin: { async getUserById() { return { data: { user: { email: "owner@example.com" } } }; } } },
};

vi.mock("@/lib/demo-mode", () => ({ isDemo: () => false }));
vi.mock("@/lib/personal-search", () => ({ queuePersonalSearch: mocks.search }));
vi.mock("@/lib/catalog", () => ({ readActiveCatalogRows: mocks.catalog }));
vi.mock("@/lib/supabase-admin", () => ({ adminSupabase: () => db }));
vi.mock("@/lib/supabase", () => ({ serverSupabase: async () => ({ auth: { async getUser() { return { data: { user: { id: "owner-a", email: "owner@example.com" } }, error: null }; } } }) }));

import { POST } from "@/app/api/actions/route";

function post(action: string, payload: Record<string, unknown> = {}) {
  return new Request("https://apply.example/api/actions", { method: "POST", headers: { origin: "https://apply.example", "content-type": "application/json" }, body: JSON.stringify({ action, payload }) });
}

beforeEach(() => {
  vi.stubEnv("DEMO_MODE", "false");
  mocks.catalog.mockResolvedValue([]);
  mocks.search.mockReset().mockResolvedValue(false);
  mocks.revision = 1;
  mocks.conflicts = 0;
  mocks.writes.length = 0;
  const state = initialDemoState();
  state.profile.id = "owner-a";
  state.profile.onboarding = { questionnaire: { workAuthorization: "yes", requiresSponsorship: "no" }, completedAt: new Date().toISOString() };
  enrollPilot(state, "owner-a", { consentVersion: "pilot-consent-v1", confirmed: true });
  selectApplication(state, state.jobs[1].id, "owner-a");
  mocks.state = state;
  mocks.user.mockResolvedValue("owner-a");
});

it("runs the public action through the real revision-qualified repository and retries one CAS loser", async () => {
  mocks.conflicts = 1;
  const response = await POST(post("profile", { headline: "Owner changed this" }));
  expect(response.status).toBe(200);
  expect(mocks.revision).toBe(2);
  expect(mocks.writes).toHaveLength(1);
  const saved = JSON.parse(mocks.writes[0].data) as ReturnType<typeof initialDemoState>;
  expect(saved.profile.headline).toBe("Owner changed this");
  expect(saved.applications[0].pilotAttempt?.events.at(-1)?.actor).toEqual({ kind: "owner", userId: "owner-a" });
});

it("does not persist a permanent CAS loser or create a phantom owner event", async () => {
  mocks.conflicts = 5;
  const response = await POST(post("profile", { headline: "Should not save" }));
  expect(response.status).toBe(400);
  expect(mocks.writes).toHaveLength(0);
  expect(mocks.state?.profile.headline).not.toBe("Should not save");
  expect(mocks.state?.applications[0].pilotAttempt?.events.some((event) => event.kind === "owner-action" && event.detail === "profile")).toBe(false);
});

it("applies a narrow fact correction and undo without replacing unrelated facts", async () => {
  const original = structuredClone(mocks.state!.profile.facts[0]);
  const updated = { ...original, text: "Applicant corrected this fact", verified: false, source: "user" as const, sourceAnchorId: undefined };
  const unrelated = structuredClone(mocks.state!.profile.facts.slice(1));
  expect((await POST(post("profile", { factPatch: { expected: [original], updated: [updated] } }))).status).toBe(200);
  expect(mocks.state!.profile.facts).toEqual([updated, ...unrelated]);
  expect((await POST(post("profile", { factPatch: { expected: [original], updated: [updated] } }))).status).toBe(400);
  expect(mocks.writes).toHaveLength(1);
  expect((await POST(post("profile", { factPatch: { expected: [updated], updated: [original] } }))).status).toBe(200);
  expect(mocks.state!.profile.facts).toEqual([original, ...unrelated]);
});

it("returns an idle approved attempt to materials review and rejects a started submission", async () => {
  const app = mocks.state!.applications[0]; app.status = "approved_to_submit";
  expect((await POST(post("restartBrowser", { applicationId: app.id }))).status).toBe(200);
  expect(mocks.state!.applications[0].status).toBe("draft_review");
  mocks.state!.applications[0].status = "final_review";
  mocks.state!.applications[0].submissionAttemptedAt = new Date().toISOString();
  expect((await POST(post("restartBrowser", { applicationId: app.id }))).status).toBe(400);
  expect(mocks.state!.applications[0].status).toBe("final_review");
});

it("automatically dispatches the authenticated student's search after saving explicit preferences", async () => {
  const response = await POST(post("profile", { preferredTitles: [], preferredLocations: [], remoteOnly: false, userId: "other-student", searchPreferencesConfirmedAt: "untrusted" }));
  expect(response.status).toBe(200);
  expect(mocks.state?.profile.searchPreferencesConfirmedAt).toMatch(/^\d{4}-/);
  expect(mocks.state?.profile.searchPreferencesConfirmedAt).not.toBe("untrusted");
  expect(mocks.search).toHaveBeenCalledExactlyOnceWith("owner-a");
});

it("rechecks personal search readiness when the student confirms experience or updates search settings", async () => {
  expect((await POST(post("onboarding", { facts: initialDemoState().profile.facts }))).status).toBe(200);
  expect((await POST(post("automationSettings", { preferredTitles: ["Analyst"] }))).status).toBe(200);
  expect(mocks.search).toHaveBeenCalledTimes(2);
  expect(mocks.state?.profile.searchPreferencesConfirmedAt).toBeTruthy();
});
