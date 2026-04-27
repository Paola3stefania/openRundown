/**
 * Session Tracking
 *
 * Lightweight bookkeeping for agent sessions. Tracks what an agent worked on
 * so the next briefing can highlight what changed since the last session.
 *
 * All sessions are scoped to a projectId so multiple projects can share
 * one database without collision.
 *
 * No embeddings needed — just structured data in a simple table.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "../storage/db/prisma.js";
import { detectProjectId } from "../config/project.js";
import type { AgentSession, PlanStep } from "./types.js";

export async function startSession(
  scope: string[] = [],
  projectId?: string,
): Promise<AgentSession> {
  const pid = projectId ?? detectProjectId();
  const session = await prisma.agentSession.create({
    data: {
      projectId: pid,
      scope,
      startedAt: new Date(),
    },
  });

  return mapSession(session);
}

export async function endSession(
  sessionId: string,
  updates: {
    filesEdited?: string[];
    decisionsMade?: string[];
    openItems?: string[];
    issuesReferenced?: string[];
    toolsUsed?: string[];
    planSteps?: PlanStep[];
    summary?: string;
  } = {},
): Promise<AgentSession> {
  const session = await prisma.agentSession.update({
    where: { id: sessionId },
    data: {
      endedAt: new Date(),
      filesEdited: updates.filesEdited ?? [],
      decisionsMade: updates.decisionsMade ?? [],
      openItems: updates.openItems ?? [],
      issuesReferenced: updates.issuesReferenced ?? [],
      toolsUsed: updates.toolsUsed ?? [],
      ...(updates.planSteps !== undefined && {
        planSteps: updates.planSteps as unknown as Prisma.InputJsonValue,
      }),
      summary: updates.summary ?? null,
    },
  });

  return mapSession(session);
}

export async function updateSession(
  sessionId: string,
  updates: Partial<{
    scope: string[];
    filesEdited: string[];
    decisionsMade: string[];
    openItems: string[];
    issuesReferenced: string[];
    toolsUsed: string[];
    planSteps: PlanStep[];
    summary: string;
  }>,
): Promise<AgentSession> {
  const existing = await prisma.agentSession.findUniqueOrThrow({
    where: { id: sessionId },
  });

  const mergeArrays = (existing: string[], incoming?: string[]) =>
    incoming ? [...new Set([...existing, ...incoming])] : existing;

  const mergedPlanSteps = mergePlanSteps(
    parsePlanSteps(existing.planSteps),
    updates.planSteps,
  );

  const session = await prisma.agentSession.update({
    where: { id: sessionId },
    data: {
      scope: mergeArrays(existing.scope, updates.scope),
      filesEdited: mergeArrays(existing.filesEdited, updates.filesEdited),
      decisionsMade: mergeArrays(existing.decisionsMade, updates.decisionsMade),
      openItems: mergeArrays(existing.openItems, updates.openItems),
      issuesReferenced: mergeArrays(existing.issuesReferenced, updates.issuesReferenced),
      toolsUsed: mergeArrays(existing.toolsUsed, updates.toolsUsed),
      ...(mergedPlanSteps !== undefined && {
        planSteps: mergedPlanSteps as unknown as Prisma.InputJsonValue,
      }),
      summary: updates.summary ?? existing.summary,
    },
  });

  return mapSession(session);
}

export async function getSession(sessionId: string): Promise<AgentSession | null> {
  const session = await prisma.agentSession.findUnique({
    where: { id: sessionId },
  });
  return session ? mapSession(session) : null;
}

export async function getRecentSessions(
  limit = 5,
  projectId?: string,
): Promise<AgentSession[]> {
  const pid = projectId ?? detectProjectId();
  const sessions = await prisma.agentSession.findMany({
    where: { projectId: pid },
    orderBy: { startedAt: "desc" },
    take: limit,
  });
  return sessions.map(mapSession);
}

/**
 * Auto-close sessions that were started but never properly ended.
 * A session is "stale" if endedAt is null and it hasn't been touched
 * (started or updated) within the threshold (default: 1 hour).
 * Using updatedAt means actively-updated long sessions won't be reaped.
 */
export async function closeStaleSessions(
  projectId?: string,
  maxAgeMs = 60 * 60 * 1000,
): Promise<number> {
  const pid = projectId ?? detectProjectId();
  const cutoff = new Date(Date.now() - maxAgeMs);

  const stale = await prisma.agentSession.findMany({
    where: {
      projectId: pid,
      endedAt: null,
      updatedAt: { lt: cutoff },
    },
    select: { id: true, startedAt: true, updatedAt: true },
  });

  if (stale.length === 0) return 0;

  await prisma.agentSession.updateMany({
    where: { id: { in: stale.map((s) => s.id) } },
    data: {
      endedAt: new Date(),
      summary: "Auto-closed: session was never properly ended.",
    },
  });

  console.error(`[Session] Auto-closed ${stale.length} stale session(s) for project "${pid}"`);
  return stale.length;
}

export async function getLastSession(projectId?: string): Promise<AgentSession | null> {
  const pid = projectId ?? detectProjectId();
  const session = await prisma.agentSession.findFirst({
    where: { projectId: pid },
    orderBy: { startedAt: "desc" },
  });
  return session ? mapSession(session) : null;
}

/**
 * Compact view of a session — optimized for listing many sessions without
 * blowing past MCP response size limits. Arrays are replaced with counts and
 * small previews; long strings (summary) are truncated.
 */
export interface AgentSessionSummary {
  sessionId: string;
  projectId: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  scope: string[];
  summary?: string;
  summaryTruncated: boolean;
  counts: {
    filesEdited: number;
    decisionsMade: number;
    openItems: number;
    issuesReferenced: number;
    toolsUsed: number;
    planSteps: number;
  };
  openItemsPreview: string[];
  planStepsStatus: Record<PlanStep["status"], number>;
}

const SUMMARY_MAX_CHARS = 280;
const OPEN_ITEMS_PREVIEW = 5;

export function summarizeSession(session: AgentSession): AgentSessionSummary {
  const summary = session.summary ?? "";
  const summaryTruncated = summary.length > SUMMARY_MAX_CHARS;
  const planStepsStatus: Record<PlanStep["status"], number> = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    blocked: 0,
  };
  for (const step of session.planSteps ?? []) {
    planStepsStatus[step.status] = (planStepsStatus[step.status] ?? 0) + 1;
  }

  const startedMs = Date.parse(session.startedAt);
  const endedMs = session.endedAt ? Date.parse(session.endedAt) : undefined;

  return {
    sessionId: session.sessionId,
    projectId: session.projectId,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    durationMs:
      endedMs !== undefined && !Number.isNaN(startedMs) && !Number.isNaN(endedMs)
        ? endedMs - startedMs
        : undefined,
    scope: session.scope,
    summary: summaryTruncated ? `${summary.slice(0, SUMMARY_MAX_CHARS)}…` : summary || undefined,
    summaryTruncated,
    counts: {
      filesEdited: session.filesEdited.length,
      decisionsMade: session.decisionsMade.length,
      openItems: session.openItems.length,
      issuesReferenced: session.issuesReferenced.length,
      toolsUsed: session.toolsUsed.length,
      planSteps: session.planSteps?.length ?? 0,
    },
    openItemsPreview: session.openItems.slice(0, OPEN_ITEMS_PREVIEW),
    planStepsStatus,
  };
}

function parsePlanSteps(raw: unknown): PlanStep[] | undefined {
  if (!raw) return undefined;
  if (Array.isArray(raw)) return raw as PlanStep[];
  return undefined;
}

/**
 * Merge incoming plan steps with existing ones by id.
 * New steps are appended, existing steps are updated (status/notes overwrite).
 */
function mergePlanSteps(
  existing?: PlanStep[],
  incoming?: PlanStep[],
): PlanStep[] | undefined {
  if (!incoming) return existing;
  if (!existing || existing.length === 0) return incoming;

  const merged = new Map<string, PlanStep>();
  for (const step of existing) merged.set(step.id, step);
  for (const step of incoming) merged.set(step.id, { ...merged.get(step.id), ...step });
  return [...merged.values()];
}

function mapSession(session: {
  id: string;
  projectId: string;
  startedAt: Date;
  endedAt: Date | null;
  scope: string[];
  filesEdited: string[];
  decisionsMade: string[];
  openItems: string[];
  issuesReferenced: string[];
  toolsUsed: string[];
  planSteps: unknown;
  summary: string | null;
}): AgentSession {
  return {
    sessionId: session.id,
    projectId: session.projectId,
    startedAt: session.startedAt.toISOString(),
    endedAt: session.endedAt?.toISOString(),
    scope: session.scope,
    filesEdited: session.filesEdited,
    decisionsMade: session.decisionsMade,
    openItems: session.openItems,
    issuesReferenced: session.issuesReferenced,
    toolsUsed: session.toolsUsed,
    planSteps: parsePlanSteps(session.planSteps),
    summary: session.summary ?? undefined,
  };
}
