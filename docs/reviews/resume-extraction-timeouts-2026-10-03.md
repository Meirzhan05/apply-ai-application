# Resume extraction timeout fix

Baseline: `64a12ec` (latest master, including ATS submissions and resume improvements).

The production run for the reported PDF parsed successfully. Basic extraction and ownership verification succeeded. The first worker attempt failed experience validation; the second experience extraction request failed after 45.063 seconds. Basic details were not persisted because publication waited for experience extraction.

## Standards

Passed after removing a duplicated stale-request guard from inside provider metering. The retry wrapper is the single guard before each attempt, and each real model request is metered separately. Checkpointing, deadlines, bounded concurrency and complete snapshot publication passed review. No remaining findings.

## Spec

Passed after adding a regression for a wrapped PDF bullet spanning claims ten and eleven. Each batch now retains all same-entry context, marks only assigned claims for extraction, and preserves exact evidence and full-source coverage. Basic details survive experience failures, retries do not repeat verified basic extraction, user edits remain authoritative, and superseded uploads cannot publish. No remaining findings.

Review totals: Standards 0 remaining findings; Spec 0 remaining findings.

## Verification

- Full portable suite: 968 passed, 10 skipped. Native renderer-specific checks remain excluded as in the baseline environment.
- Final focused extraction, profile and worker regression tests: 30 passed.
- Type-checking, lint, production build and diff whitespace checks passed.
- Live configured-model DOCX and PDF checks passed automatic acceptance and complete source coverage.
- Production deployment and original failed-upload recovery are verified separately after publishing.
