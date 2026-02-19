/**
 * Session End: Auto-close any open agent sessions.
 *
 * Called by the Cursor sessionEnd hook to ensure no sessions are left dangling.
 * If an agent properly called `end_agent_session` via MCP, this is a no-op.
 * If the agent forgot or the session was interrupted, this closes it gracefully.
 *
 * Usage:
 *   npx tsx scripts/save-session.ts
 */

import "dotenv/config";
import { prisma } from "../src/storage/db/prisma.js";
import { detectProjectId } from "../src/config/project.js";

const MAX_SESSION_AGE_HOURS = 24;

async function main() {
  const projectId = detectProjectId();

  const openSessions = await prisma.agentSession.findMany({
    where: {
      projectId,
      endedAt: null,
    },
    orderBy: { startedAt: "desc" },
  });

  if (openSessions.length === 0) {
    process.exit(0);
  }

  const now = new Date();
  let closedCount = 0;

  for (const session of openSessions) {
    const ageHours = (now.getTime() - session.startedAt.getTime()) / (1000 * 60 * 60);

    if (ageHours > MAX_SESSION_AGE_HOURS) {
      await prisma.agentSession.update({
        where: { id: session.id },
        data: {
          endedAt: now,
          summary: session.summary ?? "Session auto-closed (stale, exceeded 24h)",
          openItems: session.openItems.length > 0
            ? session.openItems
            : ["Session was not properly ended - review may be needed"],
        },
      });
      closedCount++;
      continue;
    }

    await prisma.agentSession.update({
      where: { id: session.id },
      data: {
        endedAt: now,
        summary: session.summary ?? "Session auto-closed by sessionEnd hook",
      },
    });
    closedCount++;
  }

  if (closedCount > 0) {
    console.log(`[openrundown] Auto-closed ${closedCount} open session(s)`);
  }

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("[openrundown] Failed to save session:", err.message);
  process.exit(0);
});
