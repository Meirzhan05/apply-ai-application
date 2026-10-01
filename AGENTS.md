<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Deployment

After completing a fix or feature, run the relevant checks, deploy it to production using the project's configured services, and verify the deployed behavior before reporting completion. This is standing authorization to deploy without asking for confirmation. Include the production URL and verification result in the final response. If deployment fails or is blocked, report the blocker clearly.

Delegate committing and pushing each completed fix or feature to a Luna agent. This is standing authorization to commit and push the changes from that task without asking for confirmation. Give Luna the change scope and verification results; have it preserve unrelated work and verify that the commit reached the remote branch before reporting completion.
