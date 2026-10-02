import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import type { BuildContext, BuildExtension } from "@trigger.dev/core/v3/build";
import config from "../../trigger.config";
import docxRuntimeLock from "../../runtime/docx-runtime.lock.json";
import pdfRuntimeLock from "../../runtime/pdf/pdf-runtime.lock.json";
import { createPdfSourceFixture } from "@/lib/fixtures/pdf-source";

function commandExists(command: string) {
  if (command.includes(path.sep)) return existsSync(command);
  return (process.env.PATH ?? "").split(path.delimiter).some((directory) => existsSync(path.join(directory, command)));
}

const pdfRuntimeRoot = process.env.PDFBOX_TEST_RUNTIME_ROOT ?? process.env.PDFBOX_RUNTIME_ROOT;
const installerJarPath = process.env.PDFBOX_JAR_PATH ?? (pdfRuntimeRoot ? path.join(pdfRuntimeRoot, pdfRuntimeLock.pdfbox.file) : undefined);
const installerJava = process.env.PDFBOX_JAVA_BIN ?? (pdfRuntimeRoot ? path.join(pdfRuntimeRoot, "jre", "bin", "java") : "java");
const installerJavac = process.env.PDFBOX_JAVAC_BIN ?? "javac";
const installerJarTool = process.env.PDFBOX_JAR_TOOL ?? "jar";
const installerToolsAvailable = Boolean(installerJarPath && existsSync(installerJarPath) && commandExists(installerJava)
  && commandExists(installerJavac) && commandExists(installerJarTool));

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
  }, 30_000);

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

  it("copies the explicit cached DOCX archive into the task build and passes it to the runtime installer", async () => {
    const archivePath = "./.data/docx-runtime-cache/LibreOffice_26.8.0_Linux_x86-64_deb.tar.gz";
    expect(path.basename(archivePath)).toBe(path.basename(new URL(docxRuntimeLock.archiveUrl).pathname));
    const archiveBytes = Buffer.from("synthetic cached runtime archive");
    const directory = await mkdtemp(path.join(os.tmpdir(), "apply-trigger-docx-cache-"));
    const sourceRoot = path.join(directory, "source");
    const outputPath = path.join(directory, "build");
    const sourceArchive = path.join(sourceRoot, archivePath);
    await mkdir(path.dirname(sourceArchive), { recursive: true });
    await writeFile(path.join(sourceRoot, ".gitignore"), ".data/\n");
    await writeFile(sourceArchive, archiveBytes);

    try {
      vi.stubEnv("TRIGGER_DOCX_RUNTIME_USE_CACHED_ARCHIVE", "1");
      vi.resetModules();
      const cachedConfig = (await import("../../trigger.config")).default;
      const extensions = cachedConfig.build!.extensions!;
      const additionalFiles = extensions.find((item) => item.name === "additionalFiles") as BuildExtension;
      const docxRuntime = extensions.find((item) => item.name === "pinned-docx-runtime") as BuildExtension;
      const logger = { debug: vi.fn(), warn: vi.fn() };
      const copyContext = { target: "deploy", config: cachedConfig, workingDir: sourceRoot, logger } as unknown as BuildContext;
      const manifest = { outputPath, target: "deploy" } as unknown as Parameters<NonNullable<BuildExtension["onBuildComplete"]>>[1];

      await additionalFiles.onBuildComplete!(copyContext, manifest);

      expect(await readFile(path.join(outputPath, archivePath))).toEqual(archiveBytes);
      expect(await readdir(path.join(outputPath, ".data", "docx-runtime-cache"))).toEqual([path.basename(archivePath)]);

      const addLayer = vi.fn();
      const layerContext = { target: "deploy", config: cachedConfig, addLayer } as unknown as BuildContext;
      await docxRuntime.onBuildComplete!(layerContext, { environment: "staging" } as Parameters<NonNullable<BuildExtension["onBuildComplete"]>>[1]);
      expect(addLayer).toHaveBeenCalledWith(expect.objectContaining({
        id: "docx-runtime",
        commands: [`DOCX_RUNTIME_ARCHIVE_PATH=${archivePath.slice(2)} node ./scripts/setup-docx-runtime.mjs /app/docx-runtime`],
      }));
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the normal DOCX runtime install on its online archive path by default", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apply-trigger-docx-online-"));
    const outputPath = path.join(directory, "build");

    try {
      vi.stubEnv("TRIGGER_DOCX_RUNTIME_USE_CACHED_ARCHIVE", "0");
      vi.resetModules();
      const defaultConfig = (await import("../../trigger.config")).default;
      const extensions = defaultConfig.build!.extensions!;
      const additionalFiles = extensions.find((item) => item.name === "additionalFiles") as BuildExtension;
      const docxRuntime = extensions.find((item) => item.name === "pinned-docx-runtime") as BuildExtension;
      const logger = { debug: vi.fn(), warn: vi.fn() };
      const copyContext = { target: "deploy", config: defaultConfig, workingDir: directory, logger } as unknown as BuildContext;
      const manifest = { outputPath, target: "deploy" } as unknown as Parameters<NonNullable<BuildExtension["onBuildComplete"]>>[1];
      await additionalFiles.onBuildComplete!(copyContext, manifest);
      await expect(readdir(path.join(outputPath, ".data"))).rejects.toMatchObject({ code: "ENOENT" });

      const addLayer = vi.fn();
      const layerContext = { target: "deploy", config: defaultConfig, addLayer } as unknown as BuildContext;
      await docxRuntime.onBuildComplete!(layerContext, { environment: "staging" } as Parameters<NonNullable<BuildExtension["onBuildComplete"]>>[1]);
      expect(addLayer).toHaveBeenCalledWith(expect.objectContaining({
        id: "docx-runtime",
        commands: ["node ./scripts/setup-docx-runtime.mjs /app/docx-runtime"],
      }));
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
      await rm(directory, { recursive: true, force: true });
    }
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
    expect(config.build!.external).toContain("@napi-rs/canvas");
  });

  it.skipIf(!installerToolsAvailable)("rejects a corrupted PDFBox jar before creating installer output", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apply-pdf-installer-checksum-"));
    const corruptedJar = path.join(directory, "corrupted.jar");
    const target = path.join(directory, "runtime");
    try {
      const bytes = await readFile(installerJarPath!);
      bytes[bytes.length - 1] ^= 1;
      await writeFile(corruptedJar, bytes);

      let failure: unknown;
      try {
        execFileSync(process.execPath, ["scripts/setup-pdf-runtime.mjs", target, "--local"], {
          cwd: process.cwd(), encoding: "utf8", timeout: 120_000,
          env: { ...process.env, PDFBOX_JAR_PATH: corruptedJar, PDFBOX_JAVA_BIN: installerJava, PDFBOX_JAVAC_BIN: installerJavac, PDFBOX_JAR_TOOL: installerJarTool },
        });
      } catch (error) { failure = error; }

      expect(failure).toMatchObject({ status: 1, stderr: expect.stringMatching(/pinned PDFBox jar checksum mismatch/i) });
      expect(await readdir(target)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);

  it.skipIf(!installerToolsAvailable)("compiles the pinned helper and runs it with the supplied Java runtime", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "apply-pdf-installer-output-"));
    const target = path.join(directory, "runtime");
    try {
      const stdout = execFileSync(process.execPath, ["scripts/setup-pdf-runtime.mjs", target, "--local"], {
        cwd: process.cwd(), encoding: "utf8", timeout: 120_000,
        env: { ...process.env, PDFBOX_JAR_PATH: installerJarPath!, PDFBOX_JAVA_BIN: installerJava, PDFBOX_JAVAC_BIN: installerJavac, PDFBOX_JAR_TOOL: installerJarTool },
      });
      const install = JSON.parse(stdout) as { java: string; jarSha512: string; local: boolean };
      const manifest = JSON.parse(await readFile(path.join(target, "runtime-manifest.json"), "utf8")) as { version: number; java: string; pdfbox: string; architecture: string };
      const classPath = path.join(target, "classes", "PdfSourceRewrite.class");
      const jarPath = path.join(target, pdfRuntimeLock.pdfbox.file);
      const classPathArg = path.join(target, "classes") + path.delimiter + jarPath;
      const version = execFileSync(installerJava, ["-cp", classPathArg, "PdfSourceRewrite", "--version"], { encoding: "utf8", timeout: 30_000 });

      expect(install).toMatchObject({ java: expect.stringContaining("pdfbox=" + pdfRuntimeLock.pdfbox.version), jarSha512: pdfRuntimeLock.pdfbox.sha512, local: true });
      expect(manifest).toMatchObject({ version: 1, java: pdfRuntimeLock.java.version, pdfbox: pdfRuntimeLock.pdfbox.version, architecture: process.platform + "-" + process.arch });
      expect((await readFile(classPath)).byteLength).toBeGreaterThan(0);
      expect(version).toContain("pdfbox=" + pdfRuntimeLock.pdfbox.version + "\tjava=" + pdfRuntimeLock.java.version);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
