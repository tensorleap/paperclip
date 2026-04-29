# GitHub Concierge Webhook POC

This example plugin turns GitHub issue assignment in `tensorleap/concierge` into Paperclip work and mirrors later GitHub updates back into the Paperclip issue thread.

Current behavior:

- Creates a new Paperclip issue in a configured project when a GitHub issue in the configured repository is assigned to the configured GitHub login.
- Assigns that Paperclip issue to a configured Paperclip agent and requests a wake.
- Writes a durable `Source Mirror` block into the mirrored Paperclip issue description showing GitHub repo/issue identity, routing, sync mode, and the last GitHub delivery id.
- Mirrors GitHub issue comments and issue status changes into the Paperclip issue thread.
- Resolves related pull requests through PR body references like `Closes #17` and mirrors PR status changes plus PR review comments into the same Paperclip issue.
- Verifies `X-Hub-Signature-256` and dedupes `X-GitHub-Delivery` in plugin state.

## Development

```bash
pnpm install
pnpm dev            # watch builds
pnpm dev:ui         # local dev server with hot-reload events
pnpm typecheck
pnpm test
pnpm build
```

## Instance Config

The plugin accepts these instance config fields:

- `companyId` — target Paperclip company UUID
- `projectId` — target Concierge project UUID for created issues
- `webhookSecretRef` — company secret UUID used for GitHub signature verification
- `repositoryFullName` — GitHub repository to accept, defaults to `tensorleap/concierge`
- `syncMode` — descriptive sync policy shown on mirrored issues, defaults to `inbound_only`
- `assigneeRoutes` — explicit GitHub assignee login to Paperclip assignee mappings
  - `githubAssigneeLogin` — GitHub assignee login that triggers Paperclip issue creation
  - `paperclipAssigneeAgentId` — Paperclip agent UUID assigned to created issues for that GitHub login
  - `paperclipAssigneeLabel` — optional human-readable label shown in the mirrored issue source block
- `issueTitlePrefix` — title prefix for created Paperclip issues, defaults to `[GitHub]`

Legacy `githubAssigneeLogin` + `assigneeAgentId` config is still accepted as a fallback, but saving explicit `assigneeRoutes` is the preferred shape.

## Expected GitHub Events

Configure GitHub to send these events to the plugin webhook:

- `issues`
- `issue_comment`
- `pull_request`
- `pull_request_review_comment`

The worker only processes the configured repository and only creates new Paperclip work when the tracked GitHub login is assigned.

## Install Into Paperclip

From the Paperclip repo root, build the plugin and install it by local path:

```bash
pnpm --filter @paperclipai/plugin-github-issues-poc-example build
pnpm paperclipai plugin install ./packages/plugins/examples/plugin-github-issues-poc-example
```

If you prefer the raw API install route, point `packageName` at a checkout path in
this repo rather than the runtime `/app` copy:

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"/absolute/path/to/paperclip/packages/plugins/examples/plugin-github-issues-poc-example","isLocalPath":true}'
```

After install, configure the plugin through `POST /api/plugins/:pluginId/config` with a `configJson` object matching the fields above.

## Build Options

- `pnpm build` uses esbuild presets from `@paperclipai/plugin-sdk/bundlers`.
- `pnpm build:rollup` uses rollup presets from the same SDK.

## Activation Notes

Full GitHub activation still requires:

- a company secret storing the shared webhook secret
- a stable externally reachable HTTPS Paperclip URL
- GitHub repo or app admin access to register the webhook on `tensorleap/concierge`

Production guidance:

- Use the Paperclip plugin route directly:
  - `https://<paperclip-public-base-url>/api/plugins/<plugin-id>/webhooks/github`
- Use a tunnel only for local development or one-off debugging, not for the steady-state production path.
- Keep `webhookSecretRef` in a Paperclip company secret instead of inline config.
- If you later add outbound GitHub writeback, keep the GitHub App private key in a Paperclip company secret too and mint installation tokens at runtime rather than reusing a shell machine-user credential.
- Prefer a GitHub App installation scoped to only the selected repositories, and keep a plugin-side repository allowlist in config as a second gate.

This example leaves GitHub-side registration intentionally manual. It proves the Paperclip ingress, mapping, signature validation, and delivery dedupe behavior first; a production rollout should add the GitHub App and managed-secret setup above.
