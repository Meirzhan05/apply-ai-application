import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import type { BuildContext, BuildExtension } from "@trigger.dev/core/v3/build";
import config from "../../trigger.config";
import docxRuntimeLock from "../../runtime/docx-runtime.lock.json";
import { createPdfSourceFixture } from "@/lib/fixtures/pdf-source";

describe("Trigger native package deployment", () => {
  it("parses a PDF from the task bundle with the worker copied into the build directory", async () => {
    const outputPath = await mkdtemp(path.join(os.tmpdir(), "apply-pdfjs-build-"));
    const inputPath = path.join(outputPath, "resume.pdf");
    const bundlePath = path.join(outputPath, "pdf-source.bundle.mjs");
    try {
      const additionalFiles = config.build!.extensions!.find((item) => item.name === "additionalFiles") as BuildExtension;
      const context = {
        target: "deploy",
        config,
        workingDir: process.cwd(),
        logger: { debug: vi.fn(), warn: vi.fn() },
      } as unknown as BuildContext;
      const manifest = { outputPath, target: "deploy" } as unknown as Parameters<NonNullable<BuildExtension["onBuildComplete"]>>[1];
      await additionalFiles.onBuildComplete!(context, manifest);

      await build({
        entryPoints: ["src/lib/pdf-source.ts"],
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node24",
        alias: { "@": path.resolve("src") },
        external: config.build!.external,
        outfile: bundlePath,
      });
      await mkdir(path.join(outputPath, "node_modules", "@napi-rs"), { recursive: true });
      await symlink(path.resolve("node_modules/@napi-rs/canvas"), path.join(outputPath, "node_modules/@napi-rs/canvas"));
      await writeFile(inputPath, await createPdfSourceFixture());
      const script = `
        import { readFile } from "node:fs/promises";
        const { parsePdfSource } = await import(${JSON.stringify(bundlePath)});
        const result = await parsePdfSource(await readFile(${JSON.stringify(inputPath)}));
        console.log(JSON.stringify({ status: result.support.status, pages: result.layout.pageCount, text: result.text }));
      `;
      const run = (workerPath: string) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
        cwd: outputPath,
        env: { ...process.env, PDFJS_WORKER_PATH: workerPath },
      }));
      const bundledWorker = path.join(outputPath, "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs");
      const triggerRuntime = run(bundledWorker);
      const webRuntime = run("");
      const expected = { status: "candidate", pages: 1, text: expect.stringContaining("Built a search index for 1,200 users.") };
      expect(triggerRuntime).toMatchObject(expected);
      expect(webRuntime).toMatchObject(expected);
    } finally {
      await rm(outputPath, { recursive: true, force: true });
    }
  });

  it("sets the task worker path to the file preserved by additionalFiles", async () => {
    const syncEnvironment = config.build!.extensions!.find((item) => item.name === "SyncEnvVarsExtension") as BuildExtension;
    const addLayer = vi.fn();
    const context = {
      target: "deploy",
      config,
      workingDir: process.cwd(),
      logger: { debug: vi.fn(), warn: vi.fn(), spinner: () => ({ stop: vi.fn(), message: vi.fn() }) },
      addLayer,
    } as unknown as BuildContext;
    const manifest = { environment: "staging", deploy: { env: {} } } as unknown as Parameters<NonNullable<BuildExtension["onBuildComplete"]>>[1];
    await syncEnvironment.onBuildComplete!(context, manifest);
    expect(addLayer).toHaveBeenCalledWith(expect.objectContaining({
      deploy: expect.objectContaining({ env: expect.objectContaining({ PDFJS_WORKER_PATH: "/app/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs" }) }),
    }));
  });

  it("pins LibreOffice's English UI resources for headless conversion", () => {
    const series = docxRuntimeLock.libreOfficeVersion.split(".").slice(0, 2).join(".");
    expect(docxRuntimeLock.libreOfficePackageNames).toContain(`libobasis${series}-en-us`);
  });

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
