/**
 * Code ownership analysis based on git blame
 * Analyzes local codebase to determine which engineers own which files/features
 * Uses git blame for accurate line-by-line ownership - NO API calls needed
 */

import { PrismaClient } from "@prisma/client";
import { log } from "../mcp/logger.js";
import { exec } from "child_process";
import { promisify } from "util";
import { readdir, stat } from "fs/promises";
import { join } from "path";

const execAsync = promisify(exec);
const prisma = new PrismaClient();

// Directories to skip during analysis
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".output",
  "vendor",
]);

// File extensions to analyze
const ALLOWED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".css",
  ".scss",
  ".html",
  ".vue",
  ".svelte",
]);

interface BlameResult {
  engineer: string;      // GitHub username or email prefix (for matching)
  engineerEmail: string; // Full email address
  engineerName: string;  // Display name from git
  linesOwned: number;
}

/**
 * Get all files in a directory recursively
 */
async function getAllFiles(dir: string, baseDir: string): Promise<string[]> {
  const files: string[] = [];
  
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relativePath = fullPath.replace(baseDir + "/", "");
      
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          const subFiles = await getAllFiles(fullPath, baseDir);
          files.push(...subFiles);
        }
      } else if (entry.isFile()) {
        const ext = "." + entry.name.split(".").pop()?.toLowerCase();
        if (ALLOWED_EXTENSIONS.has(ext)) {
          files.push(relativePath);
        }
      }
    }
  } catch (error) {
    log(`[CodeOwnership] Error reading directory ${dir}: ${error instanceof Error ? error.message : String(error)}`);
  }
  
  return files;
}

/**
 * Run git blame on a file and parse the results
 */
async function getFileBlame(repoPath: string, filePath: string): Promise<Map<string, BlameResult>> {
  const ownershipMap = new Map<string, BlameResult>();
  
  try {
    // Use git blame with porcelain format for easier parsing
    // -e shows email, -w ignores whitespace
    const { stdout } = await execAsync(
      `git blame --line-porcelain -e "${filePath}"`,
      { 
        cwd: repoPath,
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large files
      }
    );
    
    // Parse porcelain output
    const lines = stdout.split("\n");
    let currentAuthorName = "";
    let currentAuthorEmail = "";
    
    for (const line of lines) {
      if (line.startsWith("author ")) {
        // Capture author name
        currentAuthorName = line.replace("author ", "").trim();
      } else if (line.startsWith("author-mail ")) {
        // Capture author email
        const match = line.match(/author-mail <(.+)>/);
        if (match) {
          currentAuthorEmail = match[1];
        }
      } else if (line.startsWith("\t")) {
        // This is a code line - count it for the current author
        if (currentAuthorName || currentAuthorEmail) {
          // Extract GitHub username from email, fallback to name
          const engineer = extractGitHubUsername(currentAuthorEmail, currentAuthorName);
          
          if (!ownershipMap.has(engineer)) {
            ownershipMap.set(engineer, {
              engineer,
              engineerEmail: currentAuthorEmail,
              engineerName: currentAuthorName,
              linesOwned: 0,
            });
          }
          ownershipMap.get(engineer)!.linesOwned++;
        }
        // Reset for next block
        currentAuthorName = "";
        currentAuthorEmail = "";
      }
    }
  } catch (error) {
    // File might be new (not committed) or binary
    // This is expected for some files, don't log as error
  }
  
  return ownershipMap;
}

/**
 * Extract GitHub username from email or author info
 * For GitHub noreply emails: 145994855+bekacru@users.noreply.github.com -> bekacru
 * For regular emails: user@domain.com -> user
 */
function extractGitHubUsername(email: string, authorName: string): string {
  // GitHub noreply format: 145994855+username@users.noreply.github.com
  if (email.includes("@users.noreply.github.com")) {
    const localPart = email.split("@")[0];
    // Extract username after the + sign
    if (localPart.includes("+")) {
      const username = localPart.split("+")[1];
      if (username && username.length > 0) {
        return username.toLowerCase();
      }
    }
    // Old format without numeric prefix: username@users.noreply.github.com
    if (!/^\d+$/.test(localPart)) {
      return localPart.toLowerCase();
    }
    // Pure numeric noreply (old format) - use author name instead
    if (/^\d+$/.test(localPart) && authorName && authorName.trim()) {
      return authorName.toLowerCase().replace(/\s+/g, "-");
    }
  }
  
  // For regular emails, use the part before @ (unless it's purely numeric)
  if (email.includes("@")) {
    const username = email.split("@")[0];
    // If username is purely numeric and we have an author name, use the name
    if (/^\d+$/.test(username) && authorName && authorName.trim()) {
      return authorName.toLowerCase().replace(/\s+/g, "-");
    }
    return username.toLowerCase();
  }
  
  // Fallback to author name (convert spaces to hyphens for GitHub-like format)
  return authorName.toLowerCase().replace(/\s+/g, "-");
}

/**
 * Analyze codebase using git blame - NO API calls needed
 */
export async function analyzeCodeOwnership(
  force: boolean = false,
  _since?: string // Ignored for git blame approach
): Promise<{ filesAnalyzed: number; engineersFound: number }> {
  try {
    const repoPath = process.env.LOCAL_REPO_PATH || process.cwd();
    
    log(`[CodeOwnership] Starting git blame analysis on ${repoPath}...`);

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

    // Get all files to analyze
    log(`[CodeOwnership] Scanning files in ${repoPath}...`);
    const files = await getAllFiles(repoPath, repoPath);
    log(`[CodeOwnership] Found ${files.length} files to analyze`);

    if (files.length === 0) {
      log(`[CodeOwnership] No files found to analyze`);
      return { filesAnalyzed: 0, engineersFound: 0 };
    }

    // Analyze each file with git blame
    const allOwnerships: Array<{
      filePath: string;
      engineer: string;
      engineerEmail: string;
      engineerName: string;
      linesOwned: number;
      ownershipPercent: number;
    }> = [];
    const engineers = new Set<string>();
    let processedFiles = 0;

    for (const filePath of files) {
      const blameResult = await getFileBlame(repoPath, filePath);
      
      if (blameResult.size > 0) {
        // Calculate total lines for this file
        let totalLines = 0;
        for (const result of blameResult.values()) {
          totalLines += result.linesOwned;
        }

        // Add ownership records
        for (const [engineer, result] of blameResult) {
          engineers.add(engineer);
          const percent = totalLines > 0 ? (result.linesOwned / totalLines) * 100 : 0;
          
          allOwnerships.push({
            filePath,
            engineer,
            engineerEmail: result.engineerEmail,
            engineerName: result.engineerName,
            linesOwned: result.linesOwned,
            ownershipPercent: percent,
          });
        }
      }

      processedFiles++;
      if (processedFiles % 50 === 0) {
        log(`[CodeOwnership] Analyzed ${processedFiles}/${files.length} files...`);
      }
    }

    log(`[CodeOwnership] Finished analyzing ${processedFiles} files, found ${allOwnerships.length} ownership records`);

    // Save to database in batches
    log(`[CodeOwnership] Saving ${allOwnerships.length} ownership records to database...`);
    
    const BATCH_SIZE = 100;
    let savedCount = 0;
    
    for (let i = 0; i < allOwnerships.length; i += BATCH_SIZE) {
      const batch = allOwnerships.slice(i, i + BATCH_SIZE);
      
      await prisma.$transaction(
        batch.map(ownership => 
          (prisma as any).codeOwnership.upsert({
            where: {
              filePath_engineer: {
                filePath: ownership.filePath,
                engineer: ownership.engineer,
              },
            },
            create: {
              filePath: ownership.filePath,
              engineer: ownership.engineer,
              engineerEmail: ownership.engineerEmail,
              engineerName: ownership.engineerName,
              linesAdded: ownership.linesOwned,
              linesDeleted: 0,
              commitsCount: 1,
              ownershipPercent: ownership.ownershipPercent,
            },
            update: {
              linesAdded: ownership.linesOwned,
              engineerEmail: ownership.engineerEmail,
              engineerName: ownership.engineerName,
              ownershipPercent: ownership.ownershipPercent,
            },
          })
        )
      );
      
      savedCount += batch.length;
      if (savedCount % 500 === 0 || savedCount === allOwnerships.length) {
        log(`[CodeOwnership] Saved ${savedCount}/${allOwnerships.length} records`);
      }
    }

    log(`[CodeOwnership] Analysis complete: ${processedFiles} files, ${engineers.size} engineers`);

    return {
      filesAnalyzed: processedFiles,
      engineersFound: engineers.size,
    };
  } catch (error) {
    log(`[CodeOwnership] Error analyzing code ownership: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/**
 * Calculate feature-level ownership from file ownership
 * Uses file path pattern matching based on feature names and keywords
 */
export async function calculateFeatureOwnership(): Promise<void> {
  try {
    log(`[CodeOwnership] Calculating feature-level ownership...`);

    // Get all features with their keywords
    const features = await prisma.feature.findMany({
      select: {
        id: true,
        name: true,
        relatedKeywords: true,
      },
    });

    // Get all file ownership data
    const allFileOwnerships = await (prisma as any).codeOwnership.findMany();
    
    if (allFileOwnerships.length === 0) {
      log(`[CodeOwnership] No file ownership data found. Run analyzeCodeOwnership first.`);
      return;
    }
    
    log(`[CodeOwnership] Found ${allFileOwnerships.length} file ownership records to map to ${features.length} features`);

    for (const feature of features) {
      // Build search patterns from feature name and keywords
      const patterns: string[] = [];
      
      // Feature name variations
      const featureName = feature.name.toLowerCase();
      patterns.push(featureName);
      patterns.push(featureName.replace(/\s+/g, "-")); // "two factor" -> "two-factor"
      patterns.push(featureName.replace(/\s+/g, "_")); // "two factor" -> "two_factor"
      patterns.push(featureName.replace(/\s+/g, "")); // "two factor" -> "twofactor"
      
      // Add related keywords
      for (const keyword of feature.relatedKeywords || []) {
        const kw = keyword.toLowerCase();
        patterns.push(kw);
        patterns.push(kw.replace(/\s+/g, "-"));
        patterns.push(kw.replace(/\s+/g, "_"));
      }
      
      // Remove duplicates
      const uniquePatterns = [...new Set(patterns)];
      
      // Find files matching this feature's patterns
      const matchingOwnerships = allFileOwnerships.filter((ownership: { filePath: string }) => {
        const filePathLower = ownership.filePath.toLowerCase();
        return uniquePatterns.some(pattern => 
          filePathLower.includes(pattern) || 
          filePathLower.includes(`/${pattern}/`) ||
          filePathLower.includes(`/${pattern}.`) ||
          filePathLower.includes(`-${pattern}`) ||
          filePathLower.includes(`_${pattern}`)
        );
      });

      if (matchingOwnerships.length === 0) {
        continue; // No files match this feature
      }
      
      log(`[CodeOwnership] Feature "${feature.name}": Found ${matchingOwnerships.length} matching file ownership records`);

      // Aggregate ownership by engineer
      const engineerOwnership = new Map<string, { lines: number; files: Set<string>; email: string; name: string }>();
      let totalLines = 0;

      for (const ownership of matchingOwnerships) {
        const lines = ownership.linesAdded || 0;
        totalLines += lines;

        if (!engineerOwnership.has(ownership.engineer)) {
          engineerOwnership.set(ownership.engineer, {
            lines: 0,
            files: new Set(),
            email: ownership.engineerEmail || "",
            name: ownership.engineerName || "",
          });
        }

        const engineer = engineerOwnership.get(ownership.engineer)!;
        engineer.lines += lines;
        engineer.files.add(ownership.filePath);
        // Update email/name if not set (use first non-empty value found)
        if (!engineer.email && ownership.engineerEmail) {
          engineer.email = ownership.engineerEmail;
        }
        if (!engineer.name && ownership.engineerName) {
          engineer.name = ownership.engineerName;
        }
      }

      // Calculate percentages and collect for batch save
      const featureOwnershipRecords: Array<{
        featureId: string;
        engineer: string;
        engineerEmail: string;
        engineerName: string;
        percent: number;
        filesCount: number;
        totalLinesCount: number;
      }> = [];
      
      for (const [engineer, data] of engineerOwnership) {
        const percent = totalLines > 0 ? (data.lines / totalLines) * 100 : 0;
        featureOwnershipRecords.push({
          featureId: feature.id,
          engineer,
          engineerEmail: data.email,
          engineerName: data.name,
          percent,
          filesCount: data.files.size,
          totalLinesCount: data.lines,
        });
      }
      
      // Batch upsert for this feature
      if (featureOwnershipRecords.length > 0) {
        await prisma.$transaction(
          featureOwnershipRecords.map(record => 
            (prisma as any).featureOwnership.upsert({
              where: {
                featureId_engineer: {
                  featureId: record.featureId,
                  engineer: record.engineer,
                },
              },
              create: {
                featureId: record.featureId,
                engineer: record.engineer,
                engineerEmail: record.engineerEmail,
                engineerName: record.engineerName,
                ownershipPercent: record.percent,
                filesCount: record.filesCount,
                totalLines: record.totalLinesCount,
              },
              update: {
                ownershipPercent: record.percent,
                engineerEmail: record.engineerEmail,
                engineerName: record.engineerName,
                filesCount: record.filesCount,
                totalLines: record.totalLinesCount,
                lastUpdated: new Date(),
              },
            })
          )
        );
      }
    }

    log(`[CodeOwnership] Feature ownership calculation complete for ${features.length} features`);
    
    // Also calculate ownership for Linear projects (linear-project-* IDs)
    // These are stored in affectsFeatures JSON in groups and issues
    log(`[CodeOwnership] Calculating ownership for Linear projects...`);
    
    // Extract unique linear-project entries from groups and issues
    const linearProjects = new Map<string, string>(); // id -> name
    
    const groups = await prisma.group.findMany({
      select: { affectsFeatures: true },
    });
    
    const issues = await prisma.gitHubIssue.findMany({
      select: { affectsFeatures: true },
    });
    
    for (const g of groups) {
      const features = g.affectsFeatures as Array<{ id: string; name: string }> | null;
      for (const f of features || []) {
        if (f.id?.startsWith('linear-project-')) {
          linearProjects.set(f.id, f.name);
        }
      }
    }
    
    for (const i of issues) {
      const features = i.affectsFeatures as Array<{ id: string; name: string }> | null;
      for (const f of features || []) {
        if (f.id?.startsWith('linear-project-')) {
          linearProjects.set(f.id, f.name);
        }
      }
    }
    
    log(`[CodeOwnership] Found ${linearProjects.size} unique Linear projects`);
    
    for (const [projectId, projectName] of linearProjects) {
      // Build search patterns from project name
      const patterns: string[] = [];
      const nameLower = projectName.toLowerCase();
      patterns.push(nameLower);
      patterns.push(nameLower.replace(/\s+/g, "-"));
      patterns.push(nameLower.replace(/\s+/g, "_"));
      patterns.push(nameLower.replace(/\s+/g, ""));
      
      // Add common variations
      const words = nameLower.split(/\s+/);
      for (const word of words) {
        if (word.length > 3) {
          patterns.push(word);
        }
      }
      
      const uniquePatterns = [...new Set(patterns)];
      
      // Find matching files
      const matchingOwnerships = allFileOwnerships.filter((ownership: { filePath: string }) => {
        const filePathLower = ownership.filePath.toLowerCase();
        return uniquePatterns.some(pattern => 
          filePathLower.includes(pattern) || 
          filePathLower.includes(`/${pattern}/`) ||
          filePathLower.includes(`/${pattern}.`) ||
          filePathLower.includes(`-${pattern}`) ||
          filePathLower.includes(`_${pattern}`)
        );
      });
      
      if (matchingOwnerships.length === 0) {
        continue;
      }
      
      log(`[CodeOwnership] Linear project "${projectName}": Found ${matchingOwnerships.length} matching file ownership records`);
      
      // Aggregate ownership by engineer
      const engineerOwnership = new Map<string, { lines: number; files: Set<string>; email: string; name: string }>();
      let totalLines = 0;
      
      for (const ownership of matchingOwnerships) {
        const lines = ownership.linesAdded || 0;
        totalLines += lines;
        
        if (!engineerOwnership.has(ownership.engineer)) {
          engineerOwnership.set(ownership.engineer, {
            lines: 0,
            files: new Set(),
            email: ownership.engineerEmail || "",
            name: ownership.engineerName || "",
          });
        }
        
        const engineer = engineerOwnership.get(ownership.engineer)!;
        engineer.lines += lines;
        engineer.files.add(ownership.filePath);
        if (!engineer.email && ownership.engineerEmail) {
          engineer.email = ownership.engineerEmail;
        }
        if (!engineer.name && ownership.engineerName) {
          engineer.name = ownership.engineerName;
        }
      }
      
      // Save ownership records for this Linear project
      const projectOwnershipRecords: Array<{
        featureId: string;
        engineer: string;
        engineerEmail: string;
        engineerName: string;
        percent: number;
        filesCount: number;
        totalLinesCount: number;
      }> = [];
      
      for (const [engineer, data] of engineerOwnership) {
        const percent = totalLines > 0 ? (data.lines / totalLines) * 100 : 0;
        projectOwnershipRecords.push({
          featureId: projectId, // Use linear-project-* ID
          engineer,
          engineerEmail: data.email,
          engineerName: data.name,
          percent,
          filesCount: data.files.size,
          totalLinesCount: data.lines,
        });
      }
      
      if (projectOwnershipRecords.length > 0) {
        await prisma.$transaction(
          projectOwnershipRecords.map(record => 
            (prisma as any).featureOwnership.upsert({
              where: {
                featureId_engineer: {
                  featureId: record.featureId,
                  engineer: record.engineer,
                },
              },
              create: {
                featureId: record.featureId,
                engineer: record.engineer,
                engineerEmail: record.engineerEmail,
                engineerName: record.engineerName,
                ownershipPercent: record.percent,
                filesCount: record.filesCount,
                totalLines: record.totalLinesCount,
              },
              update: {
                ownershipPercent: record.percent,
                engineerEmail: record.engineerEmail,
                engineerName: record.engineerName,
                filesCount: record.filesCount,
                totalLines: record.totalLinesCount,
                lastUpdated: new Date(),
              },
            })
          )
        );
      }
    }
    
    log(`[CodeOwnership] Linear project ownership calculation complete for ${linearProjects.size} projects`);
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
): Promise<Array<{ engineer: string; engineerEmail?: string; engineerName?: string; ownershipPercent: number; filesCount: number }>> {
  try {
    const ownerships = await (prisma as any).featureOwnership.findMany({
      where: { featureId },
      orderBy: { ownershipPercent: "desc" },
      take: limit,
    });

    return ownerships.map((o: { engineer: string; engineerEmail?: string; engineerName?: string; ownershipPercent: { toNumber?: () => number } | number; filesCount: number }) => ({
      engineer: o.engineer,
      engineerEmail: o.engineerEmail || undefined,
      engineerName: o.engineerName || undefined,
      ownershipPercent: typeof o.ownershipPercent === 'object' && o.ownershipPercent.toNumber 
        ? o.ownershipPercent.toNumber() 
        : Number(o.ownershipPercent),
      filesCount: o.filesCount,
    }));
  } catch (error) {
    log(`[CodeOwnership] Error getting recommended assignees for feature ${featureId}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/**
 * Get recommended assignees based on files (for issues without a feature mapping)
 */
export async function getRecommendedAssigneesForFiles(
  filePaths: string[],
  limit: number = 5
): Promise<Array<{ engineer: string; ownershipPercent: number; filesCount: number }>> {
  try {
    if (filePaths.length === 0) {
      return [];
    }

    // Get ownership for all specified files
    const ownerships = await (prisma as any).codeOwnership.findMany({
      where: {
        filePath: { in: filePaths },
      },
    });

    if (ownerships.length === 0) {
      return [];
    }

    // Aggregate by engineer
    const engineerStats = new Map<string, { lines: number; files: Set<string> }>();
    let totalLines = 0;

    for (const ownership of ownerships) {
      const lines = ownership.linesAdded || 0;
      totalLines += lines;

      if (!engineerStats.has(ownership.engineer)) {
        engineerStats.set(ownership.engineer, { lines: 0, files: new Set() });
      }

      const stats = engineerStats.get(ownership.engineer)!;
      stats.lines += lines;
      stats.files.add(ownership.filePath);
    }

    // Calculate percentages and sort
    const results = Array.from(engineerStats.entries())
      .map(([engineer, stats]) => ({
        engineer,
        ownershipPercent: totalLines > 0 ? (stats.lines / totalLines) * 100 : 0,
        filesCount: stats.files.size,
      }))
      .sort((a, b) => b.ownershipPercent - a.ownershipPercent)
      .slice(0, limit);

    return results;
  } catch (error) {
    log(`[CodeOwnership] Error getting recommended assignees for files: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/**
 * Get all feature ownership data for viewing
 */
export async function getAllFeatureOwnership(): Promise<Array<{
  featureId: string;
  featureName: string;
  engineers: Array<{ engineer: string; engineerName?: string; engineerEmail?: string; ownershipPercent: number; filesCount: number; totalLines: number }>;
}>> {
  try {
    const features = await prisma.feature.findMany({
      select: { id: true, name: true },
    });

    const result: Array<{
      featureId: string;
      featureName: string;
      engineers: Array<{ engineer: string; engineerName?: string; engineerEmail?: string; ownershipPercent: number; filesCount: number; totalLines: number }>;
    }> = [];

    for (const feature of features) {
      const ownerships = await (prisma as any).featureOwnership.findMany({
        where: { featureId: feature.id },
        orderBy: { ownershipPercent: "desc" },
        take: 10,
      });

      if (ownerships.length > 0) {
        result.push({
          featureId: feature.id,
          featureName: feature.name,
          engineers: ownerships.map((o: { engineer: string; engineerName?: string; engineerEmail?: string; ownershipPercent: { toNumber?: () => number } | number; filesCount: number; totalLines: number }) => ({
            engineer: o.engineer,
            engineerName: o.engineerName || undefined,
            engineerEmail: o.engineerEmail || undefined,
            ownershipPercent: typeof o.ownershipPercent === 'object' && o.ownershipPercent.toNumber
              ? o.ownershipPercent.toNumber()
              : Number(o.ownershipPercent),
            filesCount: o.filesCount,
            totalLines: o.totalLines,
          })),
        });
      }
    }

    return result;
  } catch (error) {
    log(`[CodeOwnership] Error getting all feature ownership: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/**
 * Format feature ownership as a markdown table
 */
export async function formatFeatureOwnershipTable(): Promise<string> {
  const data = await getAllFeatureOwnership();

  if (data.length === 0) {
    return "No feature ownership data found. Run `analyze_code_ownership` first.";
  }

  const lines: string[] = [];
  lines.push("# Feature Ownership Report\n");

  for (const feature of data) {
    lines.push(`## ${feature.featureName}`);
    lines.push("");
    lines.push("| Name | Email | Ownership % | Files | Lines |");
    lines.push("|------|-------|-------------|-------|-------|");
    
    for (const eng of feature.engineers) {
      const displayName = eng.engineerName || eng.engineer;
      const email = eng.engineerEmail || "-";
      lines.push(`| ${displayName} | ${email} | ${eng.ownershipPercent.toFixed(1)}% | ${eng.filesCount} | ${eng.totalLines} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
