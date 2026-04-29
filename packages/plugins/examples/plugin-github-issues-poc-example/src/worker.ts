import { createHmac, timingSafeEqual } from "node:crypto";
import { definePlugin, runWorker, type PluginContext, type PluginWebhookInput } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclipai.plugin-github-issues-poc-example";
const WEBHOOK_ENDPOINT_KEY = "github";
const DEFAULT_REPOSITORY_FULL_NAME = "tensorleap/concierge";
const DEFAULT_ASSIGNEE_LOGIN = "marvin-tensorleap";
const DEFAULT_ISSUE_TITLE_PREFIX = "[GitHub]";
const DEFAULT_SYNC_MODE = "inbound_only";
const DEFAULT_OUTBOUND_COMMENT_POLICY = "disabled";
const LAST_DELIVERY_STATE_KEY = "github:last-delivery";
const SOURCE_MIRROR_SECTION_START = "<!-- paperclip-github-source-mirror:start -->";
const SOURCE_MIRROR_SECTION_END = "<!-- paperclip-github-source-mirror:end -->";
const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const OUTBOUND_ACK_MARKER = "<!-- paperclip-github-outbound:intake_acknowledgement -->";
const OUTBOUND_FINAL_SAVEBACK_MARKER = "<!-- paperclip-github-outbound:final_saveback_done -->";

type AssigneeRoute = {
  githubAssigneeLogin: string;
  paperclipAssigneeAgentId: string;
  paperclipAssigneeLabel: string | null;
};

type OutboundCommentPolicy =
  | "disabled"
  | "acknowledge_intake_once"
  | "acknowledge_and_saveback_done";

type OutboundCommentKind =
  | "intake_acknowledgement"
  | "final_saveback_done";

type PluginConfig = {
  companyId: string;
  projectId: string;
  webhookSecretRef: string;
  githubWriteTokenSecretRef: string;
  repositoryFullName: string;
  syncMode: string;
  outboundCommentPolicy: OutboundCommentPolicy;
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
  outboundCommentPolicy: OutboundCommentPolicy;
  assigneeRoutes: AssigneeRoute[];
  webhookSecretConfigured: boolean;
  githubWriteTokenConfigured: boolean;
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
  outboundCommentPolicy: OutboundCommentPolicy;
  lastDeliveryId: string | null;
  intakeAcknowledgedAt: string | null;
  finalSavebackState: string | null;
  outboundCommentIds: number[];
  lastOutboundCommentId: number | null;
  lastOutboundCommentKind: OutboundCommentKind | null;
  lastOutboundCommentAt: string | null;
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
};

type GitHubRepository = {
  full_name?: unknown;
  name?: unknown;
  owner?: {
    login?: unknown;
  } | null;
};

type GitHubComment = {
  id?: unknown;
  body?: unknown;
  html_url?: unknown;
  user?: GitHubActor | null;
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

let currentContext: PluginContext | null = null;

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeBoolean(value: unknown): boolean {
  return value === true;
}

function normalizeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeNumberList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const numbers: number[] = [];
  const seen = new Set<number>();
  for (const entry of value) {
    const numberValue = normalizeNumber(entry);
    if (numberValue == null || seen.has(numberValue)) continue;
    seen.add(numberValue);
    numbers.push(numberValue);
  }
  return numbers;
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

function normalizeOutboundCommentPolicy(value: unknown): OutboundCommentPolicy {
  const normalized = normalizeString(value);
  if (normalized === "acknowledge_intake_once" || normalized === "acknowledge_and_saveback_done") {
    return normalized;
  }
  return DEFAULT_OUTBOUND_COMMENT_POLICY;
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

function getPullRequestNumber(payload: GitHubPullRequestPayload | GitHubPullRequestReviewCommentPayload): number {
  if (typeof payload.number === "number" && Number.isFinite(payload.number)) {
    return payload.number;
  }
  if (payload.pull_request && typeof payload.pull_request.number === "number" && Number.isFinite(payload.pull_request.number)) {
    return payload.pull_request.number;
  }
  throw new Error("GitHub payload is missing a valid pull request number");
}

function parseRepositoryFullName(repositoryFullName: string): { owner: string; name: string } {
  const [owner, name] = repositoryFullName.split("/", 2);
  if (!owner || !name) {
    throw new Error(`Invalid GitHub repository full name: ${repositoryFullName}`);
  }
  return { owner, name };
}

function githubKey(repositoryFullName: string, number: number): string {
  return `${repositoryFullName}#${number}`;
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
  outboundCommentPolicy: OutboundCommentPolicy;
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
    `- Outbound comment policy: \`${input.outboundCommentPolicy}\``,
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
  outboundCommentPolicy: OutboundCommentPolicy;
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
  githubIssueKey: string;
  actorLogin: string;
  githubUrl: string | null;
  isMerged: boolean;
  wakeQueued: boolean;
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
    `Linked issue: ${input.githubIssueKey}`,
    `Actor: ${input.actorLogin}`,
    input.githubUrl ? `URL: ${input.githubUrl}` : null,
    "",
    actionLine,
    input.wakeQueued ? "Paperclip wake requested." : null,
  ]);
}

function buildPullRequestCommentBody(input: {
  eventName: string;
  githubPullRequestKey: string;
  githubIssueKey: string;
  actorLogin: string;
  githubUrl: string | null;
  commentBody: string | null;
  wakeQueued: boolean;
}): string {
  return joinCommentLines([
    `${input.eventName}: ${input.githubPullRequestKey}`,
    `Linked issue: ${input.githubIssueKey}`,
    `Actor: ${input.actorLogin}`,
    input.githubUrl ? `URL: ${input.githubUrl}` : null,
    "",
    input.commentBody ? blockQuote(input.commentBody) : "_Comment body unavailable._",
    input.wakeQueued ? "" : null,
    input.wakeQueued ? "Paperclip wake requested." : null,
  ]);
}

function buildGitHubIntakeAcknowledgementBody(mapping: IssueMapping): string {
  const identifier = mapping.paperclipIssueIdentifier ?? mapping.paperclipIssueId;
  const policyLine = mapping.outboundCommentPolicy === "acknowledge_and_saveback_done"
    ? "GitHub will receive one final completion comment when that Paperclip issue is marked `done`."
    : "This repo is configured for intake acknowledgement only; Paperclip keeps the remaining execution thread internal.";
  return joinCommentLines([
    OUTBOUND_ACK_MARKER,
    `Paperclip mirrored this issue as \`${identifier}\`.`,
    policyLine,
  ]);
}

function buildGitHubFinalSavebackBody(mapping: IssueMapping): string {
  const identifier = mapping.paperclipIssueIdentifier ?? mapping.paperclipIssueId;
  return joinCommentLines([
    OUTBOUND_FINAL_SAVEBACK_MARKER,
    `Paperclip issue \`${identifier}\` is marked \`done\`.`,
    "This is the configured final saveback for the mirrored Paperclip thread.",
  ]);
}

function buildOutboundAuditComment(input: {
  kind: OutboundCommentKind;
  githubIssueKey: string;
  policy: OutboundCommentPolicy;
  githubCommentId: number | null;
  githubCommentUrl?: string | null;
}): string {
  const title = input.kind === "intake_acknowledgement"
    ? "GitHub outbound intake acknowledgement posted"
    : "GitHub final saveback posted";
  return joinCommentLines([
    `${title}: ${input.githubIssueKey}`,
    `Policy: \`${input.policy}\``,
    input.githubCommentId != null ? `GitHub comment id: \`${input.githubCommentId}\`` : null,
    input.githubCommentUrl ? `URL: ${input.githubCommentUrl}` : null,
    "Loop guard: hidden outbound marker plus stored GitHub comment id.",
  ]);
}

function buildOutboundFailureComment(input: {
  kind: OutboundCommentKind;
  githubIssueKey: string;
  policy: OutboundCommentPolicy;
  error: string;
}): string {
  const title = input.kind === "intake_acknowledgement"
    ? "GitHub outbound intake acknowledgement failed"
    : "GitHub final saveback failed";
  return joinCommentLines([
    `${title}: ${input.githubIssueKey}`,
    `Policy: \`${input.policy}\``,
    `Error: ${input.error}`,
  ]);
}

function commentContainsOutboundMarker(body: string | null): boolean {
  if (!body) return false;
  return body.includes(OUTBOUND_ACK_MARKER) || body.includes(OUTBOUND_FINAL_SAVEBACK_MARKER);
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

function outboundCommentPolicyNeedsToken(policy: OutboundCommentPolicy): boolean {
  return policy !== "disabled";
}

function intakeAcknowledgementEnabled(config: PluginConfig): boolean {
  return config.outboundCommentPolicy === "acknowledge_intake_once"
    || config.outboundCommentPolicy === "acknowledge_and_saveback_done";
}

function finalSavebackEnabled(config: PluginConfig): boolean {
  return config.outboundCommentPolicy === "acknowledge_and_saveback_done";
}

function outboundCommentsRuntimeReady(config: PluginConfig): boolean {
  return !outboundCommentPolicyNeedsToken(config.outboundCommentPolicy)
    || Boolean(config.githubWriteTokenSecretRef);
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
    githubWriteTokenSecretRef: normalizeString(rawConfig.githubWriteTokenSecretRef) ?? "",
    repositoryFullName: normalizeString(rawConfig.repositoryFullName) ?? DEFAULT_REPOSITORY_FULL_NAME,
    syncMode: normalizeString(rawConfig.syncMode) ?? DEFAULT_SYNC_MODE,
    outboundCommentPolicy: normalizeOutboundCommentPolicy(rawConfig.outboundCommentPolicy),
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
    outboundCommentPolicy: mapping.outboundCommentPolicy || config.outboundCommentPolicy,
    lastDeliveryId: mapping.lastDeliveryId ?? null,
    intakeAcknowledgedAt: mapping.intakeAcknowledgedAt ?? null,
    finalSavebackState: mapping.finalSavebackState ?? null,
    outboundCommentIds: normalizeNumberList(mapping.outboundCommentIds),
    lastOutboundCommentId: mapping.lastOutboundCommentId ?? null,
    lastOutboundCommentKind: mapping.lastOutboundCommentKind ?? null,
    lastOutboundCommentAt: mapping.lastOutboundCommentAt ?? null,
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
    outboundCommentPolicy: config.outboundCommentPolicy,
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

async function writePullRequestMapping(ctx: PluginContext, companyId: string, mapping: PullRequestMapping): Promise<void> {
  await writeState(ctx, companyId, pullRequestMappingStateKey(mapping.githubPullRequestKey), mapping);
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
    outboundCommentPolicy: config.outboundCommentPolicy,
    lastDeliveryId: null,
    intakeAcknowledgedAt: null,
    finalSavebackState: null,
    outboundCommentIds: [],
    lastOutboundCommentId: null,
    lastOutboundCommentKind: null,
    lastOutboundCommentAt: null,
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

function shouldIgnoreMirroredGitHubComment(mapping: IssueMapping | null, comment: GitHubComment | null | undefined): boolean {
  const commentBody = normalizeString(comment?.body);
  if (commentContainsOutboundMarker(commentBody)) return true;
  const commentId = normalizeNumber(comment?.id);
  return commentId != null && Boolean(mapping?.outboundCommentIds.includes(commentId));
}

async function postGitHubIssueComment(
  ctx: PluginContext,
  config: PluginConfig,
  mapping: IssueMapping,
  body: string,
): Promise<{ commentId: number | null; commentUrl: string | null }> {
  if (!config.githubWriteTokenSecretRef) {
    throw new Error("githubWriteTokenSecretRef is required for outbound GitHub comments");
  }
  const token = await ctx.secrets.resolve(config.githubWriteTokenSecretRef);
  const repositoryFullName = mapping.githubIssueKey.split("#")[0] ?? config.repositoryFullName;
  const { owner, name } = parseRepositoryFullName(repositoryFullName);
  const response = await ctx.http.fetch(
    `${GITHUB_API_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${mapping.githubIssueNumber}/comments`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": PLUGIN_ID,
        "x-github-api-version": GITHUB_API_VERSION,
      },
      body: JSON.stringify({ body }),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status}: ${text.slice(0, 200)}`);
  }
  let parsed: Record<string, unknown> = {};
  if (text.trim().length > 0) {
    const decoded = JSON.parse(text);
    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
      parsed = decoded as Record<string, unknown>;
    }
  }
  return {
    commentId: normalizeNumber(parsed.id),
    commentUrl: normalizeString(parsed.html_url),
  };
}

async function recordOutboundComment(
  ctx: PluginContext,
  config: PluginConfig,
  mapping: IssueMapping,
  input: {
    kind: OutboundCommentKind;
    commentId: number | null;
  },
): Promise<IssueMapping> {
  const now = new Date().toISOString();
  const outboundCommentIds = input.commentId != null
    ? [...new Set([...mapping.outboundCommentIds, input.commentId])]
    : mapping.outboundCommentIds;
  const nextMapping = withMirrorDefaults({
    ...mapping,
    outboundCommentPolicy: config.outboundCommentPolicy,
    intakeAcknowledgedAt: input.kind === "intake_acknowledgement" ? now : mapping.intakeAcknowledgedAt,
    finalSavebackState: input.kind === "final_saveback_done" ? "done" : mapping.finalSavebackState,
    outboundCommentIds,
    lastOutboundCommentId: input.commentId ?? mapping.lastOutboundCommentId,
    lastOutboundCommentKind: input.kind,
    lastOutboundCommentAt: now,
    updatedAt: now,
  }, config);
  await writeIssueMapping(ctx, config.companyId, nextMapping);
  return nextMapping;
}

async function clearFinalSavebackState(
  ctx: PluginContext,
  config: PluginConfig,
  mapping: IssueMapping,
): Promise<IssueMapping> {
  if (!mapping.finalSavebackState) return mapping;
  const nextMapping = withMirrorDefaults({
    ...mapping,
    finalSavebackState: null,
    updatedAt: new Date().toISOString(),
  }, config);
  await writeIssueMapping(ctx, config.companyId, nextMapping);
  return nextMapping;
}

async function sendOutboundComment(
  ctx: PluginContext,
  config: PluginConfig,
  mapping: IssueMapping,
  input: {
    kind: OutboundCommentKind;
    body: string;
  },
): Promise<IssueMapping> {
  const { commentId, commentUrl } = await postGitHubIssueComment(ctx, config, mapping, input.body);
  const nextMapping = await recordOutboundComment(ctx, config, mapping, {
    kind: input.kind,
    commentId,
  });
  await appendIssueComment(
    ctx,
    config.companyId,
    mapping.paperclipIssueId,
    buildOutboundAuditComment({
      kind: input.kind,
      githubIssueKey: mapping.githubIssueKey,
      policy: config.outboundCommentPolicy,
      githubCommentId: commentId,
      githubCommentUrl: commentUrl,
    }),
  );
  return nextMapping;
}

async function maybeSendIntakeAcknowledgement(
  ctx: PluginContext,
  config: PluginConfig,
  mapping: IssueMapping,
): Promise<IssueMapping> {
  if (!intakeAcknowledgementEnabled(config) || !outboundCommentsRuntimeReady(config) || mapping.intakeAcknowledgedAt) {
    return mapping;
  }
  try {
    return await sendOutboundComment(ctx, config, mapping, {
      kind: "intake_acknowledgement",
      body: buildGitHubIntakeAcknowledgementBody({
        ...mapping,
        outboundCommentPolicy: config.outboundCommentPolicy,
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.warn("Failed to post GitHub intake acknowledgement", {
      githubIssueKey: mapping.githubIssueKey,
      error: message,
    });
    await appendIssueComment(
      ctx,
      config.companyId,
      mapping.paperclipIssueId,
      buildOutboundFailureComment({
        kind: "intake_acknowledgement",
        githubIssueKey: mapping.githubIssueKey,
        policy: config.outboundCommentPolicy,
        error: message,
      }),
    );
    return mapping;
  }
}

async function maybeSendFinalSaveback(
  ctx: PluginContext,
  config: PluginConfig,
  mapping: IssueMapping,
): Promise<IssueMapping> {
  if (!finalSavebackEnabled(config) || !outboundCommentsRuntimeReady(config) || mapping.finalSavebackState === "done") {
    return mapping;
  }
  try {
    return await sendOutboundComment(ctx, config, mapping, {
      kind: "final_saveback_done",
      body: buildGitHubFinalSavebackBody({
        ...mapping,
        outboundCommentPolicy: config.outboundCommentPolicy,
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.warn("Failed to post GitHub final saveback", {
      githubIssueKey: mapping.githubIssueKey,
      error: message,
    });
    await appendIssueComment(
      ctx,
      config.companyId,
      mapping.paperclipIssueId,
      buildOutboundFailureComment({
        kind: "final_saveback_done",
        githubIssueKey: mapping.githubIssueKey,
        policy: config.outboundCommentPolicy,
        error: message,
      }),
    );
    return mapping;
  }
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
      outboundCommentPolicy: config.outboundCommentPolicy,
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
    outboundCommentPolicy: config.outboundCommentPolicy,
    lastDeliveryId: deliveryId,
    intakeAcknowledgedAt: null,
    finalSavebackState: null,
    outboundCommentIds: [],
    lastOutboundCommentId: null,
    lastOutboundCommentKind: null,
    lastOutboundCommentAt: null,
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
      `Outbound comment policy: \`${config.outboundCommentPolicy}\``,
      "",
      `Paperclip issue created from \`issues.${triggerAction}\`.`,
      `Event actor: \`${actorLogin(actor, fallbackAssignee)}\``,
      wakeQueued ? "Paperclip wake requested." : null,
    ]),
  );

  return { mapping, created: true, wakeQueued };
}

async function resolvePullRequestMapping(
  ctx: PluginContext,
  config: PluginConfig,
  repositoryFullName: string,
  pullRequestNumber: number,
  pullRequestUrl: string | null,
  texts: Array<string | null | undefined>,
): Promise<PullRequestMapping | null> {
  const githubPullRequestKey = githubKey(repositoryFullName, pullRequestNumber);
  const existing = await readPullRequestMapping(ctx, config.companyId, githubPullRequestKey);
  if (existing) {
    const updated: PullRequestMapping = {
      ...existing,
      pullRequestUrl: pullRequestUrl ?? existing.pullRequestUrl,
      updatedAt: new Date().toISOString(),
    };
    await writePullRequestMapping(ctx, config.companyId, updated);
    return updated;
  }

  for (const referencedIssueKey of extractIssueReferenceKeys(repositoryFullName, texts)) {
    const issueMapping = await getOrRecoverIssueMapping(ctx, config, config.companyId, referencedIssueKey);
    if (!issueMapping) continue;
    const mapping: PullRequestMapping = {
      githubPullRequestKey,
      githubIssueKey: referencedIssueKey,
      paperclipIssueId: issueMapping.paperclipIssueId,
      pullRequestNumber,
      pullRequestUrl,
      updatedAt: new Date().toISOString(),
    };
    await writePullRequestMapping(ctx, config.companyId, mapping);
    return mapping;
  }

  return null;
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
    const acknowledgedMapping = mappingResult.mapping
      ? await maybeSendIntakeAcknowledgement(ctx, config, mappingResult.mapping)
      : mappingResult.mapping;
    return {
      processed: true,
      reason: `issues:${action}:created`,
      mappedIssueId: acknowledgedMapping?.paperclipIssueId ?? null,
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
    const pullRequestMapping = await resolvePullRequestMapping(
      ctx,
      config,
      repositoryFullName,
      pullRequestNumber,
      pullRequestUrl,
      [normalizeString(issue.body), normalizeString(issue.title)],
    );
    if (!pullRequestMapping) {
      return { processed: false, reason: "pull-request-mapping-missing", mappedIssueId: null, wakeQueued: false };
    }

    const wakeQueued = await maybeWakeIssue(
      ctx,
      config.companyId,
      pullRequestMapping.paperclipIssueId,
      deliveryId,
      `github:pull_request.issue_comment.${action}`,
    );

    await appendIssueComment(
      ctx,
      config.companyId,
      pullRequestMapping.paperclipIssueId,
      buildPullRequestCommentBody({
        eventName: `GitHub issue_comment.${action}`,
        githubPullRequestKey: pullRequestMapping.githubPullRequestKey,
        githubIssueKey: pullRequestMapping.githubIssueKey,
        actorLogin: actorLogin(payload.comment?.user, payload.sender),
        githubUrl: normalizeString(payload.comment?.html_url) ?? pullRequestMapping.pullRequestUrl,
        commentBody: normalizeString(payload.comment?.body),
        wakeQueued,
      }),
    );

    const issueMapping = await getOrRecoverIssueMapping(ctx, config, config.companyId, pullRequestMapping.githubIssueKey);
    if (issueMapping) {
      await refreshIssueMirror(ctx, config, issueMapping, { deliveryId });
    }

    return {
      processed: true,
      reason: `pull_request_issue_comment:${action}`,
      mappedIssueId: pullRequestMapping.paperclipIssueId,
      wakeQueued,
    };
  }

  const githubIssueKey = githubKey(repositoryFullName, getIssueNumber(issue));
  const existingMapping = await getOrRecoverIssueMapping(ctx, config, config.companyId, githubIssueKey);
  if (shouldIgnoreMirroredGitHubComment(existingMapping, payload.comment)) {
    return {
      processed: false,
      reason: "ignored-outbound-comment",
      mappedIssueId: existingMapping?.paperclipIssueId ?? null,
      wakeQueued: false,
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
  const mappedIssueAfterAck = mappingResult.created
    ? await maybeSendIntakeAcknowledgement(ctx, config, mappingResult.mapping)
    : mappingResult.mapping;

  const matchedRoute = findAssigneeRoute(issue, config.assigneeRoutes);
  const wakeQueued = mappingResult.wakeQueued
    || await maybeWakeIssue(ctx, config.companyId, mappedIssueAfterAck.paperclipIssueId, deliveryId, `github:issue_comment.${action}`);

  await appendIssueComment(
    ctx,
    config.companyId,
    mappedIssueAfterAck.paperclipIssueId,
    buildCommentMirrorBody({
      eventName: `GitHub issue_comment.${action}`,
      githubKey: mappedIssueAfterAck.githubIssueKey,
      actorLogin: actorLogin(payload.comment?.user, payload.sender),
      githubUrl: normalizeString(payload.comment?.html_url) ?? normalizeString(issue.html_url),
      commentBody: normalizeString(payload.comment?.body),
      wakeQueued,
    }),
  );

  await refreshIssueMirror(ctx, config, mappedIssueAfterAck, {
    deliveryId,
    githubIssueUrl: normalizeString(issue.html_url) ?? mappedIssueAfterAck.githubIssueUrl,
    githubIssueTitle: normalizeString(issue.title) ?? mappedIssueAfterAck.githubIssueTitle,
    route: matchedRoute,
  });

  return {
    processed: true,
    reason: `issue_comment:${action}`,
    mappedIssueId: mappedIssueAfterAck.paperclipIssueId,
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
  const pullRequestMapping = await resolvePullRequestMapping(
    ctx,
    config,
    repositoryFullName,
    pullRequestNumber,
    normalizeString(pullRequest.html_url),
    [normalizeString(pullRequest.body), normalizeString(pullRequest.title)],
  );
  if (!pullRequestMapping) {
    return { processed: false, reason: "pull-request-mapping-missing", mappedIssueId: null, wakeQueued: false };
  }

  const wakeQueued = action === "closed"
    ? false
    : await maybeWakeIssue(ctx, config.companyId, pullRequestMapping.paperclipIssueId, deliveryId, `github:pull_request.${action}`);

  await appendIssueComment(
    ctx,
    config.companyId,
    pullRequestMapping.paperclipIssueId,
    buildPullRequestEventComment({
      action,
      githubPullRequestKey: pullRequestMapping.githubPullRequestKey,
      githubIssueKey: pullRequestMapping.githubIssueKey,
      actorLogin: actorLogin(payload.sender),
      githubUrl: normalizeString(pullRequest.html_url),
      isMerged: normalizeBoolean(pullRequest.merged),
      wakeQueued,
    }),
  );

  const issueMapping = await getOrRecoverIssueMapping(ctx, config, config.companyId, pullRequestMapping.githubIssueKey);
  if (issueMapping) {
    await refreshIssueMirror(ctx, config, issueMapping, { deliveryId });
  }

  return {
    processed: true,
    reason: `pull_request:${action}`,
    mappedIssueId: pullRequestMapping.paperclipIssueId,
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
  const pullRequestMapping = await resolvePullRequestMapping(
    ctx,
    config,
    repositoryFullName,
    pullRequestNumber,
    normalizeString(pullRequest.html_url),
    [normalizeString(pullRequest.body), normalizeString(pullRequest.title)],
  );
  if (!pullRequestMapping) {
    return { processed: false, reason: "pull-request-mapping-missing", mappedIssueId: null, wakeQueued: false };
  }

  const wakeQueued = await maybeWakeIssue(
    ctx,
    config.companyId,
    pullRequestMapping.paperclipIssueId,
    deliveryId,
    `github:pull_request_review_comment.${action}`,
  );

  await appendIssueComment(
    ctx,
    config.companyId,
    pullRequestMapping.paperclipIssueId,
    buildPullRequestCommentBody({
      eventName: `GitHub pull_request_review_comment.${action}`,
      githubPullRequestKey: pullRequestMapping.githubPullRequestKey,
      githubIssueKey: pullRequestMapping.githubIssueKey,
      actorLogin: actorLogin(payload.comment?.user, payload.sender),
      githubUrl: normalizeString(payload.comment?.html_url) ?? pullRequestMapping.pullRequestUrl,
      commentBody: normalizeString(payload.comment?.body),
      wakeQueued,
    }),
  );

  const issueMapping = await getOrRecoverIssueMapping(ctx, config, config.companyId, pullRequestMapping.githubIssueKey);
  if (issueMapping) {
    await refreshIssueMirror(ctx, config, issueMapping, { deliveryId });
  }

  return {
    processed: true,
    reason: `pull_request_review_comment:${action}`,
    mappedIssueId: pullRequestMapping.paperclipIssueId,
    wakeQueued,
  };
}

function eventPayloadRecord(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
}

async function handleIssueUpdatedEvent(ctx: PluginContext, event: { companyId: string; entityId?: string; actorType?: string; payload: unknown }) {
  const config = await getConfig(ctx);
  if (event.companyId !== config.companyId) return;

  const issueId = normalizeString(event.entityId);
  if (!issueId) return;

  const issue = await ctx.issues.get(issueId, config.companyId);
  if (!issue || issue.originKind !== `plugin:${PLUGIN_ID}` || !issue.originId) return;

  const mapping = await getOrRecoverIssueMapping(ctx, config, config.companyId, issue.originId);
  if (!mapping) return;

  if (issue.status !== "done") {
    await clearFinalSavebackState(ctx, config, mapping);
    return;
  }

  if (event.actorType === "plugin") return;

  const payload = eventPayloadRecord(event.payload);
  const previous = eventPayloadRecord(payload?._previous);
  const patch = eventPayloadRecord(payload?.patch);
  const previousStatus = normalizeString(previous?.status);
  const patchStatus = normalizeString(patch?.status);
  if (previousStatus === "done") return;
  if (!previousStatus && patchStatus !== "done") return;

  await maybeSendFinalSaveback(ctx, config, mapping);
}

const plugin = definePlugin({
  async setup(ctx) {
    currentContext = ctx;

    ctx.events.on("issue.updated", async (event) => {
      await handleIssueUpdatedEvent(ctx, event);
    });

    ctx.data.register("health", async () => {
      const config = await getConfig(ctx);
      return {
        status: runtimeReady(config) && outboundCommentsRuntimeReady(config) ? "ok" : "degraded",
        checkedAt: new Date().toISOString(),
        companyId: config.companyId || null,
        projectId: config.projectId || null,
        repositoryFullName: config.repositoryFullName,
        syncMode: config.syncMode,
        outboundCommentPolicy: config.outboundCommentPolicy,
        assigneeRoutes: config.assigneeRoutes,
        webhookSecretConfigured: Boolean(config.webhookSecretRef),
        githubWriteTokenConfigured: Boolean(config.githubWriteTokenSecretRef),
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
    if (outboundCommentPolicyNeedsToken(normalized.outboundCommentPolicy) && !normalized.githubWriteTokenSecretRef) {
      errors.push("githubWriteTokenSecretRef is required when outboundCommentPolicy enables acknowledgement or saveback comments.");
    }
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

    if (currentContext && normalized.githubWriteTokenSecretRef) {
      try {
        await currentContext.secrets.resolve(normalized.githubWriteTokenSecretRef);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    warnings.push(
      "GitHub delivery still requires an externally reachable HTTPS Paperclip URL plus GitHub repo or app admin rights to register the webhook.",
    );
    warnings.push(
      "Outbound GitHub comments stay sparse by design: one intake acknowledgement, one final saveback on a non-plugin transition to `done`, and webhook echoes carrying the plugin's hidden markers are ignored.",
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
    } else if (eventType === "pull_request_review_comment") {
      result = await syncPullRequestReviewCommentWebhook(
        currentContext,
        config,
        deliveryId,
        parsed as GitHubPullRequestReviewCommentPayload,
      );
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
      status: runtimeReady(config) && outboundCommentsRuntimeReady(config) ? "ok" : "degraded",
      message: "GitHub concierge webhook worker is running",
      details: {
        repositoryFullName: config.repositoryFullName,
        syncMode: config.syncMode,
        outboundCommentPolicy: config.outboundCommentPolicy,
        assigneeRoutes: config.assigneeRoutes.map((route) => ({
          githubAssigneeLogin: route.githubAssigneeLogin,
          paperclipAssigneeAgentId: route.paperclipAssigneeAgentId,
          paperclipAssigneeLabel: route.paperclipAssigneeLabel,
        })),
        webhookConfigured: runtimeReady(config),
        githubWriteTokenConfigured: Boolean(config.githubWriteTokenSecretRef),
      },
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
