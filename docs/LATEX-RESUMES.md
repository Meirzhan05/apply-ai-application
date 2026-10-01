# LaTeX resumes

New resume drafts use packet schema v2: structured education, experience,
projects, skills and exact professional links, each citing confirmed facts.
AI rephrasing passes a separate grounding check before compilation. Contact
information comes from the saved profile. No credentials, authorization answers
or missing dates are inferred.

The classic template uses US Letter, TeX Gyre Termes, 0.55-inch margins and
11-point text. One-page fitting tries compact spacing/10.5-point text, then
removes the least relevant complete bullets (and empty entries). Omitted claims
stay visible in review. Fitting stops after eight compilations or 90 seconds.
Long overflowing fields and unsupported characters return actionable errors.

## Runtime

Run `npm run setup:latex` for local development. The installer verifies pinned
Tectonic 0.17.0 release checksums and warms the template's package/font cache.
Production workers install the same runtime during image build at
`/app/latex-runtime`. `TECTONIC_BIN` and `TECTONIC_CACHE_DIR` can override local paths.
Cloud deployments always sync both paths from the installation directory with
`override: true`; historical project settings must not point workers elsewhere.
After each worker deployment, run `npm run test:latex-worker` with production
credentials loaded to verify an actual one-page PDF, not just image build success.
Runtime compilation uses an argument-array process launch, untrusted mode,
cached packages only, an isolated temporary directory, a minimal environment,
and a 20-second timeout per invocation. Temporary files are always removed.

The drafting worker has a 600-second task limit and a 540-second shared deadline;
existing essays retain their 200-second sub-budget. Stale draft recovery waits
12 minutes so it does not interrupt a healthy longer draft. Existing spending
reservations still apply; `PROJECTED_DRAFT_USD` remains configurable.

## Artifacts and review

Apply the `application_files` migration before enabling v2 workers. The private
`application-files` bucket accepts PDFs and text sources up to 5 MB. Trusted
servers create immutable owner/input-hash/content-hash objects; authenticated
clients have owner-only SELECT access and cannot upload, replace or delete them.
All privileged reads/writes also validate the owner's object-key prefix.

The packet binds the structured content, evidence, profile, template version,
PDF and source hashes, file sizes, input hash and one-page result. Preview and
browser upload read and verify the saved PDF rather than compiling again.
Human-answer edits, essay confirmation/regeneration and cover-letter revisions
reuse it. Source downloads use authenticated routes, attachment disposition,
`nosniff` and `no-store`.

**Rebuild resume** regenerates the resume, keeps valid answers/confirmations and
cover-letter content, and invalidates packet approval. **Write essays with AI**
explicitly regenerates essays while preserving the reviewed resume. Any draft
failure leaves the previous packet available and reports the reason. Existing
v1/legacy packets keep their previous rendering and approval semantics. No
owner application is automatically rewritten or submitted during deployment.

## Verification and rollout

- `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`.
- `npm run test:latex`: real compilation, one-page/selectable/ordered text,
  preserved qualifiers and metrics, clickable exact URLs with special characters.
- `npm run test:latex-review`: synthetic desktop/mobile component checks. Set
  `TEST_DASHBOARD_URL` and `CHROMIUM_EXECUTABLE_PATH` for your local browser.
- `npm run test:latex-ai`: live drafting/auditing plus saved-artifact reuse, with
  a synthetic applicant and local demo storage only.
- `npm run test:latex-storage`: live two-account storage isolation and immutable
  server-only writes; disposable users and files are removed afterward.
- Run the manual Trigger.dev task `verify-latex-runtime` after worker deployment
  to verify the packaged binary/cache with synthetic data and no external actions.

September 30, 2026 verification: 267 unit tests and 30 controlled browser cases
passed, along with typecheck, lint, production build, real PDF compilation,
live AI grounding/artifact reuse, two-account storage isolation, and desktop/mobile
review checks against the deployed web app. Rendered fixture PDFs were visually
inspected for clipping and spacing. The storage migration and v2 web readers are
deployed. The post-deployment worker check passed with Tectonic 0.17.0 and its
packaged cache, producing a one-page, 20,097-byte PDF.

Roll out the private bucket, v2 web readers, then the compiler worker. Inspect
rendered PDFs and desktop/mobile review screenshots; do not rely only on text
extraction. Rebuilding an existing owner packet requires an explicit user action.

October 1, 2026 runtime-path correction: worker `20261001.1` reproduced the
missing-runtime error because saved project settings referenced `/opt/apply-latex`
while the image installed under `/app/latex-runtime`. Deployment now syncs the
installed paths over stale settings. The same synthetic production smoke test
passed on worker `20261001.2`, producing a one-page, 20,097-byte PDF. The deployment
regression test failed before the fix and passed afterward; all 308 unit tests,
typecheck, lint, production build, and local real-PDF checks passed. No owner
application was drafted or submitted during verification.
