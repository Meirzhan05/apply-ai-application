# Apply

AI assisted job search and reviewed applications for students and early career job seekers. Users choose each job, approve a packet built from confirmed facts, inspect the filled form, and approve its exact state before submission.

## Run the controlled demo

Requires Node 22 or newer.

```bash
npm ci
cp .env.example .env
```

Set `DEMO_MODE=true` and `NEXT_PUBLIC_APP_URL=http://localhost:3000` in `.env`. Install Chromium for the pinned Playwright version with `npx playwright@1.55.1 install chromium`, or set `CHROMIUM_EXECUTABLE_PATH` to an installed Chromium executable. Then:

```bash
npm run dev
```

Open <http://localhost:3000>. The three sample employers and applicant are invented. The controlled form submits only to this app. Demo storage is `.data/demo-state.json`; delete that ignored file to reset the demo. Demo mode is disabled when `NODE_ENV=production` to avoid exposing shared demo data.

The first visual direction is [dashboard-mockup.png](docs/dashboard-mockup.png). A captured review state from the controlled browser run is [demo-form-review.png](docs/demo-form-review.png).

## What is implemented

- Next.js dashboard with matches, evidence, gaps, feedback, imported links, application status, profile intake, resume text extraction, and fact confirmation.
- Public Greenhouse, Lever, and Ashby catalog adapters, duplicate removal, closed listing detection, and a Trigger.dev schedule every four hours. Configure actual board slugs in `JOB_BOARDS`; `example` entries are ignored.
- Deterministic hard-rule checks and immediate local match scoring. Queued OpenAI Responses assessments are cached per profile version and use verified facts. Jev is a separate shadow evaluator and cannot control production ranking.
- Conservative required-location checks recognize supported aliases and leave ambiguous geography or missing required remote status uncertain. Live hard rules override stale cached matches. Match runs serialize per owner, and changed postings receive separate cost reservations.
- Selection with unlimited daily applications for now, packet drafting and editing, exact packet approval, browser fill, takeover, exact form approval, one submit attempt, confirmation or uncertain outcome, cancellation, and an audit trail of transitions.
- Versioned approval records and application packets with separate schema/revision numbers. New packet file manifests bind approved filenames, sizes, SHA-256 hashes and verified source facts; preview and upload verify the same PDF bytes.
- Trigger.dev browser fill and submit workers for production, Browser Use Cloud sessions, an embedded live browser with action history and takeover controls, local Chromium for the controlled demo, private form screenshots, and a shared monthly service budget reservation in Postgres. A watchdog marks stalled submissions uncertain without retrying them.
- Supabase magic-link sign-in, owner scoped app state, private resume and form screenshot storage, a daily digest task, and action-needed email hooks.

## Production setup

The owner-only demo is deployed at <https://apply-ai-chi.vercel.app>. Services and callback URLs are configured. Email remains restricted to the test inbox. See [integration status](docs/INTEGRATIONS.md), [acceptance checklist](docs/ACCEPTANCE.md), and the [requirement audit](docs/PLAN-AUDIT.md). Credentials use takeover; the [later vault design](docs/CREDENTIAL-VAULT.md) is inactive.

For a new deployment, configure dedicated Supabase, Browser Use Cloud, Trigger.dev, OpenAI, and Resend projects. Do not reuse unrelated projects. Apply [the SQL migration](supabase/migrations/20260929202218_initial.sql) to Supabase. Set the variables in [.env.example](.env.example) on Vercel and set `DEMO_MODE=false`. Use a strong random `INTERNAL_TASK_SECRET` in both Vercel and Trigger.dev; set `APP_ORIGIN` and `TRIGGER_PROJECT_REF` in Trigger.dev. Configure Supabase Auth redirect URLs to include `/auth/callback`. Set `BETA_ALLOWED_EMAILS` for invitation-only access. Deploy all tasks in [trigger](trigger), including polling, digest, queue dispatch, and recovery schedules.

Set `BROWSER_PROVIDER=browser-use` and the server-only `BROWSER_USE_API_KEY` on both Vercel and Trigger.dev. Sessions remain available across review for up to 30 minutes. Existing Browserbase sessions retain their original provider; setting `BROWSER_PROVIDER=browserbase` explicitly enables that adapter and requires its `keepAlive` capability. In Applications, the Agent browser panel shows the real remote page and timestamped actions. Watch mode prevents embedded input while the agent fills. When paused, choose Take control, then Refresh form state to review your edits. Open browser window provides a larger live view. The browser uses only the approved packet, pauses at unfamiliar required fields and consent controls, and blocks LinkedIn and Indeed automation. Users can import those links for tracking and handoff. Public ATS posting APIs are used for discovery only. No direct ATS submit adapter is active.

The global $500 monthly projected ceiling covers drafting, matching, and browser runs. Reconcile estimates with actual provider bills before beta. Set `EMAIL_TEST_RECIPIENT` to restrict outbound email during testing. Digest delivery is marked after provider acceptance.

## Jev shadow evaluation

Prepare 10–100 **user-labeled** profile and job pairs in JSON, each with `profile`, `job`, and `label` (`strong`, `possible`, or `uncertain`). Set `TYPESAFE_API_KEY`, then run:

```bash
npm run eval:jev -- /absolute/path/to/labeled-pairs.json
```

Label jobs in Settings and export the owner-scoped dataset from `/api/evaluation/pairs`. The output compares category accuracy and mean latency against the current matcher, and reports Jev token usage. It deliberately leaves `enableJev: false`; compare actual service costs and review errors before enabling it. Names and contact fields are excluded from Jev requests.

## Verification and remaining gates

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm audit
npm run test:browser
npm run test:live-browser
# With the non-demo app running on port 3001:
npm run test:supabase
```

The controlled flow passed both approvals, PDF upload, one submit click, and confirmation. Production cloud drafting, remote filling and live-viewer takeover, polling, and two-account isolation also passed. A protected cloud receiver verified one submit, saved confirmation proof, and duplicate-task rejection. Run `npm run test:submit` with production environment variables to repeat that synthetic test. The remote test cancels without submitting. The full plan remains incomplete: a real owner-approved application, labeled Jev evaluation, broader employer and human-takeover tests, feed rights, and invoice reconciliation remain release gates. Email stays restricted to the test inbox until the owner chooses to expand it.

Resume drafting now supports a classic one-page LaTeX layout with grounded AI rephrasing, structured sections, private immutable PDF/source files, and explicit resume rebuilding. See [LaTeX resume setup and verification](docs/LATEX-RESUMES.md).
