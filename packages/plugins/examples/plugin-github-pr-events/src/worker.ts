import { createHmac, timingSafeEqual } from "node:crypto";
import { definePlugin, runWorker, type PluginContext, type PluginWebhookInput } from "@paperclipai/plugin-sdk";
import type { Issue } from "@paperclipai/shared";

const WEBHOOK_ENDPOINT_KEY = "github";
const LAST_DELIVERY_KEY = "github-pr:last-delivery";

// Delivery state stored per delivery ID for deduplication.
type DeliveryState = {
  deliveryId: string;
  requestId: string;
  eventType: string;
  action: string;
  processedAt: string;
  processed: boolean;
  reason: string;
  matchedIssueId: string | null;
};

type PluginConfig = {
  companyId: string;
  webhookSecretRef: string;
};

// Minimal GitHub payload shapes — we only extract what we need.
type GitHubPullRequest = {
  number?: unknown;
  title?: unknown;
  html_url?: unknown;
  merged?: unknown;
  head?: { ref?: unknown } | null;
  base?: { ref?: unknown } | null;
  user?: { login?: unknown } | null;
};

type GitHubPullRequestPayload = {
  action?: unknown;
  pull_request?: GitHubPullRequest | null;
  repository?: { full_name?: unknown } | null;
  sender?: { login?: unknown } | null;
};

type GitHubPullRequestReview = {
  state?: unknown;
  html_url?: unknown;
  body?: unknown;
  user?: { login?: unknown } | null;
};

type GitHubPullRequestReviewPayload = {
  action?: unknown;
  review?: GitHubPullRequestReview | null;
  pull_request?: GitHubPullRequest | null;
  repository?: { full_name?: unknown } | null;
  sender?: { login?: unknown } | null;
};

// ──────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function getHeader(headers: Record<string, string | string[]>, name: string): string | null {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== target) continue;
    if (typeof v === "string") return str(v);
    if (Array.isArray(v)) {
      const first = v.find((e): e is string => typeof e === "string" && e.trim().length > 0);
      return first ? str(first) : null;
    }
  }
  return null;
}

function computeGitHubSignature(secret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

function verifyGitHubSignature(secret: string, rawBody: string, signatureHeader: string): void {
  const expected = Buffer.from(computeGitHubSignature(secret, rawBody), "utf8");
  const actual = Buffer.from(signatureHeader, "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("Invalid GitHub webhook signature");
  }
}

/**
 * Parse a Paperclip issue identifier from a Git branch name.
 *
 * Convention: `{prefix-lower}-{number}-{slug}` → `{PREFIX}-{NUMBER}`
 * Example: `ten-73-fix-auth-bug` → `TEN-73`
 */
export function parseBranchIdentifier(branchRef: string): string | null {
  const match = /^([a-z]+)-(\d+)-/.exec(branchRef.toLowerCase().trim());
  if (!match) return null;
  const prefix = match[1];
  const number = match[2];
  if (!prefix || !number) return null;
  return `${prefix.toUpperCase()}-${number}`;
}

/**
 * Find an issue by its identifier string (e.g. "TEN-73") across active statuses.
 * Pages through non-done issues to avoid full-table cost.
 */
async function findIssueByIdentifier(
  ctx: PluginContext,
  companyId: string,
  identifier: string,
): Promise<Issue | null> {
  const activeStatuses = ["in_progress", "in_review", "todo", "blocked"] as const;
  const pageSize = 50;

  for (const status of activeStatuses) {
    let offset = 0;
    while (true) {
      const issues = await ctx.issues.list({ companyId, status, limit: pageSize, offset });
      for (const issue of issues) {
        if (issue.identifier === identifier) return issue;
      }
      if (issues.length < pageSize) break;
      offset += pageSize;
    }
  }
  return null;
}

function deliveryStateKey(deliveryId: string): string {
  return `github-pr:delivery:${deliveryId}`;
}

// ──────────────────────────────────────────────
// Comment builders
// ──────────────────────────────────────────────

function buildPrMergedComment(input: {
  prNumber: number;
  prTitle: string | null;
  prUrl: string | null;
  baseBranch: string | null;
  headBranch: string | null;
  mergedBy: string | null;
  mergedAt: string;
  repoFullName: string | null;
}): string {
  const prLabel = input.prTitle ? `#${input.prNumber} ${input.prTitle}` : `#${input.prNumber}`;
  const prLink = input.prUrl ? `[${prLabel}](${input.prUrl})` : prLabel;
  const base = input.baseBranch ? `\`${input.baseBranch}\`` : "the base branch";
  const actor = input.mergedBy ? `@${input.mergedBy}` : "unknown";

  return [
    `**GitHub PR Event:** \`pull_request.closed (merged)\``,
    `- PR: ${prLink} merged into ${base}`,
    `- Merged by: ${actor} at ${input.mergedAt}`,
    input.headBranch ? `- Branch: \`${input.headBranch}\`` : null,
    input.repoFullName ? `- Repository: \`${input.repoFullName}\`` : null,
    ``,
    `The PR linked to this issue has been merged. Review and close if work is complete.`,
  ].filter((line): line is string => line !== null).join("\n");
}

function buildPrOpenedComment(input: {
  prNumber: number;
  prTitle: string | null;
  prUrl: string | null;
  headBranch: string | null;
  author: string | null;
  repoFullName: string | null;
  openedAt: string;
}): string {
  const prLabel = input.prTitle ? `#${input.prNumber} ${input.prTitle}` : `#${input.prNumber}`;
  const prLink = input.prUrl ? `[${prLabel}](${input.prUrl})` : prLabel;
  const actor = input.author ? `@${input.author}` : "unknown";

  return [
    `**GitHub PR Event:** \`pull_request.opened\``,
    `- PR: ${prLink} opened by ${actor} at ${input.openedAt}`,
    input.headBranch ? `- Branch: \`${input.headBranch}\`` : null,
    input.repoFullName ? `- Repository: \`${input.repoFullName}\`` : null,
    ``,
    `A pull request has been opened for this issue.`,
  ].filter((line): line is string => line !== null).join("\n");
}

function buildPrReviewComment(input: {
  prNumber: number;
  prTitle: string | null;
  prUrl: string | null;
  reviewState: string;
  reviewUrl: string | null;
  reviewer: string | null;
  repoFullName: string | null;
  submittedAt: string;
}): string {
  const prLabel = input.prTitle ? `#${input.prNumber} ${input.prTitle}` : `#${input.prNumber}`;
  const prLink = input.prUrl ? `[${prLabel}](${input.prUrl})` : prLabel;
  const reviewer = input.reviewer ? `@${input.reviewer}` : "unknown";
  const reviewLink = input.reviewUrl ? `[review](${input.reviewUrl})` : "review";
  const stateDisplay = input.reviewState.replace(/_/g, " ").toLowerCase();

  return [
    `**GitHub PR Event:** \`pull_request_review.submitted\``,
    `- PR: ${prLink}`,
    `- Review: ${reviewer} submitted a ${stateDisplay} ${reviewLink} at ${input.submittedAt}`,
    input.repoFullName ? `- Repository: \`${input.repoFullName}\`` : null,
    ``,
    `A pull request review requires your attention.`,
  ].filter((line): line is string => line !== null).join("\n");
}

// ──────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────

let currentContext: PluginContext | null = null;

function normalizeConfig(raw: Record<string, unknown>): PluginConfig {
  return {
    companyId: str(raw.companyId) ?? "",
    webhookSecretRef: str(raw.webhookSecretRef) ?? "",
  };
}

function configReady(config: PluginConfig): boolean {
  return config.companyId.length > 0 && config.webhookSecretRef.length > 0;
}

async function getConfig(ctx: PluginContext): Promise<PluginConfig> {
  const raw = await ctx.config.get();
  return normalizeConfig(raw as Record<string, unknown>);
}

// ──────────────────────────────────────────────
// Event handlers
// ──────────────────────────────────────────────

async function handlePullRequest(
  ctx: PluginContext,
  companyId: string,
  deliveryId: string,
  payload: GitHubPullRequestPayload,
): Promise<{ processed: boolean; reason: string; matchedIssueId: string | null }> {
  const action = str(payload.action);
  const pr = payload.pull_request;
  if (!pr) return { processed: false, reason: "missing-pull_request", matchedIssueId: null };

  const isMerged = action === "closed" && pr.merged === true;
  const isOpened = action === "opened";

  if (!isMerged && !isOpened) {
    return { processed: false, reason: `ignored-action:${action ?? "unknown"}`, matchedIssueId: null };
  }

  const headBranch = str(pr.head?.ref);
  const identifier = headBranch ? parseBranchIdentifier(headBranch) : null;

  if (!identifier) {
    ctx.logger.info("No issue identifier found in branch name, skipping", { headBranch, deliveryId });
    return { processed: false, reason: "no-branch-match", matchedIssueId: null };
  }

  const issue = await findIssueByIdentifier(ctx, companyId, identifier);
  if (!issue) {
    ctx.logger.info("No matching issue found for identifier", { identifier, deliveryId });
    return { processed: false, reason: `no-issue:${identifier}`, matchedIssueId: null };
  }

  const prNumber = typeof pr.number === "number" ? pr.number : 0;
  const now = new Date().toISOString();

  let commentBody: string;
  if (isMerged) {
    commentBody = buildPrMergedComment({
      prNumber,
      prTitle: str(pr.title),
      prUrl: str(pr.html_url),
      baseBranch: str(pr.base?.ref),
      headBranch,
      mergedBy: str(payload.sender?.login),
      mergedAt: now,
      repoFullName: str(payload.repository?.full_name),
    });
  } else {
    commentBody = buildPrOpenedComment({
      prNumber,
      prTitle: str(pr.title),
      prUrl: str(pr.html_url),
      headBranch,
      author: str(pr.user?.login),
      repoFullName: str(payload.repository?.full_name),
      openedAt: now,
    });
  }

  await ctx.issues.createComment(issue.id, commentBody, companyId);

  try {
    await ctx.issues.requestWakeup(issue.id, companyId, {
      reason: isMerged ? "pr-merged" : "pr-opened",
      idempotencyKey: `github-pr:${deliveryId}`,
    });
  } catch (err) {
    ctx.logger.warn("requestWakeup failed (non-fatal)", { issueId: issue.id, error: String(err) });
  }

  ctx.logger.info("Processed pull_request event", { action, identifier, issueId: issue.id, deliveryId });
  return { processed: true, reason: `ok:${action}`, matchedIssueId: issue.id };
}

async function handlePullRequestReview(
  ctx: PluginContext,
  companyId: string,
  deliveryId: string,
  payload: GitHubPullRequestReviewPayload,
): Promise<{ processed: boolean; reason: string; matchedIssueId: string | null }> {
  const action = str(payload.action);
  if (action !== "submitted") {
    return { processed: false, reason: `ignored-action:${action ?? "unknown"}`, matchedIssueId: null };
  }

  const pr = payload.pull_request;
  if (!pr) return { processed: false, reason: "missing-pull_request", matchedIssueId: null };

  const review = payload.review;
  const reviewState = str(review?.state) ?? "unknown";

  const headBranch = str(pr.head?.ref);
  const identifier = headBranch ? parseBranchIdentifier(headBranch) : null;

  if (!identifier) {
    ctx.logger.info("No issue identifier found in branch name, skipping", { headBranch, deliveryId });
    return { processed: false, reason: "no-branch-match", matchedIssueId: null };
  }

  const issue = await findIssueByIdentifier(ctx, companyId, identifier);
  if (!issue) {
    ctx.logger.info("No matching issue found for identifier", { identifier, deliveryId });
    return { processed: false, reason: `no-issue:${identifier}`, matchedIssueId: null };
  }

  const prNumber = typeof pr.number === "number" ? pr.number : 0;

  const commentBody = buildPrReviewComment({
    prNumber,
    prTitle: str(pr.title),
    prUrl: str(pr.html_url),
    reviewState,
    reviewUrl: str(review?.html_url),
    reviewer: str(payload.sender?.login),
    repoFullName: str(payload.repository?.full_name),
    submittedAt: new Date().toISOString(),
  });

  await ctx.issues.createComment(issue.id, commentBody, companyId);

  try {
    await ctx.issues.requestWakeup(issue.id, companyId, {
      reason: "pr-review",
      idempotencyKey: `github-pr:${deliveryId}`,
    });
  } catch (err) {
    ctx.logger.warn("requestWakeup failed (non-fatal)", { issueId: issue.id, error: String(err) });
  }

  ctx.logger.info("Processed pull_request_review event", { reviewState, identifier, issueId: issue.id, deliveryId });
  return { processed: true, reason: `ok:review:${reviewState}`, matchedIssueId: issue.id };
}

// ──────────────────────────────────────────────
// Plugin definition
// ──────────────────────────────────────────────

const plugin = definePlugin({
  async setup(ctx) {
    currentContext = ctx;
    ctx.logger.info("github-pr-events plugin setup complete");
  },

  async onValidateConfig(config) {
    const errors: string[] = [];
    const normalized = normalizeConfig(config as Record<string, unknown>);

    if (!normalized.companyId) errors.push("companyId is required");
    if (!normalized.webhookSecretRef) errors.push("webhookSecretRef is required");

    if (currentContext && normalized.webhookSecretRef) {
      try {
        await currentContext.secrets.resolve(normalized.webhookSecretRef);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }

    return { ok: errors.length === 0, errors, warnings: [] };
  },

  async onWebhook(input: PluginWebhookInput) {
    if (!currentContext) throw new Error("Plugin context not initialized");
    if (input.endpointKey !== WEBHOOK_ENDPOINT_KEY) {
      throw new Error(`Unsupported webhook endpoint: ${input.endpointKey}`);
    }

    const config = await getConfig(currentContext);
    if (!configReady(config)) {
      throw new Error("Plugin config incomplete: companyId and webhookSecretRef are required");
    }

    const deliveryId = getHeader(input.headers, "x-github-delivery");
    const eventType = getHeader(input.headers, "x-github-event");
    const signature = getHeader(input.headers, "x-hub-signature-256");

    if (!deliveryId) throw new Error("Missing X-GitHub-Delivery header");
    if (!eventType) throw new Error("Missing X-GitHub-Event header");
    if (!signature) throw new Error("Missing X-Hub-Signature-256 header");

    const existing = await currentContext.state.get({
      scopeKind: "instance",
      stateKey: deliveryStateKey(deliveryId),
    });
    if (existing) {
      currentContext.logger.info("Skipping duplicate delivery", { deliveryId, eventType });
      return;
    }

    const secret = await currentContext.secrets.resolve(config.webhookSecretRef);
    verifyGitHubSignature(secret, input.rawBody, signature);

    const parsed = input.parsedBody as Record<string, unknown>;
    const action = str(parsed.action) ?? "unknown";

    let result: { processed: boolean; reason: string; matchedIssueId: string | null };

    if (eventType === "pull_request") {
      result = await handlePullRequest(
        currentContext,
        config.companyId,
        deliveryId,
        parsed as GitHubPullRequestPayload,
      );
    } else if (eventType === "pull_request_review") {
      result = await handlePullRequestReview(
        currentContext,
        config.companyId,
        deliveryId,
        parsed as GitHubPullRequestReviewPayload,
      );
    } else {
      result = { processed: false, reason: `ignored-event:${eventType}`, matchedIssueId: null };
    }

    const deliveryState: DeliveryState = {
      deliveryId,
      requestId: input.requestId,
      eventType,
      action,
      processedAt: new Date().toISOString(),
      ...result,
    };

    await currentContext.state.set(
      { scopeKind: "instance", stateKey: deliveryStateKey(deliveryId) },
      deliveryState,
    );
    await currentContext.state.set(
      { scopeKind: "instance", stateKey: LAST_DELIVERY_KEY },
      deliveryState,
    );

    currentContext.logger.info("Processed GitHub PR webhook delivery", deliveryState);
  },

  async onHealth() {
    if (!currentContext) {
      return { status: "degraded", message: "github-pr-events plugin not initialized" };
    }
    const config = await getConfig(currentContext);
    const ready = configReady(config);
    const lastDelivery = await currentContext.state.get({
      scopeKind: "instance",
      stateKey: LAST_DELIVERY_KEY,
    });
    return {
      status: ready ? "ok" : "degraded",
      message: ready ? "github-pr-events plugin is running" : "Plugin config incomplete",
      details: {
        companyId: config.companyId || null,
        webhookConfigured: ready,
        lastDelivery: lastDelivery ?? null,
      },
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
