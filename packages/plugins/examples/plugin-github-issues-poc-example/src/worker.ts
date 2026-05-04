import { createHmac, timingSafeEqual } from "node:crypto";
import { definePlugin, runWorker, type PluginContext, type PluginWebhookInput } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclipai.plugin-github-issues-poc-example";
const WEBHOOK_ENDPOINT_KEY = "github";
const DEFAULT_REPOSITORY_FULL_NAME = "tensorleap/concierge";
const DEFAULT_ASSIGNEE_LOGIN = "marvin-tensorleap";
const DEFAULT_ISSUE_TITLE_PREFIX = "[GitHub]";
const DEFAULT_SYNC_MODE = "inbound_only";
const LAST_DELIVERY_STATE_KEY = "github:last-delivery";
const SOURCE_MIRROR_SECTION_START = "<!-- paperclip-github-source-mirror:start -->";
const SOURCE_MIRROR_SECTION_END = "<!-- paperclip-github-source-mirror:end -->";

type AssigneeRoute = {
  githubAssigneeLogin: string;
  paperclipAssigneeAgentId: string;
  paperclipAssigneeLabel: string | null;
};

type PluginConfig = {
  companyId: string;
  projectId: string;
  webhookSecretRef: string;
  repositoryFullName: string;
  syncMode: string;
  assigneeRoutes: AssigneeRoute[];
  issueTitlePrefix: string;
};

type DeliveryState = {
  deliveryId: string;
  requestId: string;
  eventType: string;
  action: string;
  processedAt: string;
  processed: boolean;
  reason: string;
  mappedIssueId: string | null;
  wakeQueued: boolean;
};

type HealthData = {
  status: "ok" | "degraded";
  checkedAt: string;
  companyId: string | null;
  projectId: string | null;
  repositoryFullName: string;
  syncMode: string;
  assigneeRoutes: AssigneeRoute[];
  webhookSecretConfigured: boolean;
  webhookPath: string;
  lastDelivery: DeliveryState | null;
};

type IssueMapping = {
  githubIssueKey: string;
  githubIssueNumber: number;
  githubIssueUrl: string | null;
  githubIssueTitle: string | null;
  trackedGitHubAssigneeLogin: string | null;
  mappedPaperclipAssigneeAgentId: string | null;
  mappedPaperclipAssigneeLabel: string | null;
  syncMode: string;
  lastDeliveryId: string | null;
  paperclipIssueId: string;
  paperclipIssueIdentifier: string | null;
  createdAt: string;
  updatedAt: string;
};

type PullRequestMapping = {
  githubPullRequestKey: string;
  githubIssueKey: string;
  paperclipIssueId: string;
  pullRequestNumber: number;
  pullRequestUrl: string | null;
  updatedAt: string;
};

type PullRequestLink = {
  githubPullRequestKey: string;
  githubIssueKey: string | null;
  paperclipIssueId: string;
  paperclipIssueIdentifier: string | null;
  pullRequestUrl: string | null;
  workProduct: unknown | null;
};

type PullRequestCheckActionability = "waiting" | "failed" | "passed";

type SyncResult = {
  processed: boolean;
  reason: string;
  mappedIssueId: string | null;
  wakeQueued: boolean;
};

type GitHubActor = {
  login?: unknown;
};

type GitHubLabel = {
  name?: unknown;
};

type GitHubIssue = {
  number?: unknown;
  title?: unknown;
  body?: unknown;
  html_url?: unknown;
  state?: unknown;
  labels?: unknown;
  assignee?: GitHubActor | null;
  assignees?: unknown;
  pull_request?: unknown;
};

type GitHubPullRequest = {
  number?: unknown;
  title?: unknown;
  body?: unknown;
  html_url?: unknown;
  draft?: unknown;
  merged?: unknown;
  state?: unknown;
  review_decision?: unknown;
  head?: {
    ref?: unknown;
    sha?: unknown;
  } | null;
  base?: {
    ref?: unknown;
    sha?: unknown;
  } | null;
};

type GitHubRepository = {
  full_name?: unknown;
  name?: unknown;
  owner?: {
    login?: unknown;
  } | null;
};

type GitHubComment = {
  body?: unknown;
  html_url?: unknown;
  user?: GitHubActor | null;
};

type GitHubPullRequestReview = {
  body?: unknown;
  html_url?: unknown;
  state?: unknown;
  user?: GitHubActor | null;
};

type GitHubCheckRun = {
  name?: unknown;
  status?: unknown;
  conclusion?: unknown;
  html_url?: unknown;
  details_url?: unknown;
  head_sha?: unknown;
  output?: {
    title?: unknown;
    summary?: unknown;
    text?: unknown;
  } | null;
  pull_requests?: unknown;
};

type GitHubCheckSuite = {
  status?: unknown;
  conclusion?: unknown;
  head_branch?: unknown;
  head_sha?: unknown;
  html_url?: unknown;
  pull_requests?: unknown;
  app?: {
    name?: unknown;
  } | null;
};

type GitHubIssuesPayload = {
  action?: unknown;
  issue?: GitHubIssue | null;
  repository?: GitHubRepository | null;
  sender?: GitHubActor | null;
  assignee?: GitHubActor | null;
  label?: GitHubLabel | null;
};

type GitHubIssueCommentPayload = {
  action?: unknown;
  issue?: GitHubIssue | null;
  repository?: GitHubRepository | null;
  sender?: GitHubActor | null;
  comment?: GitHubComment | null;
};

type GitHubPullRequestPayload = {
  action?: unknown;
  number?: unknown;
  pull_request?: GitHubPullRequest | null;
  repository?: GitHubRepository | null;
  sender?: GitHubActor | null;
};

type GitHubPullRequestReviewCommentPayload = {
  action?: unknown;
  number?: unknown;
  pull_request?: GitHubPullRequest | null;
  repository?: GitHubRepository | null;
  sender?: GitHubActor | null;
  comment?: GitHubComment | null;
};

type GitHubPullRequestReviewPayload = {
  action?: unknown;
  number?: unknown;
  pull_request?: GitHubPullRequest | null;
  repository?: GitHubRepository | null;
  sender?: GitHubActor | null;
  review?: GitHubPullRequestReview | null;
};

type GitHubCheckRunPayload = {
  action?: unknown;
  repository?: GitHubRepository | null;
  sender?: GitHubActor | null;
  check_run?: GitHubCheckRun | null;
};

type GitHubCheckSuitePayload = {
  action?: unknown;
  repository?: GitHubRepository | null;
  sender?: GitHubActor | null;
  check_suite?: GitHubCheckSuite | null;
};

let currentContext: PluginContext | null = null;

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeLowercaseString(value: unknown): string | null {
  return normalizeString(value)?.toLowerCase() ?? null;
}

function normalizeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeBoolean(value: unknown): boolean {
  return value === true;
}

function normalizeOptionalBoolean(value: unknown): boolean | null {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

function normalizeAssigneeRoute(value: unknown): AssigneeRoute | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const route = value as Record<string, unknown>;
  const githubAssigneeLogin = normalizeString(route.githubAssigneeLogin);
  const paperclipAssigneeAgentId = normalizeString(route.paperclipAssigneeAgentId);
  const paperclipAssigneeLabel = normalizeString(route.paperclipAssigneeLabel);
  if (!githubAssigneeLogin || !paperclipAssigneeAgentId) return null;
  return {
    githubAssigneeLogin,
    paperclipAssigneeAgentId,
    paperclipAssigneeLabel,
  };
}

function normalizeAssigneeRoutes(value: unknown): AssigneeRoute[] {
  if (!Array.isArray(value)) return [];
  const routes: AssigneeRoute[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const route = normalizeAssigneeRoute(entry);
    if (!route) continue;
    const key = `${route.githubAssigneeLogin.toLowerCase()}::${route.paperclipAssigneeAgentId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push(route);
  }
  return routes;
}

function buildLegacyAssigneeRoutes(raw: Record<string, unknown>): AssigneeRoute[] {
  const githubAssigneeLogin = normalizeString(raw.githubAssigneeLogin) ?? DEFAULT_ASSIGNEE_LOGIN;
  const paperclipAssigneeAgentId = normalizeString(raw.assigneeAgentId);
  if (!githubAssigneeLogin || !paperclipAssigneeAgentId) return [];
  return [{
    githubAssigneeLogin,
    paperclipAssigneeAgentId,
    paperclipAssigneeLabel: null,
  }];
}

function getHeader(headers: Record<string, string | string[]>, name: string): string | null {
  const target = name.toLowerCase();
  for (const [headerName, value] of Object.entries(headers)) {
    if (headerName.toLowerCase() !== target) continue;
    if (typeof value === "string") return normalizeString(value);
    if (Array.isArray(value)) {
      const first = value.find((entry) => typeof entry === "string" && entry.trim().length > 0);
      return normalizeString(first);
    }
  }
  return null;
}

function getRepositoryFullName(repository: GitHubRepository | null | undefined): string {
  const fullName = normalizeString(repository?.full_name);
  if (fullName) return fullName;
  const owner = normalizeString(repository?.owner?.login);
  const name = normalizeString(repository?.name);
  if (!owner || !name) {
    throw new Error("GitHub payload is missing repository.full_name");
  }
  return `${owner}/${name}`;
}

function getIssueNumber(candidate: { number?: unknown }): number {
  if (typeof candidate.number === "number" && Number.isFinite(candidate.number)) {
    return candidate.number;
  }
  throw new Error("GitHub payload is missing a valid issue or pull request number");
}

function getPullRequestNumber(
  payload: GitHubPullRequestPayload | GitHubPullRequestReviewCommentPayload | GitHubPullRequestReviewPayload,
): number {
  if (typeof payload.number === "number" && Number.isFinite(payload.number)) {
    return payload.number;
  }
  if (payload.pull_request && typeof payload.pull_request.number === "number" && Number.isFinite(payload.pull_request.number)) {
    return payload.pull_request.number;
  }
  throw new Error("GitHub payload is missing a valid pull request number");
}

function githubKey(repositoryFullName: string, number: number): string {
  return `${repositoryFullName}#${number}`;
}

function splitRepositoryFullName(repositoryFullName: string): { owner: string | null; name: string | null } {
  const [ownerPart, ...nameParts] = repositoryFullName.split("/");
  const owner = normalizeString(ownerPart);
  const name = normalizeString(nameParts.join("/"));
  return { owner, name };
}

function pullRequestWorkProductStatus(input: {
  state: string | null;
  isDraft: boolean | null;
  isMerged: boolean | null;
}): "active" | "ready_for_review" | "merged" | "closed" | "draft" {
  if (input.isMerged === true) return "merged";
  if (input.state === "closed") return "closed";
  if (input.isDraft === true) return "draft";
  if (input.state === "open" && input.isDraft === false) return "ready_for_review";
  return "active";
}

function pullRequestWorkProductReviewState(value: string | null): "none" | "approved" | "changes_requested" {
  const normalized = normalizeLowercaseString(value);
  if (normalized === "approved") return "approved";
  if (normalized === "changes_requested") return "changes_requested";
  return "none";
}

function pullRequestCheckActionabilityFromSignal(input: {
  status: string | null;
  conclusion: string | null;
}): PullRequestCheckActionability | null {
  if (input.status !== "completed") return "waiting";
  if (!input.conclusion) return "waiting";
  if (["success", "neutral", "skipped"].includes(input.conclusion)) return "passed";
  if (["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"].includes(input.conclusion)) {
    return "failed";
  }
  return "waiting";
}

function readPullRequestCheckActionability(value: unknown): PullRequestCheckActionability | null {
  const normalized = normalizeLowercaseString(value);
  if (normalized === "waiting" || normalized === "failed" || normalized === "passed") {
    return normalized;
  }
  return null;
}

function aggregatePullRequestCheckActionability(collections: Array<Record<string, unknown>>): PullRequestCheckActionability | null {
  const actionabilities = collections.flatMap((collection) => Object.values(collection).map((entry) => {
    const record = normalizeRecord(entry);
    return readPullRequestCheckActionability(record?.actionability);
  })).filter((value): value is PullRequestCheckActionability => value !== null);

  if (actionabilities.includes("failed")) return "failed";
  if (actionabilities.includes("waiting")) return "waiting";
  if (actionabilities.includes("passed")) return "passed";
  return null;
}

function pullRequestHealthStatusFromChecks(actionability: PullRequestCheckActionability | null): "unknown" | "healthy" | "unhealthy" {
  if (actionability === "failed") return "unhealthy";
  if (actionability === "waiting") return "unknown";
  if (actionability === "passed") return "healthy";
  return "unknown";
}

function buildPullRequestWorkProductSummary(input: {
  externalId: string;
  status: "active" | "ready_for_review" | "merged" | "closed" | "draft";
  reviewState: "none" | "approved" | "changes_requested";
  checksActionability: PullRequestCheckActionability | null;
}): string {
  const segments = [`GitHub pull request ${input.externalId}`, `status: ${input.status}`];
  if (input.reviewState !== "none") {
    segments.push(`review: ${input.reviewState.replace(/_/g, " ")}`);
  }
  if (input.checksActionability) {
    segments.push(`checks: ${input.checksActionability}`);
  }
  return segments.join(" | ");
}

function buildNextPullRequestChecksMetadata(
  existingMetadata: Record<string, unknown> | null,
  input: {
    collection: "checkRuns" | "checkSuites";
    key: string;
    status: string | null;
    conclusion: string | null;
    name: string | null;
    url: string | null;
    deliveryId: string;
    eventName: string;
  },
): {
  metadataPatch: Record<string, unknown>;
  previousActionability: PullRequestCheckActionability | null;
  nextActionability: PullRequestCheckActionability | null;
} {
  const now = new Date().toISOString();
  const existingCheckRuns = normalizeRecord(existingMetadata?.checkRuns) ?? {};
  const existingCheckSuites = normalizeRecord(existingMetadata?.checkSuites) ?? {};
  const previousActionability = aggregatePullRequestCheckActionability([existingCheckRuns, existingCheckSuites]);
  const nextEntry = {
    actionability: pullRequestCheckActionabilityFromSignal({
      status: input.status,
      conclusion: input.conclusion,
    }),
    status: input.status,
    conclusion: input.conclusion,
    name: input.name,
    url: input.url,
    lastDeliveryId: input.deliveryId,
    lastEventName: input.eventName,
    updatedAt: now,
  };
  const nextCheckRuns = input.collection === "checkRuns"
    ? { ...existingCheckRuns, [input.key]: nextEntry }
    : existingCheckRuns;
  const nextCheckSuites = input.collection === "checkSuites"
    ? { ...existingCheckSuites, [input.key]: nextEntry }
    : existingCheckSuites;
  const nextActionability = aggregatePullRequestCheckActionability([nextCheckRuns, nextCheckSuites]);

  return {
    metadataPatch: {
      checkRuns: nextCheckRuns,
      checkSuites: nextCheckSuites,
      checks: {
        actionability: nextActionability,
        status: input.status,
        conclusion: input.conclusion,
        name: input.name,
        url: input.url,
        lastDeliveryId: input.deliveryId,
        lastEventName: input.eventName,
        updatedAt: now,
      },
    },
    previousActionability,
    nextActionability,
  };
}

function issueMappingStateKey(githubIssueKey: string): string {
  return `github:issue:${githubIssueKey}`;
}

function pullRequestMappingStateKey(githubPullRequestKey: string): string {
  return `github:pull-request:${githubPullRequestKey}`;
}

function deliveryStateKey(deliveryId: string): string {
  return `github:delivery:${deliveryId}`;
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

function issueIsPullRequest(issue: GitHubIssue): boolean {
  return issue.pull_request != null;
}

function repositoryMatches(repositoryFullName: string, expectedRepositoryFullName: string): boolean {
  return repositoryFullName.toLowerCase() === expectedRepositoryFullName.trim().toLowerCase();
}

function listIssueAssigneeLogins(issue: GitHubIssue, fallbackAssignee?: GitHubActor | null): string[] {
  const logins = new Set<string>();
  const fallbackLogin = normalizeString(fallbackAssignee?.login);
  if (fallbackLogin) logins.add(fallbackLogin.toLowerCase());

  if (Array.isArray(issue.assignees)) {
    for (const entry of issue.assignees) {
      const login = normalizeString((entry as GitHubActor | null)?.login);
      if (login) logins.add(login.toLowerCase());
    }
  }

  const primaryAssignee = normalizeString(issue.assignee?.login);
  if (primaryAssignee) logins.add(primaryAssignee.toLowerCase());
  return [...logins];
}

function buildPaperclipIssueTitle(prefix: string, githubTitle: string | null, githubIssueNumber: number): string {
  const trimmedPrefix = prefix.trim();
  const title = githubTitle ?? `GitHub issue #${githubIssueNumber}`;
  return trimmedPrefix ? `${trimmedPrefix} ${title}` : title;
}

function blockQuote(body: string): string {
  return body.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
}

function joinCommentLines(lines: Array<string | null | undefined>): string {
  return lines.filter((line): line is string => typeof line === "string").join("\n");
}

function joinSections(sections: Array<string | null | undefined>): string {
  return sections
    .map((section) => (typeof section === "string" ? section.trim() : ""))
    .filter((section) => section.length > 0)
    .join("\n\n");
}

function buildSourceMirrorSection(input: {
  githubIssueKey: string;
  githubIssueNumber: number;
  githubIssueUrl: string | null;
  trackedGitHubAssigneeLogin: string | null;
  mappedPaperclipAssigneeLabel: string | null;
  syncMode: string;
  lastDeliveryId: string | null;
}): string {
  return joinCommentLines([
    SOURCE_MIRROR_SECTION_START,
    "## Source Mirror",
    "",
    `- GitHub issue: \`${input.githubIssueKey}\``,
    `- GitHub repository: \`${input.githubIssueKey.split("#")[0] ?? ""}\``,
    `- GitHub issue number: \`${input.githubIssueNumber}\``,
    input.githubIssueUrl ? `- Source URL: ${input.githubIssueUrl}` : "- Source URL: unavailable",
    input.trackedGitHubAssigneeLogin
      ? `- GitHub assignee login: \`${input.trackedGitHubAssigneeLogin}\``
      : "- GitHub assignee login: unavailable",
    input.mappedPaperclipAssigneeLabel
      ? `- Mapped Paperclip assignee: ${input.mappedPaperclipAssigneeLabel}`
      : "- Mapped Paperclip assignee: unavailable",
    `- Sync mode: \`${input.syncMode}\``,
    input.lastDeliveryId
      ? `- Last GitHub delivery id: \`${input.lastDeliveryId}\``
      : "- Last GitHub delivery id: unavailable",
    SOURCE_MIRROR_SECTION_END,
  ]);
}

function buildInitialIssueDescription(input: {
  githubIssueKey: string;
  githubIssueNumber: number;
  githubIssueUrl: string | null;
  trackedGitHubAssigneeLogin: string | null;
  mappedPaperclipAssigneeLabel: string | null;
  syncMode: string;
  lastDeliveryId: string | null;
  githubIssueBody: string | null;
}): string {
  return joinSections([
    buildSourceMirrorSection(input),
    joinCommentLines([
      "## GitHub Body",
      input.githubIssueBody ? blockQuote(input.githubIssueBody) : "> _No GitHub body provided._",
    ]),
  ]);
}

function upsertSourceMirrorSection(description: string | null, sourceMirrorSection: string): string {
  const existing = description ?? "";
  const start = existing.indexOf(SOURCE_MIRROR_SECTION_START);
  const end = existing.indexOf(SOURCE_MIRROR_SECTION_END);
  if (start !== -1 && end !== -1 && end >= start) {
    const before = existing.slice(0, start).trim();
    const after = existing.slice(end + SOURCE_MIRROR_SECTION_END.length).trim();
    return joinSections([before, sourceMirrorSection, after]);
  }
  return joinSections([sourceMirrorSection, existing]);
}

function buildIssueEventComment(input: {
  action: string;
  githubIssueKey: string;
  actorLogin: string;
  githubUrl: string | null;
  githubTitle: string | null;
  trackedAssigneeLogin: string;
  assignees: string[];
  wakeQueued: boolean;
  paperclipStatusChanged?: string | null;
}): string {
  const assigneeList = input.assignees.length > 0
    ? input.assignees.map((login) => `\`${login}\``).join(", ")
    : null;

  let actionLine = `GitHub issue event \`${input.action}\` was received.`;
  if (input.action === "assigned") {
    actionLine = `Tracked assignee \`${input.trackedAssigneeLogin}\` is assigned on GitHub.`;
  } else if (input.action === "unassigned") {
    actionLine = `Tracked assignee \`${input.trackedAssigneeLogin}\` is no longer assigned on GitHub.`;
  } else if (input.action === "edited" && input.githubTitle) {
    actionLine = `GitHub title is now: ${input.githubTitle}`;
  } else if (input.action === "closed") {
    actionLine = "GitHub issue was closed.";
  } else if (input.action === "reopened") {
    actionLine = "GitHub issue was reopened.";
  }

  return joinCommentLines([
    `GitHub issues.${input.action}: ${input.githubIssueKey}`,
    `Actor: ${input.actorLogin}`,
    input.githubUrl ? `URL: ${input.githubUrl}` : null,
    "",
    actionLine,
    assigneeList ? `Current GitHub assignees: ${assigneeList}` : null,
    input.paperclipStatusChanged ? `Paperclip status set to \`${input.paperclipStatusChanged}\`.` : null,
    input.wakeQueued ? "Paperclip wake requested." : null,
  ]);
}

function buildCommentMirrorBody(input: {
  eventName: string;
  githubKey: string;
  actorLogin: string;
  githubUrl: string | null;
  commentBody: string | null;
  wakeQueued: boolean;
}): string {
  return joinCommentLines([
    `${input.eventName}: ${input.githubKey}`,
    `Actor: ${input.actorLogin}`,
    input.githubUrl ? `URL: ${input.githubUrl}` : null,
    "",
    input.commentBody ? blockQuote(input.commentBody) : "_Comment body unavailable._",
    input.wakeQueued ? "" : null,
    input.wakeQueued ? "Paperclip wake requested." : null,
  ]);
}

function buildPullRequestEventComment(input: {
  action: string;
  githubPullRequestKey: string;
  githubIssueKey: string | null;
  actorLogin: string;
  githubUrl: string | null;
  isMerged: boolean;
  wakeQueued: boolean;
  paperclipStatusChanged?: string | null;
}): string {
  let actionLine = `GitHub pull request event \`${input.action}\` was received.`;
  if (input.action === "closed") {
    actionLine = input.isMerged ? "Related pull request was merged." : "Related pull request was closed.";
  } else if (input.action === "ready_for_review") {
    actionLine = "Related pull request is ready for review.";
  } else if (input.action === "converted_to_draft") {
    actionLine = "Related pull request was moved back to draft.";
  } else if (input.action === "synchronize") {
    actionLine = "Related pull request received new commits.";
  }

  return joinCommentLines([
    `GitHub pull_request.${input.action}: ${input.githubPullRequestKey}`,
    input.githubIssueKey ? `Linked issue: ${input.githubIssueKey}` : null,
    `Actor: ${input.actorLogin}`,
    input.githubUrl ? `URL: ${input.githubUrl}` : null,
    "",
    actionLine,
    input.paperclipStatusChanged ? `Paperclip status set to \`${input.paperclipStatusChanged}\`.` : null,
    input.wakeQueued ? "Paperclip wake requested." : null,
  ]);
}

function buildPullRequestCommentBody(input: {
  eventName: string;
  githubPullRequestKey: string;
  githubIssueKey: string | null;
  actorLogin: string;
  githubUrl: string | null;
  commentBody: string | null;
  wakeQueued: boolean;
}): string {
  return joinCommentLines([
    `${input.eventName}: ${input.githubPullRequestKey}`,
    input.githubIssueKey ? `Linked issue: ${input.githubIssueKey}` : null,
    `Actor: ${input.actorLogin}`,
    input.githubUrl ? `URL: ${input.githubUrl}` : null,
    "",
    input.commentBody ? blockQuote(input.commentBody) : "_Comment body unavailable._",
    input.wakeQueued ? "" : null,
    input.wakeQueued ? "Paperclip wake requested." : null,
  ]);
}

function buildPullRequestReviewBody(input: {
  action: string;
  githubPullRequestKey: string;
  githubIssueKey: string | null;
  actorLogin: string;
  githubUrl: string | null;
  reviewState: "none" | "approved" | "changes_requested";
  reviewBody: string | null;
  wakeQueued: boolean;
}): string {
  return joinCommentLines([
    `GitHub pull_request_review.${input.action}: ${input.githubPullRequestKey}`,
    input.githubIssueKey ? `Linked issue: ${input.githubIssueKey}` : null,
    `Actor: ${input.actorLogin}`,
    input.githubUrl ? `URL: ${input.githubUrl}` : null,
    "",
    `Review state: ${input.reviewState.replace(/_/g, " ")}`,
    input.reviewBody ? blockQuote(input.reviewBody) : "_Review body unavailable._",
    input.wakeQueued ? "" : null,
    input.wakeQueued ? "Paperclip wake requested." : null,
  ]);
}

function buildPullRequestCheckBody(input: {
  eventName: string;
  githubPullRequestKey: string;
  githubIssueKey: string | null;
  actorLogin: string;
  githubUrl: string | null;
  checkName: string | null;
  status: string | null;
  conclusion: string | null;
  actionability: PullRequestCheckActionability | null;
  wakeQueued: boolean;
}): string {
  return joinCommentLines([
    `${input.eventName}: ${input.githubPullRequestKey}`,
    input.githubIssueKey ? `Linked issue: ${input.githubIssueKey}` : null,
    `Actor: ${input.actorLogin}`,
    input.githubUrl ? `URL: ${input.githubUrl}` : null,
    "",
    input.checkName ? `Check: ${input.checkName}` : null,
    input.status ? `Status: ${input.status}` : null,
    input.conclusion ? `Conclusion: ${input.conclusion}` : null,
    input.actionability ? `Actionability: ${input.actionability}` : null,
    input.wakeQueued ? "" : null,
    input.wakeQueued ? "Paperclip wake requested." : null,
  ]);
}

function extractIssueReferenceKeys(repositoryFullName: string, texts: Array<string | null | undefined>): string[] {
  const keys = new Set<string>();

  for (const text of texts) {
    if (!text) continue;

    const urlPattern = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)/g;
    for (const match of text.matchAll(urlPattern)) {
      keys.add(`${match[1]}#${match[2]}`);
    }

    const repoPattern = /\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)\b/g;
    for (const match of text.matchAll(repoPattern)) {
      keys.add(`${match[1]}#${match[2]}`);
    }

    const localPattern = /(^|[^A-Za-z0-9_./-])#(\d+)\b/g;
    for (const match of text.matchAll(localPattern)) {
      keys.add(`${repositoryFullName}#${match[2]}`);
    }
  }

  return [...keys];
}

function parseWebhookPayload(input: PluginWebhookInput): Record<string, unknown> {
  if (input.parsedBody && typeof input.parsedBody === "object" && !Array.isArray(input.parsedBody)) {
    return input.parsedBody as Record<string, unknown>;
  }
  const parsed = JSON.parse(input.rawBody);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Webhook body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function actorLogin(...candidates: Array<GitHubActor | null | undefined>): string {
  for (const candidate of candidates) {
    const login = normalizeString(candidate?.login);
    if (login) return login;
  }
  return "unknown";
}

function findAssigneeRoute(
  issue: GitHubIssue,
  assigneeRoutes: AssigneeRoute[],
  fallbackAssignee?: GitHubActor | null,
): AssigneeRoute | null {
  const assignees = listIssueAssigneeLogins(issue, fallbackAssignee);
  for (const route of assigneeRoutes) {
    if (assignees.includes(route.githubAssigneeLogin.trim().toLowerCase())) {
      return route;
    }
  }
  return null;
}

function issueShouldCreatePaperclipWork(
  repositoryFullName: string,
  issue: GitHubIssue,
  config: PluginConfig,
  fallbackAssignee?: GitHubActor | null,
): boolean {
  return repositoryMatches(repositoryFullName, config.repositoryFullName)
    && findAssigneeRoute(issue, config.assigneeRoutes, fallbackAssignee) != null;
}

function runtimeReady(config: PluginConfig): boolean {
  return Boolean(
    config.companyId
      && config.projectId
      && config.webhookSecretRef
      && config.repositoryFullName
      && config.syncMode
      && config.assigneeRoutes.length > 0,
  );
}

function normalizeConfig(rawConfig: Record<string, unknown>): PluginConfig {
  const assigneeRoutes = normalizeAssigneeRoutes(rawConfig.assigneeRoutes);
  const fallbackRoutes = assigneeRoutes.length > 0 ? assigneeRoutes : buildLegacyAssigneeRoutes(rawConfig);
  return {
    companyId: normalizeString(rawConfig.companyId) ?? "",
    projectId: normalizeString(rawConfig.projectId) ?? "",
    webhookSecretRef: normalizeString(rawConfig.webhookSecretRef) ?? "",
    repositoryFullName: normalizeString(rawConfig.repositoryFullName) ?? DEFAULT_REPOSITORY_FULL_NAME,
    syncMode: normalizeString(rawConfig.syncMode) ?? DEFAULT_SYNC_MODE,
    assigneeRoutes: fallbackRoutes,
    issueTitlePrefix: normalizeString(rawConfig.issueTitlePrefix) ?? DEFAULT_ISSUE_TITLE_PREFIX,
  };
}

async function getConfig(ctx: PluginContext): Promise<PluginConfig> {
  const raw = await ctx.config.get();
  const rawConfig = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  return normalizeConfig(rawConfig);
}

async function readState<T>(ctx: PluginContext, scopeId: string, stateKey: string): Promise<T | null> {
  const value = await ctx.state.get({ scopeKind: "company", scopeId, stateKey });
  return value && typeof value === "object" ? (value as T) : null;
}

async function writeState(ctx: PluginContext, scopeId: string, stateKey: string, value: unknown): Promise<void> {
  await ctx.state.set({ scopeKind: "company", scopeId, stateKey }, value);
}

async function getLastDelivery(ctx: PluginContext): Promise<DeliveryState | null> {
  const value = await ctx.state.get({ scopeKind: "instance", stateKey: LAST_DELIVERY_STATE_KEY });
  return value && typeof value === "object" ? (value as DeliveryState) : null;
}

async function readIssueMapping(ctx: PluginContext, companyId: string, githubIssueKey: string): Promise<IssueMapping | null> {
  return readState<IssueMapping>(ctx, companyId, issueMappingStateKey(githubIssueKey));
}

async function writeIssueMapping(ctx: PluginContext, companyId: string, mapping: IssueMapping): Promise<void> {
  await writeState(ctx, companyId, issueMappingStateKey(mapping.githubIssueKey), mapping);
}

async function resolveAssigneeRouteLabel(
  ctx: PluginContext,
  companyId: string,
  route: AssigneeRoute,
): Promise<string> {
  if (route.paperclipAssigneeLabel) return route.paperclipAssigneeLabel;
  try {
    const agent = await ctx.agents.get(route.paperclipAssigneeAgentId, companyId);
    return normalizeString(agent?.name) ?? route.paperclipAssigneeAgentId;
  } catch {
    return route.paperclipAssigneeAgentId;
  }
}

function withMirrorDefaults(
  mapping: IssueMapping,
  config: PluginConfig,
  route: AssigneeRoute | null = null,
): IssueMapping {
  const fallbackRoute = route ?? config.assigneeRoutes[0] ?? null;
  return {
    ...mapping,
    trackedGitHubAssigneeLogin: mapping.trackedGitHubAssigneeLogin ?? fallbackRoute?.githubAssigneeLogin ?? null,
    mappedPaperclipAssigneeAgentId: mapping.mappedPaperclipAssigneeAgentId ?? fallbackRoute?.paperclipAssigneeAgentId ?? null,
    mappedPaperclipAssigneeLabel: mapping.mappedPaperclipAssigneeLabel
      ?? fallbackRoute?.paperclipAssigneeLabel
      ?? fallbackRoute?.paperclipAssigneeAgentId
      ?? null,
    syncMode: mapping.syncMode || config.syncMode,
    lastDeliveryId: mapping.lastDeliveryId ?? null,
  };
}

async function syncSourceMirrorDescription(
  ctx: PluginContext,
  companyId: string,
  mapping: IssueMapping,
): Promise<void> {
  const issue = await ctx.issues.get(mapping.paperclipIssueId, companyId);
  if (!issue) return;
  const sourceMirrorSection = buildSourceMirrorSection(mapping);
  const nextDescription = upsertSourceMirrorSection(issue.description, sourceMirrorSection);
  if (nextDescription === (issue.description ?? "")) return;
  await ctx.issues.update(mapping.paperclipIssueId, { description: nextDescription }, companyId);
}

async function refreshIssueMirror(
  ctx: PluginContext,
  config: PluginConfig,
  mapping: IssueMapping,
  input: {
    deliveryId: string;
    githubIssueUrl?: string | null;
    githubIssueTitle?: string | null;
    route?: AssigneeRoute | null;
  },
): Promise<IssueMapping> {
  const route = input.route ?? null;
  const routeLabel = route
    ? await resolveAssigneeRouteLabel(ctx, config.companyId, route)
    : mapping.mappedPaperclipAssigneeLabel;
  const nextMapping = withMirrorDefaults({
    ...mapping,
    githubIssueUrl: input.githubIssueUrl ?? mapping.githubIssueUrl,
    githubIssueTitle: input.githubIssueTitle ?? mapping.githubIssueTitle,
    trackedGitHubAssigneeLogin: route?.githubAssigneeLogin ?? mapping.trackedGitHubAssigneeLogin,
    mappedPaperclipAssigneeAgentId: route?.paperclipAssigneeAgentId ?? mapping.mappedPaperclipAssigneeAgentId,
    mappedPaperclipAssigneeLabel: routeLabel ?? mapping.mappedPaperclipAssigneeLabel,
    syncMode: config.syncMode,
    lastDeliveryId: input.deliveryId,
    updatedAt: new Date().toISOString(),
  }, config, route);
  await writeIssueMapping(ctx, config.companyId, nextMapping);
  await syncSourceMirrorDescription(ctx, config.companyId, nextMapping);
  return nextMapping;
}

async function readPullRequestMapping(
  ctx: PluginContext,
  companyId: string,
  githubPullRequestKey: string,
): Promise<PullRequestMapping | null> {
  return readState<PullRequestMapping>(ctx, companyId, pullRequestMappingStateKey(githubPullRequestKey));
}

async function buildPullRequestLinkFromWorkProduct(
  ctx: PluginContext,
  companyId: string,
  githubPullRequestKey: string,
  workProduct: unknown,
  fallbackPullRequestUrl: string | null,
): Promise<PullRequestLink | null> {
  const workProductRecord = normalizeRecord(workProduct);
  const issueId = normalizeString(workProductRecord?.issueId);
  if (!issueId) return null;
  const issue = await ctx.issues.get(issueId, companyId);
  if (!issue) return null;
  return {
    githubPullRequestKey,
    githubIssueKey: normalizeString(issue.originId),
    paperclipIssueId: issue.id,
    paperclipIssueIdentifier: issue.identifier,
    pullRequestUrl: normalizeString(workProductRecord?.url) ?? fallbackPullRequestUrl,
    workProduct: workProductRecord,
  };
}

async function findPullRequestLinksByWorkProduct(
  ctx: PluginContext,
  companyId: string,
  githubPullRequestKey: string,
  fallbackPullRequestUrl: string | null,
): Promise<PullRequestLink[]> {
  const linkedWorkProducts = await ctx.issues.workProducts.find({
    companyId,
    type: "pull_request",
    provider: "github",
    externalId: githubPullRequestKey,
  });
  const links: PullRequestLink[] = [];
  const seenIssueIds = new Set<string>();
  for (const workProduct of linkedWorkProducts) {
    const link = await buildPullRequestLinkFromWorkProduct(
      ctx,
      companyId,
      githubPullRequestKey,
      workProduct,
      fallbackPullRequestUrl,
    );
    if (!link || seenIssueIds.has(link.paperclipIssueId)) continue;
    seenIssueIds.add(link.paperclipIssueId);
    links.push(link);
  }
  return links;
}

async function upsertPullRequestWorkProduct(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  input: {
    repositoryFullName: string;
    pullRequestNumber: number;
    pullRequestUrl: string | null;
    pullRequestTitle: string | null;
    state: string | null;
    isDraft: boolean | null;
    isMerged: boolean | null;
    reviewState: string | null;
    headRef: string | null;
    headSha: string | null;
    baseRef: string | null;
    baseSha: string | null;
    existingWorkProduct?: unknown;
    metadataPatch?: Record<string, unknown>;
    healthStatus?: "unknown" | "healthy" | "unhealthy" | null;
  },
): Promise<void> {
  const externalId = githubKey(input.repositoryFullName, input.pullRequestNumber);
  const { owner, name } = splitRepositoryFullName(input.repositoryFullName);
  const workProductRecord = normalizeRecord(input.existingWorkProduct);
  const existingMetadata = normalizeRecord(workProductRecord?.metadata);
  const nextPullRequestUrl = input.pullRequestUrl
    ?? normalizeString(workProductRecord?.url)
    ?? normalizeString(existingMetadata?.url);
  const nextState = input.state ?? normalizeString(existingMetadata?.state);
  const nextIsDraft = input.isDraft ?? normalizeOptionalBoolean(existingMetadata?.draft);
  const nextIsMerged = input.isMerged ?? normalizeOptionalBoolean(existingMetadata?.merged);
  const nextReviewStateSource = input.reviewState ?? normalizeString(existingMetadata?.reviewState);
  const nextHeadRef = input.headRef ?? normalizeString(existingMetadata?.headRef);
  const nextHeadSha = input.headSha ?? normalizeString(existingMetadata?.headSha);
  const nextBaseRef = input.baseRef ?? normalizeString(existingMetadata?.baseRef);
  const nextBaseSha = input.baseSha ?? normalizeString(existingMetadata?.baseSha);
  const checksActionability = readPullRequestCheckActionability(normalizeRecord(existingMetadata?.checks)?.actionability);
  const status = pullRequestWorkProductStatus({
    state: nextState,
    isDraft: nextIsDraft,
    isMerged: nextIsMerged,
  });
  const reviewState = pullRequestWorkProductReviewState(nextReviewStateSource);
  const nextMetadata: Record<string, unknown> = {
    ...(existingMetadata ?? {}),
    host: "github.com",
    repositoryFullName: input.repositoryFullName,
    repositoryOwner: owner,
    repositoryName: name,
    pullRequestNumber: input.pullRequestNumber,
    url: nextPullRequestUrl,
    state: nextState,
    draft: nextIsDraft,
    merged: nextIsMerged,
    reviewState: nextReviewStateSource,
    headRef: nextHeadRef,
    headSha: nextHeadSha,
    baseRef: nextBaseRef,
    baseSha: nextBaseSha,
    ...(input.metadataPatch ?? {}),
  };
  const nextChecksActionability = readPullRequestCheckActionability(normalizeRecord(nextMetadata.checks)?.actionability) ?? checksActionability;
  await ctx.issues.workProducts.upsert({
    issueId,
    companyId,
    type: "pull_request",
    provider: "github",
    externalId,
    title: input.pullRequestTitle
      ?? normalizeString(workProductRecord?.title)
      ?? `GitHub pull request #${input.pullRequestNumber}`,
    url: nextPullRequestUrl,
    status,
    reviewState,
    isPrimary: true,
    healthStatus: input.healthStatus
      ?? (normalizeLowercaseString(workProductRecord?.healthStatus) as "unknown" | "healthy" | "unhealthy" | null)
      ?? "healthy",
    summary: buildPullRequestWorkProductSummary({
      externalId,
      status,
      reviewState,
      checksActionability: nextChecksActionability,
    }),
    metadata: nextMetadata,
  });
}

async function resolvePullRequestLinks(
  ctx: PluginContext,
  config: PluginConfig,
  repositoryFullName: string,
  pullRequestNumber: number,
  pullRequestUrl: string | null,
  texts: Array<string | null | undefined>,
): Promise<PullRequestLink[]> {
  const githubPullRequestKey = githubKey(repositoryFullName, pullRequestNumber);
  const linkedByWorkProduct = await findPullRequestLinksByWorkProduct(
    ctx,
    config.companyId,
    githubPullRequestKey,
    pullRequestUrl,
  );
  if (linkedByWorkProduct.length > 0) {
    return linkedByWorkProduct;
  }

  const legacyMapping = await readPullRequestMapping(ctx, config.companyId, githubPullRequestKey);
  if (legacyMapping) {
    return [{
      githubPullRequestKey,
      githubIssueKey: legacyMapping.githubIssueKey,
      paperclipIssueId: legacyMapping.paperclipIssueId,
      paperclipIssueIdentifier: null,
      pullRequestUrl: pullRequestUrl ?? legacyMapping.pullRequestUrl,
      workProduct: null,
    }];
  }

  const links: PullRequestLink[] = [];
  const seenIssueIds = new Set<string>();
  for (const referencedIssueKey of extractIssueReferenceKeys(repositoryFullName, texts)) {
    const issueMapping = await getOrRecoverIssueMapping(ctx, config, config.companyId, referencedIssueKey);
    if (!issueMapping || seenIssueIds.has(issueMapping.paperclipIssueId)) continue;
    seenIssueIds.add(issueMapping.paperclipIssueId);
    links.push({
      githubPullRequestKey,
      githubIssueKey: referencedIssueKey,
      paperclipIssueId: issueMapping.paperclipIssueId,
      paperclipIssueIdentifier: issueMapping.paperclipIssueIdentifier,
      pullRequestUrl,
      workProduct: null,
    });
  }

  if (links.length === 0 && pullRequestUrl) {
    const commentRecovered = await recoverPullRequestMappingFromIssueComments(
      ctx, config.companyId, githubPullRequestKey, pullRequestUrl,
    );
    if (commentRecovered) {
      links.push(commentRecovered);
      await upsertPullRequestWorkProduct(ctx, config.companyId, commentRecovered.paperclipIssueId, {
        repositoryFullName,
        pullRequestNumber,
        pullRequestUrl,
        pullRequestTitle: null,
        state: null,
        isDraft: null,
        isMerged: null,
        reviewState: null,
        headRef: null,
        headSha: null,
        baseRef: null,
        baseSha: null,
      });
    }
  }

  return links;
}

async function recoverPullRequestMappingFromIssueComments(
  ctx: PluginContext,
  companyId: string,
  githubPullRequestKey: string,
  pullRequestUrl: string,
): Promise<PullRequestLink | null> {
  const activeStatuses = ["in_progress", "in_review", "todo", "blocked"] as const;
  for (const status of activeStatuses) {
    let offset = 0;
    const pageSize = 25;
    while (true) {
      const issues = await ctx.issues.list({ companyId, status, limit: pageSize, offset });
      for (const issue of issues) {
        const comments = await ctx.issues.listComments(issue.id, companyId);
        if (comments.some((c) => c.body.includes(pullRequestUrl))) {
          return {
            githubPullRequestKey,
            githubIssueKey: normalizeString(issue.originId) ?? null,
            paperclipIssueId: issue.id,
            paperclipIssueIdentifier: issue.identifier,
            pullRequestUrl,
            workProduct: null,
          };
        }
      }
      if (issues.length < pageSize) break;
      offset += pageSize;
    }
  }
  return null;
}

async function recoverIssueMappingFromOrigin(
  ctx: PluginContext,
  config: PluginConfig,
  companyId: string,
  githubIssueKey: string,
): Promise<IssueMapping | null> {
  const recovered = await ctx.issues.list({
    companyId,
    originKind: `plugin:${PLUGIN_ID}`,
    originId: githubIssueKey,
    limit: 1,
  });
  const issue = recovered[0];
  if (!issue) return null;
  const githubIssueNumber = Number(githubIssueKey.split("#").at(-1) ?? "0");
  if (!Number.isFinite(githubIssueNumber) || githubIssueNumber <= 0) return null;

  const fallbackRoute = config.assigneeRoutes[0] ?? null;
  const mapping: IssueMapping = {
    githubIssueKey,
    githubIssueNumber,
    githubIssueUrl: null,
    githubIssueTitle: issue.title,
    trackedGitHubAssigneeLogin: fallbackRoute?.githubAssigneeLogin ?? null,
    mappedPaperclipAssigneeAgentId: fallbackRoute?.paperclipAssigneeAgentId ?? issue.assigneeAgentId,
    mappedPaperclipAssigneeLabel: fallbackRoute?.paperclipAssigneeLabel ?? null,
    syncMode: config.syncMode,
    lastDeliveryId: null,
    paperclipIssueId: issue.id,
    paperclipIssueIdentifier: issue.identifier,
    createdAt: issue.createdAt.toISOString(),
    updatedAt: issue.updatedAt.toISOString(),
  };
  await writeIssueMapping(ctx, companyId, mapping);
  return mapping;
}

async function getOrRecoverIssueMapping(
  ctx: PluginContext,
  config: PluginConfig,
  companyId: string,
  githubIssueKey: string,
): Promise<IssueMapping | null> {
  return await readIssueMapping(ctx, companyId, githubIssueKey)
    ?? await recoverIssueMappingFromOrigin(ctx, config, companyId, githubIssueKey);
}

async function appendIssueComment(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  body: string,
): Promise<void> {
  await ctx.issues.createComment(issueId, body, companyId);
}

async function maybeWakeIssue(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  deliveryId: string,
  reason: string,
): Promise<boolean> {
  const issue = await ctx.issues.get(issueId, companyId);
  if (!issue?.assigneeAgentId) return false;
  if (["backlog", "done", "cancelled"].includes(issue.status)) return false;

  try {
    const result = await ctx.issues.requestWakeup(issueId, companyId, {
      reason,
      contextSource: "github-webhook-poc",
      idempotencyKey: `github:${deliveryId}:${reason}`,
    });
    return result.queued;
  } catch (error) {
    ctx.logger.warn("Failed to queue wakeup from GitHub delivery", {
      companyId,
      issueId,
      deliveryId,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function ensureIssueMapping(
  ctx: PluginContext,
  config: PluginConfig,
  repositoryFullName: string,
  issue: GitHubIssue,
  fallbackAssignee: GitHubActor | null | undefined,
  actor: GitHubActor | null | undefined,
  deliveryId: string,
  triggerAction: string,
): Promise<{ mapping: IssueMapping | null; created: boolean; wakeQueued: boolean }> {
  const githubIssueNumber = getIssueNumber(issue);
  const githubIssueKey = githubKey(repositoryFullName, githubIssueNumber);
  const matchedRoute = findAssigneeRoute(issue, config.assigneeRoutes, fallbackAssignee);
  const existing = await getOrRecoverIssueMapping(ctx, config, config.companyId, githubIssueKey);
  if (existing) {
    const updated = withMirrorDefaults({
      ...existing,
      githubIssueUrl: normalizeString(issue.html_url) ?? existing.githubIssueUrl,
      githubIssueTitle: normalizeString(issue.title) ?? existing.githubIssueTitle,
      updatedAt: new Date().toISOString(),
    }, config, matchedRoute);
    await writeIssueMapping(ctx, config.companyId, updated);
    return { mapping: updated, created: false, wakeQueued: false };
  }

  if (!matchedRoute || !issueShouldCreatePaperclipWork(repositoryFullName, issue, config, fallbackAssignee)) {
    return { mapping: null, created: false, wakeQueued: false };
  }

  const mappedPaperclipAssigneeLabel = await resolveAssigneeRouteLabel(ctx, config.companyId, matchedRoute);
  const createdIssue = await ctx.issues.create({
    companyId: config.companyId,
    projectId: config.projectId || undefined,
    title: buildPaperclipIssueTitle(config.issueTitlePrefix, normalizeString(issue.title), githubIssueNumber),
    description: buildInitialIssueDescription({
      githubIssueKey,
      githubIssueNumber,
      githubIssueUrl: normalizeString(issue.html_url),
      trackedGitHubAssigneeLogin: matchedRoute.githubAssigneeLogin,
      mappedPaperclipAssigneeLabel,
      syncMode: config.syncMode,
      lastDeliveryId: deliveryId,
      githubIssueBody: normalizeString(issue.body),
    }),
    status: "todo",
    priority: "medium",
    assigneeAgentId: matchedRoute.paperclipAssigneeAgentId || undefined,
    originKind: `plugin:${PLUGIN_ID}`,
    originId: githubIssueKey,
  });

  const wakeQueued = await maybeWakeIssue(
    ctx,
    config.companyId,
    createdIssue.id,
    deliveryId,
    `github:${triggerAction}:create`,
  );

  const mapping: IssueMapping = {
    githubIssueKey,
    githubIssueNumber,
    githubIssueUrl: normalizeString(issue.html_url),
    githubIssueTitle: normalizeString(issue.title),
    trackedGitHubAssigneeLogin: matchedRoute.githubAssigneeLogin,
    mappedPaperclipAssigneeAgentId: matchedRoute.paperclipAssigneeAgentId,
    mappedPaperclipAssigneeLabel,
    syncMode: config.syncMode,
    lastDeliveryId: deliveryId,
    paperclipIssueId: createdIssue.id,
    paperclipIssueIdentifier: createdIssue.identifier,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeIssueMapping(ctx, config.companyId, mapping);

  await appendIssueComment(
    ctx,
    config.companyId,
    createdIssue.id,
    joinCommentLines([
      `GitHub issue linked: ${githubIssueKey}`,
      `Trigger: assigned to \`${matchedRoute.githubAssigneeLogin}\` in \`${config.repositoryFullName}\``,
      normalizeString(issue.html_url) ? `URL: ${normalizeString(issue.html_url)}` : null,
      `Mapped Paperclip assignee: ${mappedPaperclipAssigneeLabel}`,
      `Sync mode: \`${config.syncMode}\``,
      "",
      `Paperclip issue created from \`issues.${triggerAction}\`.`,
      `Event actor: \`${actorLogin(actor, fallbackAssignee)}\``,
      wakeQueued ? "Paperclip wake requested." : null,
    ]),
  );

  return { mapping, created: true, wakeQueued };
}

async function syncIssuesWebhook(
  ctx: PluginContext,
  config: PluginConfig,
  deliveryId: string,
  payload: GitHubIssuesPayload,
): Promise<SyncResult> {
  const action = normalizeString(payload.action) ?? "unknown";
  const issue = payload.issue;
  if (!issue) return { processed: false, reason: "missing-issue", mappedIssueId: null, wakeQueued: false };

  const repositoryFullName = getRepositoryFullName(payload.repository);
  if (!repositoryMatches(repositoryFullName, config.repositoryFullName)) {
    return { processed: false, reason: "ignored-repository", mappedIssueId: null, wakeQueued: false };
  }

  const matchedRoute = findAssigneeRoute(issue, config.assigneeRoutes, payload.assignee);
  const mappingResult = await ensureIssueMapping(
    ctx,
    config,
    repositoryFullName,
    issue,
    payload.assignee,
    payload.sender,
    deliveryId,
    action,
  );
  if (mappingResult.created) {
    return {
      processed: true,
      reason: `issues:${action}:created`,
      mappedIssueId: mappingResult.mapping?.paperclipIssueId ?? null,
      wakeQueued: mappingResult.wakeQueued,
    };
  }
  if (!mappingResult.mapping) {
    return {
      processed: false,
      reason: matchedRoute
        ? "mapping-not-created"
        : "tracked-assignee-missing",
      mappedIssueId: null,
      wakeQueued: false,
    };
  }

  const mappedIssue = await ctx.issues.get(mappingResult.mapping.paperclipIssueId, config.companyId);
  if (!mappedIssue) {
    return { processed: false, reason: "paperclip-issue-missing", mappedIssueId: null, wakeQueued: false };
  }

  const patch: { title?: string; status?: "todo" | "done" } = {};
  if (["opened", "edited", "assigned", "reopened"].includes(action)) {
    patch.title = buildPaperclipIssueTitle(
      config.issueTitlePrefix,
      normalizeString(issue.title),
      mappingResult.mapping.githubIssueNumber,
    );
  }
  if (action === "closed") {
    patch.status = "done";
  } else if (action === "reopened" && mappedIssue.status === "done") {
    patch.status = "todo";
  }

  if (patch.title || patch.status) {
    await ctx.issues.update(mappingResult.mapping.paperclipIssueId, patch, config.companyId);
  }

  const wakeQueued = patch.status === "done"
    ? false
    : await maybeWakeIssue(ctx, config.companyId, mappingResult.mapping.paperclipIssueId, deliveryId, `github:issues.${action}`);

  await appendIssueComment(
    ctx,
    config.companyId,
    mappingResult.mapping.paperclipIssueId,
    buildIssueEventComment({
      action,
      githubIssueKey: mappingResult.mapping.githubIssueKey,
      actorLogin: actorLogin(payload.sender, payload.assignee),
      githubUrl: normalizeString(issue.html_url) ?? mappingResult.mapping.githubIssueUrl,
      githubTitle: normalizeString(issue.title),
      trackedAssigneeLogin: matchedRoute?.githubAssigneeLogin
        ?? mappingResult.mapping.trackedGitHubAssigneeLogin
        ?? config.assigneeRoutes[0]?.githubAssigneeLogin
        ?? DEFAULT_ASSIGNEE_LOGIN,
      assignees: listIssueAssigneeLogins(issue, payload.assignee),
      wakeQueued,
      paperclipStatusChanged: patch.status ?? null,
    }),
  );

  await refreshIssueMirror(ctx, config, mappingResult.mapping, {
    deliveryId,
    githubIssueUrl: normalizeString(issue.html_url) ?? mappingResult.mapping.githubIssueUrl,
    githubIssueTitle: normalizeString(issue.title) ?? mappingResult.mapping.githubIssueTitle,
    route: matchedRoute,
  });

  return {
    processed: true,
    reason: `issues:${action}`,
    mappedIssueId: mappingResult.mapping.paperclipIssueId,
    wakeQueued,
  };
}

async function refreshPullRequestLinkMirrorIfPossible(
  ctx: PluginContext,
  config: PluginConfig,
  deliveryId: string,
  link: PullRequestLink,
): Promise<void> {
  if (!link.githubIssueKey) return;
  const issueMapping = await getOrRecoverIssueMapping(ctx, config, config.companyId, link.githubIssueKey);
  if (!issueMapping) return;
  await refreshIssueMirror(ctx, config, issueMapping, { deliveryId });
}

async function maybeCompleteIssueOnMergedPullRequest(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
): Promise<"done" | null> {
  const issue = await ctx.issues.get(issueId, companyId);
  if (!issue) return null;
  if (issue.status !== "in_review") return null;
  if (issue.executionPolicy || issue.executionState) return null;
  await ctx.issues.update(issueId, { status: "done" }, companyId);
  return "done";
}

function getLinkedPullRequestNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const numbers = new Set<number>();
  for (const entry of value) {
    const number = (entry && typeof entry === "object" && !Array.isArray(entry))
      ? (entry as { number?: unknown }).number
      : null;
    if (typeof number === "number" && Number.isFinite(number)) {
      numbers.add(number);
    }
  }
  return [...numbers];
}

async function syncIssueCommentWebhook(
  ctx: PluginContext,
  config: PluginConfig,
  deliveryId: string,
  payload: GitHubIssueCommentPayload,
): Promise<SyncResult> {
  const action = normalizeString(payload.action) ?? "unknown";
  const issue = payload.issue;
  if (!issue) return { processed: false, reason: "missing-issue", mappedIssueId: null, wakeQueued: false };

  const repositoryFullName = getRepositoryFullName(payload.repository);
  if (!repositoryMatches(repositoryFullName, config.repositoryFullName)) {
    return { processed: false, reason: "ignored-repository", mappedIssueId: null, wakeQueued: false };
  }

  if (issueIsPullRequest(issue)) {
    const pullRequestNumber = getIssueNumber(issue);
    const pullRequestUrl = normalizeString((issue.pull_request as { html_url?: unknown } | null | undefined)?.html_url)
      ?? normalizeString(issue.html_url);
    const pullRequestLinks = await resolvePullRequestLinks(
      ctx,
      config,
      repositoryFullName,
      pullRequestNumber,
      pullRequestUrl,
      [normalizeString(issue.body), normalizeString(issue.title)],
    );
    if (pullRequestLinks.length === 0) {
      return { processed: false, reason: "pull-request-link-missing", mappedIssueId: null, wakeQueued: false };
    }

    let wakeQueued = false;
    for (const pullRequestLink of pullRequestLinks) {
      await upsertPullRequestWorkProduct(ctx, config.companyId, pullRequestLink.paperclipIssueId, {
        repositoryFullName,
        pullRequestNumber,
        pullRequestUrl,
        pullRequestTitle: normalizeString(issue.title),
        state: normalizeString(issue.state),
        isDraft: null,
        isMerged: null,
        reviewState: null,
        headRef: null,
        headSha: null,
        baseRef: null,
        baseSha: null,
        existingWorkProduct: pullRequestLink.workProduct,
      });

      const linkWakeQueued = await maybeWakeIssue(
        ctx,
        config.companyId,
        pullRequestLink.paperclipIssueId,
        deliveryId,
        `github:pull_request.issue_comment.${action}`,
      );
      wakeQueued ||= linkWakeQueued;

      await appendIssueComment(
        ctx,
        config.companyId,
        pullRequestLink.paperclipIssueId,
        buildPullRequestCommentBody({
          eventName: `GitHub issue_comment.${action}`,
          githubPullRequestKey: pullRequestLink.githubPullRequestKey,
          githubIssueKey: pullRequestLink.githubIssueKey,
          actorLogin: actorLogin(payload.comment?.user, payload.sender),
          githubUrl: normalizeString(payload.comment?.html_url) ?? pullRequestLink.pullRequestUrl,
          commentBody: normalizeString(payload.comment?.body),
          wakeQueued: linkWakeQueued,
        }),
      );

      await refreshPullRequestLinkMirrorIfPossible(ctx, config, deliveryId, pullRequestLink);
    }

    return {
      processed: true,
      reason: `pull_request_issue_comment:${action}`,
      mappedIssueId: pullRequestLinks[0]?.paperclipIssueId ?? null,
      wakeQueued,
    };
  }

  const mappingResult = await ensureIssueMapping(
    ctx,
    config,
    repositoryFullName,
    issue,
    null,
    payload.sender,
    deliveryId,
    `issue_comment.${action}`,
  );
  if (!mappingResult.mapping) {
    return { processed: false, reason: "issue-mapping-missing", mappedIssueId: null, wakeQueued: false };
  }

  const matchedRoute = findAssigneeRoute(issue, config.assigneeRoutes);
  const wakeQueued = mappingResult.wakeQueued
    || await maybeWakeIssue(ctx, config.companyId, mappingResult.mapping.paperclipIssueId, deliveryId, `github:issue_comment.${action}`);

  await appendIssueComment(
    ctx,
    config.companyId,
    mappingResult.mapping.paperclipIssueId,
    buildCommentMirrorBody({
      eventName: `GitHub issue_comment.${action}`,
      githubKey: mappingResult.mapping.githubIssueKey,
      actorLogin: actorLogin(payload.comment?.user, payload.sender),
      githubUrl: normalizeString(payload.comment?.html_url) ?? normalizeString(issue.html_url),
      commentBody: normalizeString(payload.comment?.body),
      wakeQueued,
    }),
  );

  await refreshIssueMirror(ctx, config, mappingResult.mapping, {
    deliveryId,
    githubIssueUrl: normalizeString(issue.html_url) ?? mappingResult.mapping.githubIssueUrl,
    githubIssueTitle: normalizeString(issue.title) ?? mappingResult.mapping.githubIssueTitle,
    route: matchedRoute,
  });

  return {
    processed: true,
    reason: `issue_comment:${action}`,
    mappedIssueId: mappingResult.mapping.paperclipIssueId,
    wakeQueued,
  };
}

async function syncPullRequestWebhook(
  ctx: PluginContext,
  config: PluginConfig,
  deliveryId: string,
  payload: GitHubPullRequestPayload,
): Promise<SyncResult> {
  const action = normalizeString(payload.action) ?? "unknown";
  const pullRequest = payload.pull_request;
  if (!pullRequest) return { processed: false, reason: "missing-pull-request", mappedIssueId: null, wakeQueued: false };

  const repositoryFullName = getRepositoryFullName(payload.repository);
  if (!repositoryMatches(repositoryFullName, config.repositoryFullName)) {
    return { processed: false, reason: "ignored-repository", mappedIssueId: null, wakeQueued: false };
  }

  const pullRequestNumber = getPullRequestNumber(payload);
  const pullRequestLinks = await resolvePullRequestLinks(
    ctx,
    config,
    repositoryFullName,
    pullRequestNumber,
    normalizeString(pullRequest.html_url),
    [normalizeString(pullRequest.body), normalizeString(pullRequest.title)],
  );
  if (pullRequestLinks.length === 0) {
    return { processed: false, reason: "pull-request-link-missing", mappedIssueId: null, wakeQueued: false };
  }

  let wakeQueued = false;
  for (const pullRequestLink of pullRequestLinks) {
    await upsertPullRequestWorkProduct(ctx, config.companyId, pullRequestLink.paperclipIssueId, {
      repositoryFullName,
      pullRequestNumber,
      pullRequestUrl: normalizeString(pullRequest.html_url),
      pullRequestTitle: normalizeString(pullRequest.title),
      state: normalizeString(pullRequest.state),
      isDraft: normalizeOptionalBoolean(pullRequest.draft),
      isMerged: normalizeOptionalBoolean(pullRequest.merged),
      reviewState: normalizeString(pullRequest.review_decision),
      headRef: normalizeString(pullRequest.head?.ref),
      headSha: normalizeString(pullRequest.head?.sha),
      baseRef: normalizeString(pullRequest.base?.ref),
      baseSha: normalizeString(pullRequest.base?.sha),
      existingWorkProduct: pullRequestLink.workProduct,
    });

    const linkWakeQueued = await maybeWakeIssue(
      ctx,
      config.companyId,
      pullRequestLink.paperclipIssueId,
      deliveryId,
      `github:pull_request.${action}`,
    );
    wakeQueued ||= linkWakeQueued;

    const paperclipStatusChanged = action === "closed" && normalizeBoolean(pullRequest.merged)
      ? await maybeCompleteIssueOnMergedPullRequest(ctx, config.companyId, pullRequestLink.paperclipIssueId)
      : null;

    await appendIssueComment(
      ctx,
      config.companyId,
      pullRequestLink.paperclipIssueId,
      buildPullRequestEventComment({
        action,
        githubPullRequestKey: pullRequestLink.githubPullRequestKey,
        githubIssueKey: pullRequestLink.githubIssueKey,
        actorLogin: actorLogin(payload.sender),
        githubUrl: normalizeString(pullRequest.html_url),
        isMerged: normalizeBoolean(pullRequest.merged),
        wakeQueued: linkWakeQueued,
        paperclipStatusChanged,
      }),
    );

    await refreshPullRequestLinkMirrorIfPossible(ctx, config, deliveryId, pullRequestLink);
  }

  return {
    processed: true,
    reason: `pull_request:${action}`,
    mappedIssueId: pullRequestLinks[0]?.paperclipIssueId ?? null,
    wakeQueued,
  };
}

async function syncPullRequestReviewWebhook(
  ctx: PluginContext,
  config: PluginConfig,
  deliveryId: string,
  payload: GitHubPullRequestReviewPayload,
): Promise<SyncResult> {
  const action = normalizeString(payload.action) ?? "unknown";
  const pullRequest = payload.pull_request;
  if (!pullRequest) return { processed: false, reason: "missing-pull-request", mappedIssueId: null, wakeQueued: false };

  const repositoryFullName = getRepositoryFullName(payload.repository);
  if (!repositoryMatches(repositoryFullName, config.repositoryFullName)) {
    return { processed: false, reason: "ignored-repository", mappedIssueId: null, wakeQueued: false };
  }

  const pullRequestNumber = getPullRequestNumber(payload as GitHubPullRequestPayload & GitHubPullRequestReviewPayload);
  const pullRequestLinks = await resolvePullRequestLinks(
    ctx,
    config,
    repositoryFullName,
    pullRequestNumber,
    normalizeString(pullRequest.html_url),
    [normalizeString(pullRequest.body), normalizeString(pullRequest.title), normalizeString(payload.review?.body)],
  );
  if (pullRequestLinks.length === 0) {
    return { processed: false, reason: "pull-request-link-missing", mappedIssueId: null, wakeQueued: false };
  }

  const reviewStateSource = normalizeString(payload.review?.state) ?? normalizeString(pullRequest.review_decision);
  const reviewState = pullRequestWorkProductReviewState(reviewStateSource);
  let wakeQueued = false;
  for (const pullRequestLink of pullRequestLinks) {
    await upsertPullRequestWorkProduct(ctx, config.companyId, pullRequestLink.paperclipIssueId, {
      repositoryFullName,
      pullRequestNumber,
      pullRequestUrl: normalizeString(pullRequest.html_url),
      pullRequestTitle: normalizeString(pullRequest.title),
      state: normalizeString(pullRequest.state),
      isDraft: normalizeOptionalBoolean(pullRequest.draft),
      isMerged: normalizeOptionalBoolean(pullRequest.merged),
      reviewState: reviewStateSource,
      headRef: normalizeString(pullRequest.head?.ref),
      headSha: normalizeString(pullRequest.head?.sha),
      baseRef: normalizeString(pullRequest.base?.ref),
      baseSha: normalizeString(pullRequest.base?.sha),
      existingWorkProduct: pullRequestLink.workProduct,
    });

    const linkWakeQueued = await maybeWakeIssue(
      ctx,
      config.companyId,
      pullRequestLink.paperclipIssueId,
      deliveryId,
      `github:pull_request_review.${action}`,
    );
    wakeQueued ||= linkWakeQueued;

    await appendIssueComment(
      ctx,
      config.companyId,
      pullRequestLink.paperclipIssueId,
      buildPullRequestReviewBody({
        action,
        githubPullRequestKey: pullRequestLink.githubPullRequestKey,
        githubIssueKey: pullRequestLink.githubIssueKey,
        actorLogin: actorLogin(payload.review?.user, payload.sender),
        githubUrl: normalizeString(payload.review?.html_url) ?? normalizeString(pullRequest.html_url),
        reviewState,
        reviewBody: normalizeString(payload.review?.body),
        wakeQueued: linkWakeQueued,
      }),
    );

    await refreshPullRequestLinkMirrorIfPossible(ctx, config, deliveryId, pullRequestLink);
  }

  return {
    processed: true,
    reason: `pull_request_review:${action}`,
    mappedIssueId: pullRequestLinks[0]?.paperclipIssueId ?? null,
    wakeQueued,
  };
}

async function syncCheckRunWebhook(
  ctx: PluginContext,
  config: PluginConfig,
  deliveryId: string,
  payload: GitHubCheckRunPayload,
): Promise<SyncResult> {
  const action = normalizeString(payload.action) ?? "unknown";
  const checkRun = payload.check_run;
  if (!checkRun) return { processed: false, reason: "missing-check-run", mappedIssueId: null, wakeQueued: false };

  const repositoryFullName = getRepositoryFullName(payload.repository);
  if (!repositoryMatches(repositoryFullName, config.repositoryFullName)) {
    return { processed: false, reason: "ignored-repository", mappedIssueId: null, wakeQueued: false };
  }

  const pullRequestNumbers = getLinkedPullRequestNumbers(checkRun.pull_requests);
  if (pullRequestNumbers.length === 0) {
    return { processed: false, reason: "check-run-unlinked", mappedIssueId: null, wakeQueued: false };
  }

  const checkName = normalizeString(checkRun.name) ?? normalizeString(checkRun.output?.title);
  const checkUrl = normalizeString(checkRun.details_url) ?? normalizeString(checkRun.html_url);
  const status = normalizeLowercaseString(checkRun.status);
  const conclusion = normalizeLowercaseString(checkRun.conclusion);
  const eventName = `check_run.${action}`;
  let processed = false;
  let mappedIssueId: string | null = null;
  let wakeQueued = false;

  for (const pullRequestNumber of pullRequestNumbers) {
    const pullRequestLinks = await resolvePullRequestLinks(
      ctx,
      config,
      repositoryFullName,
      pullRequestNumber,
      checkUrl,
      [],
    );
    if (pullRequestLinks.length === 0) continue;
    processed = true;
    mappedIssueId ??= pullRequestLinks[0]?.paperclipIssueId ?? null;

    for (const pullRequestLink of pullRequestLinks) {
      const workProductRecord = normalizeRecord(pullRequestLink.workProduct);
      const existingMetadata = normalizeRecord(workProductRecord?.metadata);
      const checkMetadata = buildNextPullRequestChecksMetadata(existingMetadata, {
        collection: "checkRuns",
        key: checkName ?? `check-run:${pullRequestNumber}`,
        status,
        conclusion,
        name: checkName,
        url: checkUrl,
        deliveryId,
        eventName,
      });

      await upsertPullRequestWorkProduct(ctx, config.companyId, pullRequestLink.paperclipIssueId, {
        repositoryFullName,
        pullRequestNumber,
        pullRequestUrl: checkUrl,
        pullRequestTitle: null,
        state: normalizeString(existingMetadata?.state),
        isDraft: normalizeOptionalBoolean(existingMetadata?.draft),
        isMerged: normalizeOptionalBoolean(existingMetadata?.merged),
        reviewState: normalizeString(existingMetadata?.reviewState),
        headRef: normalizeString(existingMetadata?.headRef),
        headSha: normalizeString(checkRun.head_sha) ?? normalizeString(existingMetadata?.headSha),
        baseRef: normalizeString(existingMetadata?.baseRef),
        baseSha: normalizeString(existingMetadata?.baseSha),
        existingWorkProduct: pullRequestLink.workProduct,
        metadataPatch: checkMetadata.metadataPatch,
        healthStatus: pullRequestHealthStatusFromChecks(checkMetadata.nextActionability),
      });

      if (checkMetadata.previousActionability === checkMetadata.nextActionability) {
        continue;
      }

      const linkWakeQueued = checkMetadata.nextActionability === "failed" || checkMetadata.nextActionability === "passed"
        ? await maybeWakeIssue(
          ctx,
          config.companyId,
          pullRequestLink.paperclipIssueId,
          deliveryId,
          `github:check_run.${action}:${checkMetadata.nextActionability}`,
        )
        : false;
      wakeQueued ||= linkWakeQueued;

      await appendIssueComment(
        ctx,
        config.companyId,
        pullRequestLink.paperclipIssueId,
        buildPullRequestCheckBody({
          eventName: `GitHub check_run.${action}`,
          githubPullRequestKey: pullRequestLink.githubPullRequestKey,
          githubIssueKey: pullRequestLink.githubIssueKey,
          actorLogin: actorLogin(payload.sender),
          githubUrl: checkUrl,
          checkName,
          status,
          conclusion,
          actionability: checkMetadata.nextActionability,
          wakeQueued: linkWakeQueued,
        }),
      );

      await refreshPullRequestLinkMirrorIfPossible(ctx, config, deliveryId, pullRequestLink);
    }
  }

  return {
    processed,
    reason: processed ? `check_run:${action}` : "pull-request-link-missing",
    mappedIssueId,
    wakeQueued,
  };
}

async function syncCheckSuiteWebhook(
  ctx: PluginContext,
  config: PluginConfig,
  deliveryId: string,
  payload: GitHubCheckSuitePayload,
): Promise<SyncResult> {
  const action = normalizeString(payload.action) ?? "unknown";
  const checkSuite = payload.check_suite;
  if (!checkSuite) return { processed: false, reason: "missing-check-suite", mappedIssueId: null, wakeQueued: false };

  const repositoryFullName = getRepositoryFullName(payload.repository);
  if (!repositoryMatches(repositoryFullName, config.repositoryFullName)) {
    return { processed: false, reason: "ignored-repository", mappedIssueId: null, wakeQueued: false };
  }

  const pullRequestNumbers = getLinkedPullRequestNumbers(checkSuite.pull_requests);
  if (pullRequestNumbers.length === 0) {
    return { processed: false, reason: "check-suite-unlinked", mappedIssueId: null, wakeQueued: false };
  }

  const checkName = normalizeString(checkSuite.app?.name) ?? normalizeString(checkSuite.head_branch);
  const checkUrl = normalizeString(checkSuite.html_url);
  const status = normalizeLowercaseString(checkSuite.status);
  const conclusion = normalizeLowercaseString(checkSuite.conclusion);
  const eventName = `check_suite.${action}`;
  let processed = false;
  let mappedIssueId: string | null = null;
  let wakeQueued = false;

  for (const pullRequestNumber of pullRequestNumbers) {
    const pullRequestLinks = await resolvePullRequestLinks(
      ctx,
      config,
      repositoryFullName,
      pullRequestNumber,
      checkUrl,
      [],
    );
    if (pullRequestLinks.length === 0) continue;
    processed = true;
    mappedIssueId ??= pullRequestLinks[0]?.paperclipIssueId ?? null;

    for (const pullRequestLink of pullRequestLinks) {
      const workProductRecord = normalizeRecord(pullRequestLink.workProduct);
      const existingMetadata = normalizeRecord(workProductRecord?.metadata);
      const checkMetadata = buildNextPullRequestChecksMetadata(existingMetadata, {
        collection: "checkSuites",
        key: checkName ?? `check-suite:${pullRequestNumber}`,
        status,
        conclusion,
        name: checkName,
        url: checkUrl,
        deliveryId,
        eventName,
      });

      await upsertPullRequestWorkProduct(ctx, config.companyId, pullRequestLink.paperclipIssueId, {
        repositoryFullName,
        pullRequestNumber,
        pullRequestUrl: checkUrl,
        pullRequestTitle: null,
        state: normalizeString(existingMetadata?.state),
        isDraft: normalizeOptionalBoolean(existingMetadata?.draft),
        isMerged: normalizeOptionalBoolean(existingMetadata?.merged),
        reviewState: normalizeString(existingMetadata?.reviewState),
        headRef: normalizeString(existingMetadata?.headRef),
        headSha: normalizeString(checkSuite.head_sha) ?? normalizeString(existingMetadata?.headSha),
        baseRef: normalizeString(existingMetadata?.baseRef),
        baseSha: normalizeString(existingMetadata?.baseSha),
        existingWorkProduct: pullRequestLink.workProduct,
        metadataPatch: checkMetadata.metadataPatch,
        healthStatus: pullRequestHealthStatusFromChecks(checkMetadata.nextActionability),
      });

      if (checkMetadata.previousActionability === checkMetadata.nextActionability) {
        continue;
      }

      const linkWakeQueued = checkMetadata.nextActionability === "failed" || checkMetadata.nextActionability === "passed"
        ? await maybeWakeIssue(
          ctx,
          config.companyId,
          pullRequestLink.paperclipIssueId,
          deliveryId,
          `github:check_suite.${action}:${checkMetadata.nextActionability}`,
        )
        : false;
      wakeQueued ||= linkWakeQueued;

      await appendIssueComment(
        ctx,
        config.companyId,
        pullRequestLink.paperclipIssueId,
        buildPullRequestCheckBody({
          eventName: `GitHub check_suite.${action}`,
          githubPullRequestKey: pullRequestLink.githubPullRequestKey,
          githubIssueKey: pullRequestLink.githubIssueKey,
          actorLogin: actorLogin(payload.sender),
          githubUrl: checkUrl,
          checkName,
          status,
          conclusion,
          actionability: checkMetadata.nextActionability,
          wakeQueued: linkWakeQueued,
        }),
      );

      await refreshPullRequestLinkMirrorIfPossible(ctx, config, deliveryId, pullRequestLink);
    }
  }

  return {
    processed,
    reason: processed ? `check_suite:${action}` : "pull-request-link-missing",
    mappedIssueId,
    wakeQueued,
  };
}

async function syncPullRequestReviewCommentWebhook(
  ctx: PluginContext,
  config: PluginConfig,
  deliveryId: string,
  payload: GitHubPullRequestReviewCommentPayload,
): Promise<SyncResult> {
  const action = normalizeString(payload.action) ?? "unknown";
  const pullRequest = payload.pull_request;
  if (!pullRequest) return { processed: false, reason: "missing-pull-request", mappedIssueId: null, wakeQueued: false };

  const repositoryFullName = getRepositoryFullName(payload.repository);
  if (!repositoryMatches(repositoryFullName, config.repositoryFullName)) {
    return { processed: false, reason: "ignored-repository", mappedIssueId: null, wakeQueued: false };
  }

  const pullRequestNumber = getPullRequestNumber(payload);
  const pullRequestLinks = await resolvePullRequestLinks(
    ctx,
    config,
    repositoryFullName,
    pullRequestNumber,
    normalizeString(pullRequest.html_url),
    [normalizeString(pullRequest.body), normalizeString(pullRequest.title)],
  );
  if (pullRequestLinks.length === 0) {
    return { processed: false, reason: "pull-request-link-missing", mappedIssueId: null, wakeQueued: false };
  }

  let wakeQueued = false;
  for (const pullRequestLink of pullRequestLinks) {
    await upsertPullRequestWorkProduct(ctx, config.companyId, pullRequestLink.paperclipIssueId, {
      repositoryFullName,
      pullRequestNumber,
      pullRequestUrl: normalizeString(pullRequest.html_url),
      pullRequestTitle: normalizeString(pullRequest.title),
      state: normalizeString(pullRequest.state),
      isDraft: normalizeOptionalBoolean(pullRequest.draft),
      isMerged: normalizeOptionalBoolean(pullRequest.merged),
      reviewState: normalizeString(pullRequest.review_decision),
      headRef: normalizeString(pullRequest.head?.ref),
      headSha: normalizeString(pullRequest.head?.sha),
      baseRef: normalizeString(pullRequest.base?.ref),
      baseSha: normalizeString(pullRequest.base?.sha),
      existingWorkProduct: pullRequestLink.workProduct,
    });

    const linkWakeQueued = await maybeWakeIssue(
      ctx,
      config.companyId,
      pullRequestLink.paperclipIssueId,
      deliveryId,
      `github:pull_request_review_comment.${action}`,
    );
    wakeQueued ||= linkWakeQueued;

    await appendIssueComment(
      ctx,
      config.companyId,
      pullRequestLink.paperclipIssueId,
      buildPullRequestCommentBody({
        eventName: `GitHub pull_request_review_comment.${action}`,
        githubPullRequestKey: pullRequestLink.githubPullRequestKey,
        githubIssueKey: pullRequestLink.githubIssueKey,
        actorLogin: actorLogin(payload.comment?.user, payload.sender),
        githubUrl: normalizeString(payload.comment?.html_url) ?? pullRequestLink.pullRequestUrl,
        commentBody: normalizeString(payload.comment?.body),
        wakeQueued: linkWakeQueued,
      }),
    );

    await refreshPullRequestLinkMirrorIfPossible(ctx, config, deliveryId, pullRequestLink);
  }

  return {
    processed: true,
    reason: `pull_request_review_comment:${action}`,
    mappedIssueId: pullRequestLinks[0]?.paperclipIssueId ?? null,
    wakeQueued,
  };
}

const plugin = definePlugin({
  async setup(ctx) {
    currentContext = ctx;

    ctx.data.register("health", async () => {
      const config = await getConfig(ctx);
      return {
        status: runtimeReady(config) ? "ok" : "degraded",
        checkedAt: new Date().toISOString(),
        companyId: config.companyId || null,
        projectId: config.projectId || null,
        repositoryFullName: config.repositoryFullName,
        syncMode: config.syncMode,
        assigneeRoutes: config.assigneeRoutes,
        webhookSecretConfigured: Boolean(config.webhookSecretRef),
        webhookPath: `/api/plugins/${PLUGIN_ID}/webhooks/${WEBHOOK_ENDPOINT_KEY}`,
        lastDelivery: await getLastDelivery(ctx),
      } satisfies HealthData;
    });
  },

  async onValidateConfig(config) {
    const rawConfig = config && typeof config === "object" && !Array.isArray(config)
      ? config as Record<string, unknown>
      : {};
    const normalized = normalizeConfig(rawConfig);

    const errors: string[] = [];
    const warnings: string[] = [];

    if (!normalized.companyId) warnings.push("companyId is not set yet.");
    if (!normalized.projectId) warnings.push("projectId is not set yet.");
    if (!normalized.webhookSecretRef) warnings.push("webhookSecretRef is not set yet.");
    if (!normalized.repositoryFullName) errors.push("repositoryFullName is required.");
    if (!normalized.syncMode) errors.push("syncMode is required.");
    if (normalized.assigneeRoutes.length === 0) {
      errors.push("At least one assignee route is required.");
    }

    if (!Array.isArray(rawConfig.assigneeRoutes) && normalizeString(rawConfig.assigneeId ?? rawConfig.assigneeAgentId)) {
      warnings.push("Legacy assigneeAgentId/githubAssigneeLogin config is still in use; save the plugin config to persist explicit assigneeRoutes.");
    }

    if (currentContext && normalized.companyId && normalized.projectId) {
      const project = await currentContext.projects.get(normalized.projectId, normalized.companyId);
      if (!project) errors.push(`projectId does not resolve inside company ${normalized.companyId}.`);
    }

    if (currentContext && normalized.companyId) {
      for (const route of normalized.assigneeRoutes) {
        const agent = await currentContext.agents.get(route.paperclipAssigneeAgentId, normalized.companyId);
        if (!agent) {
          errors.push(`Route for GitHub assignee ${route.githubAssigneeLogin} does not resolve agent ${route.paperclipAssigneeAgentId} inside company ${normalized.companyId}.`);
        }
      }
    }

    if (currentContext && normalized.webhookSecretRef) {
      try {
        await currentContext.secrets.resolve(normalized.webhookSecretRef);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    warnings.push(
      "GitHub delivery still requires an externally reachable HTTPS Paperclip URL plus GitHub repo or app admin rights to register the webhook.",
    );

    return {
      ok: errors.length === 0,
      errors,
      warnings,
    };
  },

  async onWebhook(input) {
    if (!currentContext) {
      throw new Error("Plugin context is not initialized");
    }
    if (input.endpointKey !== WEBHOOK_ENDPOINT_KEY) {
      throw new Error(`Unsupported webhook endpoint: ${input.endpointKey}`);
    }

    const config = await getConfig(currentContext);
    if (!runtimeReady(config)) {
      throw new Error("Plugin config is incomplete; companyId, projectId, webhookSecretRef, repositoryFullName, syncMode, and at least one assignee route are required");
    }

    const deliveryId = getHeader(input.headers, "x-github-delivery");
    const eventType = getHeader(input.headers, "x-github-event");
    const signature = getHeader(input.headers, "x-hub-signature-256");
    if (!deliveryId) throw new Error("Missing X-GitHub-Delivery header");
    if (!eventType) throw new Error("Missing X-GitHub-Event header");
    if (!signature) throw new Error("Missing X-Hub-Signature-256 header");

    const existingDelivery = await currentContext.state.get({ scopeKind: "instance", stateKey: deliveryStateKey(deliveryId) });
    if (existingDelivery) {
      currentContext.logger.info("Skipping duplicate GitHub delivery", { deliveryId, eventType });
      return;
    }

    const secret = await currentContext.secrets.resolve(config.webhookSecretRef);
    verifyGitHubSignature(secret, input.rawBody, signature);

    const parsed = parseWebhookPayload(input);
    const action = normalizeString(parsed.action) ?? "unknown";

    let result: SyncResult;
    if (eventType === "issues") {
      result = await syncIssuesWebhook(currentContext, config, deliveryId, parsed as GitHubIssuesPayload);
    } else if (eventType === "issue_comment") {
      result = await syncIssueCommentWebhook(currentContext, config, deliveryId, parsed as GitHubIssueCommentPayload);
    } else if (eventType === "pull_request") {
      result = await syncPullRequestWebhook(currentContext, config, deliveryId, parsed as GitHubPullRequestPayload);
    } else if (eventType === "pull_request_review") {
      result = await syncPullRequestReviewWebhook(
        currentContext,
        config,
        deliveryId,
        parsed as GitHubPullRequestReviewPayload,
      );
    } else if (eventType === "pull_request_review_comment") {
      result = await syncPullRequestReviewCommentWebhook(
        currentContext,
        config,
        deliveryId,
        parsed as GitHubPullRequestReviewCommentPayload,
      );
    } else if (eventType === "check_run") {
      result = await syncCheckRunWebhook(currentContext, config, deliveryId, parsed as GitHubCheckRunPayload);
    } else if (eventType === "check_suite") {
      result = await syncCheckSuiteWebhook(currentContext, config, deliveryId, parsed as GitHubCheckSuitePayload);
    } else {
      result = {
        processed: false,
        reason: `ignored-event:${eventType}`,
        mappedIssueId: null,
        wakeQueued: false,
      };
    }

    const deliveryState: DeliveryState = {
      deliveryId,
      requestId: input.requestId,
      eventType,
      action,
      processedAt: new Date().toISOString(),
      processed: result.processed,
      reason: result.reason,
      mappedIssueId: result.mappedIssueId,
      wakeQueued: result.wakeQueued,
    };

    await currentContext.state.set({ scopeKind: "instance", stateKey: deliveryStateKey(deliveryId) }, deliveryState);
    await currentContext.state.set({ scopeKind: "instance", stateKey: LAST_DELIVERY_STATE_KEY }, deliveryState);
    currentContext.logger.info("Processed GitHub webhook delivery", deliveryState);
  },

  async onHealth() {
    if (!currentContext) {
      return {
        status: "degraded",
        message: "GitHub concierge webhook worker is not initialized yet",
      };
    }

    const config = await getConfig(currentContext);
    return {
      status: runtimeReady(config) ? "ok" : "degraded",
      message: "GitHub concierge webhook worker is running",
      details: {
        repositoryFullName: config.repositoryFullName,
        syncMode: config.syncMode,
        assigneeRoutes: config.assigneeRoutes.map((route) => ({
          githubAssigneeLogin: route.githubAssigneeLogin,
          paperclipAssigneeAgentId: route.paperclipAssigneeAgentId,
          paperclipAssigneeLabel: route.paperclipAssigneeLabel,
        })),
        webhookConfigured: runtimeReady(config),
      },
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
