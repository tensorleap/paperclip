import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  companies,
  issueComments,
  issueThreadInteractions,
  issues,
  projects,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";

export const DEFAULT_STALL_TIER1_MINUTES = 30;
export const DEFAULT_STALL_TIER2_MINUTES = 120;
export const STALL_SYSTEM_AUTHOR = "Paperclip System";

const MAX_CANDIDATE_ISSUES = 250;
const STALL_ACTION_TIER1 = "issue.stall_detected_tier1";
const STALL_ACTION_TIER2 = "issue.stall_detected_tier2";

type StallPolicy = {
  tier1Minutes: number;
  tier2Minutes: number;
};

type EnqueueWakeup = (
  agentId: string,
  opts?: {
    source?: "timer" | "assignment" | "on_demand" | "automation";
    triggerDetail?: "manual" | "ping" | "callback" | "system";
    reason?: string | null;
    payload?: Record<string, unknown> | null;
    requestedByActorType?: "user" | "agent" | "system";
    requestedByActorId?: string | null;
    contextSnapshot?: Record<string, unknown>;
  },
) => Promise<unknown | null>;

function readPositiveInteger(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function buildPolicy(overrides?: { tier1Minutes?: number | null; tier2Minutes?: number | null }): StallPolicy {
  return {
    tier1Minutes: readPositiveInteger(overrides?.tier1Minutes, DEFAULT_STALL_TIER1_MINUTES),
    tier2Minutes: readPositiveInteger(overrides?.tier2Minutes, DEFAULT_STALL_TIER2_MINUTES),
  };
}

function msToMinutes(ms: number): number {
  return Math.floor(ms / 60_000);
}

function agentMentionLink(agent: { id: string; name: string }): string {
  return `[@${agent.name}](agent://${agent.id})`;
}

function buildStallCommentBody(opts: {
  status: string;
  elapsedMinutes: number;
  tier: 1 | 2;
  assigneeLink: string;
  managerLink?: string;
}): string {
  const intro = `**Stall detected** — This issue has been \`${opts.status}\` for ${opts.elapsedMinutes}m with no agent activity and no pending interaction. Please re-check current state (external events, PRs, webhooks) and post an update or status change.`;
  if (opts.tier === 1) {
    return `${intro}\n\nPinging assignee: ${opts.assigneeLink}`;
  }
  const manager = opts.managerLink ?? "(no manager found)";
  return `${intro}\n\n**Tier 2 escalation** — pinging manager: ${manager}\nAssignee: ${opts.assigneeLink}`;
}

export function stallDetectionService(db: Db, deps?: { enqueueWakeup?: EnqueueWakeup }) {
  async function getCompanyIssuePrefix(companyId: string): Promise<string> {
    return db
      .select({ issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0]?.issuePrefix ?? "PAP");
  }

  async function getProjectStallPolicy(projectId: string): Promise<StallPolicy | null> {
    const project = await db
      .select({ stallPolicy: projects.stallPolicy })
      .from(projects)
      .where(eq(projects.id, projectId))
      .then((rows) => rows[0] ?? null);
    if (!project?.stallPolicy) return null;
    return buildPolicy(project.stallPolicy);
  }

  async function getLastAgentActivityAt(issue: {
    id: string;
    executionLockedAt: Date | null;
    startedAt: Date | null;
  }): Promise<Date | null> {
    const lastAgentComment = await db
      .select({ createdAt: issueComments.createdAt })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, issue.id),
          isNotNull(issueComments.authorAgentId),
          isNull(issueComments.systemAuthor),
        ),
      )
      .orderBy(desc(issueComments.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    const candidates: Date[] = [];
    if (lastAgentComment) candidates.push(lastAgentComment.createdAt);
    if (issue.executionLockedAt) candidates.push(issue.executionLockedAt);
    if (issue.startedAt) candidates.push(issue.startedAt);
    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) => (a.getTime() > b.getTime() ? a : b));
  }

  async function hasPendingInteraction(issueId: string): Promise<boolean> {
    const row = await db
      .select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.issueId, issueId),
          eq(issueThreadInteractions.status, "pending"),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row !== null;
  }

  async function getLastStallEventForEpisode(
    companyId: string,
    issueId: string,
    tier: 1 | 2,
    episodeStart: Date,
  ) {
    const action = tier === 1 ? STALL_ACTION_TIER1 : STALL_ACTION_TIER2;
    return db
      .select({
        id: activityLog.id,
        createdAt: activityLog.createdAt,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.entityId, issueId),
          eq(activityLog.action, action),
          sql`${activityLog.createdAt} >= ${episodeStart.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(desc(activityLog.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function postSystemComment(issueId: string, companyId: string, body: string) {
    const [comment] = await db
      .insert(issueComments)
      .values({
        companyId,
        issueId,
        authorAgentId: null,
        authorUserId: null,
        systemAuthor: STALL_SYSTEM_AUTHOR,
        body,
      })
      .returning();

    await db
      .update(issues)
      .set({ updatedAt: new Date() })
      .where(eq(issues.id, issueId));

    return comment;
  }

  async function reconcileStallDetection(opts?: { now?: Date; companyId?: string }) {
    const now = opts?.now ?? new Date();
    const defaultPolicy = buildPolicy();

    const candidates = await db
      .select()
      .from(issues)
      .where(
        and(
          opts?.companyId ? eq(issues.companyId, opts.companyId) : undefined,
          isNull(issues.hiddenAt),
          inArray(issues.status, ["in_progress", "in_review"]),
          isNotNull(issues.checkoutRunId),
          isNotNull(issues.assigneeAgentId),
        ),
      )
      .orderBy(asc(issues.updatedAt))
      .limit(MAX_CANDIDATE_ISSUES);

    const result = {
      scanned: candidates.length,
      tier1Posted: 0,
      tier2Posted: 0,
      skipped: 0,
      failed: 0,
    };

    const prefixCache = new Map<string, string>();

    for (const candidate of candidates) {
      if (!candidate.assigneeAgentId) {
        result.skipped++;
        continue;
      }

      try {
        if (await hasPendingInteraction(candidate.id)) {
          result.skipped++;
          continue;
        }

        const lastActivity = await getLastAgentActivityAt({
          id: candidate.id,
          executionLockedAt: candidate.executionLockedAt,
          startedAt: candidate.startedAt,
        });
        if (!lastActivity) {
          result.skipped++;
          continue;
        }

        const silentMs = now.getTime() - lastActivity.getTime();
        const policy = candidate.projectId
          ? (await getProjectStallPolicy(candidate.projectId)) ?? defaultPolicy
          : defaultPolicy;

        if (silentMs < policy.tier1Minutes * 60_000) {
          result.skipped++;
          continue;
        }

        const tier1Event = await getLastStallEventForEpisode(
          candidate.companyId,
          candidate.id,
          1,
          lastActivity,
        );

        if (!tier1Event) {
          // Post Tier 1
          let prefix = prefixCache.get(candidate.companyId);
          if (!prefix) {
            prefix = await getCompanyIssuePrefix(candidate.companyId);
            prefixCache.set(candidate.companyId, prefix);
          }

          const assigneeAgent = await db
            .select({ id: agents.id, name: agents.name })
            .from(agents)
            .where(eq(agents.id, candidate.assigneeAgentId))
            .then((r) => r[0] ?? null);
          const assigneeLink = assigneeAgent
            ? agentMentionLink(assigneeAgent)
            : `(agent ${candidate.assigneeAgentId.slice(0, 8)})`;

          const body = buildStallCommentBody({
            status: candidate.status,
            elapsedMinutes: msToMinutes(silentMs),
            tier: 1,
            assigneeLink,
          });

          await postSystemComment(candidate.id, candidate.companyId, body);
          await logActivity(db, {
            companyId: candidate.companyId,
            actorType: "system",
            actorId: "stall_detection",
            action: STALL_ACTION_TIER1,
            entityType: "issue",
            entityId: candidate.id,
            agentId: candidate.assigneeAgentId,
            details: {
              tier: 1,
              assigneeAgentId: candidate.assigneeAgentId,
              elapsedMs: silentMs,
              stallEpisodeStart: lastActivity.toISOString(),
            },
          });

          if (deps?.enqueueWakeup) {
            await deps.enqueueWakeup(candidate.assigneeAgentId, {
              source: "automation",
              triggerDetail: "system",
              reason: "issue_comment_mentioned",
              payload: { issueId: candidate.id },
              requestedByActorType: "system",
              requestedByActorId: "stall_detection",
              contextSnapshot: {
                issueId: candidate.id,
                taskId: candidate.id,
                wakeReason: "issue_comment_mentioned",
                source: "stall_detection.tier1",
              },
            });
          }

          logger.info(
            { issueId: candidate.id, elapsedMs: silentMs, assigneeAgentId: candidate.assigneeAgentId },
            "stall detection tier 1 posted",
          );
          result.tier1Posted++;
          continue;
        }

        // Tier 1 already posted — check for Tier 2
        const tier1Age = now.getTime() - tier1Event.createdAt.getTime();
        if (tier1Age < policy.tier2Minutes * 60_000) {
          result.skipped++;
          continue;
        }

        const tier2Event = await getLastStallEventForEpisode(
          candidate.companyId,
          candidate.id,
          2,
          lastActivity,
        );
        if (tier2Event) {
          result.skipped++;
          continue;
        }

        // Post Tier 2
        let prefix = prefixCache.get(candidate.companyId);
        if (!prefix) {
          prefix = await getCompanyIssuePrefix(candidate.companyId);
          prefixCache.set(candidate.companyId, prefix);
        }

        const assigneeAgent = await db
          .select({ id: agents.id, name: agents.name, reportsTo: agents.reportsTo })
          .from(agents)
          .where(eq(agents.id, candidate.assigneeAgentId))
          .then((r) => r[0] ?? null);
        const assigneeLink = assigneeAgent
          ? agentMentionLink(assigneeAgent)
          : `(agent ${candidate.assigneeAgentId.slice(0, 8)})`;

        let managerLink: string | undefined;
        let managerId: string | undefined;
        if (assigneeAgent?.reportsTo) {
          const manager = await db
            .select({ id: agents.id, name: agents.name })
            .from(agents)
            .where(eq(agents.id, assigneeAgent.reportsTo))
            .then((r) => r[0] ?? null);
          if (manager) {
            managerId = manager.id;
            managerLink = agentMentionLink(manager);
          }
        }

        const body = buildStallCommentBody({
          status: candidate.status,
          elapsedMinutes: msToMinutes(silentMs),
          tier: 2,
          assigneeLink,
          managerLink,
        });

        await postSystemComment(candidate.id, candidate.companyId, body);
        await logActivity(db, {
          companyId: candidate.companyId,
          actorType: "system",
          actorId: "stall_detection",
          action: STALL_ACTION_TIER2,
          entityType: "issue",
          entityId: candidate.id,
          agentId: managerId ?? candidate.assigneeAgentId,
          details: {
            tier: 2,
            assigneeAgentId: candidate.assigneeAgentId,
            managerAgentId: managerId ?? null,
            elapsedMs: silentMs,
            stallEpisodeStart: lastActivity.toISOString(),
          },
        });

        const wakeTarget = managerId ?? candidate.assigneeAgentId;
        if (deps?.enqueueWakeup) {
          await deps.enqueueWakeup(wakeTarget, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_comment_mentioned",
            payload: { issueId: candidate.id },
            requestedByActorType: "system",
            requestedByActorId: "stall_detection",
            contextSnapshot: {
              issueId: candidate.id,
              taskId: candidate.id,
              wakeReason: "issue_comment_mentioned",
              source: "stall_detection.tier2",
            },
          });
        }

        logger.info(
          {
            issueId: candidate.id,
            elapsedMs: silentMs,
            assigneeAgentId: candidate.assigneeAgentId,
            managerId,
          },
          "stall detection tier 2 posted",
        );
        result.tier2Posted++;
      } catch (err) {
        result.failed++;
        logger.warn(
          { err, issueId: candidate.id, companyId: candidate.companyId },
          "stall detection failed for candidate issue",
        );
      }
    }

    return result;
  }

  return { reconcileStallDetection };
}
