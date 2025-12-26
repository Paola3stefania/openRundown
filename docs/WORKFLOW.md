# UNMute Workflow

How messages are fetched, classified, and grouped.

## Complete Workflow

### Step 1: Fetch Data (Sync)

**Tools:**
- `fetch_discord_messages` - Fetch Discord messages
- `fetch_github_issues` - Fetch GitHub issues
- `sync_and_classify` - Automated sync (both)

**What happens:**
1. **Discord Messages:**
   - Fetches messages from Discord channel
   - Organizes by threads (groups messages in same thread)
   - Saves to `cache/discord-messages-{channelId}.json`
   - **Incremental:** Only fetches new/updated messages since last fetch

2. **GitHub Issues:**
   - Fetches all issues from GitHub repository
   - Saves to `cache/github-issues-cache.json`
   - **Incremental:** Only fetches issues updated since last fetch

**Result:** Both data sources are cached locally

---

### Step 2: Classification (1-to-1 Matching)

**Tool:** `classify_discord_messages`

**What happens:**
1. **Loads cached data:**
   - Discord messages from cache
   - GitHub issues from cache
   - Classification history (to skip already-classified threads)

2. **Organizes messages by thread:**
   - Combines all messages in a thread into one "signal"
   - Standalone messages become single-message threads

3. **Classifies each thread against all GitHub issues:**
   - **Semantic (LLM):** Uses OpenAI embeddings to find similar issues
   - **Keyword:** Falls back to keyword matching if no OpenAI key
   - Compares thread content with issue title + body
   - Returns top matches with similarity scores

4. **Saves incrementally:**
   - Processes in batches of 50 threads
   - Saves after each batch to `results/discord-classified-{channelId}.json`
   - Updates `classification-history.json` to track progress

**Result:** Each Discord thread is matched to 1+ GitHub issues with similarity scores

**Example:**
```json
{
  "thread_id": "123",
  "thread_name": "How to change postgres schema?",
  "issues": [
    { "number": 6606, "similarity_score": 83.5, "title": "CLI generate command: Support for PostgreSQL..." },
    { "number": 1234, "similarity_score": 45.2, "title": "Database configuration..." }
  ]
}
```

---

### Step 3: Grouping (Many-to-Many)

**Tool:** `suggest_grouping`

**What happens:**
1. **Loads classification results:**
   - Reads `results/discord-classified-{channelId}.json`
   - Uses the file with the **most** classified threads (not just most recent)

2. **Groups threads by shared GitHub issues:**
   - If multiple threads match the same GitHub issue → they're in the same group
   - Example: 4 threads all matched issue #6606 → 1 group with 4 threads

3. **Generates group title:**
   - **Priority 1:** GitHub issue title (for PR auto-closing)
   - **Priority 2:** Summary of thread titles
   - Ensures every group has a `suggested_title`

4. **Identifies ungrouped threads:**
   - Threads with no matches → `reason: "no_matches"`
   - Threads with matches below threshold → `reason: "below_threshold"`

5. **Saves incrementally:**
   - Processes in batches of 1000 threads
   - Saves after each batch to `results/grouping-{channelId}.json`
   - Merges groups across batches (threads for same issue are combined)

**Result:** Groups of related threads, each group linked to a GitHub issue

**Example:**
```json
{
  "id": "issue-6606",
  "suggested_title": "CLI generate command: Support for PostgreSQL custom schema...",
  "github_issue": { "number": 6606, "title": "...", "url": "..." },
  "thread_count": 4,
  "threads": [
    { "thread_id": "123", "similarity_score": 83.5 },
    { "thread_id": "456", "similarity_score": 81.4 },
    ...
  ]
}
```

---

### Step 4: Export to PM Tool

**Tool:** `export_to_pm_tool`

**What happens:**
1. **Loads grouping results:**
   - Reads `results/grouping-{channelId}.json`
   - Or uses `grouping_data_path` parameter

2. **Ensures all groups have `suggested_title`:**
   - Generates from thread titles if missing
   - Falls back to GitHub issue title

3. **Creates Linear issues:**
   - One Linear issue per group
   - Title = `suggested_title` (GitHub issue title for PR auto-closing)
   - Description includes:
     - Summary of Discord discussions
     - Similarity breakdown (high/medium)
     - Common themes from thread titles
     - Links to all Discord threads and GitHub issues
     - Tip about using `Fixes LIN-XXX` in PRs

4. **Updates grouping JSON:**
   - Marks groups as `status: "exported"`
   - Adds `exported_at`, `linear_issue_id`, `linear_issue_url`, `linear_issue_identifier`
   - Saves back to file

**Result:** Linear issues created, grouping file updated with export status

---

## Incremental Processing

**Key feature:** Everything is incremental and resumable

1. **Classification:**
   - Skips threads already in `classification-history.json`
   - Only processes new threads
   - Saves after each batch of 50

2. **Grouping:**
   - Uses classification file with **most** threads (not just newest)
   - Merges new groups into existing grouping file
   - Saves after each batch of 1000

3. **Export:**
   - Can skip already-exported groups (check `status: "exported"`)
   - Updates grouping file with export status

---

## Data Flow

```
Discord API
    ↓
cache/discord-messages-{channelId}.json
    ↓
classify_discord_messages
    ↓ (compares with)
cache/github-issues-cache.json
    ↓
results/discord-classified-{channelId}.json
    ↓
suggest_grouping
    ↓ (groups by shared issues)
results/grouping-{channelId}.json
    ↓
export_to_pm_tool
    ↓
Linear (via API)
    ↓
results/grouping-{channelId}.json (updated with export status)
```

---

## Typical Usage

**First time:**
```bash
# 1. Fetch all data
fetch_discord_messages
fetch_github_issues

# 2. Classify (processes all threads)
classify_discord_messages

# 3. Group (uses all classified threads)
suggest_grouping

# 4. Export to Linear
export_to_pm_tool --grouping_data_path results/grouping-{channelId}.json
```

**Subsequent runs (incremental):**
```bash
# 1. Sync (only new data)
sync_and_classify

# 2. Classify (only new threads)
classify_discord_messages  # Automatically skips already-classified

# 3. Group (merges with existing groups)
suggest_grouping  # Uses file with most threads

# 4. Export (only unexported groups)
export_to_pm_tool --grouping_data_path results/grouping-{channelId}.json
```

---

## Key Concepts

1. **Thread = Signal:** Each Discord thread (or standalone message) is one signal
2. **1-to-1 Classification:** Each thread matched to multiple GitHub issues (with scores)
3. **Many-to-Many Grouping:** Multiple threads → one group (via shared GitHub issue)
4. **Incremental:** Everything saves progress and can resume
5. **Resumable:** If process breaks, restart and it continues where it left off

