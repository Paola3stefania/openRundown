/**
 * Distillation Layer
 *
 * Compresses OpenRundown's rich data (issues, groups, threads, signals, features)
 * into a compact `project.context` JSON payload (~300-500 tokens) that an
 * agent can consume at session start.
 *
 * The intelligence is in what we leave out, not what we put in.
 */

import { prisma } from "../storage/db/prisma.js";
import { detectProjectId } from "../config/project.js";
import type {
  ProjectContext,
  ActiveIssue,
  UserSignal,
  CodebaseNote,
  Decision,
  RecentActivity,
  BriefingOptions,
} from "./types.js";

const DEFAULT_LOOKBACK_DAYS = 14;
const MAX_ACTIVE_ISSUES = 10;
const MAX_USER_SIGNALS = 5;
const MAX_CODEBASE_NOTES = 5;
const MAX_DECISIONS = 5;

export async function distillBriefing(options: BriefingOptions = {}): Promise<ProjectContext> {
  const since = options.since
    ? new Date(options.since)
    : new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const scope = options.scope?.toLowerCase();
  const projectId = options.project ?? detectProjectId();

  const [
    activeIssues,
    userSignals,
    codebaseNotes,
    decisions,
    recentActivity,
    preferences,
  ] = await Promise.all([
    distillActiveIssues(since, scope),
    distillUserSignals(since, scope),
    distillCodebaseNotes(scope),
    distillDecisions(since, scope),
    distillRecentActivity(since),
    loadPreferences(projectId),
  ]);

  return {
    project: projectId,
    focus: scope,
    lastUpdated: new Date().toISOString(),
    decisions,
    activeIssues,
    userSignals,
    codebaseNotes,
    recentActivity,
    preferences,
  };
}

async function distillActiveIssues(since: Date, scope?: string): Promise<ActiveIssue[]> {
  const issues = await prisma.gitHubIssue.findMany({
    where: {
      issueState: "open",
      issueCreatedAt: { gte: since },
      ...(scope
        ? {
            OR: [
              { issueTitle: { contains: scope, mode: "insensitive" } },
              { issueBody: { contains: scope, mode: "insensitive" } },
              { issueLabels: { has: scope } },
            ],
          }
        : {}),
    },
    include: {
      threadMatches: true,
    },
    orderBy: [{ issueCreatedAt: "desc" }],
    take: MAX_ACTIVE_ISSUES * 2,
  });

  const scored = issues.map((issue) => {
    const threadReports = issue.threadMatches.length;
    const hasLabels = issue.detectedLabels.length > 0;
    const isBug = issue.detectedLabels.includes("bug") || issue.issueLabels.includes("bug");
    const isSecurity = issue.detectedLabels.includes("security");
    const isRegression = issue.detectedLabels.includes("regression");
    const hasAssignees = issue.issueAssignees.length > 0;
    const reactionCount = getReactionCount(issue.issueReactions);

    let priority: ActiveIssue["priority"] = "medium";
    if (isSecurity || isRegression) priority = "critical";
    else if (isBug && (threadReports >= 3 || reactionCount >= 5)) priority = "high";
    else if (isBug || threadReports >= 2) priority = "high";
    else if (hasAssignees || hasLabels) priority = "medium";
    else priority = "low";

    const priorityWeight =
      priority === "critical" ? 4 : priority === "high" ? 3 : priority === "medium" ? 2 : 1;
    const score = priorityWeight * 10 + threadReports * 3 + reactionCount;

    return { issue, threadReports, priority, score, allLabels: [...issue.issueLabels, ...issue.detectedLabels] };
  });

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, MAX_ACTIVE_ISSUES).map(({ issue, threadReports, priority, allLabels }) => ({
    id: `#${issue.issueNumber}`,
    summary: issue.issueTitle,
    reports: threadReports + 1,
    source: threadReports > 0 ? "github + discord" : "github",
    priority,
    labels: [...new Set(allLabels)].slice(0, 5),
    assignees: issue.issueAssignees,
  }));
}

async function distillUserSignals(since: Date, scope?: string): Promise<UserSignal[]> {
  const groups = await prisma.group.findMany({
    where: {
      createdAt: { gte: since },
      ...(scope
        ? {
            OR: [
              { suggestedTitle: { contains: scope, mode: "insensitive" } },
              { affectsFeatures: { path: [], not: "[]" } },
            ],
          }
        : {}),
    },
    include: {
      groupThreads: true,
    },
    orderBy: [{ threadCount: "desc" }],
    take: MAX_USER_SIGNALS * 3,
  });

  const signals: UserSignal[] = groups
    .filter((g) => g.threadCount >= 2)
    .slice(0, MAX_USER_SIGNALS)
    .map((group) => {
      const features = Array.isArray(group.affectsFeatures) ? group.affectsFeatures : [];
      const featureNames = features
        .filter((f): f is { id: string; name: string } => typeof f === "object" && f !== null && "name" in f)
        .map((f) => f.name);

      return {
        theme: group.suggestedTitle,
        count: group.threadCount,
        period: `since ${since.toISOString().split("T")[0]}`,
        summary: featureNames.length > 0
          ? `Affects: ${featureNames.join(", ")}`
          : `${group.threadCount} related threads grouped`,
        sources: group.githubIssueNumber
          ? ["discord", "github"]
          : ["discord"],
      };
    });

  return signals;
}

async function distillCodebaseNotes(scope?: string): Promise<CodebaseNote[]> {
  const notes: CodebaseNote[] = [];

  const features = await prisma.feature.findMany({
    where: scope
      ? {
          OR: [
            { name: { contains: scope, mode: "insensitive" } },
            { relatedKeywords: { has: scope } },
          ],
        }
      : {},
    include: {
      codeMappings: {
        include: {
          codeSection: {
            include: {
              codeFile: true,
            },
          },
        },
        orderBy: { similarity: "desc" },
        take: 3,
      },
    },
    take: 10,
  });

  for (const feature of features) {
    if (feature.codeMappings.length > 0) {
      const files = feature.codeMappings.map((m) => m.codeSection.codeFile.filePath);
      const uniqueFiles = [...new Set(files)];
      if (uniqueFiles.length > 0) {
        notes.push({
          area: feature.name,
          note: `Mapped to ${uniqueFiles.length} file(s): ${uniqueFiles.slice(0, 3).join(", ")}`,
          priority: feature.priority === "high" ? "high" : "medium",
        });
      }
    }
  }

  const ungroupedCount = await prisma.ungroupedThread.count();
  if (ungroupedCount > 10) {
    notes.push({
      area: "classification",
      note: `${ungroupedCount} ungrouped threads need review`,
      priority: ungroupedCount > 50 ? "high" : "medium",
    });
  }

  return notes.slice(0, MAX_CODEBASE_NOTES);
}

async function distillDecisions(since: Date, scope?: string): Promise<Decision[]> {
  const decisions: Decision[] = [];

  const mergedPRs = await prisma.gitHubPullRequest.findMany({
    where: {
      prMerged: true,
      prCreatedAt: { gte: since },
      ...(scope
        ? {
            OR: [
              { prTitle: { contains: scope, mode: "insensitive" } },
              { prBody: { contains: scope, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    include: {
      linkedIssues: true,
    },
    orderBy: { prCreatedAt: "desc" },
    take: MAX_DECISIONS * 2,
  });

  for (const pr of mergedPRs) {
    const linkedIssueNumbers = pr.linkedIssues.map((i) => `#${i.issueNumber}`);
    const openItems = pr.linkedIssues
      .filter((i) => i.issueState === "open")
      .map((i) => `#${i.issueNumber} still open`);

    decisions.push({
      what: pr.prTitle,
      why: linkedIssueNumbers.length > 0
        ? `Addresses ${linkedIssueNumbers.join(", ")}`
        : "Direct improvement",
      when: pr.prCreatedAt.toISOString().split("T")[0],
      status: "implemented",
      openItems,
    });
  }

  return decisions.slice(0, MAX_DECISIONS);
}

async function distillRecentActivity(since: Date): Promise<RecentActivity> {
  const [issuesOpened, issuesClosed, prsOpened, prsMerged, discordThreads] = await Promise.all([
    prisma.gitHubIssue.count({
      where: { issueCreatedAt: { gte: since }, issueState: "open" },
    }),
    prisma.gitHubIssue.count({
      where: { issueUpdatedAt: { gte: since }, issueState: "closed" },
    }),
    prisma.gitHubPullRequest.count({
      where: { prCreatedAt: { gte: since } },
    }),
    prisma.gitHubPullRequest.count({
      where: { prCreatedAt: { gte: since }, prMerged: true },
    }),
    prisma.classifiedThread.count({
      where: { classifiedAt: { gte: since } },
    }),
  ]);

  const days = Math.ceil((Date.now() - since.getTime()) / (24 * 60 * 60 * 1000));
  return {
    issuesOpened,
    issuesClosed,
    prsOpened,
    prsMerged,
    discordThreads,
    period: `last ${days} days`,
  };
}

async function loadPreferences(projectId: string): Promise<Record<string, string>> {
  const lastSession = await prisma.agentSession.findFirst({
    where: { projectId },
    orderBy: { startedAt: "desc" },
    select: { scope: true },
  });

  return {
    lastScope: lastSession?.scope?.join(", ") ?? "none",
  };
}

function getReactionCount(reactions: unknown): number {
  if (!reactions || typeof reactions !== "object") return 0;
  const r = reactions as Record<string, unknown>;
  let total = 0;
  for (const key of Object.keys(r)) {
    const val = r[key];
    if (typeof val === "number") total += val;
  }
  return total;
}
