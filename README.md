# OpenRundown

**Give your AI agents memory.** OpenRundown is an MCP server and Cursor plugin that gives every agent session a briefing -- active issues, recent decisions, and open items from past sessions -- so no agent ever starts blind.

## The Problem

Every time you open a new Cursor chat, the agent starts from zero. It doesn't know what you worked on yesterday, what decisions were made, which issues are critical, or what the last agent left unfinished. You end up repeating context, re-explaining decisions, and watching agents redo work that was already done.

## How OpenRundown Solves It

OpenRundown sits between your project signals (GitHub, Discord, past sessions) and your AI agents. It compresses everything into a compact briefing (~300-500 tokens) that the agent reads at session start.

```
GitHub Issues + Discord Threads + Past Sessions
                    |
              [ OpenRundown ]
                    |
            Compact Briefing JSON
                    |
         Agent starts with full context
```

When the session ends, OpenRundown saves what happened -- decisions made, files edited, open items -- so the *next* agent picks up exactly where this one left off.

## What Agents Get

At session start, the agent automatically receives:

- **Active issues** ranked by priority (security, bugs, regressions first)
- **Recent decisions** from merged PRs and past sessions
- **Open items** the last agent left unfinished
- **User signals** -- recurring themes from Discord and GitHub
- **Codebase notes** -- which files map to which features

This all fits in ~300-500 tokens. No vector search needed at query time.

## Install

### As a Cursor Plugin

OpenRundown ships as a Cursor plugin with rules, skills, hooks, and an MCP server bundled together. The plugin auto-briefs agents at session start and auto-saves sessions on end.

```
.cursor-plugin/plugin.json   -- plugin manifest
mcp.json                      -- MCP server config
rules/openrundown.mdc        -- session protocol (always applied)
skills/openrundown/SKILL.md  -- detailed agent instructions
hooks/hooks.json              -- sessionEnd hook
agents/session-tracker.md     -- session tracking agent
```

### Manual Setup

1. Clone and install:
   ```bash
   git clone https://github.com/Paola3stefania/openrundown.git
   cd openrundown
   npm install && npm run build
   ```

2. Configure: Copy `env.example` to `.env` and set your tokens:
   ```bash
   cp env.example .env
   ```
   Required: `DISCORD_TOKEN`, `GITHUB_TOKEN`, `GITHUB_REPO_URL`
   Optional: `OPENAI_API_KEY`, `DATABASE_URL`, `PM_TOOL_*`

3. Database (optional, for persistent storage):
   ```bash
   createdb openrundown && npx prisma migrate deploy
   ```

4. Add to Cursor: See `cursor-mcp-config.json.example` for MCP configuration.

## Agent Briefing Tools

These are the core tools agents use every session:

| Tool | What it does |
|------|-------------|
| `get_agent_briefing` | Get project context at session start |
| `start_agent_session` | Begin tracking a work session |
| `update_agent_session` | Record progress mid-session |
| `end_agent_session` | Save decisions, files, open items |
| `get_session_history` | See what previous agents did |

### CLI

```bash
npm run briefing                    # See what agents see
npm run briefing -- --json          # Machine-readable output
npm run briefing -- --scope auth    # Scoped to a specific area
```

## Signal Pipeline

OpenRundown's briefings are powered by a signal pipeline that ingests, classifies, and compresses project data. You can use the pipeline tools directly or let the complete workflow handle everything:

```bash
sync_classify_and_export   # Runs the full pipeline end to end
```

### What the pipeline does

1. **Ingests** GitHub issues, Discord messages, and pull requests
2. **Computes embeddings** for semantic matching across all sources
3. **Groups** related issues (1 ticket per problem, not per report)
4. **Matches** Discord threads to the GitHub issues they're discussing
5. **Labels** issues (bug, security, regression, enhancement) using AI
6. **Maps** everything to product features extracted from your docs
7. **Prioritizes** by severity, community report count, and recency
8. **Exports** to Linear with rich descriptions and auto-assignment
9. **Syncs** status bidirectionally (PRs -> In Progress, merged -> Done)

### AI-Powered Fixes

OpenRundown can investigate issues, learn from your merged PRs, generate fixes, and open draft PRs:

```bash
fix_github_issue(issue_number: 1234)   # Investigate + generate fix + open PR
```

See [PR Fix Tool Documentation](docs/OPEN_PR_WITH_FIX_TOOL.md) for details.

## Architecture

```
src/
  briefing/        -- Distillation layer (the core: compresses signals into briefings)
  mcp/             -- MCP server (40+ tools exposed to agents)
  export/          -- Linear/Jira export and sync
  config/          -- Project auto-detection and configuration
  storage/         -- Prisma database layer

hooks/             -- Cursor lifecycle hooks (sessionEnd)
rules/             -- Cursor rules (session protocol)
skills/            -- Cursor skills (agent instructions)
agents/            -- Cursor agent definitions
scripts/           -- CLI tools (briefing, save-session, setup)
api/               -- Vercel serverless API endpoints
```

## How It Works Across Sessions

```
Session 1: Agent works on auth refactor
  -> end_agent_session records: "Split auth into middleware, 3 files edited, 
     open item: add tests for new middleware"

Session 2: New agent opens fresh chat
  -> get_agent_briefing returns the open item automatically
  -> Agent says: "I see the last session split auth into middleware 
     but tests weren't added yet. Want me to pick that up?"
```

No manual context passing. No copy-pasting. The memory just flows.

## Documentation

- [Environment Variables](docs/ENVIRONMENT_VARIABLES.md)
- [Database Setup](docs/DATABASE_SETUP.md)
- [GitHub Integration](docs/GITHUB_INTEGRATION.md)
- [Linear Team Setup](docs/LINEAR_TEAM_SETUP.md)
- [Vercel Deployment](docs/VERCEL_DEPLOYMENT.md)
- [PR Fix Tool](docs/OPEN_PR_WITH_FIX_TOOL.md)

## License

MIT
