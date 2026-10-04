# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Next.js and TypeScript, requested by the user. The planned production services are Supabase, Trigger.dev, Browserbase, and OpenAI.

## Users

US students, new graduates, and early career job seekers who need help finding relevant roles and completing applications.

## Product Purpose

Continuously find relevant jobs, explain fit, prepare truthful tailored materials, and assist with applications while keeping the applicant in control. Success means more qualified, accurate applications with less user effort.

## Positioning

A reviewed application workflow: the agent discovers and prepares opportunities, while the applicant selects each job and approves both the materials and the final submission.

## Operating Context

Users upload a resume, receive automatically extracted resume facts and save search preferences, review matches, choose jobs, edit tailored materials, and inspect a live browser before submission. Some sites require login, CAPTCHA, or manual takeover.

## Capabilities and Constraints

- Each student’s search agent starts automatically after resume facts are automatically extracted and they save search preferences. It searches for that student, verifies public employer postings, and refreshes every four hours. New accounts start with no matches; discovered jobs and manually imported links remain private to their owner. A daily email digest summarizes that owner’s results.
- Begin with public Greenhouse, Lever, and Ashby postings and imported links. Broader feeds require authorized access.
- No unauthorized LinkedIn or Indeed automation.
- Unlimited initiated applications per user per day for now, one active browser run per user, and a global monthly service-spend ceiling of $500.
- Applications require distinct approval to fill a form and approval to submit its final state.
- A controlled demo precedes a free invited beta for 50–100 users.
- Invited pilot participation is an explicit, versioned opt-in after onboarding. It measures initiated applications and their evidence without enabling automation, public signup, billing, or a daily application cap.
- TypeSafe JEV now evaluates career level, skills, and support for each requirement in production. An offline comparison against OpenAI remains available; real labeled evaluation is pending. A temporary Search jobs (test) control lets applicants request discovery immediately.

## Evidence on Hand

The approved product and agent plan in this conversation. Service credentials are configured in private environment files and deployment settings. No logo, customer proof, or employer partnership has been supplied.

## Product Principles

- Show the source of each match and factual application claim.
- Treat unknown information as uncertain instead of inventing it.
- Give users clear control over consequential actions and recovery from blocked forms.
- Make current status and the next required action visible.
- Keep controlled validation, unknown outcomes, and real employer evidence visibly distinct in pilot reports; incomplete evidence remains unknown rather than zero or a passing claim.
