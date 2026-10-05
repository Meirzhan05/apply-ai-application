# Apply

Apply helps students and early-career job seekers find relevant roles, prepare factual application materials, and complete employer forms. It combines private job discovery with a reviewed application workflow and optional automatic applications under the applicant’s saved permission.

**Production:** [apply-ai-chi.vercel.app](https://apply-ai-chi.vercel.app) · **Stack:** Next.js 16, React 19, TypeScript, Supabase, Trigger.dev

The app is under active development. Controlled tests establish workflow behavior; they do not establish real employer acceptance or matching quality. See [release gates](#release-gates) before expanding the rollout.

## Contents

- [Local demo](#local-demo)
- [How it works](#how-it-works)
- [Project structure](#project-structure)
- [Configuration](#configuration)
- [Production deployment](#production-deployment)
- [Development and verification](#development-and-verification)
- [Release gates](#release-gates)
- [Documentation](#documentation)

## Local demo

Requires **Node.js 22 or newer** and npm. The controlled demo works without service credentials.

```bash
npm ci
cp .env.example .env
npx playwright@1.55.1 install chromium
npm run dev
```

If you already have a `.env`, preserve it instead of copying over it. For the demo, set:

```dotenv
DEMO_MODE=true
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

Open [localhost:3000](http://localhost:3000). The sample applicant and three employers are invented, and the controlled form submits only to this app. Playwright needs Chromium for browser filling and browser tests; alternatively, set `CHROMIUM_EXECUTABLE_PATH` to an installed Chromium executable.

Demo state is saved in the ignored `.data/demo-state.json`. Delete that file to reset it. Live job search is unavailable in the demo, and demo mode is disabled when `NODE_ENV=production`. `npm run build` followed by `npm start` therefore requires the authenticated service configuration below.

For an example of the controlled review flow, see [the captured form review](docs/demo-form-review.png).

## How it works

1. **Build a profile.** Upload a resume and complete required onboarding. AI extracts facts, grounds them in the source document, and makes them available without a separate fact-confirmation step. Applicants can correct facts and save reusable personal answers.
2. **Find and assess jobs.** Personal search uses saved preferences and redacted experience, then verifies selected Greenhouse, Lever, and Ashby postings through their public APIs. Eligible searches refresh every four hours. Deterministic rules check hard constraints; TypeSafe JEV assesses fit against supported facts. Jobs, imports, and assessments remain private to their owner.
3. **Prepare materials.** Select a role, review tailored resume files and answers, and approve the exact packet before browser filling. Saved file manifests bind filenames, sizes, SHA-256 hashes, and evidence so previews and uploads use the same bytes.
4. **Complete the form.** Watch the remote browser, take control when needed, refresh the captured form, and approve its exact state before submission. The app records confirmation evidence or an uncertain outcome without blindly repeating a submit click.

Applicants can also explicitly enable automatic applications after onboarding. Those runs bind the current profile, settings, job, materials, and form to the saved authorization. Unsupported required questions or forms can pause for user action. Automatic-application permission is separate from invited-pilot consent at `/pilot`.

### Supported behavior and limits

| Area | Current behavior |
| --- | --- |
| Job discovery | Owner-specific AI web search and imported links; public ATS APIs verify postings. `JOB_BOARDS` is used by demo/legacy catalog tooling. |
| Matching | Local scoring and conservative hard rules, followed by queued JEV assessments. Missing evidence or provider failures produce uncertain matches. |
| Resume tailoring | Source-preserving PDF/DOCX editing supports up to eight pages and two text columns per page. Structured LaTeX drafting uses a classic one-page template. Unsupported layouts stop with an actionable error. |
| Browser sessions | Browser Use Cloud is the default production provider; Browserbase remains a legacy adapter. Sessions last up to 30 minutes, with live viewing and takeover. The local demo uses Chromium. |
| Application controls | Versioned approvals, cancellation, transition history, private screenshots, and submission recovery. LinkedIn and Indeed automation is blocked; imported links support tracking and handoff. |
| Service budget | A shared Postgres reservation enforces a configurable projected monthly ceiling, defaulting to $500. Reservations are estimates, not provider invoices. Daily applications are currently uncapped; browser work serializes per owner. |
| Accounts and reporting | Supabase password and magic-link sign-in, owner-scoped state and files, account deletion, daily digests, usage views, and invited-pilot evidence. |

Employer login and CAPTCHA may require takeover. The credential-vault proposal is [inactive](docs/CREDENTIAL-VAULT.md). Applications use public employer browser forms; no employer submission API keys are required.

## Project structure

```text
src/app/              Dashboard, onboarding, authentication, and API routes
src/components/       Reusable application and review UI
src/lib/              Matching, application policies, persistence, and renderers
trigger/              Discovery, drafting, browser workers, and schedules
supabase/migrations/  Database schema, storage policies, and service accounting
runtime/              Pinned document-rendering runtime definitions
scripts/              Runtime setup, evaluations, and integration checks
docs/                 Design decisions, operating notes, and dated test evidence
```

Tests live beside the code in `src/` and `scripts/`. Start with [PRODUCT.md](PRODUCT.md) for product context and [GLOSSARY.md](GLOSSARY.md) for domain terminology. Before changing Next.js code, follow [AGENTS.md](AGENTS.md) and read the relevant guide bundled in `node_modules/next/dist/docs/`.

## Configuration

[.env.example](.env.example) is the configuration reference. Next.js loads root `.env*` files; most integration scripts explicitly load `.env`. Keep credentials out of source control. Only variables prefixed with `NEXT_PUBLIC_` belong in the client bundle.

| Purpose | Variables |
| --- | --- |
| App mode and URLs | `DEMO_MODE`, `NEXT_PUBLIC_APP_URL`, `APP_ORIGIN` |
| Supabase Auth, database, and storage | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, server-only `SUPABASE_SERVICE_ROLE_KEY` |
| AI discovery and drafting | Server-only `OPENAI_API_KEY` |
| JEV matching | Server-only `TYPESAFE_API_KEY` |
| Background tasks | `TRIGGER_PROJECT_REF`, server-only `TRIGGER_SECRET_KEY` and `INTERNAL_TASK_SECRET` |
| Browser provider | `BROWSER_PROVIDER=browser-use`, `BROWSER_USE_API_KEY`, `BROWSER_USE_SOLVE_CAPTCHAS`; the legacy adapter uses `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` |
| Application email | `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_TEST_RECIPIENT` |
| Projected spending | `MONTHLY_SPEND_LIMIT_USD`, `PROJECTED_BROWSER_RUN_USD`, `PROJECTED_DRAFT_USD` |
| Operator access | `USAGE_OPERATOR_USER_IDS` — comma-separated Supabase Auth UUIDs for server-authorized reviewers |

`EMAIL_TEST_RECIPIENT` limits outbound application emails to an authorized test inbox. Supabase authentication email uses its own mail configuration. Keep the application-email restriction in place until the sender and wider delivery are verified.

For local structured resume compilation, run `npm run setup:latex`. Optional binary and cache overrides are documented in [.env.example](.env.example). Production document runtimes are installed by [trigger.config.ts](trigger.config.ts); see [LaTeX resumes](docs/LATEX-RESUMES.md) and [source-preserving resumes](docs/SOURCE-PRESERVING-RESUMES.md) for renderer requirements.

## Production deployment

The configured web host is Vercel, with Supabase for persistence and Trigger.dev for background work. Use dedicated service projects and configure the variables above for each environment.

1. **Prepare Supabase.** Apply all [database migrations](supabase/migrations/) in order, including private file storage, service accounting, account lifecycle, and JEV usage changes. Applying only the initial migration is insufficient. Configure Auth redirects for the app’s `/auth/callback` URL.
2. **Configure the web app.** Set Vercel’s production variables, including `DEMO_MODE=false`, the production `NEXT_PUBLIC_APP_URL`, Supabase credentials, and the Trigger secret key. Use a strong random `INTERNAL_TASK_SECRET` shared with the workers.
3. **Configure workers.** Supply `TRIGGER_PROJECT_REF`, `APP_ORIGIN`, and provider credentials. `APP_ORIGIN` and `NEXT_PUBLIC_APP_URL` must resolve to matching HTTPS production origins. The production-origin guard in `trigger.config.ts` rejects localhost or mismatched origins when syncing worker variables.
4. **Deploy web and tasks.** Deploy the web app to its linked Vercel project and all tasks in [trigger/](trigger/) to Trigger.dev. The worker build installs pinned LaTeX, DOCX, and PDF runtimes and syncs their paths. Deploy required schema changes before code that consumes them.
5. **Verify the deployment.** Check sign-in and callback cookies, anonymous-access rejection, two-account isolation, and the affected worker paths. After document-worker changes, run the relevant runtime probes, including `npm run test:latex-worker`, `npm run test:docx-worker`, or `npm run test:pdf-worker`.

Schedules cover four-hour discovery refreshes, a daily digest at **09:00 America/New_York**, queue dispatch every five minutes, and stale-run reconciliation every fifteen minutes. A stalled submission becomes uncertain rather than starting another submit attempt.

The [integration log](docs/INTEGRATIONS.md) records dated deployment evidence and service limitations; it is not a live service-status page.

## Development and verification

Run the core checks from the repository root:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Use focused checks for the area you change:

| Command | Scope and prerequisites |
| --- | --- |
| `npm run test:browser` | Controlled local browser workflow, including file upload and submission to a local receiver; requires Chromium. |
| `npm run test:live-browser` | Desktop/mobile viewer and takeover UI; requires a running local app, `.env`, and Chromium. Defaults to port 3000. |
| `npm run test:supabase` | Authenticated persistence and isolation; requires configured Supabase and a non-demo app on port 3001. |
| `npm run test:jev` | Four synthetic cases against the live JEV provider; requires `TYPESAFE_API_KEY`. |
| `npm run test:personal-search:ui` | Desktop/mobile discovery UI; requires a running app on port 3013 and Chromium. Override the URL with `TEST_UI_URL`. |
| `npm run test:personal-search:cloud` | Production discovery and matching with temporary isolated users; requires production service credentials and Chromium. |
| `npm run test:remote` | Cloud fill and takeover validation; cancels without submitting. |
| `npm run test:submit` | Cloud submission to a protected synthetic receiver, confirmation evidence, and duplicate-task rejection. |

Live-provider checks can incur costs and create temporary service data. Read their scripts and the relevant operating docs before running them. The full command list is in [package.json](package.json).

### Evaluate matching quality

Prepare 10–100 **human-labeled** JSON pairs with `profile`, `job`, and `label` (`strong`, `possible`, or `uncertain`). Set `TYPESAFE_API_KEY` and `OPENAI_API_KEY`, then run:

```bash
npm run eval:jev -- /absolute/path/to/labeled-pairs.json
```

Applicants can label jobs in Settings and export their owner-scoped dataset from `/api/evaluation/pairs`. The evaluation compares JEV with the preserved OpenAI baseline and reports category accuracy, latency, fallback counts, and token usage. It saves local usage records and does not start applications. Names and contact fields are excluded from JEV requests.

**Search jobs (test)** in Matches runs the normal personal-search pipeline immediately. Existing automatic-application permission still applies to eligible strong results, so pause automation in Settings when testing discovery alone.

## Release gates

Before claiming broader launch readiness, establish:

- Real applicant-authorized employer submissions, including upload acceptance and login/CAPTCHA takeover across more forms.
- Human-labeled matching quality and provider-invoice reconciliation before claiming ranking quality or billed-cost savings.
- Feed usage rights and verified email delivery beyond the restricted test inbox.
- Pilot evidence that meets the gate: at least 20 real initiated attempts, internship and new-grad coverage, an 80% unattended confirmed-receipt rate, and explicit suitability and factual-accuracy review for confirmed attempts.

Pilot reports include blocked, uncertain, failed, and cancelled real attempts in the denominator. Controlled tests are excluded; missing evidence stays unknown. See the [acceptance checklist](docs/ACCEPTANCE.md) and [delivery audit](docs/PLAN-AUDIT.md) for evidence and outstanding work.

## Documentation

| Document | Read it for |
| --- | --- |
| [Automatic resume facts](docs/AUTOMATIC-RESUME-FACTS.md) | Upload extraction, evidence, replacement, and recovery |
| [Resume profile memory](docs/RESUME-PROFILE-MEMORY.md) | Profile details and reusable personal answers |
| [Source-preserving resumes](docs/SOURCE-PRESERVING-RESUMES.md) | PDF/DOCX layout limits, grounding, and repair |
| [LaTeX resumes](docs/LATEX-RESUMES.md) | Compiler setup, immutable artifacts, and worker probes |
| [Browser questions](docs/BROWSER-QUESTIONS.md) | Required answers, takeover, approvals, and submission verification |
| [Model usage](docs/MODEL-USAGE.md) | Usage metering and reporting |
| [Feed usage](docs/FEED-USAGE.md) | ATS sources and access restrictions |
| [Integration log](docs/INTEGRATIONS.md) | Dated service verification and remaining limits |
| [Acceptance checklist](docs/ACCEPTANCE.md) | Controlled test evidence and release criteria |
| [Delivery audit](docs/PLAN-AUDIT.md) | Requirement coverage and contract compatibility |
