---
name: openrundown
description: Provides project context and session memory for AI agents via the OpenRundown MCP server. Use at the start of every conversation to get a briefing on active issues, recent decisions, and open items. Use during work sessions to record decisions and progress for the next agent. Triggers when working on any project with OpenRundown configured.
---

# OpenRundown

OpenRundown gives you persistent memory across sessions. It distills signals from Discord, GitHub, X/Twitter, and past agent sessions into structured briefings so you never start blind.

## Detecting the Project

Every call to `get_agent_briefing`, `get_session_history`, and `start_agent_session` needs a `project` parameter. The MCP server runs separately and cannot detect your workspace, so you must detect it yourself:

1. Run `git remote get-url origin` in the workspace and parse `owner/repo` from the URL
2. If there is no git remote, use the workspace folder name (e.g., `my-project`)
3. Always pass the result as the `project` argument

## At Session Start

Always do this before responding to the user:

1. Detect the project identifier (see above)
2. Call `get_agent_briefing` from the `user-openrundown` MCP server with `project`
   - Optionally pass `scope` if you know what area the user is working on
   - Optionally pass `since` with the last session timestamp
3. Call `get_session_history` with `limit: 3` and `project` to see recent sessions
4. Use the briefing to understand: active issues, recent decisions, open items, active plans, user signals, tech signals from X/Twitter
5. If a previous session has `open_items`, proactively mention them
6. **Resume active plans**: If the last session has `planSteps` with incomplete steps (pending/in_progress/blocked), show the plan status to the user and offer to continue from where the previous agent left off.
7. **Recover auto-closed sessions**: If the most recent session's summary indicates it was auto-closed (e.g., "Auto-closed: session was never properly ended") and its `filesEdited`, `decisionsMade`, or `openItems` are empty, check if the `lastSession` from the briefing has a `scope`. If it does, mention to the user that the previous session (scope: `<scope>`) was lost without saving progress and ask if there is anything to record before moving on. This prevents silent data loss across agent handoffs.

## During Work Sessions

When doing meaningful work (not just answering questions):

1. Call `start_agent_session` with the scope of work and `project`
   - Example: `scope: ["agent-auth", "mcp-tools"], project: "owner/repo"`
2. Call `update_agent_session` **immediately after each meaningful step** (see auto-save rules below)
3. Call `end_agent_session` when done, recording:
   - `decisions_made`: key decisions with brief reasoning
   - `files_edited`: files that were changed
   - `open_items`: unfinished work the next agent should pick up
   - `issues_referenced`: GitHub issue numbers discussed
   - `plan_steps`: structured plan with step statuses (see below)
   - `summary`: 1-2 sentence description of what was accomplished

## Saving Plans (mandatory when plans exist)

When you create a plan (in Plan mode, or outline implementation steps), you **must** persist it via `plan_steps` so the next agent can continue:

1. **When creating a plan**: Convert each step into a `plan_steps` entry with `id`, `description`, and `status: "pending"`. Save immediately via `update_agent_session`.
2. **As you complete steps**: Update the step's status to `"completed"` (or `"blocked"` with a `notes` explaining why). Include the full `plan_steps` array with updated statuses in your `update_agent_session` call.
3. **Plan step statuses**: `pending`, `in_progress`, `completed`, `blocked`
4. **At session end**: The final `plan_steps` state should reflect what was done and what remains. Incomplete steps are automatically visible to the next agent via the briefing.

Example `plan_steps`:
```json
[
  { "id": "1", "description": "Add planSteps field to schema", "status": "completed" },
  { "id": "2", "description": "Update session CRUD", "status": "completed" },
  { "id": "3", "description": "Update MCP handlers", "status": "in_progress" },
  { "id": "4", "description": "Write tests", "status": "pending" }
]
```

The next agent's briefing will include these steps, so they know exactly where to pick up.

## Auto-Save on Every Turn (mandatory)

Sessions can be lost at any time (chat disconnects, crashes, timeouts). Since you cannot detect when a chat is about to end, you must save at the end of every turn:

1. **At the end of each response**, after all tool calls and edits are done, call `update_agent_session` with the current cumulative state: `files_edited`, `decisions_made`, `open_items`, `plan_steps` (if a plan exists), and a `summary` of progress so far.
2. This is the **only** required save point -- do not call `update_agent_session` after every individual action.
3. `end_agent_session` is still preferred when you know the work is done, but the per-turn save ensures nothing is lost if the chat drops unexpectedly.
4. **First turn rule**: Even if your first response is just a greeting or briefing summary, call `update_agent_session` with at least a `summary` (e.g., "Session started, briefing reviewed. Waiting for user direction."). An empty session that gets auto-closed is useless to the next agent.

## What Makes a Good Session Record

- Decisions should include the "why", not just the "what"
- Open items should be specific and actionable
- Summaries should be useful to a future agent with no prior context

## Available Tools

| Tool | When to Use |
|------|-------------|
| `get_agent_briefing` | Start of every session |
| `get_session_history` | Start of session, to see recent work |
| `start_agent_session` | Beginning of meaningful work |
| `update_agent_session` | Mid-session progress recording (include `plan_steps`!) |
| `end_agent_session` | End of meaningful work |
| `import_claude_plans` | Import plans from Claude Code's `~/.claude/plans/` |
| `fetch_x_posts` | Fetch tweets by users, hashtags, or keywords |
| `manage_x_watches` | Add/remove/list monitored X accounts and hashtags |
| `search_x_posts` | Search stored tweets by content, author, engagement |
