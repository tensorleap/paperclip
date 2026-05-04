import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin, { parseBranchIdentifier } from "../src/worker.js";

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function signPayload(secretRef: string, body: string): string {
  return `sha256=${createHmac("sha256", `resolved:${secretRef}`).update(body).digest("hex")}`;
}

/** Build a minimal seeded issue with required fields filled in. */
function makeIssue(partial: {
  id?: string;
  companyId: string;
  identifier: string;
  title?: string;
  status?: Issue["status"];
  assigneeAgentId?: string;
}): Issue {
  const now = new Date();
  return {
    id: partial.id ?? randomUUID(),
    companyId: partial.companyId,
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: partial.title ?? partial.identifier,
    description: null,
    status: partial.status ?? "in_progress",
    priority: "medium",
    assigneeAgentId: partial.assigneeAgentId ?? null,
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
// Branch parsing
// ──────────────────────────────────────────────

describe("parseBranchIdentifier", () => {
  it("parses standard convention branches", () => {
    expect(parseBranchIdentifier("ten-73-fix-auth-bug")).toBe("TEN-73");
    expect(parseBranchIdentifier("ten-131-something-long")).toBe("TEN-131");
    expect(parseBranchIdentifier("pap-224-add-feature")).toBe("PAP-224");
  });

  it("is case-insensitive on input", () => {
    expect(parseBranchIdentifier("TEN-73-fix")).toBe("TEN-73");
    expect(parseBranchIdentifier("TEN-73-Fix-Auth")).toBe("TEN-73");
  });

  it("returns null for non-matching branches", () => {
    expect(parseBranchIdentifier("feature/add-widget")).toBeNull();
    expect(parseBranchIdentifier("main")).toBeNull();
    expect(parseBranchIdentifier("hotfix-broken")).toBeNull();
    expect(parseBranchIdentifier("73-only-number")).toBeNull();
    expect(parseBranchIdentifier("")).toBeNull();
  });

  it("requires a trailing dash after the number", () => {
    // "ten-73" has no trailing dash, so it should not match
    expect(parseBranchIdentifier("ten-73")).toBeNull();
  });
});

// ──────────────────────────────────────────────
// Manifest
// ──────────────────────────────────────────────

describe("manifest", () => {
  it("declares required capabilities", () => {
    expect(manifest.capabilities).toEqual(
      expect.arrayContaining([
        "issues.read",
        "issues.wakeup",
        "issue.comments.create",
        "plugin.state.read",
        "plugin.state.write",
        "secrets.read-ref",
        "webhooks.receive",
      ]),
    );
  });

  it("declares github webhook endpoint", () => {
    expect(manifest.webhooks).toEqual([
      expect.objectContaining({ endpointKey: "github" }),
    ]);
  });

  it("requires companyId and webhookSecretRef in config schema", () => {
    expect(manifest.instanceConfigSchema?.required).toEqual(
      expect.arrayContaining(["companyId", "webhookSecretRef"]),
    );
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

  it("accepts a valid signature and processes the event", async () => {
    const companyId = randomUUID();
    const secretRef = randomUUID();
    const agentId = randomUUID();
    const issue = makeIssue({ companyId, identifier: "TEN-73", status: "in_progress", assigneeAgentId: agentId });
    const harness = buildHarness(companyId, secretRef);
    harness.seed({ issues: [issue] });
    await plugin.definition.setup(harness.ctx);

    const payload = {
      action: "opened",
      pull_request: { number: 1, head: { ref: "ten-73-branch" }, base: { ref: "main" }, merged: false },
    };
    const input = webhookInput({ secretRef, payload, eventType: "pull_request" });

    await expect(plugin.definition.onWebhook?.(input)).resolves.not.toThrow();
  });
});

// ──────────────────────────────────────────────
// pull_request.closed (merged)
// ──────────────────────────────────────────────

describe("pull_request merged", () => {
  it("posts comment on matched issue", async () => {
    const companyId = randomUUID();
    const secretRef = randomUUID();
    const agentId = randomUUID();
    const issue = makeIssue({
      companyId,
      identifier: "TEN-73",
      title: "Fix auth bug",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    const harness = buildHarness(companyId, secretRef);
    harness.seed({ issues: [issue] });
    await plugin.definition.setup(harness.ctx);

    const payload = {
      action: "closed",
      pull_request: {
        number: 414,
        title: "Fix auth regression",
        html_url: "https://github.com/org/repo/pull/414",
        merged: true,
        head: { ref: "ten-73-fix-auth-bug" },
        base: { ref: "main" },
        user: { login: "devuser" },
      },
      repository: { full_name: "org/repo" },
      sender: { login: "revieweruser" },
    };
    const input = webhookInput({ secretRef, payload, eventType: "pull_request" });

    await plugin.definition.onWebhook?.(input);

    const comments = await harness.ctx.issues.listComments(issue.id, companyId);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("pull_request.closed (merged)");
    expect(comments[0]?.body).toContain("#414 Fix auth regression");
    expect(comments[0]?.body).toContain("ten-73-fix-auth-bug");
    expect(comments[0]?.body).toContain("`main`");
    expect(comments[0]?.body).toContain("@revieweruser");
  });

  it("returns silently when branch does not match issue pattern", async () => {
    const companyId = randomUUID();
    const secretRef = randomUUID();
    const harness = buildHarness(companyId, secretRef);
    await plugin.definition.setup(harness.ctx);

    const payload = {
      action: "closed",
      pull_request: { number: 10, merged: true, head: { ref: "feature/no-ticket" }, base: { ref: "main" } },
    };
    const input = webhookInput({ secretRef, payload, eventType: "pull_request" });

    await expect(plugin.definition.onWebhook?.(input)).resolves.not.toThrow();
  });

  it("returns silently when matching issue is not found", async () => {
    const companyId = randomUUID();
    const secretRef = randomUUID();
    const harness = buildHarness(companyId, secretRef);
    await plugin.definition.setup(harness.ctx);

    const payload = {
      action: "closed",
      pull_request: { number: 10, merged: true, head: { ref: "ten-999-nonexistent" }, base: { ref: "main" } },
    };
    const input = webhookInput({ secretRef, payload, eventType: "pull_request" });

    await expect(plugin.definition.onWebhook?.(input)).resolves.not.toThrow();
  });

  it("ignores a non-merged closed PR", async () => {
    const companyId = randomUUID();
    const secretRef = randomUUID();
    const issue = makeIssue({ companyId, identifier: "TEN-73", status: "in_progress" });
    const harness = buildHarness(companyId, secretRef);
    harness.seed({ issues: [issue] });
    await plugin.definition.setup(harness.ctx);

    const payload = {
      action: "closed",
      pull_request: { number: 414, merged: false, head: { ref: "ten-73-fix-auth-bug" }, base: { ref: "main" } },
    };
    const input = webhookInput({ secretRef, payload, eventType: "pull_request" });

    await plugin.definition.onWebhook?.(input);

    const comments = await harness.ctx.issues.listComments(issue.id, companyId);
    expect(comments).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────
// pull_request.opened
// ──────────────────────────────────────────────

describe("pull_request opened", () => {
  it("posts comment on matched issue", async () => {
    const companyId = randomUUID();
    const secretRef = randomUUID();
    const agentId = randomUUID();
    const issue = makeIssue({
      companyId,
      identifier: "TEN-73",
      title: "Fix auth bug",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    const harness = buildHarness(companyId, secretRef);
    harness.seed({ issues: [issue] });
    await plugin.definition.setup(harness.ctx);

    const payload = {
      action: "opened",
      pull_request: {
        number: 414,
        title: "Fix auth regression",
        html_url: "https://github.com/org/repo/pull/414",
        merged: false,
        head: { ref: "ten-73-fix-auth-bug" },
        base: { ref: "main" },
        user: { login: "devuser" },
      },
      repository: { full_name: "org/repo" },
    };
    const input = webhookInput({ secretRef, payload, eventType: "pull_request" });

    await plugin.definition.onWebhook?.(input);

    const comments = await harness.ctx.issues.listComments(issue.id, companyId);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("pull_request.opened");
    expect(comments[0]?.body).toContain("#414 Fix auth regression");
    expect(comments[0]?.body).toContain("@devuser");
  });
});

// ──────────────────────────────────────────────
// pull_request_review.submitted
// ──────────────────────────────────────────────

describe("pull_request_review submitted", () => {
  it("posts comment for changes_requested review", async () => {
    const companyId = randomUUID();
    const secretRef = randomUUID();
    const agentId = randomUUID();
    const issue = makeIssue({
      companyId,
      identifier: "TEN-73",
      title: "Fix auth bug",
      status: "in_review",
      assigneeAgentId: agentId,
    });
    const harness = buildHarness(companyId, secretRef);
    harness.seed({ issues: [issue] });
    await plugin.definition.setup(harness.ctx);

    const payload = {
      action: "submitted",
      review: {
        state: "changes_requested",
        html_url: "https://github.com/org/repo/pull/414#pullrequestreview-1",
        body: "Please address comments",
        user: { login: "reviewer" },
      },
      pull_request: {
        number: 414,
        title: "Fix auth regression",
        html_url: "https://github.com/org/repo/pull/414",
        head: { ref: "ten-73-fix-auth-bug" },
      },
      repository: { full_name: "org/repo" },
      sender: { login: "reviewer" },
    };
    const input = webhookInput({ secretRef, payload, eventType: "pull_request_review" });

    await plugin.definition.onWebhook?.(input);

    const comments = await harness.ctx.issues.listComments(issue.id, companyId);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("pull_request_review.submitted");
    expect(comments[0]?.body).toContain("changes requested");
    expect(comments[0]?.body).toContain("@reviewer");
  });

  it("posts comment for approved review", async () => {
    const companyId = randomUUID();
    const secretRef = randomUUID();
    const agentId = randomUUID();
    const issue = makeIssue({
      companyId,
      identifier: "TEN-73",
      status: "in_review",
      assigneeAgentId: agentId,
    });
    const harness = buildHarness(companyId, secretRef);
    harness.seed({ issues: [issue] });
    await plugin.definition.setup(harness.ctx);

    const payload = {
      action: "submitted",
      review: { state: "approved", user: { login: "approver" } },
      pull_request: {
        number: 414,
        head: { ref: "ten-73-fix-auth-bug" },
      },
      sender: { login: "approver" },
    };
    const input = webhookInput({ secretRef, payload, eventType: "pull_request_review" });

    await plugin.definition.onWebhook?.(input);

    const comments = await harness.ctx.issues.listComments(issue.id, companyId);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("pull_request_review.submitted");
    expect(comments[0]?.body).toContain("approved");
  });

  it("ignores non-submitted review actions", async () => {
    const companyId = randomUUID();
    const secretRef = randomUUID();
    const issue = makeIssue({ companyId, identifier: "TEN-73", status: "in_review" });
    const harness = buildHarness(companyId, secretRef);
    harness.seed({ issues: [issue] });
    await plugin.definition.setup(harness.ctx);

    const payload = {
      action: "dismissed",
      review: { state: "dismissed" },
      pull_request: { number: 414, head: { ref: "ten-73-fix-auth-bug" } },
    };
    const input = webhookInput({ secretRef, payload, eventType: "pull_request_review" });

    await plugin.definition.onWebhook?.(input);

    const comments = await harness.ctx.issues.listComments(issue.id, companyId);
    expect(comments).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────
// Unmatched events
// ──────────────────────────────────────────────

describe("unmatched events", () => {
  it("returns silently for unsupported event types", async () => {
    const companyId = randomUUID();
    const secretRef = randomUUID();
    const harness = buildHarness(companyId, secretRef);
    await plugin.definition.setup(harness.ctx);

    const payload = { action: "created", issue: { number: 1 } };
    const input = webhookInput({ secretRef, payload, eventType: "issues" });

    await expect(plugin.definition.onWebhook?.(input)).resolves.not.toThrow();
  });

  it("returns silently for push events", async () => {
    const companyId = randomUUID();
    const secretRef = randomUUID();
    const harness = buildHarness(companyId, secretRef);
    await plugin.definition.setup(harness.ctx);

    const payload = { ref: "refs/heads/main" };
    const input = webhookInput({ secretRef, payload, eventType: "push" });

    await expect(plugin.definition.onWebhook?.(input)).resolves.not.toThrow();
  });
});

// ──────────────────────────────────────────────
// Deduplication
// ──────────────────────────────────────────────

describe("deduplication", () => {
  it("skips duplicate delivery IDs", async () => {
    const companyId = randomUUID();
    const secretRef = randomUUID();
    const agentId = randomUUID();
    const issue = makeIssue({
      companyId,
      identifier: "TEN-73",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    const harness = buildHarness(companyId, secretRef);
    harness.seed({ issues: [issue] });
    await plugin.definition.setup(harness.ctx);

    const deliveryId = randomUUID();
    const payload = {
      action: "closed",
      pull_request: {
        number: 1,
        merged: true,
        head: { ref: "ten-73-fix-auth-bug" },
        base: { ref: "main" },
      },
    };

    const input1 = webhookInput({ secretRef, payload, eventType: "pull_request", deliveryId });
    const input2 = webhookInput({ secretRef, payload, eventType: "pull_request", deliveryId });

    await plugin.definition.onWebhook?.(input1);
    await plugin.definition.onWebhook?.(input2);

    const comments = await harness.ctx.issues.listComments(issue.id, companyId);
    // Only one comment despite two deliveries with same ID
    expect(comments).toHaveLength(1);
  });
});
