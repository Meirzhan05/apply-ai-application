import { defineConfig } from "@trigger.dev/sdk";
import { additionalFiles, aptGet, syncEnvVars } from "@trigger.dev/build/extensions/core";

// Keep image installation and persisted worker settings together. Existing
// project env vars otherwise override the paths declared by the image layer.
const latexRoot = "/app/latex-runtime";
const latexEnv = { TECTONIC_BIN: `${latexRoot}/tectonic`, TECTONIC_CACHE_DIR: `${latexRoot}/cache` };
const docxRoot = "/app/docx-runtime";
const docxEnv = { SOFFICE_BIN: "/usr/bin/soffice", DOCX_RUNTIME_ROOT: docxRoot, DOCX_RENDERER_VERSION: "26.8.0.3" };
const syncedEnvironmentNames = ["APP_ORIGIN", "NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY", "OPENAI_API_KEY", "BROWSER_PROVIDER", "BROWSER_USE_API_KEY", "BROWSER_USE_SOLVE_CAPTCHAS", "BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "INTERNAL_TASK_SECRET", "RESEND_API_KEY", "EMAIL_FROM", "EMAIL_TEST_RECIPIENT", "JOB_BOARDS", "MONTHLY_SPEND_LIMIT_USD", "PROJECTED_BROWSER_RUN_USD", "PROJECTED_DRAFT_USD"];
const productionOriginError = "Refusing production environment sync: set APP_ORIGIN and NEXT_PUBLIC_APP_URL to matching HTTPS production origins.";

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function isProductionEnvironment(environment: string): boolean {
  const normalized = environment.trim().toLowerCase();
  return normalized === "prod" || normalized === "production";
}

function assertProductionOrigins(): void {
  const values = [process.env.APP_ORIGIN?.trim(), process.env.NEXT_PUBLIC_APP_URL?.trim()];
  if (!values[0] || !values[1]) throw new Error(productionOriginError);
  let origins: URL[];
  try {
    origins = values.map((value) => new URL(value!));
  } catch {
    throw new Error(productionOriginError);
  }
  if (origins.some((origin) => origin.protocol !== "https:" || isLoopback(origin.hostname)) || origins[0].origin !== origins[1].origin)
    throw new Error(productionOriginError);
}

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF || "configure-project-ref",
  dirs: ["./trigger"],
  machine: "small-1x",
  runtime: "node-24",
  maxDuration: 300,
  build: {
    external: ["playwright-core"],
    extensions: [
      additionalFiles({ files: ["./src/assets/fonts/*", "./scripts/setup-latex.mjs", "./scripts/setup-docx-runtime.mjs", "./runtime/docx-runtime.lock.json"] }),
      aptGet({ packages: ["fontconfig"] }),
      {
        name: "pinned-latex-runtime",
        onBuildComplete(context) {
          if (context.target === "dev") return;
          context.addLayer({ id: "latex-runtime", commands: [`node ./scripts/setup-latex.mjs ${latexRoot}`],
            deploy: { env: latexEnv } });
        },
      },
      {
        name: "pinned-docx-runtime",
        onBuildComplete(context) {
          if (context.target === "dev") return;
          context.addLayer({ id: "docx-runtime", commands: [`node ./scripts/setup-docx-runtime.mjs ${docxRoot}`], deploy: { env: docxEnv } });
        },
      },
      {
        name: "production-origin-guard",
        onBuildComplete(context, manifest) {
          if (context.target === "dev") return;
          if (isProductionEnvironment(manifest.environment)) assertProductionOrigins();
        },
      },
      syncEnvVars(({ environment }) => {
        if (isProductionEnvironment(environment)) assertProductionOrigins();
        return syncedEnvironmentNames.flatMap((name) => process.env[name] ? [{ name, value: process.env[name]!, isSecret: /KEY|SECRET/.test(name) }] : []).concat([
        { name: "DEMO_MODE", value: "false", isSecret: false },
        ...Object.entries(latexEnv).map(([name, value]) => ({ name, value, isSecret: false })),
        ...Object.entries(docxEnv).map(([name, value]) => ({ name, value, isSecret: false })),
        ]);
      }, { override: true }),
    ],
  },
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 2,
      factor: 2,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      randomize: true,
    },
  },
});
