# Resume-based onboarding

Status: design interview complete. The implementation specification is in [resume-onboarding.md](specs/resume-onboarding.md) and published as [GitHub issue #21](https://github.com/Meirzhan05/apply-ai-application/issues/21) with the `ready-for-agent` label.

## Agreed decisions

- Onboarding establishes a profile primarily for filling job applications. The same profile can support job matching.
- A resume is required during onboarding.
- Information extracted from the resume is saved automatically and remains editable. A separate review step is not required before saving.
- A single "Finish onboarding" action confirms the saved, editable profile for application filling. Individual extracted facts do not each require a separate confirmation during onboarding.
- Initial onboarding supports US job applications only.
- Ask for current city/country, preferred job locations, remote/hybrid/on-site preference, US work authorization, and sponsorship needed now or later.
- Relocation willingness and start date are optional.
- Do not ask for target roles during onboarding.
- Populate name, email, phone, and links from the resume while reusing the existing saved professional information. Do not require a second professional-history questionnaire.
- Visa status is required and answered directly by the candidate, separately from authorization and sponsorship.
- Require current city, state or region, and country. Do not collect a full mailing address during onboarding.
- Everyone, including existing users, goes through onboarding.
- Existing users can reuse their already-uploaded resume and replace it if desired.
- Require name, email, and phone before completion. Links are optional.
- Do not provide a manual-entry fallback for failed resume extraction in this version. Candidates must retry or provide a readable replacement resume.
- Onboarding is mandatory after registration. Existing users must also complete it before entering the app.
- Restrict job matching and applications to US jobs. A candidate's current residence may be outside the US.
- When a replacement resume contains different details, update the corresponding resume-derived fields even if the candidate previously edited them manually. Keep the fields editable and preserve directly answered location, immigration, authorization, and sponsorship information.
- Label the required status question "US immigration status": citizen, permanent resident, visa holder with a visa type, or another status with details.
- Ask separately whether sponsorship is needed now and whether it will be needed in the future.
- After completion, open the main dashboard.

## Consolidated flow

1. Upload a required resume, or reuse an existing uploaded resume.
2. Show editable name, email, phone, and links populated from the resume. Reuse saved professional information rather than asking candidates to re-enter their history.
3. Collect location, work preferences, immigration status, authorization, and sponsorship answers directly from the candidate.
4. Select "Finish onboarding" to confirm the profile for application filling and enter the dashboard.

Save imported information before confirmation and keep it editable. Completion provides one confirmation for the displayed imported information; do not require separate confirmation of each fact during onboarding. Incomplete onboarding prevents entry into the app; saved progress allows candidates to return and continue.

Required information: a successfully parsed resume; name, email, and phone; current city, state or region, and country; preferred US job locations; remote/hybrid/on-site preferences; US immigration status and visa type when applicable; current US work authorization; sponsorship needed now; and sponsorship needed in the future.

Optional information: links, relocation willingness, and start date or availability. Do not ask for target roles or a full mailing address.

Immigration status, visa type, work authorization, and sponsorship answers are distinct. Collect them directly rather than inferring them from the resume or from one another. Manual-entry fallback for failed extraction is out of scope; editing successfully extracted details and filling missing basic fields remain supported.

## Existing behavior

Resume intake currently saves the source document and proposes unconfirmed professional facts. It does not populate basic profile fields. The profile questionnaire already asks about work authorization, sponsorship, and availability. Preferred job locations exist; current residence and visa status do not have separate structured fields.

Application drafting and browser filling use normalized profile fields and confirmed facts rather than treating the stored resume text as automatically approved answers. The agreed "Finish onboarding" action needs to connect the reviewed resume-derived information to that existing confirmation boundary. Target roles can remain unset: personal search already supports inferring roles from confirmed experience. Existing search does not impose a universal US-country restriction.

## Implementation implications

Connect the single completion action to the existing confirmation boundary for the imported information shown during onboarding. Saving information alone does not approve it for use. Continue using existing profile-change invalidation for application packets and approvals.

Add the separate residence, immigration-status, visa-type, and sponsorship-timing information needed by the agreed flow. Enforce US-only job destinations for both matching and applications while allowing candidates who live abroad.
