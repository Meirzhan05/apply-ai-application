import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
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
});
