-- UNMute MCP Database Schema
-- Stores Discord message classifications and groupings

-- Channels table
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT,
  guild_id TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Classified threads (1-to-1 classification results)
CREATE TABLE IF NOT EXISTS classified_threads (
  thread_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  thread_name TEXT,
  message_count INTEGER DEFAULT 1,
  first_message_id TEXT,
  first_message_author TEXT,
  first_message_timestamp TIMESTAMP,
  first_message_url TEXT,
  classified_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  status TEXT DEFAULT 'completed' CHECK (status IN ('pending', 'classifying', 'completed', 'failed'))
);

-- Thread-issue matches (many-to-many)
CREATE TABLE IF NOT EXISTS thread_issue_matches (
  id SERIAL PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES classified_threads(thread_id) ON DELETE CASCADE,
  issue_number INTEGER NOT NULL,
  issue_title TEXT NOT NULL,
  issue_url TEXT NOT NULL,
  issue_state TEXT,
  similarity_score DECIMAL(5,2) NOT NULL,
  matched_terms TEXT[],
  issue_labels TEXT[],
  issue_author TEXT,
  issue_created_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(thread_id, issue_number)
);

-- Indexes for thread_issue_matches
CREATE INDEX IF NOT EXISTS idx_thread_issue_thread_id ON thread_issue_matches(thread_id);
CREATE INDEX IF NOT EXISTS idx_thread_issue_issue_number ON thread_issue_matches(issue_number);
CREATE INDEX IF NOT EXISTS idx_thread_issue_similarity ON thread_issue_matches(similarity_score DESC);

-- Groups (issue-based groupings)
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  github_issue_number INTEGER,
  suggested_title TEXT NOT NULL,
  avg_similarity DECIMAL(5,2),
  thread_count INTEGER DEFAULT 0,
  is_cross_cutting BOOLEAN DEFAULT FALSE,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'exported')),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  exported_at TIMESTAMP,
  linear_issue_id TEXT,
  linear_issue_url TEXT,
  linear_project_ids TEXT[]
);

-- Group-thread relationships
CREATE TABLE IF NOT EXISTS group_threads (
  id SERIAL PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES classified_threads(thread_id) ON DELETE CASCADE,
  similarity_score DECIMAL(5,2),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(group_id, thread_id)
);

-- Indexes for group_threads
CREATE INDEX IF NOT EXISTS idx_group_threads_group_id ON group_threads(group_id);
CREATE INDEX IF NOT EXISTS idx_group_threads_thread_id ON group_threads(thread_id);

-- Ungrouped threads
CREATE TABLE IF NOT EXISTS ungrouped_threads (
  thread_id TEXT PRIMARY KEY REFERENCES classified_threads(thread_id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('no_matches', 'below_threshold')),
  top_issue_number INTEGER,
  top_issue_title TEXT,
  top_issue_similarity DECIMAL(5,2),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for ungrouped_threads
CREATE INDEX IF NOT EXISTS idx_ungrouped_channel ON ungrouped_threads(channel_id);
CREATE INDEX IF NOT EXISTS idx_ungrouped_reason ON ungrouped_threads(reason);

-- Classification history (for tracking)
CREATE TABLE IF NOT EXISTS classification_history (
  id SERIAL PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  message_id TEXT,
  thread_id TEXT REFERENCES classified_threads(thread_id) ON DELETE CASCADE,
  classified_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(channel_id, message_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_channels_guild ON channels(guild_id);
CREATE INDEX IF NOT EXISTS idx_classified_threads_channel ON classified_threads(channel_id);
CREATE INDEX IF NOT EXISTS idx_classified_threads_status ON classified_threads(status);
CREATE INDEX IF NOT EXISTS idx_groups_channel ON groups(channel_id);
CREATE INDEX IF NOT EXISTS idx_groups_status ON groups(status);
CREATE INDEX IF NOT EXISTS idx_groups_issue ON groups(github_issue_number);

-- Update timestamps trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_channels_updated_at BEFORE UPDATE ON channels
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_classified_threads_updated_at BEFORE UPDATE ON classified_threads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_groups_updated_at BEFORE UPDATE ON groups
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_ungrouped_threads_updated_at BEFORE UPDATE ON ungrouped_threads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

