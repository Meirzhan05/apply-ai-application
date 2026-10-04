# Automatic resume facts

Uploading a PDF or DOCX queues `extract-uploaded-resume` on Trigger.dev. The existing document parsers retain complete text and source anchors. The configured OpenAI model combines source lines into reusable statements covering every substantive anchor, then a separate model call checks the statements against their cited excerpts. No fact-confirmation action is required.

## Evidence and acceptance

New resume facts have `verified: false`, `status: "accepted"`, a category, and server-owned grounding metadata. Grounding records the original source hash, model, accepted wording, primary source anchor, and exact supporting excerpts. It establishes fidelity to the uploaded resume, not independent verification of real-world credentials.

`isUsableFact` is the common eligibility rule for matching, onboarding, search, essays and resume drafting. Previously user-confirmed facts and user-entered facts remain supported. `factEvidenceSnapshot` binds new resume artifacts to their full evidence while preserving the legacy hash shape for existing artifacts. Client profile edits cannot create or alter automatic acceptance metadata.

The extraction module validates exact quote membership, complete source-anchor coverage, unique claim identifiers, fact length, and association with the same resume entry (section headings from the same section may support categories). The grounding call must assess every proposed fact and accept all of them. Structural or semantic failures receive one extraction repair attempt. Trigger.dev may retry a failed task once. A partial snapshot is never activated.

## Replacement and recovery

The pending source and extraction progress live separately from the active resume. A successful worker atomically replaces the resume-derived facts, text and original-source manifest, preserving user-entered facts and invalidating stale materials and matching results. Upload request identifiers prevent older workers or uploads from replacing a newer request. Processing metadata is excluded from application authorization hashes so status updates alone do not invalidate active work.

Saved resumes are queued lazily when their owner loads the workspace; the existing reconciliation schedule also queues migrations and identifies stalled extraction. A failed migration preserves the existing resume. Failed or budget-limited extraction offers Retry extraction and another upload, rather than a confirmation checklist. Each paid attempt reserves service budget and records model usage. Account-operation leases cover upload, dispatch and worker activity.

The profile shows grouped facts and optional source excerpts, edits and removal. Fact changes use the displayed snapshot for concurrency checks. Full settings saves do not overwrite facts from an older profile draft.

## Limits

Files must be PDF or DOCX, at most 5 MB and 20,000 readable characters. Sources may contain at most 400 substantive anchors. The complete profile may contain at most 80 facts; an over-capacity replacement fails without dropping content. OCR remains unsupported. Conservative PDF continuation grouping covers nearby indented lines with matching body fonts on the same page and column; mixed-font, same-line and cross-page fragments may require a clearer PDF or DOCX. Split PDF bullets are copied unchanged during tailoring. A source may provide usable extracted facts while its font/layout remains unsupported for source-preserving tailoring.

## Verification

Focused tests exercise extraction and grounding, source coverage, fabricated quotes, amplified metrics, client metadata forgery, atomic replacement, stale jobs, failure recovery, budget limits, legacy migration and the profile UI. Existing PDF and DOCX application-flow tests use automatically accepted facts. `scripts/test-ai-resume-extraction.ts` exercises the real configured model with synthetic sources; `scripts/test-resume-intake.ts` verifies authenticated uploads, asynchronous acceptance, replacement, private original bytes and owner isolation without employer submissions.


Verified production at `https://apply-ai-chi.vercel.app` on October 3, 2026. Authenticated disposable-account checks passed for DOCX and wrapped PDF automatic acceptance, source-byte fidelity, replacement, manual-fact preservation and account isolation, with no user confirmation actions. Test accounts and files were removed. Desktop/mobile production UI checks also passed. The deployed worker's pinned LibreOffice 26.8.0.3 fidelity probe passed; local checks use a different native renderer and skip release-specific coverage.
