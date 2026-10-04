# Direct employer application APIs

Application preparation tries a configured employer API before allocating a browser. Supported adapters are Greenhouse Job Board, Lever Postings, and Ashby application forms. They use the existing materials approval and final review, or the existing current automation authorization. An adapter never grants permission to apply by itself.

All three submission APIs require employer-issued credentials. Public posting access is not submission access. No employer has granted this project submission access yet, so production currently uses browser fallback. Workday and other unsupported employers also use the browser, subject to existing compatibility and takeover rules. LinkedIn and Indeed automation remains disabled.

## Server configuration

Set `ATS_SUBMISSION_INTEGRATIONS` to a JSON array on both Vercel and Trigger.dev. This is a server secret, never a `NEXT_PUBLIC_` variable. Worker deployment synchronization marks it secret. Empty, invalid, or duplicate configuration enables no adapters.

```json
[
  { "provider": "greenhouse", "board": "employer-board-token", "apiKey": "EMPLOYER_ISSUED_JOB_BOARD_KEY" },
  { "provider": "ashby", "board": "employer-board-slug", "apiKey": "EMPLOYER_ISSUED_ASHBY_KEY" }
]
```

Greenhouse needs a Job Board API key, not a Harvest key. Ashby needs `jobsRead` and `candidatesWrite`. Keys are scoped to the exact provider and board and never included in form snapshots, public state, receipts, browser URLs, or errors.

Lever does not expose custom questions through its Postings API. Every enabled posting also needs an employer-reviewed complete form definition and an attestation that it has no custom questions:

```json
[
  {
    "provider": "lever",
    "board": "employer-slug",
    "apiKey": "EMPLOYER_ISSUED_LEVER_KEY",
    "leverForms": {
      "posting-id": {
        "revision": "employer-reviewed-v1",
        "customQuestionsAbsent": true,
        "fields": [
          { "name": "name", "label": "Name", "kind": "text", "required": true },
          { "name": "email", "label": "Email", "kind": "email", "required": true },
          { "name": "resume", "label": "Resume", "kind": "file", "required": true }
        ]
      }
    }
  }
]
```

Lever defaults to the global instance. For `jobs.eu.lever.co` postings, set `"region": "eu"` on the integration; requests use only `api.eu.lever.co`. Credentials are scoped to the matching region.

Name and email must be required. Additional supported Lever names are `phone`, `resume`, `org`, `comments`, and `urls[GitHub]`, `urls[LinkedIn]`, `urls[Portfolio]`, or `urls[Website]`. Update the revision and complete definition when the employer changes its form. Postings without a definition use the browser. An approved cover-letter PDF is never silently converted into comments.

## Coverage and fallback

Greenhouse reads the exact job with `questions=true`. Ashby reads `jobPosting.info`. Lever verifies the posting and uses the configured form. Each adapter checks posting identity and constructs a review snapshot with field labels, displayed answers, request values, and the file manifest.

Supported controls include text, email, phone, URL, textarea, number, date, single-select, boolean, and known resume/cover-letter files. Contact fields use saved profile values. Other answers require an exact matching question in the approved packet. Select labels map to unique native values. The adapter never guesses consent or legal answers.

Missing required answers, consent/demographic controls, unrecognized fields, conditional Ashby fields, additional Ashby surveys, unsupported attachments, unavailable credentials/schema reads, and unconfigured employers use the browser. Preparation fallback performs no application POST and no file upload. Existing live browser sessions retain their browser flow.

## Submission and recovery

The form digest binds the provider, board, posting, endpoint, definition, integration configuration including a one-way credential digest, packet, values, and attachment mapping. Legacy browser forms retain their existing digest. Submission re-reads the definition and reconstructs the reviewed request. Changes stop before sending and require preparation and review again. Upload bytes are checked against the approved filename, MIME type, size, and SHA-256.

Immediately before sending, the worker atomically verifies current state and authorization and records the attempt plus its material manifest. It sends one application POST with no redirects or automatic retries. API errors, timeouts, unreadable receipts, rate limits, or uncertain acceptance never trigger browser fallback or a second POST. Duplicate task deliveries are rejected by the existing durable worker claim.

Lever confirmation requires `ok: true` and `applicationId`. Ashby requires an unblocked successful response with a submitted form instance ID. Greenhouse acknowledgement uses HTTP 200 with a non-error JSON object. An API acknowledgement is not proof of recruiter review or email delivery. Receipts contain normalized evidence rather than raw provider payloads.

## Workday

Workday recruiting web services need employer-controlled tenant credentials, security permissions, requisition references, and tenant-specific application requirements. A Workday adapter must be configured and validated with a cooperating employer. This change does not invent tenant endpoints or replay undocumented career-site requests; Workday remains on the browser path.

## Verification

Run `npx vitest run src/lib/ats-application.test.ts src/lib/ats-application-flow.test.ts`. These tests exercise the ATS HTTP boundary and application workers, including browser-free preparation/submission, exact uploaded bytes, final approval, duplicate delivery, changed schema, select values, credential isolation and rotation, Lever EU routing, consent/conditional fallback, denied claims, tampered endpoints, and uncertain outcomes. Provider responses are controlled fixtures. Real employer acceptance cannot be verified until an employer grants access.

The desktop/mobile UI check is `node --import tsx scripts/test-api-application-ui.ts` (set `TEST_DASHBOARD_URL` for the running app and `CHROMIUM_EXECUTABLE_PATH` if needed). It intercepts synthetic state and actions; it does not contact an employer.

Official contracts: [Greenhouse Job Board API](https://docs.greenhouse.io/job-board.html), [Lever Postings API](https://github.com/lever/postings-api), [Ashby careers flow](https://developers.ashbyhq.com/docs/creating-a-custom-careers-page), [Ashby submission](https://developers.ashbyhq.com/reference/applicationformsubmit), and [Workday integration security](https://doc.workday.com/workday-education/en-us/course-manuals/creating-and-securing-integrations/workday-configurable-security.html).
