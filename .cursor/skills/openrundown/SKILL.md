---
name: openrundown
description: Provides project context and session memory for AI agents via the OpenRundown MCP server. Use at the start of every conversation to get a briefing on active issues, recent decisions, and open items. Use during work sessions to record decisions and progress for the next agent. Triggers when working on any project with OpenRundown configured.
---

# OpenRundown

OpenRundown gives you persistent memory across sessions. It distills signals from Discord, GitHub, and past agent sessions into structured briefings so you never start blind.

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
4. Use the briefing to understand: active issues, recent decisions, open items, user signals
5. If a previous session has `open_items`, proactively mention them

## During Work Sessions

When doing meaningful work (not just answering questions):

1. Call `start_agent_session` with the scope of work and `project`
   - Example: `scope: ["agent-auth", "mcp-tools"], project: "owner/repo"`
2. Call `update_agent_session` periodically to record progress
3. Call `end_agent_session` when done, recording:
   - `decisions_made`: key decisions with brief reasoning
   - `files_edited`: files that were changed
   - `open_items`: unfinished work the next agent should pick up
   - `issues_referenced`: GitHub issue numbers discussed
   - `summary`: 1-2 sentence description of what was accomplished

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
| `update_agent_session` | Mid-session progress recording |
| `end_agent_session` | End of meaningful work |
