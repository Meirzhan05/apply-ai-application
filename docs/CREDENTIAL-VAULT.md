# Proposed credential vault — later feature

This is a design for future implementation, not a deployed capability. The demo and initial beta use browser takeover for credentials and CAPTCHA. Neither an application approval nor a saved sensitive screening answer authorizes storing a password.

## Owner consent and origin binding

The owner would explicitly choose whether to save a credential for one exact HTTPS origin. The UI must show that origin, what is stored, retention, and how to revoke it. Reject local/private network targets and unauthorized boards. Bind federated login origins separately; a redirect never broadens consent.

Each use requires an authenticated owner, an approved application, and a short-lived credential-use authorization bound to the owner, application, browser session and origin. Packet and submit approvals remain separate. Keep CAPTCHA, MFA, recovery codes and unfamiliar login steps under owner control. Never save those responses by default.

## Storage design

Use a dedicated server-only vault table with owner-scoped RLS and no browser-accessible secret read API. Suggested records:

- Credential ID, owner ID, normalized origin, display label, consent version and timestamps.
- Ciphertext, nonce, authentication tag, wrapped data-encryption key and key version.
- Revocation/deletion state and last authorized use time; no plaintext audit values.

Generate a fresh random data-encryption key for each credential. Encrypt the payload with authenticated encryption such as AES-256-GCM and a unique nonce. Include credential ID, owner ID, origin and schema version as authenticated associated data so ciphertext cannot be transplanted to a different owner or destination.

Wrap each data key using a managed key service. Keep wrapping keys outside the database and app environment file; database backups alone must not decrypt credentials. Restrict unwrap access to the vault service identity, separate from ordinary web request workers. Key rotation rewraps data keys; credential revocation invalidates future leases. Implementation must choose a key service and verify its access, rotation and deletion semantics before rollout.

## Execution boundary

1. The authenticated web action issues a single-use authorization with a maximum five-minute lifetime and the exact application/session/origin.
2. The worker presents that authorization to the vault service. The service checks ownership, consent, revocation, application state and session identity before unwrapping.
3. The worker verifies the page's current origin and the login form destination before entering the credential into supported password controls. Cross-origin navigation or unfamiliar controls stop the action and return for takeover.
4. Keep plaintext only in the executing process for the login step. Exclude it from models, task payloads, persistent state, logs, traces, snapshots, recordings and email. Clear references when finished and terminate the isolated session when the application workflow ends. Process-memory zeroization is best effort, not a guarantee.
5. Mark the authorization consumed and record an audit event containing IDs, origin, timestamps and outcome only. Retried task delivery cannot reuse it.

Password fields should be masked in review captures and the login phase must disable provider recording where supported. Do not enable the vault if the browser provider cannot meet the chosen retention and capture requirements. Session cookies can also authenticate the applicant: remote session lifetime, takeover access, recordings and teardown require the same review as stored passwords.

## Revocation and recovery

Allow owners to inspect metadata, revoke all authorizations and delete a credential. Never redisplay an existing password through the app. Revocation prevents new retrieval; active browser sessions may already hold authentication cookies, so release them as part of revocation and explain that employer-side sessions may need separate sign-out.

Choose retention and backup-deletion behavior explicitly. Require owner takeover when the key service is unavailable or any origin/consent check fails; there is no plaintext fallback. Do not attempt account recovery, password resets, MFA bypass or automatic CAPTCHA solving.

## Release tests

Before enabling this feature, verify cross-user and cross-origin denial, ciphertext/associated-data tampering, nonce uniqueness, expired/replayed authorization, worker retries, revocation during a run, key rotation and outage, secret-free observability, capture retention, remote session expiry and deletion behavior. Test with synthetic accounts before an owner authorizes a real credential. Review the vault service and its key access independently of the rest of the application.
