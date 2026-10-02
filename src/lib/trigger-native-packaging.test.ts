import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import type { BuildContext, BuildExtension } from "@trigger.dev/core/v3/build";
import config from "../../trigger.config";

describe("Trigger native package deployment", () => {
  it("keeps Canvas external so the Linux image can select its matching optional binary", async () => {
    const result = await build({
      stdin: {
        contents: 'import { createCanvas } from "@napi-rs/canvas"; export { createCanvas };',
        resolveDir: process.cwd(),
        sourcefile: "trigger-canvas-runtime-fixture.mjs",
      },
      bundle: true,
      platform: "node",
      target: "node24",
      write: false,
      metafile: true,
      external: config.build!.external,
    });
    const emittedImports = Object.values(result.metafile.outputs).flatMap((output) => output.imports);
    expect(emittedImports).toContainEqual(expect.objectContaining({ path: "@napi-rs/canvas", external: true }));
    expect(emittedImports.some(({ path }) => /@napi-rs\/canvas-(?:darwin|linux|win32)-/.test(path))).toBe(false);

    const lock = JSON.parse(await readFile("package-lock.json", "utf8")) as {
      packages: Record<string, { version?: string; os?: string[]; cpu?: string[]; optional?: boolean; optionalDependencies?: Record<string, string> }>;
    };
    const canvas = lock.packages["node_modules/@napi-rs/canvas"];
    const linuxX64 = lock.packages["node_modules/@napi-rs/canvas-linux-x64-gnu"];
    const darwinArm64 = lock.packages["node_modules/@napi-rs/canvas-darwin-arm64"];
    expect(canvas.optionalDependencies?.["@napi-rs/canvas-linux-x64-gnu"]).toBe("0.1.80");
    expect(linuxX64).toMatchObject({ version: "0.1.80", os: ["linux"], cpu: ["x64"], optional: true });
    expect(darwinArm64).toMatchObject({ version: "0.1.80", os: ["darwin"], cpu: ["arm64"], optional: true });
  });

  it("builds and syncs the pinned PDFBox plus Temurin runtime into the Linux worker layer", async () => {
    const extension = config.build!.extensions!.find((item) => item.name === "pinned-pdf-runtime") as BuildExtension;
    expect(extension).toBeDefined();
    const addLayer = vi.fn();
    const context = { target: "deploy", config, addLayer } as unknown as BuildContext;
    const manifest = { environment: "staging", deploy: { env: {} } } as unknown as Parameters<NonNullable<BuildExtension["onBuildComplete"]>>[1];
    await extension.onBuildComplete!(context, manifest);
    expect(addLayer).toHaveBeenCalledWith(expect.objectContaining({ id: "pdf-runtime", commands: ["node ./scripts/setup-pdf-runtime.mjs /app/pdf-runtime"],
      deploy: { env: { PDFBOX_RUNTIME_ROOT: "/app/pdf-runtime", PDFBOX_JAVA_BIN: "/app/pdf-runtime/jre/bin/java" } } }));

    const lock = JSON.parse(await readFile("runtime/pdf/pdf-runtime.lock.json", "utf8")) as { java: { version: string; jre: { sha256: string }; jdk: { sha256: string } }; pdfbox: { version: string; sha512: string } };
    expect(lock).toMatchObject({ java: { version: "21.0.12.1+1", jre: { sha256: "2413149700df0f7d440500a84a8f764c535f21e5a5e87d38328b64eec2c5b500" },
      jdk: { sha256: "ce79869e1307ed8ee1e2baa86a412b1eb5b75d10a01006d788a6f968bcfaee94" } },
      pdfbox: { version: "3.0.8", sha512: "768847238f683568507bf73570a2b6fedcbe58b25c7b4f97fba536ba110b290fe96ba065aed58629d41fb94857d76bc1978c2f31d294b553c69f287f71ee9600" } });
    const setup = await readFile("scripts/setup-pdf-runtime.mjs", "utf8");
    expect(setup).toContain('execFile(javacBin, ["--release", "21"');
    expect(setup).toContain('hash(jarBytes, "sha512") !== lock.pdfbox.sha512');
    expect(config.build!.external).toContain("@napi-rs/canvas");
  });
});
