import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function signPayload(secretRef: string, body: string): string {
  return `sha256=${createHmac("sha256", `resolved:${secretRef}`).update(body).digest("hex")}`;
}

function makeIssue(partial: {
  id?: string;
  companyId: string;
  identifier: string;
  title?: string;
  /** GitHub ref (e.g. "tensorleap/fsd#414") stored in description for search */
  githubRef?: string;
  status?: Issue["status"];
}): Issue {
  const now = new Date();
  return {
    id: partial.id ?? randomUUID(),
    companyId: partial.companyId,
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: partial.title ?? `TEN issue for ${partial.identifier}`,
    description: partial.githubRef
      ? `Tracks ${partial.githubRef}`
      : null,
    status: partial.status ?? "in_progress",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: null,
    identifier: partial.identifier,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function buildHarness(companyId: string, secretRef: string) {
  return createTestHarness({
    manifest,
    capabilities: [...manifest.capabilities, "issue.comments.read"],
    config: { companyId, webhookSecretRef: secretRef },
  });
}

function webhookInput(opts: {
  secretRef: string;
  payload: object;
  eventType: string;
  deliveryId?: string;
  overrideSignature?: string;
}) {
  const body = JSON.stringify(opts.payload);
  return {
    endpointKey: "github",
    requestId: `req-${randomUUID()}`,
    headers: {
      "x-github-delivery": opts.deliveryId ?? randomUUID(),
      "x-github-event": opts.eventType,
      "x-hub-signature-256": opts.overrideSignature ?? signPayload(opts.secretRef, body),
    } as Record<string, string>,
    rawBody: body,
    parsedBody: opts.payload,
  };
}

// ──────────────────────────────────────────────
// Manifest
// ──────────────────────────────────────────────

describe("manifest", () => {
  it("declares required capabilities", () => {
    expect(manifest.capabilities).toEqual(
      expect.arrayContaining([
        "webhooks.receive",
        "issues.read",
        "issues.create",
        "issue.comments.create",
        "plugin.state.read",
        "plugin.state.write",
        "secrets.read-ref",
      ]),
    );
  });

  it("declares github webhook endpoint", () => {
    expect(manifest.webhooks).toEqual([
      expect.objectContaining({ endpointKey: "github" }),
    ]);
  });
});

// ──────────────────────────────────────────────
// HMAC signature validation
// ──────────────────────────────────────────────

describe("signature validation", () => {
  it("rejects missing X-Hub-Signature-256 header", async () => {
    const companyId = randomUUID();
    const secretRef = randomUUID();
    const harness = buildHarness(companyId, secretRef);
    await plugin.definition.setup(harness.ctx);

    const body = JSON.stringify({ action: "opened" });
    await expect(
      plugin.definition.onWebhook?.({
        endpointKey: "github",
        requestId: "req-1",
        headers: {
          "x-github-delivery": randomUUID(),
          "x-github-event": "pull_request",
        },
        rawBody: body,
        parsedBody: { action: "opened" },
      }),
    ).rejects.toThrow("Missing X-Hub-Signature-256 header");
  });

  it("rejects an invalid signature", async () => {
    const companyId = randomUUID();
    const secretRef = randomUUID();
    const harness = buildHarness(companyId, secretRef);
    await plugin.definition.setup(harness.ctx);

    const body = JSON.stringify({ action: "opened" });
    await expect(
      plugin.definition.onWebhook?.({
        endpointKey: "github",
        requestId: "req-2",
        headers: {
          "x-github-delivery": randomUUID(),
          "x-github-event": "pull_request",
          "x-hub-signature-256": "sha256=deadbeefdeadbeef",
        },
        rawBody: body,
        parsedBody: { action: "opened" },
      }),
    ).rejects.toThrow("Invalid GitHub webhook signature");
  });
});

// ──────────────────────────────────────────────
// pull_request events
// ──────────────────────────────────────────────

describe("pull_request events", () => {
  it("posts wake comment on matched TEN issue for PR opened", async () => {
    const companyId = randomUUID();
    const secretRef = randomUUID();
    const issue = makeIssue({ companyId, identifier: "TEN-73", githubRef: "tensorleap/fsd#414" });
    const harness = buildHarness(companyId, secretRef);
    harness.seed({ issues: [issue] });
    await plugin.definition.setup(harness.ctx);

    const payload = {
      action: "opened",
      pull_request: {
        number: 414,
        title: "Fix auth regression",
        html_url: "https://github.com/tensorleap/fsd/pull/414",
        merged: false,
        user: { login: "devuser" },
      },
      repository: { full_name: "tensorleap/fsd" },
      sender: { login: "devuser" },
    };
    const input = webhookInput({ secretRef, payload, eventType: "pull_request" });

    await plugin.definition.onWebhook?.(input);

    const comments = await harness.ctx.issues.listComments(issue.id, companyId);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("## GitHub Event: pull_request.opened");
    expect(comments[0]?.body).toContain("`tensorleap/fsd#414`");
    expect(comments[0]?.body).toContain("`devuser`");
  });

  it("posts wake comment for PR synchronize", async () => {
    const companyId = randomUUID();
    const secretRef = randomUUID();
    const issue = makeIssue({ companyId, identifier: "TEN-73", githubRef: "tensorleap/fsd#414" });
    const harness = buildHarness(companyId, secretRef);
    harness.seed({ issues: [issue] });
    await plugin.definition.setup(harness.ctx);

    const payload = {
      action: "synchronize",
      pull_request: { number: 414, title: "Fix auth" },
      repository: { full_name: "tensorleap/fsd" },
      sender: { login: "devuser" },
    };
    const input = webhookInput({ secretRef, payload, eventType: "pull_request" });
    await plugin.definition.onWebhook?.(input);

    const comments = await harness.ctx.issues.listComments(issue.id, companyId);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("pull_request.synchronize");
  });

  it("silently drops pull_request.labeled", async () => {
    const companyId = randomUUID();
    const secretRef = randomUUID();
    const issue = makeIssue({ companyId, identifier: "TEN-73", githubRef: "tensorleap/fsd#414" });
    const harness = buildHarness(companyId, secretRef);
    harness.seed({ issues: [issue] });
    await plugin.definition.setup(harness.ctx);

    const payload = {
      action: "labeled",
      pull_request: { number: 414 },
      repository: { full_name: "tensorleap/fsd" },
    };
    const input = webhookInput({ secretRef, payload, eventType: "pull_request" });
    await plugin.definition.onWebhook?.(input);

    const comments = await harness.ctx.issues.listComments(issue.id, companyId);
    expect(comments).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────
// pull_request_review events
// ──────────────────────────────────────────────

describe("pull_request_review events", () => {
  it("posts comment for review submitted (changes_requested)", async () => {
    const companyId = randomUUID();
    const secretRef = randomUUID();
    const issue = makeIssue({ companyId, identifier: "TEN-73", githubRef: "tensorleap/fsd#414" });
    const harness = buildHarness(companyId, secretRef);
    harness.seed({ issues: [issue] });
    await plugin.definition.setup(harness.ctx);

    const payload = {
      action: "submitted",
      review: {
        state: "changes_requested",
        html_url: "https://github.com/tensorleap/fsd/pull/414#pullrequestreview-1",
        user: { login: "reviewer" },
      },
      pull_request: { number: 414, title: "Fix auth" },
      repository: { full_name: "tensorleap/fsd" },
      sender: { login: "reviewer" },
    };
    const input = webhookInput({ secretRef, payload, eventType: "pull_request_review" });
    await plugin.definition.onWebhook?.(input);

    const comments = await harness.ctx.issues.listComments(issue.id, companyId);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("## GitHub Event: pull_request_review.submitted");
    expect(comments[0]?.body).toContain("changes_requested");
  });

  it("silently drops pull_request_review.dismissed", async () => {
    const companyId = randomUUID();
    const secretRef = randomUUID();
    const issue = makeIssue({ companyId, identifier: "TEN-73", githubRef: "tensorleap/fsd#414" });
    const harness = buildHarness(companyId, secretRef);
    harness.seed({ issues: [issue] });
    await plugin.definition.setup(harness.ctx);

    const payload = {
      action: "dismissed",
      review: { state: "dismissed" },
      pull_request: { number: 414 },
      repository: { full_name: "tensorleap/fsd" },
    };
    const input = webhookInput({ secretRef, payload, eventType: "pull_request_review" });
    await plugin.definition.onWebhook?.(input);

    const comments = await harness.ctx.issues.listComments(issue.id, companyId);
    expect(comments).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────
// issues events
// ──────────────────────────────────────────────

describe("issues events", () => {
  it("posts comment for issues.opened", async () => {
    const companyId = randomUUID();
    const secretRef = randomUUID();
    const issue = makeIssue({ companyId, identifier: "TEN-73", githubRef: "tensorleap/fsd#10" });
    const harness = buildHarness(companyId, secretRef);
    harness.seed({ issues: [issue] });
    await plugin.definition.setup(harness.ctx);

    const payload = {
      action: "opened",
      issue: { number: 10, title: "Bug report" },
      repository: { full_name: "tensorleap/fsd" },
      sender: { login: "user1" },
    };
    const input = webhookInput({ secretRef, payload, eventType: "issues" });
    await plugin.definition.onWebhook?.(input);

    const comments = await harness.ctx.issues.listComments(issue.id, companyId);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("## GitHub Event: issues.opened");
  });

  it("silently drops issues.labeled", async () => {
    const companyId = randomUUID();
    const secretRef = randomUUID();
    const issue = makeIssue({ companyId, identifier: "TEN-73", githubRef: "tensorleap/fsd#10" });
    const harness = buildHarness(companyId, secretRef);
    harness.seed({ issues: [issue] });
    await plugin.definition.setup(harness.ctx);

    const payload = {
      action: "labeled",
      issue: { number: 10 },
      repository: { full_name: "tensorleap/fsd" },
    };
    const input = webhookInput({ secretRef, payload, eventType: "issues" });
    await plugin.definition.onWebhook?.(input);

    const comments = await harness.ctx.issues.listComments(issue.id, companyId);
    expect(comments).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────
// issue_comment events
// ──────────────────────────────────────────────

describe("issue_comment events", () => {
  it("posts comment for issue_comment.created", async () => {
    const companyId = randomUUID();
    const secretRef = randomUUID();
    const issue = makeIssue({ companyId, identifier: "TEN-73", githubRef: "tensorleap/fsd#10" });
    const harness = buildHarness(companyId, secretRef);
    harness.seed({ issues: [issue] });
    await plugin.definition.setup(harness.ctx);

    const payload = {
      action: "created",
      issue: { number: 10 },
      comment: { body: "LGTM!", html_url: "https://github.com/tensorleap/fsd/issues/10#issuecomment-1" },
      repository: { full_name: "tensorleap/fsd" },
      sender: { login: "commenter" },
    };
    const input = webhookInput({ secretRef, payload, eventType: "issue_comment" });
    await plugin.definition.onWebhook?.(input);

    const comments = await harness.ctx.issues.listComments(issue.id, companyId);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("## GitHub Event: issue_comment.created");
    expect(comments[0]?.body).toContain("`commenter`");
  });
});

// ──────────────────────────────────────────────
// check_suite events
// ──────────────────────────────────────────────

describe("check_suite events", () => {
  it("posts comment for failed completed check_suite with PRs", async () => {
    const companyId = randomUUID();
    const secretRef = randomUUID();
    const issue = makeIssue({ companyId, identifier: "TEN-73", githubRef: "tensorleap/fsd#414" });
    const harness = buildHarness(companyId, secretRef);
    harness.seed({ issues: [issue] });
    await plugin.definition.setup(harness.ctx);

    const payload = {
      action: "completed",
      check_suite: {
        status: "completed",
        conclusion: "failure",
        pull_requests: [{ number: 414 }],
        app: { name: "GitHub Actions" },
      },
      repository: { full_name: "tensorleap/fsd" },
      sender: { login: "github-actions[bot]" },
    };
    const input = webhookInput({ secretRef, payload, eventType: "check_suite" });
    await plugin.definition.onWebhook?.(input);

    const comments = await harness.ctx.issues.listComments(issue.id, companyId);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("## GitHub Event: check_suite");
    expect(comments[0]?.body).toContain("`failure`");
  });

  it("silently drops successful check_suite", async () => {
    const companyId = randomUUID();
    const secretRef = randomUUID();
    const issue = makeIssue({ companyId, identifier: "TEN-73", githubRef: "tensorleap/fsd#414" });
    const harness = buildHarness(companyId, secretRef);
    harness.seed({ issues: [issue] });
    await plugin.definition.setup(harness.ctx);

    const payload = {
      action: "completed",
      check_suite: {
        status: "completed",
        conclusion: "success",
        pull_requests: [{ number: 414 }],
      },
      repository: { full_name: "tensorleap/fsd" },
    };
    const input = webhookInput({ secretRef, payload, eventType: "check_suite" });
    await plugin.definition.onWebhook?.(input);

    const comments = await harness.ctx.issues.listComments(issue.id, companyId);
    expect(comments).toHaveLength(0);
  });

  it("silently drops check_suite with empty pull_requests", async () => {
    const companyId = randomUUID();
    const secretRef = randomUUID();
    const harness = buildHarness(companyId, secretRef);
    await plugin.definition.setup(harness.ctx);

    const payload = {
      action: "completed",
      check_suite: {
        status: "completed",
        conclusion: "failure",
        pull_requests: [],
      },
      repository: { full_name: "tensorleap/fsd" },
    };
    const input = webhookInput({ secretRef, payload, eventType: "check_suite" });
    await expect(plugin.definition.onWebhook?.(input)).resolves.not.toThrow();
  });
});

// ──────────────────────────────────────────────
// Unmapped refs — triage issue creation
// ──────────────────────────────────────────────

describe("unmapped refs", () => {
  it("creates a triage issue when no TEN issue matches", async () => {
    const companyId = randomUUID();
    const secretRef = randomUUID();
    const harness = buildHarness(companyId, secretRef);
    // No issues seeded — no match
    await plugin.definition.setup(harness.ctx);

    const payload = {
      action: "opened",
      pull_request: { number: 999, title: "Unknown PR" },
      repository: { full_name: "tensorleap/fsd" },
      sender: { login: "devuser" },
    };
    const input = webhookInput({ secretRef, payload, eventType: "pull_request" });
    await plugin.definition.onWebhook?.(input);

    const allIssues = await harness.ctx.issues.list({ companyId });
    const triageIssue = allIssues.find((i) => i.title.includes("triage: unmapped tensorleap/fsd#999"));
    expect(triageIssue).toBeDefined();
    expect(triageIssue?.description).toContain("## GitHub Event: pull_request.opened");
  });
});

// ──────────────────────────────────────────────
// Deduplication
// ──────────────────────────────────────────────

describe("deduplication", () => {
  it("skips duplicate delivery IDs", async () => {
    const companyId = randomUUID();
    const secretRef = randomUUID();
    const issue = makeIssue({ companyId, identifier: "TEN-73", githubRef: "tensorleap/fsd#414" });
    const harness = buildHarness(companyId, secretRef);
    harness.seed({ issues: [issue] });
    await plugin.definition.setup(harness.ctx);

    const deliveryId = randomUUID();
    const payload = {
      action: "opened",
      pull_request: { number: 414, title: "Fix" },
      repository: { full_name: "tensorleap/fsd" },
      sender: { login: "dev" },
    };

    const input1 = webhookInput({ secretRef, payload, eventType: "pull_request", deliveryId });
    const input2 = webhookInput({ secretRef, payload, eventType: "pull_request", deliveryId });

    await plugin.definition.onWebhook?.(input1);
    await plugin.definition.onWebhook?.(input2);

    const comments = await harness.ctx.issues.listComments(issue.id, companyId);
    expect(comments).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────
// Ignored event types
// ──────────────────────────────────────────────

describe("ignored event types", () => {
  it("silently drops push events", async () => {
    const companyId = randomUUID();
    const secretRef = randomUUID();
    const harness = buildHarness(companyId, secretRef);
    await plugin.definition.setup(harness.ctx);

    const payload = { ref: "refs/heads/main" };
    const input = webhookInput({ secretRef, payload, eventType: "push" });
    await expect(plugin.definition.onWebhook?.(input)).resolves.not.toThrow();
  });

  it("silently drops star events", async () => {
    const companyId = randomUUID();
    const secretRef = randomUUID();
    const harness = buildHarness(companyId, secretRef);
    await plugin.definition.setup(harness.ctx);

    const payload = { action: "created" };
    const input = webhookInput({ secretRef, payload, eventType: "star" });
    await expect(plugin.definition.onWebhook?.(input)).resolves.not.toThrow();
  });
});
