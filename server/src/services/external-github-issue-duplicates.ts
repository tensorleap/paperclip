import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueComments, issues } from "@paperclipai/db";
import { extractGitHubIssueReferenceMatches, type IssueRelationIssueSummary } from "@paperclipai/shared";
import { conflict } from "../errors.js";

const OPEN_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"] as const;
const MAX_SOURCE_CHAIN_DEPTH = 50;
type GitHubReferenceSourceKind = "title" | "description" | "comment";

type OpenIssueReferenceMatch = {
  issue: IssueRelationIssueSummary;
  matchedExternalReferences: string[];
  matchedSourceKinds: GitHubReferenceSourceKind[];
};

export type DuplicateExternalIssueReferenceConflictDetails = {
  kind: "duplicate_external_issue_reference";
  normalizedReferences: string[];
  existingIssues: OpenIssueReferenceMatch[];
  overrideField: "allowDuplicateExternalIssueReference";
};

type CollectSourceContextResult = {
  exclusionIssueIds: string[];
  normalizedReferences: string[];
};

type SourceIssueRow = {
  id: string;
  parentId: string | null;
  title: string;
  description: string | null;
};

function formatReferenceLabel(normalizedUrl: string) {
  const parts = normalizedUrl.split("/");
  const owner = parts[3] ?? "github";
  const repo = parts[4] ?? "repo";
  const issueNumber = parts[6] ?? "?";
  return `${owner}/${repo}#${issueNumber}`;
}

function dedupeNormalizedReferences(values: string[]) {
  return [...new Set(values)];
}

function collectNormalizedReferences(text: string | null | undefined) {
  return extractGitHubIssueReferenceMatches(text ?? "").map((match) => match.normalizedUrl);
}

function toIssueSummary(row: {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}): IssueRelationIssueSummary {
  return {
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    status: row.status as IssueRelationIssueSummary["status"],
    priority: row.priority as IssueRelationIssueSummary["priority"],
    assigneeAgentId: row.assigneeAgentId,
    assigneeUserId: row.assigneeUserId,
  };
}

async function listSourceIssueChain(
  db: Db,
  companyId: string,
  sourceIssueId: string,
): Promise<SourceIssueRow[]> {
  const visited = new Set<string>();
  const chain: SourceIssueRow[] = [];
  let currentId: string | null = sourceIssueId;

  while (currentId && !visited.has(currentId) && chain.length < MAX_SOURCE_CHAIN_DEPTH) {
    visited.add(currentId);
    const rows = await db
      .select({
        id: issues.id,
        parentId: issues.parentId,
        title: issues.title,
        description: issues.description,
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, currentId)));
    const row = rows[0] ?? null;
    if (!row) break;
    chain.push(row);
    currentId = row.parentId ?? null;
  }

  return chain;
}

async function listCommentBodiesByIssueId(
  db: Db,
  companyId: string,
  issueIds: string[],
) {
  if (issueIds.length === 0) return new Map<string, string[]>();

  const rows = await db
    .select({
      issueId: issueComments.issueId,
      body: issueComments.body,
    })
    .from(issueComments)
    .where(and(eq(issueComments.companyId, companyId), inArray(issueComments.issueId, issueIds)))
    .orderBy(asc(issueComments.createdAt), asc(issueComments.id));

  const commentBodiesByIssueId = new Map<string, string[]>();
  for (const row of rows) {
    const current = commentBodiesByIssueId.get(row.issueId);
    if (current) {
      current.push(row.body);
    } else {
      commentBodiesByIssueId.set(row.issueId, [row.body]);
    }
  }
  return commentBodiesByIssueId;
}

async function readCommentBody(
  db: Db,
  companyId: string,
  commentId: string,
) {
  return db
    .select({
      body: issueComments.body,
    })
    .from(issueComments)
    .where(and(eq(issueComments.companyId, companyId), eq(issueComments.id, commentId)))
    .then((rows) => rows[0]?.body ?? null);
}

async function collectSourceContextReferences(input: {
  db: Db;
  companyId: string;
  sourceIssueId?: string | null;
  sourceCommentId?: string | null;
}): Promise<CollectSourceContextResult> {
  const normalizedReferences = new Set<string>();
  const exclusionIssueIds = new Set<string>();

  if (input.sourceCommentId) {
    const commentBody = await readCommentBody(input.db, input.companyId, input.sourceCommentId);
    for (const ref of collectNormalizedReferences(commentBody)) {
      normalizedReferences.add(ref);
    }
  }

  if (!input.sourceIssueId) {
    return {
      exclusionIssueIds: [],
      normalizedReferences: [...normalizedReferences],
    };
  }

  const chain = await listSourceIssueChain(input.db, input.companyId, input.sourceIssueId);
  const commentBodiesByIssueId = await listCommentBodiesByIssueId(
    input.db,
    input.companyId,
    chain.map((row) => row.id),
  );

  for (const issue of chain) {
    exclusionIssueIds.add(issue.id);
    for (const ref of collectNormalizedReferences(issue.title)) {
      normalizedReferences.add(ref);
    }
    for (const ref of collectNormalizedReferences(issue.description)) {
      normalizedReferences.add(ref);
    }
    for (const commentBody of commentBodiesByIssueId.get(issue.id) ?? []) {
      for (const ref of collectNormalizedReferences(commentBody)) {
        normalizedReferences.add(ref);
      }
    }
  }

  return {
    exclusionIssueIds: [...exclusionIssueIds],
    normalizedReferences: [...normalizedReferences],
  };
}

export async function findDuplicateExternalGitHubIssueReferences(input: {
  db: Db;
  companyId: string;
  title?: string | null;
  description?: string | null;
  sourceIssueId?: string | null;
  sourceCommentId?: string | null;
}): Promise<DuplicateExternalIssueReferenceConflictDetails | null> {
  const explicitReferences = dedupeNormalizedReferences([
    ...collectNormalizedReferences(input.title),
    ...collectNormalizedReferences(input.description),
  ]);

  const sourceContext =
    input.sourceIssueId || input.sourceCommentId
      ? await collectSourceContextReferences(input)
      : { exclusionIssueIds: [], normalizedReferences: [] };
  const candidateReferences = explicitReferences.length > 0
    ? explicitReferences
    : dedupeNormalizedReferences(sourceContext.normalizedReferences);
  if (candidateReferences.length === 0) return null;

  const openIssueRows = await input.db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      description: issues.description,
      status: issues.status,
      priority: issues.priority,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
    })
    .from(issues)
    .where(and(
      eq(issues.companyId, input.companyId),
      inArray(issues.status, [...OPEN_ISSUE_STATUSES]),
      sourceContext.exclusionIssueIds.length > 0 ? notInArray(issues.id, sourceContext.exclusionIssueIds) : undefined,
    ))
    .orderBy(asc(issues.issueNumber), asc(issues.createdAt));
  if (openIssueRows.length === 0) return null;

  const commentBodiesByIssueId = await listCommentBodiesByIssueId(
    input.db,
    input.companyId,
    openIssueRows.map((row) => row.id),
  );

  const issueMatches: OpenIssueReferenceMatch[] = [];
  for (const issue of openIssueRows) {
    const matchedExternalReferences = new Set<string>();
    const matchedSourceKinds = new Set<GitHubReferenceSourceKind>();

    for (const ref of collectNormalizedReferences(issue.title)) {
      if (!candidateReferences.includes(ref)) continue;
      matchedExternalReferences.add(ref);
      matchedSourceKinds.add("title");
    }
    for (const ref of collectNormalizedReferences(issue.description)) {
      if (!candidateReferences.includes(ref)) continue;
      matchedExternalReferences.add(ref);
      matchedSourceKinds.add("description");
    }
    for (const commentBody of commentBodiesByIssueId.get(issue.id) ?? []) {
      for (const ref of collectNormalizedReferences(commentBody)) {
        if (!candidateReferences.includes(ref)) continue;
        matchedExternalReferences.add(ref);
        matchedSourceKinds.add("comment");
      }
    }

    if (matchedExternalReferences.size === 0) continue;
    issueMatches.push({
      issue: toIssueSummary(issue),
      matchedExternalReferences: [...matchedExternalReferences],
      matchedSourceKinds: [...matchedSourceKinds],
    });
  }

  if (issueMatches.length === 0) return null;

  return {
    kind: "duplicate_external_issue_reference",
    normalizedReferences: candidateReferences,
    existingIssues: issueMatches,
    overrideField: "allowDuplicateExternalIssueReference",
  };
}

export async function assertNoDuplicateExternalGitHubIssueReferences(input: {
  db: Db;
  companyId: string;
  title?: string | null;
  description?: string | null;
  sourceIssueId?: string | null;
  sourceCommentId?: string | null;
  allowDuplicateExternalIssueReference?: boolean;
}) {
  if (input.allowDuplicateExternalIssueReference) return;

  const duplicates = await findDuplicateExternalGitHubIssueReferences(input);
  if (!duplicates) return;

  const issueLabels = duplicates.existingIssues
    .map((match) => match.issue.identifier ?? match.issue.id)
    .join(", ");
  const referenceLabels = duplicates.normalizedReferences.map(formatReferenceLabel).join(", ");
  throw conflict(
    `Open issue${duplicates.existingIssues.length === 1 ? "" : "s"} ${issueLabels} already reference GitHub issue${duplicates.normalizedReferences.length === 1 ? "" : "s"} ${referenceLabels}. Reuse the existing issue or set allowDuplicateExternalIssueReference=true to create a deliberate duplicate.`,
    duplicates,
  );
}
