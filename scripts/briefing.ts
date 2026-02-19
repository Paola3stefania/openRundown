/**
 * Session Start: Generate and output a project briefing.
 *
 * This is the CLI companion to the MCP `get_agent_briefing` tool.
 * It can be run standalone to see what an agent would receive at session start.
 *
 * Usage:
 *   npx tsx scripts/briefing.ts [--scope <area>] [--since <ISO date>] [--json]
 */

import "dotenv/config";
import { distillBriefing } from "../src/briefing/distill.js";
import { getRecentSessions } from "../src/briefing/sessions.js";

async function main() {
  const args = process.argv.slice(2);
  const scope = getArg(args, "--scope");
  const since = getArg(args, "--since");
  const jsonOutput = args.includes("--json");

  const [briefing, sessions] = await Promise.all([
    distillBriefing({ scope: scope ?? undefined, since: since ?? undefined }),
    getRecentSessions(3),
  ]);

  const lastSession = sessions[0];
  const output = {
    briefing,
    lastSession: lastSession
      ? {
          sessionId: lastSession.sessionId,
          endedAt: lastSession.endedAt,
          scope: lastSession.scope,
          summary: lastSession.summary,
          openItems: lastSession.openItems,
        }
      : null,
  };

  if (jsonOutput) {
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  } else {
    console.log("=== openrundown Briefing ===\n");
    console.log(`Project: ${briefing.project}`);
    if (briefing.focus) console.log(`Focus: ${briefing.focus}`);
    console.log(`Updated: ${briefing.lastUpdated}\n`);

    if (briefing.decisions.length > 0) {
      console.log("--- Recent Decisions ---");
      for (const d of briefing.decisions) {
        console.log(`  [${d.status}] ${d.what}`);
        console.log(`    Why: ${d.why} (${d.when})`);
        if (d.openItems.length > 0) {
          console.log(`    Open: ${d.openItems.join(", ")}`);
        }
      }
      console.log();
    }

    if (briefing.activeIssues.length > 0) {
      console.log("--- Active Issues ---");
      for (const issue of briefing.activeIssues) {
        console.log(`  [${issue.priority.toUpperCase()}] ${issue.id}: ${issue.summary} (${issue.reports} reports)`);
      }
      console.log();
    }

    if (briefing.recentActivity) {
      const a = briefing.recentActivity;
      console.log(`--- Activity (${a.period}) ---`);
      console.log(`  Issues: ${a.issuesOpened} opened, ${a.issuesClosed} closed`);
      console.log(`  PRs: ${a.prsOpened} opened, ${a.prsMerged} merged`);
      console.log(`  Discord: ${a.discordThreads} threads\n`);
    }

    if (lastSession) {
      console.log("--- Last Session ---");
      console.log(`  Scope: ${lastSession.scope.join(", ")}`);
      if (lastSession.summary) console.log(`  Summary: ${lastSession.summary}`);
      if (lastSession.openItems.length > 0) {
        console.log("  Open Items:");
        for (const item of lastSession.openItems) {
          console.log(`    - ${item}`);
        }
      }
      console.log();
    }
  }

  process.exit(0);
}

function getArg(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return null;
}

main().catch((err) => {
  console.error("[ERROR] Failed to generate briefing:", err.message);
  process.exit(1);
});
