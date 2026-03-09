import { saveMemory, searchMemory, getRecentMemories } from "../src/storage/db/memory.js";

async function main() {
  console.log("Saving test memory...");
  const entry = await saveMemory({
    content: "User wants to extend OpenRundown with semantic memory for Claude Code and Cursor. We added save_memory and search_memory MCP tools backed by PostgreSQL + OpenAI embeddings.",
    summary: "Extended OpenRundown with persistent semantic memory MCP tools.",
    tags: ["memory", "mcp", "openrundown"],
  });
  console.log("Saved:", JSON.stringify(entry, null, 2));

  console.log("\nSearching...");
  const results = await searchMemory({ query: "semantic memory Claude Code" });
  console.log(`Found ${results.length} result(s)`);
  results.forEach((r) => console.log(" -", r.summary, r.similarity ? `(${r.similarity.toFixed(3)})` : ""));

  console.log("\nRecent memories:");
  const recent = await getRecentMemories({ limit: 3 });
  recent.forEach((r) => console.log(" -", r.summary, `[${r.tags.join(", ")}]`));
}

main().catch(console.error).finally(() => process.exit(0));
