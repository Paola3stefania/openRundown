/**
 * Per-project scoping for shared databases.
 *
 * OpenRundown is often run with a single Postgres database serving multiple
 * projects (different repos, same DB). Discord-derived data (`Group`,
 * `ClassifiedThread`, `UngroupedThread`) and X/Twitter posts are not keyed by
 * `projectId` in the schema, so without a scoping rule a briefing for project
 * A will surface signals from project B's ingest.
 *
 * This module reads an env-var-driven mapping that lets the operator say
 * "project X owns Discord guilds Y and Z" without a schema migration.
 *
 * Backward compatibility: when `PROJECT_DISCORD_GUILDS` is unset, the legacy
 * behavior (no filter) is preserved so single-project setups don't change.
 */

const ENV_KEY = "PROJECT_DISCORD_GUILDS";

let cachedRaw: string | undefined;
let cachedMap: Map<string, string[]> | undefined;

function loadMap(): Map<string, string[]> | undefined {
  const raw = process.env[ENV_KEY];
  if (!raw) {
    cachedRaw = undefined;
    cachedMap = undefined;
    return undefined;
  }

  if (raw === cachedRaw && cachedMap) return cachedMap;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error(`[projectScope] ${ENV_KEY} must be a JSON object mapping projectId -> string[].`);
      cachedRaw = raw;
      cachedMap = new Map();
      return cachedMap;
    }

    const map = new Map<string, string[]>();
    for (const [projectId, guilds] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(guilds)) {
        console.error(`[projectScope] ${ENV_KEY}["${projectId}"] is not an array; ignoring.`);
        continue;
      }
      const cleaned = guilds.filter((g): g is string => typeof g === "string" && g.trim().length > 0);
      map.set(projectId, cleaned);
    }
    cachedRaw = raw;
    cachedMap = map;
    return map;
  } catch (error) {
    console.error(`[projectScope] Failed to parse ${ENV_KEY}: ${(error as Error).message}`);
    cachedRaw = raw;
    cachedMap = new Map();
    return cachedMap;
  }
}

/**
 * Returns the Discord guild IDs that should scope a briefing for `projectId`.
 *
 * Return value semantics:
 *   - `undefined`     → no mapping configured anywhere; caller should not filter
 *                       (preserves single-project / pre-migration behavior).
 *   - `string[]` (>=0) → caller MUST filter Discord queries to those guilds.
 *                       An empty array means "this project owns no Discord
 *                       data; suppress Discord-derived signals entirely."
 */
export function getProjectDiscordGuilds(projectId: string): string[] | undefined {
  const map = loadMap();
  if (!map) return undefined;
  return map.get(projectId) ?? [];
}

/**
 * Test-only helper to reset the cache between cases that mutate `process.env`.
 */
export function __resetProjectScopeCacheForTests(): void {
  cachedRaw = undefined;
  cachedMap = undefined;
}
