# Questions from the employer’s browser form

The application asks for missing employer answers in a native dialog, then continues filling the saved browser session. This extends the existing cream, forest green, and DM Sans interface. It does not establish a new global design system.

## Scope and takeover

The dialog opens when an application needs user action, has a browser session, and its inspected form contains supported unanswered controls. Questions come from the employer’s actual controls: required blanks or populated fields with invalid values. Supported kinds are text, email, telephone, URL, number, date, textarea, select, radio, and checkbox. Optional blanks, attachments, credentials, noneditable fields, ambiguous identifiers, and unsupported controls are excluded. A batch contains at most 20 questions.

Inspection reads the employer’s question heading separately from its option label. It uses the nearest scoped ATS question container or fieldset, with ARIA and native label fallbacks, and excludes dynamic location status text from the heading. Saved headings containing only Yes/No, internal `cards[...]` names, or location loading/error text cannot be answered. “Refresh questions” re-reads the same browser before showing an answerable dialog.

Applicant facts, preferences, sensitive answers, exact employer options, and consent belong to the applicant. Options are presented as supplied by the employer. A required consent checkbox requires an explicit check; it is not replaced with a Yes/No menu. Recognized motivation and experience essays belong to AI and appear as read-only drafts for review.

Closing the dialog leaves a button to reopen it. Unsaved values survive closing and reopening while the component remains mounted, but are not durably saved until continuing. A changed application, session, or form remounts the dialog. Login, CAPTCHA, uploads, unsupported controls, and other unresolved blockers retain the browser takeover path. After completing a browser step, refresh the form for review.

## Continuation and approvals

“Save answers and continue” authorizes filling these answers only. Every current question must have an answer or a confirmed AI draft before the button enables. Inputs are disabled during drafting or continuation. The continuation reconnects to the existing browser and fills the approved controls; it does not create a new session or submit the application.

Each stored answer approval binds the applicant, application, employer URL, session ID, packet hash, form hash, question, and answer. The service requires the current fill approval, a valid packet, a live session, and a `needs_user_action` state. It refuses cross-user access, concurrent or replayed continuations, stale forms, and applications with a submission attempt or unresolved manual submission report.

Before filling, the runner compares the inspected controls, values, options, attachments, and submission destination with the approved snapshot. A changed form returns a fresh snapshot for review. It checks current controls again while filling and stops if the run is cancelled or its profile, packet, session, or destination changes.

Continuation clears any prior submit approval. The resulting snapshot returns to final review when ready, or asks for more input when blocked. Final submission still requires a separate approval of the completed form.

## AI evidence and confirmation

AI essays use confirmed profile facts. The dialog exposes those source facts and requires a separate review checkbox for each draft. Confirmation sends the draft’s content hash rather than applicant replacement text. The service checks the content hash, sentence evidence, verified fact IDs, evidence hash, and current form/session/packet binding before accepting it. Changed or removed evidence requires a new draft. Human answers remain scoped to this application question; they do not become reusable profile facts or essay evidence.

Drafting supports at most five AI essays per batch. It reserves projected AI spend against the service budget before calling the model. An ungrounded answer remains unconfirmable and displays a retry message. When the budget blocks drafting, the packet and browser remain available; the user can retry later, subject to session expiry.

## Failure and recovery

CAPTCHA takeover requires a visible interactive widget or challenge. Zero-height provider mounts, transparent overlays, invisible verification badges, and hCaptcha enclave frames are background infrastructure. A visible challenge still blocks final approval even inside a widget configured as invisible; a previously approved form is invalidated when that challenge appears. The agent does not generate or modify provider response tokens. Background verification alone does not prevent final review. Any ambiguous outcome after the single approved submit click still follows the existing no-retry rule.

Errors appear inside the dialog and leave the current answers available for correction or retry. Continuation failure clears its run lock and returns to user action without discarding the packet or browser. Some controls may already have been filled before a failure, so refresh the employer form before retrying. An expired or missing session requires a fresh browser session and fill approval. Cancellation is preserved rather than overwritten by late work.

The dialog scrolls within the viewport, including long mobile batches. At widths up to 600px its footer buttons occupy the full width. Native dialog focus behavior, visible focus outlines, labelled controls, status messages, and alert errors support keyboard use.

## Employer verification after Submit

New Browser Use sessions enable the provider's built-in CAPTCHA handling by default. `BROWSER_USE_SOLVE_CAPTCHAS=false` disables it for newly allocated sessions; the mode is saved with each application browser, so existing sessions are not assumed to have a solver. Browserbase retains its existing manual configuration. The runner waits up to 20 seconds for a visible challenge before producing a review snapshot, and up to 30 seconds for the existing approved submission's response when provider handling is enabled. These waits only observe the page: they do not click challenges, inject tokens, refresh, replace sessions, or repeat Submit. Clearing a challenge still requires employer confirmation before recording success. Unsupported or unresolved challenges use the human fallback below.

Verified October 1, 2026 on `https://apply-ai-chi.vercel.app` and production Trigger version `20261001.8`: 332 unit tests, TypeScript and lint checks, and three focused browser cases passed. A controlled production cloud run allocated a Browser Use session with handling enabled and persisted that mode, retained the same browser for an unresolved synthetic challenge, skipped a duplicate submit task, and recorded confirmation after simulated human completion without another submission. Local fixtures also cover automatic continuation when a challenge clears. These tests verify configuration and workflow behavior, not solver success against a real employer CAPTCHA; no employer was contacted.

An employer can open a visible CAPTCHA after the single approved Submit click. If provider handling does not resolve it within the waiting window, the runner retains that browser session and moves the application to `awaiting_verification`. The verification record binds the existing attempt time, session, and approved employer URL; only the application owner can check it. “Finish employer verification” directs the applicant to use “Take control” to complete the CAPTCHA manually, then select “I’m done · check result”. The application itself never clicks challenge images or creates provider response tokens; enabled Browser Use sessions may handle the challenge through the provider.

`checkSubmissionResult` observes the existing page without filling controls, clicking Submit, or navigating. It reads the complete rendered employer response before saving a bounded receipt, excluding hidden text and select-option noise so long option lists cannot hide the confirmation. Confirmation requires changed response text with a recognized confirmation message and no visible challenge. A pending result keeps the session available; a transient read failure allows another result check without resubmitting.

“Stop verification”, session expiry, or a confirmed stopped browser ends verification as `uncertain`, preserving the submission attempt and any receipt. No automatic retry occurs. A browser already stopped by an earlier release cannot be restored by this flow. Completing a CAPTCHA alone does not prove acceptance; check the employer’s confirmation or receipt before taking further action.

## Verification and limits

Release verification used:

```sh
npm test
npm run typecheck
npm run lint
node --import tsx scripts/test-browser.ts
node --import tsx scripts/test-browser-questions-ui.ts
TEST_BROWSER_CASE='label extraction' npm run test:browser
node --import tsx scripts/test-form-labels-ui.ts
node --env-file=.data/production.env --import tsx scripts/test-cloud-questions.ts
node --env-file=.env --import tsx scripts/test-submission-verification-ui.ts
TEST_CLOUD_VERIFICATION=true node --env-file=.data/production.env --import tsx scripts/test-cloud-submit.ts
```

The label repair passed 319 unit tests across 41 files, type checking, lint, and the full 39-case browser suite. Its Lever-structure regression verifies five exact employer headings and their separate options; it failed before the repair and passed afterward. Read-only inspection of a real public Palantir Lever page also verified those five headings without filling or submitting it.

The CAPTCHA repair added the real Lever zero-height hCaptcha/enclave pattern and an invisible badge with a transparent challenge to browser coverage. Both reproduced false takeover warnings before the fix. The expanded suite passed 41 browser cases, and the strengthened background case verifies that revealing a challenge inside the invisible widget invalidates final approval without clicking Submit. The 319-unit suite, type checking, and lint passed. The fix deployed in worker `20261001.6`; read-only refresh of the existing owner browser removed the false CAPTCHA blocker and reached final review with zero remaining blockers and no submit click.

The post-submit verification repair passed 331 unit tests, type checking, lint, and 43 browser cases. Its regression failed when the old runner closed a post-click challenge; it now verifies retention, repeated observation without another click, and confirmation after simulated human completion. A second regression verifies confirmation beyond 4,000 native select options and the receipt length limit. Desktop and mobile checks against the production alias verified guidance, live control, an unobscured result action, hidden submit/restart/cancel controls, and the transition to confirmation using mocked state/actions.

Worker `20261001.7` passed a controlled production cloud test: the deployed worker filled the protected synthetic form, honored both approvals, retained the same browser after a simulated challenge, skipped a duplicate submit task, saved confirmation after simulated human verification, and released the session. The receiver counted one application attempt. Result checks invoked the same service function locally against the production database and browser; this did not exercise the authenticated Vercel result-check endpoint. No employer was contacted.

The label UI script passed on desktop and mobile using the snapshot produced by actual browser inspection. Run the filtered label extraction browser case first: it writes `.data/label-debug/inspected-form.json`, which the UI script requires. The UI check covers blocked malformed snapshots, refresh, readable headings, exact options, and overflow. Set `TEST_DASHBOARD_URL` to select the dashboard for either UI script; their state and action routes use controlled fixtures. Earlier desktop and mobile question-dialog checks passed against the production alias and covered read-only AI confirmation, close/reopen, errors, long-batch scrolling, consent, takeover fallback, final review, and separate submission approval.

Production: [apply-ai-chi.vercel.app](https://apply-ai-chi.vercel.app). The earlier cloud continuation verification used worker release `20261001.4`; it is not a new cloud fill verification of the label repair. That test exercised the deployed fill worker, real database, grounded drafting, and saved cloud browser, verifying the same session, final review, zero submissions, and stale/replay/cross-user rejection. Disposable accounts also tested the private beta invite gate. When that gate blocked the accounts, continuation used the same service function locally against production services; that mode did **not** verify authenticated Vercel API continuation end to end.

Controlled tests do not establish compatibility with every employer form, nor do they perform a real employer submission. Production environment files and test credentials must remain private.

Implementation: `src/app/browser-questions-dialog.tsx`, `src/app/page.tsx`, `src/app/globals.css`, `src/lib/browser-questions.ts`, `src/lib/browser-question-approval.ts`, `src/lib/browser-question-runs.ts`, `src/lib/browser-runner.ts`, `src/lib/submission-verification.ts`, `src/lib/run-recovery.ts`, and `src/lib/answer-policy.ts`.
