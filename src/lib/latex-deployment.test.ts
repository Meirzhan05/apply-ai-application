import { afterEach, expect, it, vi } from "vitest";
import type { BuildContext, BuildExtension } from "@trigger.dev/core/v3/build";
import config from "../../trigger.config";

afterEach(() => vi.unstubAllEnvs());

it("syncs installed compiler paths over stale production settings", async () => {
  vi.stubEnv("TECTONIC_BIN", "/opt/apply-latex/tectonic");
  vi.stubEnv("TECTONIC_CACHE_DIR", "/opt/apply-latex/cache");
  vi.stubEnv("APP_ORIGIN", "https://apply-ai-chi.vercel.app");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://apply-ai-chi.vercel.app/");
  const addLayer = vi.fn();
  const context = {
    target: "deploy", config,
    addLayer,
    logger: { spinner: () => ({ stop: vi.fn() }), warn: vi.fn() },
  } as unknown as BuildContext;
  const manifest = {
    environment: "prod",
    deploy: { env: { TECTONIC_BIN: "/opt/apply-latex/tectonic", TECTONIC_CACHE_DIR: "/opt/apply-latex/cache" } },
  } as unknown as Parameters<NonNullable<BuildExtension["onBuildComplete"]>>[1];
  for (const name of ["pinned-latex-runtime", "SyncEnvVarsExtension"]) {
    const extension = config.build!.extensions!.find((item) => item.name === name)!;
    await extension.onBuildComplete!(context, manifest);
  }
  const installation = addLayer.mock.calls.find(([layer]) => layer.id === "latex-runtime")![0];
  const synced = addLayer.mock.calls.find(([layer]) => layer.id === "sync-env-vars")![0];
  expect(synced.deploy.override).toBe(true);
  expect(synced.deploy.env).toMatchObject({
    TECTONIC_BIN: "/app/latex-runtime/tectonic",
    TECTONIC_CACHE_DIR: "/app/latex-runtime/cache",
  });
  expect(installation.commands).toContain("node ./scripts/setup-latex.mjs /app/latex-runtime");
  expect(installation.deploy.env).toMatchObject({
    TECTONIC_BIN: synced.deploy.env.TECTONIC_BIN,
    TECTONIC_CACHE_DIR: synced.deploy.env.TECTONIC_CACHE_DIR,
  });
});
