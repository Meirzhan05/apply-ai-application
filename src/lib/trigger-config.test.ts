import { afterEach, describe, expect, it, vi } from "vitest";
import type { BuildContext, BuildExtension } from "@trigger.dev/core/v3/build";
import config from "../../trigger.config";

const syncExtension = config.build!.extensions!.find((extension) => extension.name === "SyncEnvVarsExtension")!;
const originGuardExtension = config.build!.extensions!.find((extension) => extension.name === "production-origin-guard")!;
const aptGetExtension = config.build!.extensions!.find((extension) => extension.name === "aptGet")!;

async function invokeExtension(extension: BuildExtension, environment: string, target: "deploy" | "dev" = "deploy") {
  const addLayer = vi.fn();
  const warnings: unknown[][] = [];
  const context = {
    target,
    config,
    addLayer,
    logger: {
      spinner: () => ({ stop: vi.fn() }),
      warn: (...args: unknown[]) => warnings.push(args),
      debug: vi.fn(),
    },
  } as unknown as BuildContext;
  const manifest = { environment, deploy: { env: {} } } as unknown as Parameters<NonNullable<BuildExtension["onBuildComplete"]>>[1];
  await extension.onBuildComplete!(context, manifest);
  return { addLayer, warnings };
}

const invokeSync = (environment: string, target?: "deploy" | "dev") => invokeExtension(syncExtension, environment, target);
const invokeOriginGuard = (environment: string, target?: "deploy" | "dev") => invokeExtension(originGuardExtension, environment, target);

afterEach(() => vi.unstubAllEnvs());

describe("production environment sync guard", () => {
  it("rejects the Trigger production manifest value before syncEnvVars can swallow the error", async () => {
    vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");

    await expect(invokeOriginGuard("prod")).rejects.toThrow("set APP_ORIGIN and NEXT_PUBLIC_APP_URL to matching HTTPS production origins");
  });

  it("accepts the production manifest value and leaves development unguarded", async () => {
    vi.stubEnv("APP_ORIGIN", "https://apply-ai-chi.vercel.app");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://apply-ai-chi.vercel.app/");
    await expect(invokeOriginGuard("prod")).resolves.toBeDefined();

    vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
    await expect(invokeOriginGuard("dev")).resolves.toBeDefined();
  });

  it("syncs canonical production origins and keeps development loopback allowed", async () => {
    vi.stubEnv("APP_ORIGIN", "https://apply-ai-chi.vercel.app");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://apply-ai-chi.vercel.app/");
    vi.stubEnv("BROWSER_PROVIDER", "browser-use");
    const production = await invokeSync("production");
    const productionLayer = production.addLayer.mock.calls.find(([layer]) => layer.id === "sync-env-vars")![0];
    expect(productionLayer.deploy.env).toMatchObject({ APP_ORIGIN: "https://apply-ai-chi.vercel.app", NEXT_PUBLIC_APP_URL: "https://apply-ai-chi.vercel.app/", BROWSER_PROVIDER: "browser-use", DEMO_MODE: "false", SOFFICE_BIN: "/opt/libreoffice26.8/program/soffice" });
    expect(productionLayer.deploy.override).toBe(true);
    expect(production.warnings).toHaveLength(0);

    vi.stubEnv("APP_ORIGIN", "http://localhost:3000");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
    const development = await invokeSync("development");
    expect(development.addLayer.mock.calls.some(([layer]) => layer.id === "sync-env-vars")).toBe(true);
    expect(development.warnings).toHaveLength(0);
  });

  it("installs LibreOffice's runtime libraries into the deployed image layer", async () => {
    const production = await invokeExtension(aptGetExtension, "production");
    const aptLayer = production.addLayer.mock.calls.find(([layer]) => layer.id === "apt-get")![0];
    expect(aptLayer.image.pkgs).toEqual(expect.arrayContaining([
      "fontconfig",
      "libxinerama1",
      "libx11-6",
      "libssl3",
      "libnss3",
      "libdbus-1-3",
      "libcairo2",
      "libglib2.0-0",
      "libxext6",
      "libcups2",
      "libgssapi-krb5-2",
      "libx11-xcb1",
    ]));
  });

  it.each([
    ["missing APP_ORIGIN", "", "https://apply-ai-chi.vercel.app"],
    ["missing NEXT_PUBLIC_APP_URL", "https://apply-ai-chi.vercel.app", ""],
    ["non-HTTPS", "http://apply-ai-chi.vercel.app", "http://apply-ai-chi.vercel.app"],
    ["loopback", "https://127.0.0.1:3000", "https://127.0.0.1:3000"],
    ["mismatched", "https://apply-ai-chi.vercel.app", "https://other.example"],
  ])("rejects production origins: %s", async (_label, appOrigin, publicAppUrl) => {
    vi.stubEnv("APP_ORIGIN", appOrigin);
    vi.stubEnv("NEXT_PUBLIC_APP_URL", publicAppUrl);
    const result = await invokeSync("production");
    expect(result.addLayer.mock.calls.some(([layer]) => layer.id === "sync-env-vars")).toBe(false);
    expect(result.warnings[0]?.[1]).toMatchObject({ message: expect.stringContaining("set APP_ORIGIN and NEXT_PUBLIC_APP_URL to matching HTTPS production origins") });
  });
});
