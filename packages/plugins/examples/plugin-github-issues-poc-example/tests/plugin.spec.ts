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
        "issue.work_products.read",
        "issue.work_products.write",
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

  it("routes review and merge updates through linked pull request work products", async () => {
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
    await harness.ctx.issues.update(mappedIssue.id, { status: "in_review" }, companyId);

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
        state: "open",
        draft: false,
        merged: false,
        head: { ref: "docs/pr-28", sha: "headsha28" },
        base: { ref: "master", sha: "basesha28" },
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

    const reviewPayload = {
      action: "submitted",
      repository: { full_name: "tensorleap/concierge" },
      sender: { login: "reviewer" },
      pull_request: {
        number: 28,
        title: "Clarify onboarding docs",
        body: "Closes #17",
        html_url: "https://github.com/tensorleap/concierge/pull/28",
        state: "open",
        draft: false,
        merged: false,
        review_decision: "approved",
        head: { ref: "docs/pr-28", sha: "headsha28" },
        base: { ref: "master", sha: "basesha28" },
      },
      review: {
        body: "Looks good to me.",
        html_url: "https://github.com/tensorleap/concierge/pull/28#pullrequestreview-1",
        state: "approved",
        user: { login: "reviewer" },
      },
    };
    const reviewBody = JSON.stringify(reviewPayload);
    await plugin.definition.onWebhook?.({
      endpointKey: "github",
      requestId: "req-6-review",
      headers: {
        "x-github-delivery": "delivery-6-review",
        "x-github-event": "pull_request_review",
        "x-hub-signature-256": signWebhook(secretRef, reviewBody),
      },
      rawBody: reviewBody,
      parsedBody: reviewPayload,
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
        state: "open",
        draft: false,
        merged: false,
        head: { ref: "docs/pr-28", sha: "headsha28" },
        base: { ref: "master", sha: "basesha28" },
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

    const mergedPullRequestPayload = {
      action: "closed",
      number: 28,
      repository: { full_name: "tensorleap/concierge" },
      sender: { login: "octocat" },
      pull_request: {
        number: 28,
        title: "Clarify onboarding docs",
        body: "Closes #17",
        html_url: "https://github.com/tensorleap/concierge/pull/28",
        state: "closed",
        draft: false,
        merged: true,
        head: { ref: "docs/pr-28", sha: "headsha28" },
        base: { ref: "master", sha: "basesha28" },
      },
    };
    const mergedPullRequestBody = JSON.stringify(mergedPullRequestPayload);
    await plugin.definition.onWebhook?.({
      endpointKey: "github",
      requestId: "req-7-merged",
      headers: {
        "x-github-delivery": "delivery-7-merged",
        "x-github-event": "pull_request",
        "x-hub-signature-256": signWebhook(secretRef, mergedPullRequestBody),
      },
      rawBody: mergedPullRequestBody,
      parsedBody: mergedPullRequestPayload,
    });

    const comments = await harness.ctx.issues.listComments(mappedIssue.id, companyId);
    expect(comments.some((comment) => comment.body.includes("GitHub pull_request.opened: tensorleap/concierge#28"))).toBe(true);
    expect(comments.some((comment) => comment.body.includes("Linked issue: tensorleap/concierge#17"))).toBe(true);
    expect(comments.some((comment) => comment.body.includes("GitHub pull_request_review.submitted: tensorleap/concierge#28"))).toBe(true);
    expect(comments.some((comment) => comment.body.includes("Review state: approved"))).toBe(true);
    expect(comments.some((comment) => comment.body.includes("GitHub pull_request_review_comment.created: tensorleap/concierge#28"))).toBe(true);
    expect(comments.some((comment) => comment.body.includes("Inline nit on the wording here."))).toBe(true);
    expect(comments.some((comment) => comment.body.includes("GitHub pull_request.closed: tensorleap/concierge#28"))).toBe(true);
    expect(comments.some((comment) => comment.body.includes("Paperclip status set to `done`."))).toBe(true);
    const updatedIssue = await harness.ctx.issues.get(mappedIssue.id, companyId);
    expect(updatedIssue?.status).toBe("done");
    expect(updatedIssue?.description).toContain("- Last GitHub delivery id: `delivery-7-merged`");

    const workProducts = await harness.ctx.issues.workProducts.list(mappedIssue.id, companyId);
    expect(workProducts).toHaveLength(1);
    expect(workProducts[0]).toEqual(expect.objectContaining({
      type: "pull_request",
      provider: "github",
      externalId: "tensorleap/concierge#28",
      title: "Clarify onboarding docs",
      url: "https://github.com/tensorleap/concierge/pull/28",
      status: "merged",
      reviewState: "approved",
      isPrimary: true,
      metadata: expect.objectContaining({
        repositoryFullName: "tensorleap/concierge",
        pullRequestNumber: 28,
        state: "closed",
        merged: true,
        reviewState: "approved",
        headRef: "docs/pr-28",
        headSha: "headsha28",
        baseRef: "master",
        baseSha: "basesha28",
      }),
    }));
  });

  it("dedupes check updates until pull request actionability changes", async () => {
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
      requestId: "req-check-1",
      headers: {
        "x-github-delivery": "delivery-check-1",
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
        state: "open",
        draft: false,
        merged: false,
        head: { ref: "docs/pr-28", sha: "headsha28" },
        base: { ref: "master", sha: "basesha28" },
      },
    };
    const pullRequestBody = JSON.stringify(pullRequestPayload);
    await plugin.definition.onWebhook?.({
      endpointKey: "github",
      requestId: "req-check-2",
      headers: {
        "x-github-delivery": "delivery-check-2",
        "x-github-event": "pull_request",
        "x-hub-signature-256": signWebhook(secretRef, pullRequestBody),
      },
      rawBody: pullRequestBody,
      parsedBody: pullRequestPayload,
    });

    const failingSuitePayload = {
      action: "completed",
      repository: { full_name: "tensorleap/concierge" },
      sender: { login: "github-actions[bot]" },
      check_suite: {
        status: "completed",
        conclusion: "failure",
        head_branch: "docs/pr-28",
        head_sha: "headsha28",
        html_url: "https://github.com/tensorleap/concierge/actions/runs/1",
        pull_requests: [{ number: 28 }],
        app: { name: "GitHub Actions" },
      },
    };
    const failingSuiteBody = JSON.stringify(failingSuitePayload);
    await plugin.definition.onWebhook?.({
      endpointKey: "github",
      requestId: "req-check-3",
      headers: {
        "x-github-delivery": "delivery-check-3",
        "x-github-event": "check_suite",
        "x-hub-signature-256": signWebhook(secretRef, failingSuiteBody),
      },
      rawBody: failingSuiteBody,
      parsedBody: failingSuitePayload,
    });
    await plugin.definition.onWebhook?.({
      endpointKey: "github",
      requestId: "req-check-4",
      headers: {
        "x-github-delivery": "delivery-check-4",
        "x-github-event": "check_suite",
        "x-hub-signature-256": signWebhook(secretRef, failingSuiteBody),
      },
      rawBody: failingSuiteBody,
      parsedBody: failingSuitePayload,
    });

    const passingSuitePayload = {
      ...failingSuitePayload,
      check_suite: {
        ...failingSuitePayload.check_suite,
        conclusion: "success",
        html_url: "https://github.com/tensorleap/concierge/actions/runs/2",
      },
    };
    const passingSuiteBody = JSON.stringify(passingSuitePayload);
    await plugin.definition.onWebhook?.({
      endpointKey: "github",
      requestId: "req-check-5",
      headers: {
        "x-github-delivery": "delivery-check-5",
        "x-github-event": "check_suite",
        "x-hub-signature-256": signWebhook(secretRef, passingSuiteBody),
      },
      rawBody: passingSuiteBody,
      parsedBody: passingSuitePayload,
    });

    const failingRunPayload = {
      action: "completed",
      repository: { full_name: "tensorleap/concierge" },
      sender: { login: "github-actions[bot]" },
      check_run: {
        name: "lint",
        status: "completed",
        conclusion: "failure",
        details_url: "https://github.com/tensorleap/concierge/actions/runs/3",
        html_url: "https://github.com/tensorleap/concierge/actions/runs/3",
        head_sha: "headsha28",
        output: {
          title: "Lint",
          summary: "Style failures.",
        },
        pull_requests: [{ number: 28 }],
      },
    };
    const failingRunBody = JSON.stringify(failingRunPayload);
    await plugin.definition.onWebhook?.({
      endpointKey: "github",
      requestId: "req-check-6",
      headers: {
        "x-github-delivery": "delivery-check-6",
        "x-github-event": "check_run",
        "x-hub-signature-256": signWebhook(secretRef, failingRunBody),
      },
      rawBody: failingRunBody,
      parsedBody: failingRunPayload,
    });
    await plugin.definition.onWebhook?.({
      endpointKey: "github",
      requestId: "req-check-7",
      headers: {
        "x-github-delivery": "delivery-check-7",
        "x-github-event": "check_run",
        "x-hub-signature-256": signWebhook(secretRef, failingRunBody),
      },
      rawBody: failingRunBody,
      parsedBody: failingRunPayload,
    });

    const comments = await harness.ctx.issues.listComments(mappedIssue.id, companyId);
    const suiteComments = comments.filter((comment) => comment.body.includes("GitHub check_suite.completed: tensorleap/concierge#28"));
    const runComments = comments.filter((comment) => comment.body.includes("GitHub check_run.completed: tensorleap/concierge#28"));
    expect(suiteComments).toHaveLength(2);
    expect(suiteComments.some((comment) => comment.body.includes("Actionability: failed"))).toBe(true);
    expect(suiteComments.some((comment) => comment.body.includes("Actionability: passed"))).toBe(true);
    expect(runComments).toHaveLength(1);
    expect(runComments[0]?.body).toContain("Actionability: failed");

    const workProducts = await harness.ctx.issues.workProducts.list(mappedIssue.id, companyId);
    expect(workProducts[0]).toEqual(expect.objectContaining({
      externalId: "tensorleap/concierge#28",
      healthStatus: "unhealthy",
      metadata: expect.objectContaining({
        checks: expect.objectContaining({
          actionability: "failed",
        }),
        checkSuites: expect.objectContaining({
          "GitHub Actions": expect.objectContaining({
            conclusion: "success",
          }),
        }),
        checkRuns: expect.objectContaining({
          lint: expect.objectContaining({
            conclusion: "failure",
          }),
        }),
      }),
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

  it("wakes a manually-created Paperclip issue when its PR URL appears in comments (originKind: manual recovery)", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const ceoAgentId = randomUUID();
    const secretRef = randomUUID();
    const harness = createTestHarness({
      manifest,
      capabilities: manifest.capabilities,
      config: buildConfig({ companyId, projectId, assigneeAgentId: ceoAgentId, secretRef }),
    });
    await plugin.definition.setup(harness.ctx);

    // Simulate a manually-created Paperclip issue (no GitHub origin).
    const manualIssue = await harness.ctx.issues.create({
      companyId,
      projectId,
      title: "Implement feature X",
      status: "in_progress",
      assigneeAgentId: ceoAgentId,
    });

    // Simulate an agent posting the PR URL into the Paperclip issue comments.
    const prUrl = "https://github.com/tensorleap/concierge/pull/389";
    await harness.ctx.issues.createComment(manualIssue.id, `Opened PR: ${prUrl}`, companyId);

    // Deliver a pull_request_review webhook for that PR.
    const reviewPayload = {
      action: "submitted",
      repository: { full_name: "tensorleap/concierge" },
      sender: { login: "reviewer" },
      pull_request: {
        number: 389,
        title: "Implement feature X",
        body: "Some work done.",
        html_url: prUrl,
        state: "open",
        draft: false,
        merged: false,
        review_decision: null,
        head: { ref: "feature-x", sha: "abc123" },
        base: { ref: "main", sha: "def456" },
      },
      review: {
        body: "Looks good!",
        html_url: `${prUrl}#pullrequestreview-1`,
        state: "approved",
        user: { login: "reviewer" },
      },
    };
    const reviewBody = JSON.stringify(reviewPayload);
    await plugin.definition.onWebhook?.({
      endpointKey: "github",
      requestId: "req-manual-review",
      headers: {
        "x-github-delivery": "delivery-manual-review",
        "x-github-event": "pull_request_review",
        "x-hub-signature-256": signWebhook(secretRef, reviewBody),
      },
      rawBody: reviewBody,
      parsedBody: reviewPayload,
    });

    // The issue should have received a PR review comment via the recovery path.
    const comments = await harness.ctx.issues.listComments(manualIssue.id, companyId);
    expect(comments.some((c) => c.body.includes("GitHub pull_request_review.submitted: tensorleap/concierge#389"))).toBe(true);

    // A work product should have been attached so subsequent events resolve without re-scanning.
    const workProducts = await harness.ctx.issues.workProducts.list(manualIssue.id, companyId);
    expect(workProducts.some((wp) => wp.externalId === "tensorleap/concierge#389")).toBe(true);
  });
});
