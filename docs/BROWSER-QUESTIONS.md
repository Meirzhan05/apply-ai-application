# Questions from the employer’s browser form

The application asks for missing employer answers in a native dialog, then continues filling the saved browser session. This extends the existing cream, forest green, and DM Sans interface. It does not establish a new global design system.

## Scope and takeover

The dialog opens when an application needs user action, has a browser session, and its inspected form contains supported unanswered controls. Questions come from the employer’s actual controls: required blanks or populated fields with invalid values. Supported kinds are text, email, telephone, URL, number, date, textarea, select, radio, and checkbox. Optional blanks, attachments, credentials, noneditable fields, ambiguous identifiers, and unsupported controls are excluded. A batch contains at most 20 questions.

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

Errors appear inside the dialog and leave the current answers available for correction or retry. Continuation failure clears its run lock and returns to user action without discarding the packet or browser. Some controls may already have been filled before a failure, so refresh the employer form before retrying. An expired or missing session requires a fresh browser session and fill approval. Cancellation is preserved rather than overwritten by late work.

The dialog scrolls within the viewport, including long mobile batches. At widths up to 600px its footer buttons occupy the full width. Native dialog focus behavior, visible focus outlines, labelled controls, status messages, and alert errors support keyboard use.

## Verification and limits

Release verification used:

```sh
npm test
npm run typecheck
npm run lint
node --import tsx scripts/test-browser.ts
node --import tsx scripts/test-browser-questions-ui.ts
node --env-file=.data/production.env --import tsx scripts/test-cloud-questions.ts
```

The unit suite passed 318 tests across 41 files, including four focused continuation cases; type checking and lint also passed. Browser coverage included the earlier 37-case full run and four focused cases after the consent checkbox addition, covering 38 distinct cases in total. Desktop and mobile dialog checks passed against the production alias and covered exact options, read-only AI confirmation, close/reopen, errors, long-batch scrolling, consent, takeover fallback, final review, and separate submission approval. Set `TEST_DASHBOARD_URL` to select the production dashboard for the UI script; its state and action routes use controlled fixtures.

Production: [apply-ai-chi.vercel.app](https://apply-ai-chi.vercel.app), worker release `20261001.4`. The cloud test exercises the deployed fill worker, real database, grounded drafting, and saved cloud browser. It verifies the same session, final review, zero submissions, and stale/replay/cross-user rejection. Disposable accounts also test the private beta invite gate. When that gate blocks the accounts, continuation uses the same service function locally against production services; that mode does **not** verify authenticated Vercel API continuation end to end.

Controlled tests do not establish compatibility with every employer form, nor do they perform a real employer submission. Production environment files and test credentials must remain private.

Implementation: `src/app/browser-questions-dialog.tsx`, `src/app/globals.css`, `src/lib/browser-questions.ts`, `src/lib/browser-question-approval.ts`, `src/lib/browser-question-runs.ts`, `src/lib/browser-runner.ts`, and `src/lib/answer-policy.ts`.
