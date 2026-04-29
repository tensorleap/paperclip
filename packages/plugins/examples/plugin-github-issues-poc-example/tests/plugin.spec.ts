import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

function buildConfig(input: {
  companyId: string;
  projectId: string;
  assigneeAgentId: string;
  secretRef: string;
}) {
  return {
    companyId: input.companyId,
    projectId: input.projectId,
    webhookSecretRef: input.secretRef,
    repositoryFullName: "tensorleap/concierge",
    syncMode: "inbound_only",
    assigneeRoutes: [
      {
        githubAssigneeLogin: "marvin-tensorleap",
        paperclipAssigneeAgentId: input.assigneeAgentId,
        paperclipAssigneeLabel: "CEO",
      },
    ],
    issueTitlePrefix: "[GitHub]",
  };
}

function signWebhook(secretRef: string, body: string): string {
  return `sha256=${createHmac("sha256", `resolved:${secretRef}`).update(body).digest("hex")}`;
}

describe("github concierge webhook plugin", () => {
  it("declares webhook + issue mutation capabilities", () => {
    expect(manifest).toMatchObject({
      id: "paperclipai.plugin-github-issues-poc-example",
      capabilities: expect.arrayContaining([
        "issues.read",
        "issues.create",
        "issues.update",
        "issues.wakeup",
        "issue.comments.create",
        "plugin.state.read",
        "plugin.state.write",
        "secrets.read-ref",
        "webhooks.receive",
      ]),
      webhooks: [
        expect.objectContaining({ endpointKey: "github" }),
      ],
      instanceConfigSchema: expect.objectContaining({
        properties: expect.objectContaining({
          syncMode: expect.any(Object),
          assigneeRoutes: expect.any(Object),
        }),
      }),
    });
  });

  it("creates a Concierge Paperclip issue when Marvin is assigned on GitHub", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const ceoAgentId = randomUUID();
    const secretRef = randomUUID();
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities, "issue.comments.read"],
      config: buildConfig({ companyId, projectId, assigneeAgentId: ceoAgentId, secretRef }),
    });
    await plugin.definition.setup(harness.ctx);

    const payload = {
      action: "assigned",
      repository: { full_name: "tensorleap/concierge" },
      sender: { login: "octocat" },
      assignee: { login: "marvin-tensorleap" },
      issue: {
        number: 17,
        title: "Improve onboarding instructions",
        body: "Make Concierge handoff clearer for new repos.",
        html_url: "https://github.com/tensorleap/concierge/issues/17",
        assignees: [{ login: "marvin-tensorleap" }],
      },
    };
    const rawBody = JSON.stringify(payload);

    await plugin.definition.onWebhook?.({
      endpointKey: "github",
      requestId: "req-1",
      headers: {
        "x-github-delivery": "delivery-1",
        "x-github-event": "issues",
        "x-hub-signature-256": signWebhook(secretRef, rawBody),
      },
      rawBody,
      parsedBody: payload,
    });

    const issues = await harness.ctx.issues.list({ companyId });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual(expect.objectContaining({
      projectId,
      assigneeAgentId: ceoAgentId,
      title: "[GitHub] Improve onboarding instructions",
      originKind: "plugin:paperclipai.plugin-github-issues-poc-example",
      originId: "tensorleap/concierge#17",
    }));
    expect(issues[0]?.description).toContain("## Source Mirror");
    expect(issues[0]?.description).toContain("- GitHub repository: `tensorleap/concierge`");
    expect(issues[0]?.description).toContain("- GitHub issue number: `17`");
    expect(issues[0]?.description).toContain("- Source URL: https://github.com/tensorleap/concierge/issues/17");
    expect(issues[0]?.description).toContain("- GitHub assignee login: `marvin-tensorleap`");
    expect(issues[0]?.description).toContain("- Mapped Paperclip assignee: CEO");
    expect(issues[0]?.description).toContain("- Sync mode: `inbound_only`");
    expect(issues[0]?.description).toContain("- Last GitHub delivery id: `delivery-1`");

    const createdIssueId = issues[0]!.id;
    const comments = await harness.ctx.issues.listComments(createdIssueId, companyId);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("GitHub issue linked: tensorleap/concierge#17");
    expect(comments[0]?.body).toContain("Mapped Paperclip assignee: CEO");
    expect(comments[0]?.body).toContain("Paperclip wake requested.");

    expect(
      harness.getState({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: "github:issue:tensorleap/concierge#17",
      }),
    ).toEqual(expect.objectContaining({
      paperclipIssueId: createdIssueId,
      githubIssueKey: "tensorleap/concierge#17",
      trackedGitHubAssigneeLogin: "marvin-tensorleap",
      mappedPaperclipAssigneeAgentId: ceoAgentId,
      mappedPaperclipAssigneeLabel: "CEO",
      syncMode: "inbound_only",
      lastDeliveryId: "delivery-1",
    }));
  });

  it("mirrors issue comments and closes the mapped Paperclip issue", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const ceoAgentId = randomUUID();
    const secretRef = randomUUID();
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities, "issue.comments.read"],
      config: buildConfig({ companyId, projectId, assigneeAgentId: ceoAgentId, secretRef }),
    });
    await plugin.definition.setup(harness.ctx);

    const createPayload = {
      action: "assigned",
      repository: { full_name: "tensorleap/concierge" },
      sender: { login: "octocat" },
      assignee: { login: "marvin-tensorleap" },
      issue: {
        number: 17,
        title: "Improve onboarding instructions",
        body: "Make Concierge handoff clearer for new repos.",
        html_url: "https://github.com/tensorleap/concierge/issues/17",
        assignees: [{ login: "marvin-tensorleap" }],
      },
    };
    const createBody = JSON.stringify(createPayload);
    await plugin.definition.onWebhook?.({
      endpointKey: "github",
      requestId: "req-2",
      headers: {
        "x-github-delivery": "delivery-2",
        "x-github-event": "issues",
        "x-hub-signature-256": signWebhook(secretRef, createBody),
      },
      rawBody: createBody,
      parsedBody: createPayload,
    });

    const mappedIssue = (await harness.ctx.issues.list({ companyId }))[0]!;

    const commentPayload = {
      action: "created",
      repository: { full_name: "tensorleap/concierge" },
      sender: { login: "reviewer" },
      issue: {
        number: 17,
        title: "Improve onboarding instructions",
        body: "Make Concierge handoff clearer for new repos.",
        html_url: "https://github.com/tensorleap/concierge/issues/17",
        assignees: [{ login: "marvin-tensorleap" }],
      },
      comment: {
        body: "Please tighten the docs before release.",
        html_url: "https://github.com/tensorleap/concierge/issues/17#issuecomment-1",
        user: { login: "reviewer" },
      },
    };
    const commentBody = JSON.stringify(commentPayload);
    await plugin.definition.onWebhook?.({
      endpointKey: "github",
      requestId: "req-3",
      headers: {
        "x-github-delivery": "delivery-3",
        "x-github-event": "issue_comment",
        "x-hub-signature-256": signWebhook(secretRef, commentBody),
      },
      rawBody: commentBody,
      parsedBody: commentPayload,
    });

    const closePayload = {
      action: "closed",
      repository: { full_name: "tensorleap/concierge" },
      sender: { login: "octocat" },
      issue: {
        number: 17,
        title: "Improve onboarding instructions",
        body: "Make Concierge handoff clearer for new repos.",
        html_url: "https://github.com/tensorleap/concierge/issues/17",
        assignees: [{ login: "marvin-tensorleap" }],
      },
    };
    const closeBody = JSON.stringify(closePayload);
    await plugin.definition.onWebhook?.({
      endpointKey: "github",
      requestId: "req-4",
      headers: {
        "x-github-delivery": "delivery-4",
        "x-github-event": "issues",
        "x-hub-signature-256": signWebhook(secretRef, closeBody),
      },
      rawBody: closeBody,
      parsedBody: closePayload,
    });

    await expect(harness.ctx.issues.get(mappedIssue.id, companyId)).resolves.toEqual(
      expect.objectContaining({ status: "done" }),
    );
    const updatedIssue = await harness.ctx.issues.get(mappedIssue.id, companyId);
    expect(updatedIssue?.description).toContain("- Last GitHub delivery id: `delivery-4`");
    expect(updatedIssue?.description).toContain("- Sync mode: `inbound_only`");
    const comments = await harness.ctx.issues.listComments(mappedIssue.id, companyId);
    expect(comments.at(-2)?.body).toContain("GitHub issue_comment.created: tensorleap/concierge#17");
    expect(comments.at(-2)?.body).toContain("Please tighten the docs before release.");
    expect(comments.at(-1)?.body).toContain("GitHub issues.closed: tensorleap/concierge#17");
    expect(comments.at(-1)?.body).toContain("Paperclip status set to `done`.");
  });

  it("mirrors related pull request updates and PR review comments back to the mapped issue", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const ceoAgentId = randomUUID();
    const secretRef = randomUUID();
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities, "issue.comments.read"],
      config: buildConfig({ companyId, projectId, assigneeAgentId: ceoAgentId, secretRef }),
    });
    await plugin.definition.setup(harness.ctx);

    const issuePayload = {
      action: "assigned",
      repository: { full_name: "tensorleap/concierge" },
      sender: { login: "octocat" },
      assignee: { login: "marvin-tensorleap" },
      issue: {
        number: 17,
        title: "Improve onboarding instructions",
        body: "Make Concierge handoff clearer for new repos.",
        html_url: "https://github.com/tensorleap/concierge/issues/17",
        assignees: [{ login: "marvin-tensorleap" }],
      },
    };
    const issueBody = JSON.stringify(issuePayload);
    await plugin.definition.onWebhook?.({
      endpointKey: "github",
      requestId: "req-5",
      headers: {
        "x-github-delivery": "delivery-5",
        "x-github-event": "issues",
        "x-hub-signature-256": signWebhook(secretRef, issueBody),
      },
      rawBody: issueBody,
      parsedBody: issuePayload,
    });

    const mappedIssue = (await harness.ctx.issues.list({ companyId }))[0]!;

    const pullRequestPayload = {
      action: "opened",
      number: 28,
      repository: { full_name: "tensorleap/concierge" },
      sender: { login: "octocat" },
      pull_request: {
        number: 28,
        title: "Clarify onboarding docs",
        body: "Closes #17",
        html_url: "https://github.com/tensorleap/concierge/pull/28",
        draft: false,
        merged: false,
      },
    };
    const pullRequestBody = JSON.stringify(pullRequestPayload);
    await plugin.definition.onWebhook?.({
      endpointKey: "github",
      requestId: "req-6",
      headers: {
        "x-github-delivery": "delivery-6",
        "x-github-event": "pull_request",
        "x-hub-signature-256": signWebhook(secretRef, pullRequestBody),
      },
      rawBody: pullRequestBody,
      parsedBody: pullRequestPayload,
    });

    const reviewCommentPayload = {
      action: "created",
      repository: { full_name: "tensorleap/concierge" },
      sender: { login: "reviewer" },
      pull_request: {
        number: 28,
        title: "Clarify onboarding docs",
        body: "Closes #17",
        html_url: "https://github.com/tensorleap/concierge/pull/28",
        draft: false,
        merged: false,
      },
      comment: {
        body: "Inline nit on the wording here.",
        html_url: "https://github.com/tensorleap/concierge/pull/28#discussion_r1",
        user: { login: "reviewer" },
      },
    };
    const reviewCommentBody = JSON.stringify(reviewCommentPayload);
    await plugin.definition.onWebhook?.({
      endpointKey: "github",
      requestId: "req-7",
      headers: {
        "x-github-delivery": "delivery-7",
        "x-github-event": "pull_request_review_comment",
        "x-hub-signature-256": signWebhook(secretRef, reviewCommentBody),
      },
      rawBody: reviewCommentBody,
      parsedBody: reviewCommentPayload,
    });

    const comments = await harness.ctx.issues.listComments(mappedIssue.id, companyId);
    expect(comments.at(-2)?.body).toContain("GitHub pull_request.opened: tensorleap/concierge#28");
    expect(comments.at(-2)?.body).toContain("Linked issue: tensorleap/concierge#17");
    expect(comments.at(-1)?.body).toContain("GitHub pull_request_review_comment.created: tensorleap/concierge#28");
    expect(comments.at(-1)?.body).toContain("Inline nit on the wording here.");
    const updatedIssue = await harness.ctx.issues.get(mappedIssue.id, companyId);
    expect(updatedIssue?.description).toContain("- Last GitHub delivery id: `delivery-7`");

    expect(
      harness.getState({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: "github:pull-request:tensorleap/concierge#28",
      }),
    ).toEqual(expect.objectContaining({
      paperclipIssueId: mappedIssue.id,
      githubIssueKey: "tensorleap/concierge#17",
    }));
  });

  it("dedupes redeliveries and rejects invalid signatures", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const ceoAgentId = randomUUID();
    const secretRef = randomUUID();
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities, "issue.comments.read"],
      config: buildConfig({ companyId, projectId, assigneeAgentId: ceoAgentId, secretRef }),
    });
    await plugin.definition.setup(harness.ctx);

    const payload = {
      action: "assigned",
      repository: { full_name: "tensorleap/concierge" },
      sender: { login: "octocat" },
      assignee: { login: "marvin-tensorleap" },
      issue: {
        number: 17,
        title: "Improve onboarding instructions",
        body: "Make Concierge handoff clearer for new repos.",
        html_url: "https://github.com/tensorleap/concierge/issues/17",
        assignees: [{ login: "marvin-tensorleap" }],
      },
    };
    const rawBody = JSON.stringify(payload);
    const signature = signWebhook(secretRef, rawBody);

    await plugin.definition.onWebhook?.({
      endpointKey: "github",
      requestId: "req-8",
      headers: {
        "x-github-delivery": "delivery-8",
        "x-github-event": "issues",
        "x-hub-signature-256": signature,
      },
      rawBody,
      parsedBody: payload,
    });

    await plugin.definition.onWebhook?.({
      endpointKey: "github",
      requestId: "req-9",
      headers: {
        "x-github-delivery": "delivery-8",
        "x-github-event": "issues",
        "x-hub-signature-256": signature,
      },
      rawBody,
      parsedBody: payload,
    });

    await expect(plugin.definition.onWebhook?.({
      endpointKey: "github",
      requestId: "req-10",
      headers: {
        "x-github-delivery": "delivery-9",
        "x-github-event": "issues",
        "x-hub-signature-256": "sha256=invalid",
      },
      rawBody,
      parsedBody: payload,
    })).rejects.toThrow("Invalid GitHub webhook signature");

    const issues = await harness.ctx.issues.list({ companyId });
    expect(issues).toHaveLength(1);
    expect(
      harness.getState({
        scopeKind: "instance",
        stateKey: "github:delivery:delivery-8",
      }),
    ).toEqual(expect.objectContaining({
      processed: true,
      reason: "issues:assigned:created",
    }));
    expect(
      harness.getState({
        scopeKind: "instance",
        stateKey: "github:delivery:delivery-9",
      }),
    ).toBeUndefined();
  });
});
