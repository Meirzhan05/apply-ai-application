# Mandatory resume-based onboarding for US job applications

## Problem Statement

Candidates must currently upload a resume, manually fill basic profile fields, and individually confirm extracted experience information in the dashboard's profile settings. Uploading the resume does not create a complete, reusable Profile for application filling. Current Location, US Immigration Status, and separate present and future Sponsorship Need answers are missing or conflated with other information.

New and existing candidates need one mandatory onboarding flow that uses the information they have already supplied, collects missing application answers, and leaves their Profile ready for US job matching and application filling.

## Solution

After registration, candidates enter an unskippable onboarding flow. Existing candidates must complete the same new flow before entering the app, but may reuse their saved resume and information.

The flow requires a successfully parsed resume, saves extracted information immediately, and presents editable name, email, phone, and links. Professional information already saved from the resume is reused rather than collected in a second questionnaire. Candidates supply their Current Location, Preferred Job Locations, work arrangements, US Immigration Status, applicable Visa Type, Work Authorization, and separate current and future Sponsorship Need answers.

One explicit "Finish onboarding" action confirms the displayed imported information for application filling and opens the dashboard. Progress persists across interruptions. Job matching and applications target US jobs, including for candidates whose Current Location is outside the US.

## User Stories

1. As a newly registered candidate, I want onboarding to open before the dashboard, so that I establish my Profile before using the app.
2. As an existing candidate, I want to complete the new onboarding flow, so that my saved Profile satisfies the same requirements as a new candidate's Profile.
3. As an existing candidate, I want to reuse my uploaded resume, so that I do not have to upload the same document again.
4. As an existing candidate, I want saved information prefilled, so that I only correct or add information that needs attention.
5. As a candidate, I want a resume to be required, so that my Profile and application preparation have a source document.
6. As a candidate, I want to upload a supported PDF or DOCX, so that I can use my existing resume format.
7. As a candidate, I want unsupported or oversized uploads rejected with a clear error, so that I know which document to provide.
8. As a candidate, I want upload and extraction progress visible, so that I know whether my resume is still being processed.
9. As a candidate, I want extraction failures to offer retry or replacement, so that I can recover using a readable resume.
10. As a candidate, I want failed uploads to preserve saved progress and my previously usable resume, so that a failed replacement does not erase my information.
11. As a candidate, I want my name extracted into an editable field, so that I do not have to enter it again.
12. As a candidate, I want my email extracted into an editable field, so that application forms can use the correct address.
13. As a candidate, I want my phone extracted into an editable field, so that application forms can use the correct number.
14. As a candidate, I want resume links extracted into editable fields, so that I can reuse my LinkedIn, portfolio, and other links.
15. As a candidate, I want missing basic information left blank, so that invented information does not enter my Profile.
16. As a candidate, I want to correct extracted details and fill missing basic fields after a successful import, so that parsing mistakes do not prevent accurate application filling.
17. As a candidate, I want imported information saved before final confirmation, so that I do not lose the import when I leave and return.
18. As a candidate, I want my existing professional information reused, so that I do not repeat my education and experience in another questionnaire.
19. As a candidate, I want the imported information I am confirming available to inspect and edit, so that my completion action reflects information I have seen.
20. As a candidate, I want name, email, and phone required before completion, so that my Profile has the basic contact details needed for applications.
21. As a candidate, I want links to remain optional, so that not having a portfolio or LinkedIn account does not block onboarding.
22. As a candidate, I want my current city, state or region, and country prefilled when clearly available in the resume contact header, with missing details left blank and all fields editable, so that application filling uses where I actually live.
23. As a candidate living outside the US, I want to enter my actual Current Location, so that seeking US jobs does not require a false US residence.
24. As a candidate, I want Preferred Job Locations stored separately from Current Location, so that my residence does not determine where I want to work.
25. As a candidate, I want to select my preferred US job destinations, so that matching respects where I want to work.
26. As a candidate, I want to express remote, hybrid, and on-site preferences, so that matching respects my preferred work arrangements.
27. As a candidate, I want relocation willingness to be optional, so that I can finish without deciding it immediately.
28. As a candidate, I want start date or availability to be optional, so that uncertainty about timing does not block onboarding.
29. As a candidate, I want to declare my US Immigration Status, so that my Profile has this required application information.
30. As a US citizen or permanent resident, I want a status choice that applies to me, so that I am not forced to invent a Visa Type.
31. As a visa holder, I want to provide my Visa Type, so that the Profile records the category I declare.
32. As a candidate with another status, I want to supply details, so that a limited list does not force an inaccurate selection.
33. As a candidate, I want to answer Work Authorization directly, so that the app does not infer my answer from immigration status or resume text.
34. As a candidate, I want to answer whether I need sponsorship now, so that current Sponsorship Need is recorded accurately.
35. As a candidate, I want to answer whether I will need sponsorship in the future, so that future Sponsorship Need remains separate from my current answer.
36. As a candidate, I want explicit negative answers accepted as completed answers, so that "No" is not mistaken for missing information.
37. As a candidate, I want to see which required answers are missing, so that I know what prevents completion.
38. As a candidate, I want to resume saved onboarding after a reload or a later login, so that I can complete it across sessions.
39. As a candidate, I want incomplete onboarding to remain mandatory when I try to enter another app view, so that it cannot be accidentally bypassed.
40. As a candidate, I want one "Finish onboarding" action to confirm the displayed imported information, so that I do not have to approve every fact separately.
41. As a candidate, I want completion to be saved and followed by the dashboard, so that my Profile is ready for application filling and job matching.
42. As a candidate, I want the completed flow to remain completed when I return, so that I do not repeat it at every login.
43. As a candidate, I want a replacement resume's changed basic details to update my Profile even when I edited earlier values, so that the latest supplied details are reflected.
44. As a candidate, I want replacement-derived fields to remain editable, so that I can correct the new import too.
45. As a candidate, I want replacing a resume to preserve my directly answered location, immigration, authorization, and sponsorship information, so that a new document does not erase those answers.
46. As a candidate, I want job matching to return US job destinations only, so that results stay within the supported market.
47. As a candidate, I want the US restriction to apply when filling an application too, so that a manually imported non-US job cannot bypass the destination rule.
48. As a candidate, I want onboarding completion to make my saved preferences usable for matching, so that I do not need an extra "save preferences" step after finishing.
49. As a candidate, I want my Profile available only to my authenticated account, so that another candidate cannot access or change it.
50. As a candidate, I want changes to my Profile reflected in application preparation, so that previously prepared materials do not silently use outdated details.

## Implementation Decisions

- Extend the existing Profile, resume intake, onboarding questionnaire, completion policy, authenticated action handling, public state, dashboard entry, matching, and application-filling modules. Reuse current owner-scoped persistence rather than creating a second professional-profile store.
- Build a staged onboarding interface around resume intake, editable imported basics, directly answered questions, and final completion. Require it after registration and for existing accounts that have not completed this version of onboarding. Preserve authentication, session recovery, and sign-out access.
- Keep draft saving separate from completion. Saving an upload, editing fields, or having all required values present must not by itself record completion. Completion requires the explicit final action and server-side validation of current persisted information.
- Track completion for the new onboarding version so that legacy completion timestamps do not bypass the new requirements. Persist progress per authenticated owner and resume it across sessions. Once this flow is completed, do not repeat it on ordinary subsequent logins.
- Require an uploaded, successfully parsed resume. Reuse existing stored source documents when usable. Preserve the existing supported PDF/DOCX formats and upload limits. Failed parsing offers retry or replacement; it does not unlock a manual-entry-only path.
- Extract name, email, phone, and links into normalized, editable Profile fields. Missing values stay blank. Name, valid email, and phone are required; links are optional. Support international contact details for candidates residing abroad.
- Retain the original resume and source provenance. Reuse existing extracted professional facts instead of introducing a second experience or education questionnaire. Make the information covered by final confirmation inspectable and editable.
- Save imports immediately as unconfirmed editable information. Following the agreed confirmation decision, one final action confirms the imported information displayed during onboarding for application preparation. Do not blanket-confirm unrelated facts or treat a successful upload as permission to use every extracted claim.
- Treat successful replacement imports as the source for changed resume-derived basics, including values previously edited by the candidate. Preserve directly answered Current Location, Preferred Job Locations, work preferences, US Immigration Status, Visa Type, Work Authorization, and Sponsorship Need. Retain existing usable state if replacement processing fails.
- Store Current Location as city, state or region, and country, independently of Preferred Job Locations. Current Location may be outside the US. Preferred Job Locations represent US job destinations; a nationwide US preference is valid without requiring a particular city.
- Prefill an unset Current Location from an unambiguous residence in the resume contact header. Support US city/state and explicit international city/region/country formats; retain explicitly available city/country when the region is absent. Leave missing or ambiguous components for the candidate to supply. Never use employer or education locations, or infer immigration or job preferences from residence. Preserve any saved or partially entered Current Location during replacement and reuse.
- Record remote, hybrid, and on-site preferences explicitly. Allow a candidate to select one or more acceptable arrangements. Preserve existing matching preference behavior through compatible mappings where appropriate.
- Require US Immigration Status with choices for US citizen, permanent resident, visa holder, and another status. Require Visa Type for visa holders and details for another status. These are candidate declarations, not inferred legal conclusions.
- Require separate explicit answers for current US Work Authorization, current Sponsorship Need, and future Sponsorship Need. Missing or unknown declarations do not satisfy these requirements; explicit negative answers do. Do not infer these answers from immigration status or one another.
- Keep relocation willingness and start date or availability optional. Do not require target roles, links, or a mailing address. Job search can use confirmed experience to infer relevant roles when target roles are unset.
- Enforce the complete required set on the server before accepting the final action. Return actionable missing-field errors and persist completion, confirmation, and saved search preferences together before opening the dashboard.
- Apply the mandatory completion policy to protected app entry and the public operations that start matching or application preparation. A client-side screen alone is insufficient. Existing users retain their saved data while supplying the new required answers.
- Keep any existing automation activation, submission approvals, and authorization versions governed by their current contracts. Profile confirmation establishes reusable information; completion does not silently create a new automation authorization.
- Integrate separate sponsorship timing and explicit immigration answers into reusable form answers. Match each employer question to its meaning rather than substituting Visa Type for Work Authorization or collapsing current and future sponsorship.
- Enforce US job destinations in matching and application eligibility, including manually imported jobs. Do not equate remote work with a US destination or use the candidate's residence to infer the job's country. Unresolved destinations must not be treated as verified US jobs.
- Preserve current Profile-change invalidation for matching caches, prepared application packets, and versioned approvals. Preserve account isolation, source evidence, and confirmed user-authored facts during migration and resume replacement.

## Testing Decisions

- The user confirmed the test scope: primarily exercise saved Profile behavior through the existing authenticated resume and Profile/onboarding action interfaces, plus one browser journey for mandatory onboarding and dashboard arrival. Keep a single logical workflow boundary rather than introducing test-only APIs or testing individual UI helpers.
- Good tests assert observable responses, persisted owner state, completion eligibility, reusable application answers, and actual navigation. Avoid assertions about internal helper calls, extraction implementation details, component structure, or text that merely repeats implementation constants.
- Extend the existing resume-route behavioral tests and authenticated onboarding action/persistence tests. Their prior art already covers uploads, source-anchored unconfirmed facts, preservation of existing information, explicit negatives versus missing declarations, owner isolation, and versioned state changes.
- Test the workflow modules together through the public interfaces: upload or reuse a resume, verify saved editable basics and unconfirmed professional information, save direct answers, reject premature completion, and finish once to persist the new completion version and confirmed imported information.
- Cover missing name, email, phone, Current Location components, Preferred Job Locations, work arrangements, immigration status, conditional Visa Type or other-status details, and each authorization/sponsorship declaration. Explicit "No" answers must pass; omitted or unknown declarations must not.
- Cover new users and existing users with legacy completion, including reuse of a usable stored resume and preservation of saved direct answers. Confirm legacy completion cannot bypass the new flow and new completion survives reloads.
- Cover successful PDF and DOCX imports, unsupported files, upload limits, unreadable or empty extraction, retry, and failed replacement preservation. A failed parse must not mark onboarding complete or offer manual-entry-only completion.
- Cover candidate corrections before completion and replacement imports with changed name, email, phone, or links. Changed imported values replace older manual edits; questionnaire answers and user-authored confirmed facts remain preserved.
- Cover failed or stale final saves: the dashboard must not unlock before successful persisted completion, and a pending or changed resume import must not be approved by an outdated final action.
- Exercise reusable form answers through the existing application preparation/filling boundary so that current sponsorship, future sponsorship, Work Authorization, US Immigration Status, and Visa Type remain distinct.
- Cover US-only destination enforcement through existing matching and application eligibility interfaces, including overseas candidates, remote jobs, non-US jobs, manually imported jobs, and unresolved job destinations. Resume/source and contact data must retain their existing privacy boundaries in job search.
- Use one browser journey parameterized for desktop and mobile, following the existing browser smoke-test approach with controlled owner state and provider responses. Start from registration/session entry, observe mandatory onboarding, reuse or upload a resume, edit a basic field, supply required answers, verify the incomplete gate and saved progress, finish, and assert dashboard arrival and completion after reload.
- Use synthetic resumes and controlled integrations; the tests must not send real applications. During implementation, run focused behavior tests, type checking, linting, and the build, followed by the authorized production deployment and verification of the gated flow and dashboard handoff.

## Out of Scope

- Implementing the feature as part of publishing this specification.
- Resume-optional onboarding or manual-entry fallback after extraction failure.
- A separate professional-history questionnaire or duplicate professional-profile store.
- Target-role questions or new target-role requirements for completion.
- Full mailing address or postal-code collection during onboarding.
- Non-US job destinations or country-specific authorization questionnaires beyond the US.
- Inferring immigration, work authorization, or sponsorship answers from resume text or from another answer.
- Legal advice or evaluation of the candidate's declared immigration status.
- Replacing the existing resume rendering, application approval, or automation activation systems.
- Automatically granting submission authorization when onboarding finishes.

## Further Notes

- This specification synthesizes the accepted decisions from the onboarding design interview. The glossary vocabulary and the decision "Confirm imported profile information once at onboarding completion" apply.
- The previous onboarding and versioned automation issue is completed: https://github.com/Meirzhan05/apply-ai-application/issues/2. This specification adds the mandatory resume-first flow and broader questionnaire while preserving the established authorization contracts.
- The user explicitly confirmed the proposed authenticated-action and browser-journey testing scope. Publish this specification as a new issue with the `ready-for-agent` label.
