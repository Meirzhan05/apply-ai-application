# Feed usage review

Reviewed September 29, 2026. Technical access does not establish a general content licence for a multi-employer matching service.

## Current ATS sources

- [Greenhouse Job Board API](https://docs.greenhouse.io/job-board.html) documents public posting reads and authenticated submission. The app uses reads and hosted application forms. Employer/partner permissions and beta redistribution terms remain unconfirmed.
- [Lever Postings API](https://github.com/lever/postings-api) supports public JSON postings and hosted-form links; API submissions require an employer-generated key. No direct submission adapter is enabled.
- [Ashby Job Postings API](https://developers.ashbyhq.com/docs/public-job-posting-api) documents published postings for an organization's careers page. That documentation does not by itself confirm rights to aggregate employers' content for this beta.

The interface identifies the source and links to its original posting. Failed requests preserve existing listings instead of treating the source as empty. Beta launch still requires confirming usage rights and any required attribution for configured boards.

## Adzuna: reviewed, inactive

[Adzuna's API terms](https://developer.adzuna.com/docs/terms_of_service) permit listed publishing and research uses. Other organizational uses have a limited 14-day validation trial and may need written consent and a licence afterward. Published listings require linked “Jobs by Adzuna” branding of at least 116 × 23 pixels, using its logo. Default limits are 25 requests/minute, 250/day, 1,000/week, and 2,500/month.

AI matching and application assistance are not explicitly covered by the listed uses. Treating those uses as requiring confirmation is an inference, not a grant of rights. No Adzuna account, licence, or matching approval has been supplied; the source remains disabled.

Before enabling it, obtain confirmation covering profile-based AI processing, shared caching, beta audience, data retention, and application handoff; implement required branding and contractual limits. Keep provider queries within the agreed route and remove retained data if the agreement terminates.
