# Linear ↔ GitHub Integration Contract

This document defines the contract between UNMute and Linear's native GitHub integration for PR linking and issue lifecycle management.

## Overview

UNMute creates Linear issues with proper structure, but relies on Linear's built-in GitHub integration to handle PR linking and auto-closing. This avoids duplicate work and ensures alignment with Linear's behavior.

## Linear Issue Structure

### Title
- Canonical, descriptive title summarizing the problem/request
- Generated from grouped discussions and GitHub issues

### Project
- Each Linear issue is linked to a Linear Project
- Projects represent product features (created from documentation extraction)
- Example: "OAuth Integration", "Database Migrations"

### Description Format

```markdown
## Problem Description
[Issue description from grouped discussions]

---

## Sources

**Discord:** [View discussion](discord-link)

**Related GitHub Issues (for context):**
- [#123 Issue Title](github-link)
- [#456 Another Issue](github-link)

**Additional Discord Discussions:**
- [Thread Name](discord-link)
```

**Important:** GitHub issue numbers are included for human context only. They do not enable Linear's PR auto-linking.

## PR → Linear Linking (Linear's Native Integration)

Linear links PRs to Linear issues based on **Linear issue IDs only** (e.g., `LIN-123`).

### Required PR Reference Format

To enable Linear's auto-linking, PRs must reference the Linear issue ID using one of these methods:

**Option 1: Branch Name (Recommended)**
```
lin-123-oauth-callback-ios
lin-456-fix-token-refresh
```

**Option 2: PR Title**
```
Fixes LIN-123: OAuth callback not working
Resolves LIN-123 - OAuth callback issue
```

**Option 3: PR Description**
```
Resolves LIN-123

or

Fixes LIN-123
```

### Multiple Issues
If one PR fixes multiple Linear issues:
```
Resolves LIN-123
Resolves LIN-456
```

Each ticket closes independently when the PR is merged.

## Auto-Close Behavior

Linear's integration automatically closes Linear issues when:
1. A PR is merged
2. The PR explicitly references the Linear issue ID (LIN-###)
3. Linear is configured to auto-close on PR merge

**Recommended Linear Settings:**
- Configure Linear so merged PR moves issue to "Released" (not permanently "Closed")
- This avoids "merged but not shipped" confusion
- Final "Closed" state when version is deployed/announced

## What UNMute Does

### Creates
1. Linear Projects (one per feature)
2. Linear Issues (one per problem/request)
3. Proper issue structure with sources and GitHub context
4. Mapping: `source_id → linear_issue_id` (for finding existing issues)

### Does Not Do
- PR merge detection
- Auto-closing issues (Linear handles this)
- Heuristic PR↔issue linking
- Similarity-based closure

## Engineer Workflow

1. **Create branch:** Use `lin-123-description` format
2. **Create PR:** Include `Resolves LIN-123` in PR description
3. **Merge PR:** Linear automatically links and transitions issue
4. **Deploy:** Manually move to "Closed" when shipped (optional)

## Mapping and Tracking

UNMute maintains an internal mapping:
```
source_id → linear_issue_id
```

This allows:
- Finding existing Linear issues when re-exporting
- Updating Linear issues when new related discussions appear
- Tracking export history

The mapping is stored in:
- Export result metadata
- Optional: External mapping file for persistence across exports

## Best Practices

1. **Always reference Linear issue ID in PRs** - This is the only way Linear can auto-link
2. **Use descriptive branch names** - `lin-123-short-description` format
3. **Include GitHub issue numbers in Linear description** - For human context and traceability
4. **Group related issues intelligently** - Use semantic similarity to avoid duplicates
5. **Let Linear own the lifecycle** - Don't build duplicate PR merge detection

## Linear Configuration Checklist

- [ ] Linear GitHub integration enabled
- [ ] Repository connected in Linear settings
- [ ] Auto-close on PR merge configured (recommended: "Released" state)
- [ ] Projects created for each feature (or use team default)
- [ ] Team ID configured in UNMute `.env` (`PM_TOOL_TEAM_ID`)

