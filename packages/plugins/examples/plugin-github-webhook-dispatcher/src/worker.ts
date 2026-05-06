import { createHmac, timingSafeEqual } from "node:crypto";
import { definePlugin, runWorker, type PluginContext, type PluginWebhookInput } from "@paperclipai/plugin-sdk";

const WEBHOOK_ENDPOINT_KEY = "github";
const LAST_DELIVERY_KEY = "gh-dispatcher:last-delivery";

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

function deliveryStateKey(deliveryId: string): string {
  return `gh-dispatcher:delivery:${deliveryId}`;
}

function extractGitHubRef(payload: Record<string, unknown>): string | null {
  const repo = payload.repository as Record<string, unknown> | null | undefined;
  const repoFullName = str(repo?.full_name);

  // PR events: pull_request.number
  const pr = payload.pull_request as Record<string, unknown> | null | undefined;
  if (pr && repoFullName) {
    const num = typeof pr.number === "number" ? pr.number : null;
    if (num != null) return `${repoFullName}#${num}`;
  }

  // Issue events: issue.number
  const issue = payload.issue as Record<string, unknown> | null | undefined;
  if (issue && repoFullName) {
    const num = typeof issue.number === "number" ? issue.number : null;
    if (num != null) return `${repoFullName}#${num}`;
  }

  // check_suite: first pull_request in array
  const suite = payload.check_suite as Record<string, unknown> | null | undefined;
  if (suite && repoFullName) {
    const prs = suite.pull_requests as Array<Record<string, unknown>> | null | undefined;
    if (Array.isArray(prs) && prs.length > 0) {
      const firstPr = prs[0];
      if (firstPr) {
        const num = typeof firstPr.number === "number" ? firstPr.number : null;
        if (num != null) return `${repoFullName}#${num}`;
      }
    }
  }

  return null;
}

function isActionable(eventType: string, action: string | null, payload: Record<string, unknown>): boolean {
  switch (eventType) {
    case "check_suite": {
      const suite = payload.check_suite as Record<string, unknown> | null | undefined;
      if (!suite) return false;
      if (str(suite.status) !== "completed") return false;
      const conclusion = str(suite.conclusion);
      if (!conclusion || !["failure", "timed_out", "action_required"].includes(conclusion)) return false;
      const prs = suite.pull_requests as Array<unknown> | null | undefined;
      return Array.isArray(prs) && prs.length > 0;
    }
    case "pull_request":
      return ["opened", "closed", "synchronize", "reopened"].includes(action ?? "");
    case "pull_request_review":
      return action === "submitted";
    case "issues":
      return ["opened", "assigned", "closed"].includes(action ?? "");
    case "issue_comment":
      return action === "created";
    default:
      return false;
  }
}

function buildSummary(eventType: string, action: string | null, payload: Record<string, unknown>): string {
  const sender = (payload.sender as Record<string, unknown> | null | undefined)?.login;
  const actor = sender ? `\`${str(sender)}\`` : "unknown actor";

  switch (eventType) {
    case "pull_request": {
      const pr = payload.pull_request as Record<string, unknown> | null | undefined;
      const title = str(pr?.title as unknown) ?? "(untitled)";
      const url = str(pr?.html_url as unknown);
      const prRef = url ? `[PR](${url})` : "PR";
      if (action === "closed" && pr?.merged === true) return `${actor} merged ${prRef}: ${title}`;
      if (action === "closed") return `${actor} closed ${prRef}: ${title}`;
      return `${actor} ${action} ${prRef}: ${title}`;
    }
    case "pull_request_review": {
      const review = payload.review as Record<string, unknown> | null | undefined;
      const state = str(review?.state as unknown) ?? "unknown";
      const url = str(review?.html_url as unknown);
      const reviewRef = url ? `[review](${url})` : "review";
      return `${actor} submitted a \`${state}\` ${reviewRef}`;
    }
    case "issues": {
      const issue = payload.issue as Record<string, unknown> | null | undefined;
      const title = str(issue?.title as unknown) ?? "(untitled)";
      return `${actor} ${action} issue: ${title}`;
    }
    case "issue_comment": {
      const comment = payload.comment as Record<string, unknown> | null | undefined;
      const body = str(comment?.body as unknown);
      const url = str(comment?.html_url as unknown);
      const excerpt = body ? body.slice(0, 120) + (body.length > 120 ? "…" : "") : "(empty)";
      return `${actor} commented${url ? ` [→](${url})` : ""}: ${excerpt}`;
    }
    case "check_suite": {
      const suite = payload.check_suite as Record<string, unknown> | null | undefined;
      const conclusion = str(suite?.conclusion as unknown) ?? "unknown";
      const appName = str((suite?.app as Record<string, unknown> | null | undefined)?.name) ?? "CI";
      return `${appName} check suite completed with conclusion: \`${conclusion}\``;
    }
    default:
      return `${eventType}.${action ?? "unknown"} event received`;
  }
}

function buildWakeComment(
  eventType: string,
  action: string | null,
  githubRef: string,
  summary: string,
  rawPayload: string,
): string {
  const eventLabel = action ? `${eventType}.${action}` : eventType;
  const payloadPreview = rawPayload.length > 4000
    ? rawPayload.slice(0, 4000) + "\n… (truncated)"
    : rawPayload;

  return [
    `## GitHub Event: ${eventLabel}`,
    ``,
    `**Ref:** \`${githubRef}\``,
    ``,
    summary,
    ``,
    `<details>`,
    `<summary>Raw payload</summary>`,
    ``,
    "```json",
    payloadPreview,
    "```",
    `</details>`,
  ].join("\n");
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
// Issue matching
// ──────────────────────────────────────────────

async function findTenIssue(
  ctx: PluginContext,
  companyId: string,
  githubRef: string,
): Promise<{ id: string; identifier: string } | null> {
  const results = await ctx.issues.list({ companyId, q: githubRef, limit: 10 });
  if (!results || results.length === 0) return null;
  // The text search may tokenize the query and return broad matches.
  // Only accept issues where the ref literally appears in title or description.
  const needle = githubRef.toLowerCase();
  const exact = results.find(
    (issue) =>
      (issue.title?.toLowerCase().includes(needle) ?? false) ||
      (issue.description?.toLowerCase().includes(needle) ?? false),
  );
  if (!exact) return null;
  return { id: exact.id, identifier: exact.identifier ?? exact.id };
}

// Extracts a TEN issue identifier (e.g. "TEN-334") from a PR's head branch name or title.
// Returns the canonical uppercase form, or null if no match found.
function extractTenIdentifierFromPR(payload: Record<string, unknown>): string | null {
  const pr = payload.pull_request as Record<string, unknown> | null | undefined;
  if (!pr) return null;

  const headBranch = str((pr.head as Record<string, unknown> | null | undefined)?.ref);
  const title = str(pr.title as unknown);

  const pattern = /\bten[_-](\d+)\b/i;

  // Check branch name first (more structured), then title
  for (const text of [headBranch, title]) {
    if (!text) continue;
    const match = text.match(pattern);
    if (match) return `TEN-${match[1]}`;
  }

  return null;
}

async function findTenIssueByIdentifier(
  ctx: PluginContext,
  companyId: string,
  identifier: string,
): Promise<{ id: string; identifier: string } | null> {
  const results = await ctx.issues.list({ companyId, q: identifier, limit: 10 });
  if (!results || results.length === 0) return null;
  const normalizedId = identifier.toUpperCase();
  const exact = results.find((issue) => issue.identifier?.toUpperCase() === normalizedId);
  if (!exact) return null;
  return { id: exact.id, identifier: exact.identifier ?? exact.id };
}

// ──────────────────────────────────────────────
// Plugin definition
// ──────────────────────────────────────────────

const plugin = definePlugin({
  async setup(ctx) {
    currentContext = ctx;
    ctx.logger.info("github-webhook-dispatcher plugin setup complete");
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

    // Deduplication check
    const existing = await currentContext.state.get({
      scopeKind: "instance",
      stateKey: deliveryStateKey(deliveryId),
    });
    if (existing) {
      currentContext.logger.info("Skipping duplicate delivery", { deliveryId, eventType });
      return;
    }

    // Signature verification
    const secret = await currentContext.secrets.resolve(config.webhookSecretRef);
    verifyGitHubSignature(secret, input.rawBody, signature);

    const payload = input.parsedBody as Record<string, unknown>;
    const action = str(payload.action) ?? null;

    // Persist delivery record and skip if not actionable
    const baseState = {
      deliveryId,
      requestId: input.requestId,
      eventType,
      action: action ?? "unknown",
      processedAt: new Date().toISOString(),
    };

    if (!isActionable(eventType, action, payload)) {
      currentContext.logger.info("Skipping non-actionable event", { eventType, action, deliveryId });
      const skipState: DeliveryState = {
        ...baseState,
        processed: false,
        reason: `filtered:${eventType}.${action ?? "unknown"}`,
        matchedIssueId: null,
      };
      await currentContext.state.set({ scopeKind: "instance", stateKey: deliveryStateKey(deliveryId) }, skipState);
      await currentContext.state.set({ scopeKind: "instance", stateKey: LAST_DELIVERY_KEY }, skipState);
      return;
    }

    // Extract canonical GitHub ref
    const githubRef = extractGitHubRef(payload);
    if (!githubRef) {
      currentContext.logger.info("Cannot extract GitHub ref from payload", { eventType, action, deliveryId });
      const noRefState: DeliveryState = {
        ...baseState,
        processed: false,
        reason: "no-github-ref",
        matchedIssueId: null,
      };
      await currentContext.state.set({ scopeKind: "instance", stateKey: deliveryStateKey(deliveryId) }, noRefState);
      await currentContext.state.set({ scopeKind: "instance", stateKey: LAST_DELIVERY_KEY }, noRefState);
      return;
    }

    const summary = buildSummary(eventType, action, payload);
    const commentBody = buildWakeComment(eventType, action, githubRef, summary, input.rawBody);

    // Search for matching TEN issue — primary strategy: full-text search for the GitHub ref
    let matchedIssue = await findTenIssue(currentContext, config.companyId, githubRef);

    // Fallback: if no match, parse TEN identifier from PR branch/title and look up directly
    if (!matchedIssue) {
      const tenIdentifier = extractTenIdentifierFromPR(payload);
      if (tenIdentifier) {
        matchedIssue = await findTenIssueByIdentifier(currentContext, config.companyId, tenIdentifier);
        if (matchedIssue) {
          currentContext.logger.info("Matched issue via PR branch/title fallback", {
            githubRef,
            tenIdentifier,
            issueId: matchedIssue.id,
            identifier: matchedIssue.identifier,
            eventType,
            action,
            deliveryId,
          });
        }
      }
    }

    let matchedIssueId: string | null = null;
    let reason: string;

    if (matchedIssue) {
      await currentContext.issues.createComment(matchedIssue.id, commentBody, config.companyId);
      matchedIssueId = matchedIssue.id;
      reason = `dispatched:${matchedIssue.identifier}`;
      currentContext.logger.info("Dispatched wake comment", {
        githubRef,
        issueId: matchedIssue.id,
        identifier: matchedIssue.identifier,
        eventType,
        action,
        deliveryId,
      });
    } else {
      // Create triage issue for unmapped ref
      const triageTitle = `triage: unmapped ${githubRef}`;
      const triageDesc = [
        `GitHub event \`${eventType}.${action ?? "unknown"}\` received for \`${githubRef}\` but no matching TEN issue was found.`,
        ``,
        `Auto-created by the GitHub Webhook Dispatcher plugin for triage.`,
        ``,
        commentBody,
      ].join("\n");

      const triageIssue = await currentContext.issues.create({
        companyId: config.companyId,
        title: triageTitle,
        description: triageDesc,
      });
      reason = `triage-created:${triageIssue?.id ?? "unknown"}`;
      currentContext.logger.info("Created triage issue for unmapped ref", {
        githubRef,
        triageIssueId: triageIssue?.id,
        eventType,
        action,
        deliveryId,
      });
    }

    const deliveryState: DeliveryState = {
      ...baseState,
      processed: true,
      reason,
      matchedIssueId,
    };

    await currentContext.state.set(
      { scopeKind: "instance", stateKey: deliveryStateKey(deliveryId) },
      deliveryState,
    );
    await currentContext.state.set(
      { scopeKind: "instance", stateKey: LAST_DELIVERY_KEY },
      deliveryState,
    );

    currentContext.logger.info("GitHub webhook delivery processed", deliveryState);
  },

  async onHealth() {
    if (!currentContext) {
      return { status: "degraded", message: "github-webhook-dispatcher plugin not initialized" };
    }
    const config = await getConfig(currentContext);
    const ready = configReady(config);
    const lastDelivery = await currentContext.state.get({
      scopeKind: "instance",
      stateKey: LAST_DELIVERY_KEY,
    });
    return {
      status: ready ? "ok" : "degraded",
      message: ready ? "github-webhook-dispatcher plugin is running" : "Plugin config incomplete",
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
