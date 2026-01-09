/**
 * Code ownership analysis based on commit history
 * Analyzes commits to determine which engineers own which files/features
 */

import { PrismaClient } from "@prisma/client";
import { log } from "../mcp/logger.js";
import { getConfig } from "../config/index.js";
import { GitHubTokenManager } from "../connectors/github/tokenManager.js";

const prisma = new PrismaClient();

interface CommitFile {
  filename: string;
  additions: number;
  deletions: number;
  changes: number;
  status: "added" | "removed" | "modified" | "renamed";
  previous_filename?: string;
}

interface GitHubCommit {
  sha: string;
  commit: {
    author: {
      name: string;
      email: string;
      date: string;
    };
    committer: {
      name: string;
      email: string;
      date: string;
    };
    message: string;
  };
  author: {
    login: string;
    id: number;
  } | null;
  committer: {
    login: string;
    id: number;
  } | null;
  files: CommitFile[];
}

interface FileOwnership {
  filePath: string;
  engineer: string;
  linesAdded: number;
  linesDeleted: number;
  commitsCount: number;
  ownershipPercent: number;
  lastCommitSha: string;
  lastCommitDate: Date;
}

/**
 * Fetch commits for a repository
 */
async function fetchCommits(
  tokenManager: GitHubTokenManager,
  owner: string,
  repo: string,
  since?: string,
  perPage: number = 100
): Promise<GitHubCommit[]> {
  const commits: GitHubCommit[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    try {
      const token = await tokenManager.getCurrentToken();
      const url = new URL(`https://api.github.com/repos/${owner}/${repo}/commits`);
      url.searchParams.set("per_page", String(perPage));
      url.searchParams.set("page", String(page));
      if (since) {
        url.searchParams.set("since", since);
      }

      const response = await fetch(url.toString(), {
        headers: {
          Accept: "application/vnd.github.v3+json",
          Authorization: `Bearer ${token}`,
        },
      });

      tokenManager.updateRateLimitFromResponse(response, token);

      if (!response.ok) {
        if (response.status === 404) {
          log(`[CodeOwnership] Repository ${owner}/${repo} not found`);
          break;
        }
        if (response.status === 403 || response.status === 429) {
          log(`[CodeOwnership] Rate limited, waiting...`);
          await new Promise((resolve) => setTimeout(resolve, 60000)); // Wait 1 minute
          continue;
        }
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
      }

      const pageCommits = (await response.json()) as GitHubCommit[];
      
      if (pageCommits.length === 0) {
        hasMore = false;
      } else {
        // Fetch full commit details with file changes
        for (const commit of pageCommits) {
          try {
            const commitResponse = await fetch(
              `https://api.github.com/repos/${owner}/${repo}/commits/${commit.sha}`,
              {
                headers: {
                  Accept: "application/vnd.github.v3+json",
                  Authorization: `Bearer ${token}`,
                },
              }
            );

            tokenManager.updateRateLimitFromResponse(commitResponse, token);

            if (commitResponse.ok) {
              const fullCommit = (await commitResponse.json()) as GitHubCommit;
              commits.push(fullCommit);
            }
          } catch (error) {
            log(`[CodeOwnership] Failed to fetch commit ${commit.sha}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        page++;
        if (pageCommits.length < perPage) {
          hasMore = false;
        }
      }
    } catch (error) {
      log(`[CodeOwnership] Error fetching commits page ${page}: ${error instanceof Error ? error.message : String(error)}`);
      hasMore = false;
    }
  }

  return commits;
}

/**
 * Analyze commits and calculate file ownership
 */
function calculateFileOwnership(commits: GitHubCommit[]): Map<string, FileOwnership[]> {
  const ownershipMap = new Map<string, Map<string, FileOwnership>>();

  for (const commit of commits) {
    const engineer = commit.author?.login || commit.commit.author.email;
    if (!engineer) continue;

    const commitDate = new Date(commit.commit.author.date);

    for (const file of commit.files || []) {
      // Handle renamed files - count ownership for both old and new names
      const filePaths = [file.filename];
      if (file.status === "renamed" && file.previous_filename) {
        filePaths.push(file.previous_filename);
      }

      for (const filePath of filePaths) {
        if (!ownershipMap.has(filePath)) {
          ownershipMap.set(filePath, new Map());
        }

        const fileOwners = ownershipMap.get(filePath)!;
        
        if (!fileOwners.has(engineer)) {
          fileOwners.set(engineer, {
            filePath,
            engineer,
            linesAdded: 0,
            linesDeleted: 0,
            commitsCount: 0,
            ownershipPercent: 0, // Will be calculated later
            lastCommitSha: commit.sha,
            lastCommitDate: commitDate,
          });
        }

        const ownership = fileOwners.get(engineer)!;
        ownership.linesAdded += file.additions || 0;
        ownership.linesDeleted += file.deletions || 0;
        ownership.commitsCount += 1;
        
        // Update last commit if this is more recent
        if (commitDate > ownership.lastCommitDate) {
          ownership.lastCommitSha = commit.sha;
          ownership.lastCommitDate = commitDate;
        }
      }
    }
  }

  // Calculate percentages for each file
  const result = new Map<string, FileOwnership[]>();
  
  for (const [filePath, owners] of ownershipMap) {
    // Calculate total lines for this file
    let totalLines = 0;
    for (const owner of owners.values()) {
      totalLines += owner.linesAdded + owner.linesDeleted;
    }

    const ownershipList: FileOwnership[] = [];
    for (const owner of owners.values()) {
      const ownerLines = owner.linesAdded + owner.linesDeleted;
      const percent = totalLines > 0 ? (ownerLines / totalLines) * 100 : 0;
      
      ownershipList.push({
        ...owner,
        ownershipPercent: percent,
      });
    }

    // Sort by ownership percentage (descending)
    ownershipList.sort((a, b) => b.ownershipPercent - a.ownershipPercent);
    result.set(filePath, ownershipList);
  }

  return result;
}

/**
 * Analyze codebase and calculate ownership
 */
export async function analyzeCodeOwnership(
  force: boolean = false,
  since?: string // ISO date string, e.g., "2024-01-01T00:00:00Z"
): Promise<{ filesAnalyzed: number; engineersFound: number }> {
  try {
    const config = getConfig();
    const owner = config.github.owner;
    const repo = config.github.repo;

    if (!owner || !repo) {
      throw new Error("GITHUB_OWNER and GITHUB_REPO must be configured");
    }

    log(`[CodeOwnership] Starting code ownership analysis for ${owner}/${repo}...`);

    // Check if we already have recent analysis (unless force)
    if (!force) {
      const recentAnalysis = await (prisma as any).codeOwnership.findFirst({
        orderBy: { updatedAt: "desc" },
      });

      if (recentAnalysis && recentAnalysis.updatedAt > new Date(Date.now() - 24 * 60 * 60 * 1000)) {
        log(`[CodeOwnership] Recent analysis found (${recentAnalysis.updatedAt.toISOString()}), skipping. Use force=true to re-analyze.`);
        const fileCount = await (prisma as any).codeOwnership.groupBy({
          by: ["filePath"],
        });
        const engineerCount = await (prisma as any).codeOwnership.groupBy({
          by: ["engineer"],
        });
        return {
          filesAnalyzed: fileCount.length,
          engineersFound: engineerCount.length,
        };
      }
    }

    // Fetch commits
    const { GitHubTokenManager } = await import("../connectors/github/tokenManager.js");
    const tokenManager = await GitHubTokenManager.fromEnvironment();
    if (!tokenManager) {
      throw new Error("GITHUB_TOKEN is required");
    }

    log(`[CodeOwnership] Fetching commits${since ? ` since ${since}` : ""}...`);
    const commits = await fetchCommits(tokenManager, owner, repo, since);
    log(`[CodeOwnership] Fetched ${commits.length} commits`);

    if (commits.length === 0) {
      log(`[CodeOwnership] No commits found`);
      return { filesAnalyzed: 0, engineersFound: 0 };
    }

    // Calculate ownership
    log(`[CodeOwnership] Calculating file ownership...`);
    const ownershipMap = calculateFileOwnership(commits);

    // Save to database
    log(`[CodeOwnership] Saving ownership data to database...`);
    let filesSaved = 0;
    const engineers = new Set<string>();

    for (const [filePath, ownerships] of ownershipMap) {
      for (const ownership of ownerships) {
        engineers.add(ownership.engineer);

        await (prisma as any).codeOwnership.upsert({
          where: {
            filePath_engineer: {
              filePath,
              engineer: ownership.engineer,
            },
          },
          create: {
            filePath,
            engineer: ownership.engineer,
            linesAdded: ownership.linesAdded,
            linesDeleted: ownership.linesDeleted,
            commitsCount: ownership.commitsCount,
            ownershipPercent: ownership.ownershipPercent,
            lastCommitSha: ownership.lastCommitSha,
            lastCommitDate: ownership.lastCommitDate,
          },
          update: {
            linesAdded: ownership.linesAdded,
            linesDeleted: ownership.linesDeleted,
            commitsCount: ownership.commitsCount,
            ownershipPercent: ownership.ownershipPercent,
            lastCommitSha: ownership.lastCommitSha,
            lastCommitDate: ownership.lastCommitDate,
          },
        });
      }
      filesSaved++;
    }

    log(`[CodeOwnership] Analysis complete: ${filesSaved} files, ${engineers.size} engineers`);

    return {
      filesAnalyzed: filesSaved,
      engineersFound: engineers.size,
    };
  } catch (error) {
    log(`[CodeOwnership] Error analyzing code ownership: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/**
 * Calculate feature-level ownership from file ownership
 */
export async function calculateFeatureOwnership(): Promise<void> {
  try {
    log(`[CodeOwnership] Calculating feature-level ownership...`);

    // Get all features
    const features = await prisma.feature.findMany({
      include: {
        codeMappings: {
          include: {
            codeSection: {
              include: {
                codeFile: true,
              },
            },
          },
        },
      },
    });

    for (const feature of features) {
      // Get all files mapped to this feature
      const filePaths = new Set<string>();
      for (const mapping of feature.codeMappings) {
        filePaths.add(mapping.codeSection.codeFile.filePath);
      }

      if (filePaths.size === 0) {
        continue; // No code mapped to this feature
      }

      // Get ownership for all files in this feature
      const fileOwnerships = await (prisma as any).codeOwnership.findMany({
        where: {
          filePath: { in: Array.from(filePaths) },
        },
      });

      // Aggregate ownership by engineer
      const engineerOwnership = new Map<string, { lines: number; files: Set<string> }>();
      let totalLines = 0;

      for (const ownership of fileOwnerships) {
        const lines = ownership.linesAdded + ownership.linesDeleted;
        totalLines += lines;

        if (!engineerOwnership.has(ownership.engineer)) {
          engineerOwnership.set(ownership.engineer, {
            lines: 0,
            files: new Set(),
          });
        }

        const engineer = engineerOwnership.get(ownership.engineer)!;
        engineer.lines += lines;
        engineer.files.add(ownership.filePath);
      }

      // Calculate percentages and save
      for (const [engineer, data] of engineerOwnership) {
        const percent = totalLines > 0 ? (data.lines / totalLines) * 100 : 0;

        await (prisma as any).featureOwnership.upsert({
          where: {
            featureId_engineer: {
              featureId: feature.id,
              engineer,
            },
          },
          create: {
            featureId: feature.id,
            engineer,
            ownershipPercent: percent,
            filesCount: data.files.size,
            totalLines: data.lines,
          },
          update: {
            ownershipPercent: percent,
            filesCount: data.files.size,
            totalLines: data.lines,
            lastUpdated: new Date(),
          },
        });
      }
    }

    log(`[CodeOwnership] Feature ownership calculation complete`);
  } catch (error) {
    log(`[CodeOwnership] Error calculating feature ownership: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/**
 * Get recommended assignees for a feature (sorted by ownership percentage)
 */
export async function getRecommendedAssignees(
  featureId: string,
  limit: number = 5
): Promise<Array<{ engineer: string; ownershipPercent: number; filesCount: number }>> {
  const ownerships = await (prisma as any).featureOwnership.findMany({
    where: { featureId },
    orderBy: { ownershipPercent: "desc" },
    take: limit,
  });

  return ownerships.map((o: { engineer: string; ownershipPercent: number; filesCount: number }) => ({
    engineer: o.engineer,
    ownershipPercent: Number(o.ownershipPercent),
    filesCount: o.filesCount,
  }));
}

/**
 * Get recommended assignees for files (when feature mapping not available)
 */
export async function getRecommendedAssigneesForFiles(
  filePaths: string[],
  limit: number = 5
): Promise<Array<{ engineer: string; ownershipPercent: number; filesCount: number }>> {
  // Aggregate ownership across all files
  const ownerships = await (prisma as any).codeOwnership.findMany({
    where: { filePath: { in: filePaths } },
  });

  const engineerMap = new Map<string, { lines: number; files: Set<string> }>();
  let totalLines = 0;

  for (const ownership of ownerships) {
    const lines = ownership.linesAdded + ownership.linesDeleted;
    totalLines += lines;

    if (!engineerMap.has(ownership.engineer)) {
      engineerMap.set(ownership.engineer, {
        lines: 0,
        files: new Set(),
      });
    }

    const engineer = engineerMap.get(ownership.engineer)!;
    engineer.lines += lines;
    engineer.files.add(ownership.filePath);
  }

  // Calculate percentages and sort
  const results = Array.from(engineerMap.entries())
    .map(([engineer, data]) => ({
      engineer,
      ownershipPercent: totalLines > 0 ? (data.lines / totalLines) * 100 : 0,
      filesCount: data.files.size,
    }))
    .sort((a, b) => b.ownershipPercent - a.ownershipPercent)
    .slice(0, limit);

  return results;
}

/**
 * Get all features with ownership percentages for each engineer
 * Returns a table-like structure showing feature -> engineer -> percentage
 */
export async function getAllFeatureOwnership(): Promise<Array<{
  featureId: string;
  featureName: string;
  engineers: Array<{
    engineer: string;
    ownershipPercent: number;
    filesCount: number;
    totalLines: number;
  }>;
}>> {
  const features = await prisma.feature.findMany({
    orderBy: { name: "asc" },
  });

  // Get ownership for each feature
  const result = [];
  for (const feature of features) {
    const ownerships = await (prisma as any).featureOwnership.findMany({
      where: { featureId: feature.id },
      orderBy: { ownershipPercent: "desc" },
    });

    result.push({
      featureId: feature.id,
      featureName: feature.name,
      engineers: ownerships.map((o: { engineer: string; ownershipPercent: number; filesCount: number; totalLines: number }) => ({
        engineer: o.engineer,
        ownershipPercent: Number(o.ownershipPercent),
        filesCount: o.filesCount,
        totalLines: o.totalLines,
      })),
    });
  }

  return result;
}

/**
 * Format feature ownership as a markdown table
 */
export async function formatFeatureOwnershipTable(): Promise<string> {
  const data = await getAllFeatureOwnership();
  
  if (data.length === 0) {
    return "No feature ownership data available. Run `analyze_code_ownership` first.";
  }

  const lines: string[] = [];
  lines.push("# Feature Ownership Table");
  lines.push("");
  lines.push("This table shows the percentage of code owned by each engineer for each feature.");
  lines.push("");

  for (const feature of data) {
    if (feature.engineers.length === 0) {
      continue; // Skip features with no ownership data
    }

    lines.push(`## ${feature.featureName}`);
    lines.push("");
    lines.push("| Engineer | Ownership % | Files | Total Lines |");
    lines.push("|---------|------------|-------|-------------|");

    for (const engineer of feature.engineers) {
      const percent = engineer.ownershipPercent.toFixed(1);
      lines.push(`| @${engineer.engineer} | ${percent}% | ${engineer.filesCount} | ${engineer.totalLines} |`);
    }

    lines.push("");
  }

  return lines.join("\n");
}
