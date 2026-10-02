import { afterEach, describe, expect, it, vi } from "vitest";
import type { BuildContext, BuildExtension } from "@trigger.dev/core/v3/build";
import { build } from "esbuild";
import { existsSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import config from "../../trigger.config";
import docxRuntimeLock from "../../runtime/docx-runtime.lock.json";

const syncExtension = config.build!.extensions!.find((extension) => extension.name === "SyncEnvVarsExtension")!;
const originGuardExtension = config.build!.extensions!.find((extension) => extension.name === "production-origin-guard")!;
const aptGetExtension = config.build!.extensions!.find((extension) => extension.name === "aptGet")!;
const docxRuntimeExtension = config.build!.extensions!.find((extension) => extension.name === "pinned-docx-runtime")!;
const docxSystemPackages = docxRuntimeLock.systemPackages;

async function invokeExtension(extension: BuildExtension, environment: string, target: "deploy" | "dev" = "deploy", configForContext = config) {
  const addLayer = vi.fn();
  const warnings: unknown[][] = [];
  const context = {
    target,
    config: configForContext,
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
    expect(productionLayer.deploy.env).toMatchObject({
      APP_ORIGIN: "https://apply-ai-chi.vercel.app",
      NEXT_PUBLIC_APP_URL: "https://apply-ai-chi.vercel.app/",
      BROWSER_PROVIDER: "browser-use",
      DEMO_MODE: "false",
      SOFFICE_BIN: "/app/docx-runtime/opt/libreoffice26.8/program/soffice",
      FONTCONFIG_FILE: "/app/docx-runtime/fonts.conf",
    });
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
    expect(aptLayer.image.pkgs).toEqual(expect.arrayContaining(docxSystemPackages));
  });

  it("provides native DOCX runtime libraries to the unprivileged build stage", async () => {
    const production = await invokeExtension(docxRuntimeExtension, "production");
    const docxLayer = production.addLayer.mock.calls.find(([layer]) => layer.id === "docx-runtime")![0];
    expect(docxLayer.image.pkgs).toEqual(expect.arrayContaining(docxSystemPackages));
    expect(docxLayer.deploy.env.DOCX_RUNTIME_ROOT).toBe("/app/docx-runtime");
    expect(docxLayer.deploy.env.SOFFICE_BIN).toBe("/app/docx-runtime/opt/libreoffice26.8/program/soffice");
    expect(docxLayer.deploy.env.FONTCONFIG_FILE).toBe("/app/docx-runtime/fonts.conf");
  });

  it("loads the compiled config after relocation without copying the source lock file", async () => {
    const relocatedDirectory = await mkdtemp(path.join(os.tmpdir(), "trigger-config-relocated-"));
    try {
      await symlink(path.join(process.cwd(), "node_modules"), path.join(relocatedDirectory, "node_modules"), "dir");
      const compiledConfigPath = path.join(relocatedDirectory, "trigger.config.mjs");
      await build({
        entryPoints: [path.join(process.cwd(), "trigger.config.ts")],
        outfile: compiledConfigPath,
        absWorkingDir: process.cwd(),
        bundle: true,
        platform: "node",
        format: "esm",
        packages: "external",
        target: "node24",
      });

      expect(existsSync(path.join(relocatedDirectory, "runtime/docx-runtime.lock.json"))).toBe(false);
      const relocatedModule = await import(pathToFileURL(compiledConfigPath).href);
      const relocatedConfig = relocatedModule.default;
      const relocatedDocxExtension = relocatedConfig.build.extensions.find((extension: BuildExtension) => extension.name === "pinned-docx-runtime")!;
      const result = await invokeExtension(relocatedDocxExtension, "production", "deploy", relocatedConfig);
      const docxLayer = result.addLayer.mock.calls.find(([layer]) => layer.id === "docx-runtime")![0];

      expect(docxLayer.image.pkgs).toEqual(docxRuntimeLock.systemPackages);
      expect(docxLayer.deploy.env.SOFFICE_BIN).toBe(`/app/docx-runtime/${docxRuntimeLock.sofficeRelativePath}`);
      expect(docxLayer.deploy.env.FONTCONFIG_FILE).toBe(`/app/docx-runtime/${docxRuntimeLock.fontconfigRelativePath}`);
      expect(docxLayer.deploy.env.DOCX_RENDERER_VERSION).toBe(docxRuntimeLock.libreOfficeVersion);
    } finally {
      await rm(relocatedDirectory, { recursive: true, force: true });
    }
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
