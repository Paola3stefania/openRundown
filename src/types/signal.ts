/**
 * Normalized signal type for unified handling across sources
 * 
 * All connectors (Discord, Slack, GitHub) produce Signals,
 * which are then processed by core classification/correlation logic.
 */
export type SignalSource = "discord" | "slack" | "github" | "x";

export interface Signal {
  source: SignalSource;
  sourceId: string; // threadId, messageId, issueId, etc.
  permalink: string; // URL to the original item
  title?: string; // Optional title (for issues, threads)
  body: string; // Main content
  createdAt: string; // ISO timestamp
  updatedAt?: string; // ISO timestamp (if available)
  metadata: Record<string, unknown>; // Source-specific metadata
}

export interface IssueRef {
  source: SignalSource;
  sourceId: string;
  permalink: string;
  title?: string;
}

export interface ThreadRef {
  source: SignalSource;
  sourceId: string;
  permalink: string;
  title?: string;
}

export interface GroupCandidate {
  signals: Signal[];
  similarity: number;
  canonicalIssue?: IssueRef;
}

