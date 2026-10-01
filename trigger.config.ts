import { defineConfig } from "@trigger.dev/sdk";
import { additionalFiles, syncEnvVars } from "@trigger.dev/build/extensions/core";

// Keep image installation and persisted worker settings together. Existing
// project env vars otherwise override the paths declared by the image layer.
const latexRoot = "/app/latex-runtime";
const latexEnv = { TECTONIC_BIN: `${latexRoot}/tectonic`, TECTONIC_CACHE_DIR: `${latexRoot}/cache` };

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF || "configure-project-ref",
  dirs: ["./trigger"],
  machine: "small-1x",
  runtime: "node-24",
  maxDuration: 300,
  build: {
    external: ["playwright-core"],
    extensions: [
      additionalFiles({ files: ["./src/assets/fonts/*", "./scripts/setup-latex.mjs"] }),
      {
        name: "pinned-latex-runtime",
        onBuildComplete(context) {
          if (context.target === "dev") return;
          context.addLayer({ id: "latex-runtime", commands: [`node ./scripts/setup-latex.mjs ${latexRoot}`],
            deploy: { env: latexEnv } });
        },
      },
      syncEnvVars(() => ["APP_ORIGIN", "NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY", "OPENAI_API_KEY", "BROWSER_PROVIDER", "BROWSER_USE_API_KEY", "BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "INTERNAL_TASK_SECRET", "RESEND_API_KEY", "EMAIL_FROM", "EMAIL_TEST_RECIPIENT", "JOB_BOARDS", "MONTHLY_SPEND_LIMIT_USD", "PROJECTED_BROWSER_RUN_USD", "PROJECTED_DRAFT_USD"].flatMap((name) => process.env[name] ? [{ name, value: process.env[name]!, isSecret: /KEY|SECRET/.test(name) }] : []).concat([
        { name: "DEMO_MODE", value: "false", isSecret: false },
        ...Object.entries(latexEnv).map(([name, value]) => ({ name, value, isSecret: false })),
      ]), { override: true }),
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
