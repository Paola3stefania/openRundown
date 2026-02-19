/**
 * Agent Briefing System types
 *
 * Defines the `project.context` format — a compact, structured payload
 * optimized for agent consumption. An agent reads this in ~300-500 tokens
 * and instantly knows what a human would take 30 minutes to explain.
 */

export interface ProjectContext {
  project: string;
  focus?: string;
  lastUpdated: string;
  decisions: Decision[];
  activeIssues: ActiveIssue[];
  userSignals: UserSignal[];
  codebaseNotes: CodebaseNote[];
  recentActivity: RecentActivity;
  preferences: Record<string, string>;
}

export interface Decision {
  what: string;
  why: string;
  when: string;
  status: "proposed" | "implemented" | "reverted";
  openItems: string[];
}

export interface ActiveIssue {
  id: string;
  summary: string;
  reports: number;
  source: string;
  priority: "critical" | "high" | "medium" | "low";
  labels: string[];
  assignees: string[];
}

export interface UserSignal {
  theme: string;
  count: number;
  period: string;
  summary: string;
  sources: string[];
}

export interface CodebaseNote {
  file?: string;
  area?: string;
  note: string;
  priority: "high" | "medium" | "low";
}

export interface RecentActivity {
  issuesOpened: number;
  issuesClosed: number;
  prsOpened: number;
  prsMerged: number;
  discordThreads: number;
  period: string;
}

export interface AgentSession {
  sessionId: string;
  projectId: string;
  startedAt: string;
  endedAt?: string;
  scope: string[];
  filesEdited: string[];
  decisionsMade: string[];
  openItems: string[];
  issuesReferenced: string[];
  toolsUsed: string[];
  summary?: string;
}

export interface BriefingOptions {
  scope?: string;
  since?: string;
  project?: string;
  maxTokens?: number;
}
