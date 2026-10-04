# Resume drafting timeout recovery

Baseline: `6130e21`.

Production evidence: Notion resume generation succeeded, but grounding failed twice at 45.143 and 45.125 seconds. The prior upload-extraction fix did not cover application drafting. This change shares the request cap and bounded transient retry across upload extraction, profile extraction, source-preserving drafting, structured drafting, and the legacy packet draft.

## Standards

Passed. Request limits respect the enclosing deadline. Authorization guards precede every retry and metering covers each provider invocation. Semantic writer/checker counts and factual/layout repair budgets remain separate from transport retries. No remaining findings.

## Spec

Passed. Source audits validate at most ten claims per batch with matching original-activity checks. Full context and cited evidence remain available; every batch must validate before complete audit acceptance. A failed audit retries the same request without regenerating a valid draft. No preservation bypass, partial acceptance or unrelated behavior change found.

Review totals: Standards 0 findings; Spec 0 findings.

## Verification

- Reproduced the timeout as a failing source-plan test before implementation.
- Focused drafting tests: 51 passed, including source/structured audit recovery, writer recovery, cancellation before retry, repeated timeouts, full batched coverage and existing factual/layout repairs.
- Full portable suite: 975 passed, 10 skipped (native renderer-specific baseline exclusions).
- Type-check, lint, production build and whitespace checks passed.
- Live AI replay using the affected Notion application's account and source: all 57 claims grounded in 81.59 seconds; no production state writes.
- Production worker/controller and actual application recovery are checked after publication.
