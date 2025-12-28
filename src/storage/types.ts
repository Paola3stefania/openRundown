/**
 * Storage abstraction types
 * Allows switching between JSON files and PostgreSQL
 */

export interface ClassifiedThread {
  thread_id: string;
  channel_id: string;
  thread_name?: string;
  message_count: number;
  first_message_id: string;
  first_message_author?: string;
  first_message_timestamp?: string;
  first_message_url?: string;
  classified_at: string;
  status: "pending" | "classifying" | "completed" | "failed";
  match_status?: "matched" | "below_threshold" | "no_matches" | null; // Classification match status
  export_status?: "pending" | "exported" | null; // Export status
  exported_at?: string;
  linear_issue_id?: string;
  linear_issue_url?: string;
  linear_issue_identifier?: string;
  issues: Array<{
    number: number;
    title: string;
    state: string;
    url: string;
    similarity_score: number;
    matched_terms?: string[];
    labels?: string[];
    author?: string;
    created_at?: string;
  }>;
}

export interface Group {
  id: string;
  channel_id: string;
  github_issue_number?: number;
  suggested_title: string;
  avg_similarity: number;
  thread_count: number;
  is_cross_cutting: boolean;
  status: "pending" | "exported";
  created_at: string;
  updated_at: string;
  exported_at?: string;
  linear_issue_id?: string;
  linear_issue_url?: string;
  linear_issue_identifier?: string; // Human-readable ID like "LIN-123"
  linear_project_ids?: string[];
  affects_features?: Array<{ id: string; name: string }>; // Features this group affects
  threads: Array<{
    thread_id: string;
    thread_name?: string;
    similarity_score: number;
    url?: string;
    author?: string;
    timestamp?: string;
  }>;
}

export interface UngroupedThread {
  thread_id: string;
  channel_id: string;
  thread_name?: string;
  url?: string;
  author?: string;
  timestamp?: string;
  reason: "no_matches" | "below_threshold";
  export_status?: "pending" | "exported" | null; // Export status
  exported_at?: string;
  linear_issue_id?: string;
  linear_issue_url?: string;
  linear_issue_identifier?: string;
  top_issue?: {
    number: number;
    title: string;
    similarity_score: number;
  };
}

export interface StorageStats {
  totalThreads: number;
  groupedThreads: number;
  ungroupedThreads: number;
  uniqueIssues: number;
  multiThreadGroups: number;
  singleThreadGroups: number;
}

