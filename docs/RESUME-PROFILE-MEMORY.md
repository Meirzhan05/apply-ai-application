# Resume details and reusable personal answers

## Intended behavior

Uploading a resume automatically fills available basic profile details and personal links. There is no extraction-confirmation step. Users set their onboarding declarations, screening answers and preferences themselves. Known basic information should be reused when filling employer forms, instead of asking the user again.

The existing Basics card contains name, application contact email, phone, school, graduation year, explicitly stated headline, current location, LinkedIn, GitHub and portfolio. Skills are imported only while they are resume-owned. The authenticated account email stays separate from application contact email.

The existing resume facts panel holds grounded experience and qualifications. A compact expandable Saved personal answers section under Links shows additional personal details supplied during applications and lets the owner edit or forget them. There is no third column or Memory tab.

Missing personal details are asked when an employer requires them, saved automatically after successful form filling, and reused on future applications. Supported reusable questions cover named Basics fields, languages spoken and name pronunciation. Employer-specific, legal, demographic, screening, salary and consent questions remain scoped to the application unless they already have an explicit onboarding setting. Unknown questions are not guessed or saved globally.

## Extraction and ownership

`resume-profile-extraction.ts` requests structured named values from the existing AI model. Every value must literally appear in an exact resume anchor quote or its embedded hyperlink targets. A separate semantic check confirms ownership and field meaning. Names, locations and contacts belonging to employers or references cannot populate applicant details. No legal declarations or preferences are inferred.

DOCX hyperlinks are read from each document/header/footer part's relationships. PDF links are associated with text by annotation bounds. External destinations are never fetched. Displayed links without a scheme receive an HTTPS prefix after source validation.

The worker publishes the original source, facts and basic details together. A failed check preserves the previous active snapshot. Provenance belongs to the server. Resume-owned values can change on replacement uploads; missing imported links are removed. Existing nonempty legacy values, manual edits and intentional clears are preserved. Existing stored resumes receive a one-time lazy upgrade using original bytes.

## Reuse and concurrency

`profile-memory.ts` owns personal-question matching, input validation, resolved values and learning. Successful human text/email/phone/URL answers on manual and automatic browser continuations can be learned; packet-review personal answers are also saved. Failed or cancelled fills do not teach the profile.

A packet or automatic authorization captures a frozen personal-value snapshot. Automatic learning does not alter the current application's values or its profile authorization hashes. Future applications capture the latest memory. Explicit profile/memory edits still advance the automation version and invalidate stale approvals.

The profile editor submits only changed basic fields, checks their expected prior values, and refreshes untouched fields after extraction. Saved-answer edits also check the expected prior value. Account evaluation exports strip new contact/link/provenance/memory fields.

## Verification

Focused tests exercise literal extraction, semantic rejection, hyperlink parsing, imported/manual ownership, stale saves, migration, successful versus failed learning, unchanged active hashes, future application reuse and actual form filling. The provider smoke script uses synthetic DOCX/PDF resumes; the authenticated intake script creates disposable production accounts and verifies source bytes, isolated automatic extraction and manual edits across replacement uploads.
