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

import { prisma } from "../storage/db/prisma.js";
import { detectProjectId } from "../config/project.js";
import type { AgentSession } from "./types.js";

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
    summary: string;
  }>,
): Promise<AgentSession> {
  const existing = await prisma.agentSession.findUniqueOrThrow({
    where: { id: sessionId },
  });

  const mergeArrays = (existing: string[], incoming?: string[]) =>
    incoming ? [...new Set([...existing, ...incoming])] : existing;

  const session = await prisma.agentSession.update({
    where: { id: sessionId },
    data: {
      scope: mergeArrays(existing.scope, updates.scope),
      filesEdited: mergeArrays(existing.filesEdited, updates.filesEdited),
      decisionsMade: mergeArrays(existing.decisionsMade, updates.decisionsMade),
      openItems: mergeArrays(existing.openItems, updates.openItems),
      issuesReferenced: mergeArrays(existing.issuesReferenced, updates.issuesReferenced),
      toolsUsed: mergeArrays(existing.toolsUsed, updates.toolsUsed),
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

export async function getLastSession(projectId?: string): Promise<AgentSession | null> {
  const pid = projectId ?? detectProjectId();
  const session = await prisma.agentSession.findFirst({
    where: { projectId: pid },
    orderBy: { startedAt: "desc" },
  });
  return session ? mapSession(session) : null;
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
    summary: session.summary ?? undefined,
  };
}
