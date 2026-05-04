# GitHub PR Events Plugin

Plugin ID: `paperclipai.github-pr-events`

Bridges GitHub `pull_request` and `pull_request_review` webhook events into Paperclip issue comments. When a PR is merged, opened, or reviewed, the plugin posts a structured comment on the linked Paperclip issue and wakes the assignee agent.

## How it works

1. GitHub sends a `pull_request` or `pull_request_review` event to the plugin's webhook URL.
2. The plugin verifies the HMAC-SHA256 signature.
3. It extracts the branch name from `pull_request.head.ref` and parses a Paperclip issue identifier using the naming convention `{prefix-lower}-{number}-{slug}` (e.g. `ten-73-fix-auth-bug` → `TEN-73`).
4. It searches for an active issue with that identifier in the configured company.
5. If found, it posts a structured comment and requests a wakeup for the assigned agent.
6. Unmatched events return 200 silently — no retry storm from GitHub.

## Branch naming convention

The branch name must follow this pattern for automatic issue resolution:

```
{prefix-lower}-{number}-{slug}
```

Examples:
- `ten-73-fix-auth-bug` → resolves `TEN-73`
- `pap-224-add-dashboard` → resolves `PAP-224`
- `ten-131-some-longer-slug` → resolves `TEN-131`

Branches that do not match (e.g. `feature/add-widget`, `main`, `hotfix-broken`) are silently skipped.

## Installation

### 1. Create a webhook secret

Generate a random secret for HMAC verification and store it as a Paperclip company secret:

```bash
openssl rand -hex 32
# Store as a Paperclip secret, note the UUID returned
```

### 2. Install the plugin

Install `@paperclipai/plugin-github-pr-events` and configure an instance with:

| Config field       | Description                                                                     |
| ------------------ | ------------------------------------------------------------------------------- |
| `companyId`        | Paperclip company ID whose issues should be matched                             |
| `webhookSecretRef` | UUID of the company secret containing the webhook HMAC secret                   |

### 3. Register the GitHub webhook

On your GitHub repository (or GitHub App), add a webhook pointing to:

```
https://<your-paperclip-host>/api/plugins/<plugin-instance-id>/webhooks/github
```

Configure it to deliver:
- `pull_request` events (actions: `opened`, `closed`)
- `pull_request_review` events (action: `submitted`)

Set the **Content type** to `application/json` and paste the webhook secret from step 1.

## Comment format

### PR merged

```
**GitHub PR Event:** `pull_request.closed (merged)`
- PR: [#414 Fix auth regression](https://github.com/org/repo/pull/414) merged into `main`
- Merged by: @revieweruser at 2026-05-04T16:43Z
- Branch: `ten-73-fix-auth-bug`
- Repository: `org/repo`

The PR linked to this issue has been merged. Review and close if work is complete.
```

### PR opened

```
**GitHub PR Event:** `pull_request.opened`
- PR: [#414 Fix auth regression](https://github.com/org/repo/pull/414) opened by @devuser at 2026-05-04T16:40Z
- Branch: `ten-73-fix-auth-bug`
- Repository: `org/repo`

A pull request has been opened for this issue.
```

### PR review submitted

```
**GitHub PR Event:** `pull_request_review.submitted`
- PR: [#414 Fix auth regression](https://github.com/org/repo/pull/414)
- Review: @reviewer submitted a changes requested [review](https://github.com/.../review) at 2026-05-04T16:45Z
- Repository: `org/repo`

A pull request review requires your attention.
```

## Error handling

| Condition                  | Response            |
| -------------------------- | ------------------- |
| Invalid or missing signature | 401                |
| Issue not found for branch | 200 (silent skip)   |
| Branch does not match pattern | 200 (silent skip) |
| Unsupported event type     | 200 (silent skip)   |
| Duplicate delivery ID      | 200 (deduplicated)  |
| Comment API failure        | Retried once, then logged |

## Deduplication

Each GitHub delivery includes an `X-GitHub-Delivery` header with a unique ID. The plugin stores processed delivery IDs in plugin state and skips any duplicate delivery, preventing double-comments if GitHub retries.
