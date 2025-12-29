/**
 * Fetch code files from local repository filesystem
 * Used when LOCAL_REPO_PATH is configured - provides faster, more accurate code indexing
 */

import { readdir, readFile, stat } from "fs/promises";
import { join, extname, relative, resolve } from "path";
import { log } from "../../mcp/logger.js";

/**
 * Fetch code context from local repository
 * Uses semantic search with LLM embeddings to find relevant code files
 */
export async function fetchLocalCodeContext(
  localRepoPath: string,
  searchQuery: string,
  maxFiles: number | null = null // null = return all files (will be processed in chunks)
): Promise<string> {
  try {
    // Resolve path (handles both absolute and relative paths)
    // If relative, resolves from current working directory
    const resolvedPath = resolve(localRepoPath);
    
    // Verify the path exists and is a directory
    const stats = await stat(resolvedPath).catch(() => null);
    if (!stats || !stats.isDirectory()) {
      log(`[LocalCodeFetcher] Local repo path does not exist or is not a directory: ${resolvedPath} (resolved from: ${localRepoPath})`);
      return "";
    }

    log(`[LocalCodeFetcher] Using semantic search to find code matching "${searchQuery}"...`);
    log(`[LocalCodeFetcher] Scanning repository at: ${resolvedPath}`);

    // Collect all code files from source directories (no keyword filtering)
    // Find all files first, then limit processing to maxFiles
    const scannedDirs = new Set<string>();
    // Use a high limit for discovery (10000) to find all files, but we'll limit processing later
    // If maxFiles is null, discover all files (up to 10000 safety limit)
    const discoveryLimit = maxFiles === null ? 10000 : Math.max(maxFiles * 10, 10000);
    const allCodeFiles = await findAllCodeFiles(resolvedPath, "", [], discoveryLimit, scannedDirs);
    log(`[LocalCodeFetcher] Found ${allCodeFiles.length} code files in repository`);
    
    // Log scanned directories summary
    if (scannedDirs.size > 0) {
      const dirList = Array.from(scannedDirs).slice(0, 30).join(", ");
      log(`[LocalCodeFetcher] Scanned ${scannedDirs.size} directories: ${dirList}${scannedDirs.size > 30 ? "..." : ""}`);
    }
    
    // Log sample of file paths to verify scanning
    if (allCodeFiles.length > 0) {
      const samplePaths = allCodeFiles.slice(0, 10).map(f => relative(resolvedPath, f));
      log(`[LocalCodeFetcher] Sample file paths found: ${samplePaths.join(", ")}${allCodeFiles.length > 10 ? "..." : ""}`);
    }

    if (allCodeFiles.length === 0) {
      log(`[LocalCodeFetcher] No code files found in repository`);
      return "";
    }

    // Use semantic search to rank files by relevance
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      log(`[LocalCodeFetcher] OPENAI_API_KEY not set, falling back to keyword matching`);
      // Fallback to keyword matching if no API key
      const codeFiles = await findCodeFiles(resolvedPath, searchQuery, maxFiles || 100);
      return await readAndFormatFiles(codeFiles, resolvedPath);
    }

    // Compute embedding for search query
    const { createEmbedding } = await import("../../core/classify/semantic.js");
    log(`[LocalCodeFetcher] Computing embedding for search query...`);
    const queryEmbedding = await createEmbedding(searchQuery, apiKey);
    
    // Check database for existing file embeddings to reuse
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();
    const { getCodeFileEmbedding } = await import("../../storage/db/embeddings.js");
    const { createHash } = await import("crypto");
    
    // Limit embedding computation for ranking
    // If maxFiles is null, rank up to 5000 files (process entire repo in chunks)
    // Otherwise, rank maxFiles * 5 or 500, whichever is larger
    const maxFilesForRanking = maxFiles === null 
      ? Math.min(5000, allCodeFiles.length) // Rank up to 5000 files for full repo processing
      : Math.max(maxFiles * 5, 500);
    const filesToRank = allCodeFiles.slice(0, Math.min(allCodeFiles.length, maxFilesForRanking));
    
    if (maxFiles === null) {
      log(`[LocalCodeFetcher] Found ${allCodeFiles.length} total files, will compute embeddings for ${filesToRank.length} files for ranking (processing entire repository in chunks)...`);
    } else {
      log(`[LocalCodeFetcher] Found ${allCodeFiles.length} total files, will compute embeddings for ${filesToRank.length} files for ranking (then select top ${maxFiles})...`);
    }
    log(`[LocalCodeFetcher] Checking database for existing file embeddings to reuse...`);
    
    // Read files and compute similarities
    // Process limited set of files for similarity ranking, then limit to top maxFiles
    const fileSimilarities: Array<{ filePath: string; relativePath: string; similarity: number; content: string }> = [];
    
    let reusedEmbeddings = 0;
    let computedEmbeddings = 0;
    
    for (let i = 0; i < filesToRank.length; i++) {
      const filePath = filesToRank[i];
      try {
        const content = await readFile(filePath, "utf-8");
        const relativePath = relative(resolvedPath, filePath);
        const keyInfo = extractKeyCodeInfo(content, relativePath);
        
        if (keyInfo) {
          // Try to find existing file embedding in database
          // Look for any code file with this path and matching content hash (from any search)
          const contentHash = createHash("md5").update(content).digest("hex");
          const existingCodeFile = await prisma.codeFile.findFirst({
            where: {
              filePath: relativePath,
              contentHash: contentHash,
            },
            include: {
              embeddings: true,
            },
          });
          
          let fileEmbedding: number[] | null = null;
          
          if (existingCodeFile?.embeddings) {
            // Reuse existing embedding from database
            // The embedding is stored as JSON in the database, convert it
            const savedEmbedding = existingCodeFile.embeddings.embedding;
            if (savedEmbedding && Array.isArray(savedEmbedding)) {
              fileEmbedding = savedEmbedding as number[];
              reusedEmbeddings++;
            }
          }
          
          if (!fileEmbedding) {
            // Need to compute new embedding
            // Use full file content for consistency with database embeddings
            // This ensures embeddings are comparable across searches
            const fileText = `File: ${relativePath}\n${content}`;
            fileEmbedding = await createEmbedding(fileText, apiKey);
            computedEmbeddings++;
          }
          
          // Compute cosine similarity (semantic similarity from LLM embeddings)
          const semanticSimilarity = computeCosineSimilarity(queryEmbedding, fileEmbedding);
          
          // Compute keyword-based similarity (exact/partial matches)
          const keywordSimilarity = computeKeywordSimilarity(searchQuery, relativePath, keyInfo);
          
          // Compute folder-based similarity boost
          // Files in folders that match the search query get a boost
          const folderSimilarity = computeFolderSimilarity(relativePath, searchQuery);
          
          // Combine semantic, keyword, and folder similarity
          // Weight: 60% semantic (LLM), 30% keywords, 10% folder
          // This gives us both semantic understanding and exact matches
          const combinedSimilarity = Math.min(1.0, 
            (semanticSimilarity * 0.6) + 
            (keywordSimilarity * 0.3) + 
            (folderSimilarity * 0.1)
          );
          
          fileSimilarities.push({
            filePath,
            relativePath,
            similarity: combinedSimilarity,
            content: keyInfo
          });
        }
        
        // Log progress every 10 files
        if ((i + 1) % 10 === 0) {
          log(`[LocalCodeFetcher] Processed ${i + 1}/${filesToRank.length} files for ranking... (reused: ${reusedEmbeddings}, computed: ${computedEmbeddings})`);
        }
      } catch (error) {
        log(`[LocalCodeFetcher] Failed to process file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    
    await prisma.$disconnect();
    
    log(`[LocalCodeFetcher] Embedding summary: reused ${reusedEmbeddings} from database, computed ${computedEmbeddings} new embeddings`);

    // Sort by similarity
    fileSimilarities.sort((a, b) => b.similarity - a.similarity);
    
    // If maxFiles is null, return all files (will be processed in chunks)
    // Otherwise, return top N files
    const topFiles = maxFiles ? fileSimilarities.slice(0, maxFiles) : fileSimilarities;
    
    if (maxFiles) {
      log(`[LocalCodeFetcher] Selected top ${topFiles.length} files by semantic similarity from ${fileSimilarities.length} total files (similarity range: ${topFiles[topFiles.length - 1]?.similarity.toFixed(3)} - ${topFiles[0]?.similarity.toFixed(3)})`);
    } else {
      log(`[LocalCodeFetcher] Returning all ${topFiles.length} files ranked by semantic similarity (will be processed in chunks)`);
    }

    // Format results
    const codeContexts = topFiles.map(file => 
      `File: ${file.relativePath}\n${file.content}`
    );

    return codeContexts.join("\n\n");
  } catch (error) {
    log(`[LocalCodeFetcher] Error fetching local code context: ${error instanceof Error ? error.message : String(error)}`);
    return "";
  }
}

/**
 * Compute cosine similarity between two embeddings
 */
function computeCosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * Compute keyword-based similarity
 * Checks for exact and partial keyword matches in file path and content
 * Returns a value between 0 and 1
 */
function computeKeywordSimilarity(searchQuery: string, filePath: string, content: string): number {
  const searchLower = searchQuery.toLowerCase();
  const pathLower = filePath.toLowerCase();
  const contentLower = content.toLowerCase();
  
  // Extract keywords from search query (words longer than 2 chars)
  const searchKeywords = searchLower
    .split(/\s+/)
    .filter(word => word.length > 2)
    .map(word => word.replace(/[^a-z0-9]/g, "")); // Remove punctuation
  
  if (searchKeywords.length === 0) {
    return 0;
  }
  
  let matches = 0;
  let exactMatches = 0;
  
  for (const keyword of searchKeywords) {
    if (keyword.length > 2) {
      // Check for exact matches (higher weight)
      if (pathLower.includes(keyword) || contentLower.includes(keyword)) {
        exactMatches++;
        matches++;
      } else {
        // Check for partial matches (lower weight)
        const partialMatch = searchKeywords.some(k => 
          k.includes(keyword) || keyword.includes(k)
        );
        if (partialMatch) {
          matches += 0.5;
        }
      }
    }
  }
  
  // Weight exact matches more heavily
  const score = (exactMatches * 1.0 + (matches - exactMatches) * 0.5) / searchKeywords.length;
  return Math.min(1.0, score);
}

/**
 * Compute folder-based similarity
 * Files in folders that match search query keywords get a boost
 * Returns a value between 0 and 1
 */
function computeFolderSimilarity(filePath: string, searchQuery: string): number {
  // Extract folder path (everything except filename)
  const folderPath = filePath.substring(0, filePath.lastIndexOf("/")) || "";
  const folderPathLower = folderPath.toLowerCase();
  const searchQueryLower = searchQuery.toLowerCase();
  
  // Split search query into keywords (words longer than 2 chars)
  const searchKeywords = searchQueryLower
    .split(/\s+/)
    .filter(word => word.length > 2)
    .map(word => word.replace(/[^a-z0-9]/g, "")); // Remove punctuation
  
  if (searchKeywords.length === 0) {
    return 0;
  }
  
  // Check how many keywords match in the folder path
  let matches = 0;
  for (const keyword of searchKeywords) {
    if (keyword.length > 2 && folderPathLower.includes(keyword)) {
      matches++;
    }
  }
  
  // Return similarity score based on keyword matches
  // If all keywords match, return 1.0 (full boost)
  // If some match, return proportional score
  return matches / searchKeywords.length;
}

/**
 * Helper to read and format files (for fallback)
 */
async function readAndFormatFiles(
  filePaths: string[],
  resolvedPath: string
): Promise<string> {
  const codeContexts: string[] = [];
  
  for (const filePath of filePaths) {
    try {
      const content = await readFile(filePath, "utf-8");
      const relativePath = relative(resolvedPath, filePath);
      const keyInfo = extractKeyCodeInfo(content, relativePath);
      
      if (keyInfo) {
        codeContexts.push(`File: ${relativePath}\n${keyInfo}`);
      }
    } catch (error) {
      log(`[LocalCodeFetcher] Failed to read file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return codeContexts.join("\n\n");
}

/**
 * Find all code files in source directories (for semantic search)
 * No keyword filtering - we'll use embeddings to rank relevance
 */
async function findAllCodeFiles(
  repoPath: string,
  currentPath: string = "",
  foundFiles: string[] = [],
  maxFiles: number = 10000, // High limit for discovery - we want to find all files
  scannedDirs: Set<string> = new Set()
): Promise<string[]> {
  // Check limit before processing (safety limit to prevent infinite loops)
  if (foundFiles.length >= maxFiles) {
    return foundFiles;
  }

  try {
    const fullPath = currentPath ? join(repoPath, currentPath) : repoPath;
    const entries = await readdir(fullPath, { withFileTypes: true });
    
    // Track scanned directories for logging
    scannedDirs.add(currentPath || ".");
    
    for (const entry of entries) {
      // Check limit at start of each iteration (safety check)
      if (foundFiles.length >= maxFiles) {
        break;
      }

      const entryPath = currentPath ? join(currentPath, entry.name) : entry.name;
      const fullEntryPath = join(repoPath, entryPath);

      // Skip common directories
      if (entry.isDirectory()) {
        const dirName = entry.name.toLowerCase();
        if (
          dirName === "node_modules" ||
          dirName === "dist" ||
          dirName === "build" ||
          dirName === ".git" ||
          dirName === "coverage" ||
          dirName === ".next" ||
          dirName === ".nuxt" ||
          dirName === "vendor" ||
          dirName === ".cache" ||
          dirName === ".turbo" ||
          dirName === "demo" || // Exclude demo directories
          entryPath.toLowerCase().startsWith("demo/") // Exclude anything under demo/
        ) {
          continue;
        }

        // Only recurse into source directories at root level, not in demo/
        const pathLower = entryPath.toLowerCase();
        const isRootSourceDir = entryPath === "src" ||
                                entryPath === "lib" ||
                                entryPath === "app" ||
                                entryPath.startsWith("packages/");
        const isNestedSourceDir = (pathLower.includes("/src/") || 
                                   pathLower.includes("/lib/") || 
                                   pathLower.includes("/packages/")) &&
                                   !pathLower.startsWith("demo/"); // Exclude demo/src, demo/lib, etc.

        if (isRootSourceDir || isNestedSourceDir || currentPath === "") {
          // Recursively search subdirectories - find all files
          if (foundFiles.length < maxFiles) {
            const subFiles = await findAllCodeFiles(repoPath, entryPath, foundFiles, maxFiles, scannedDirs);
            // Add all found files (up to limit)
            if (foundFiles.length < maxFiles) {
              const remaining = maxFiles - foundFiles.length;
              foundFiles.push(...subFiles.slice(0, remaining));
            }
          }
        }
      } else if (entry.isFile()) {
        // Check limit before adding file (safety check)
        if (foundFiles.length >= maxFiles) {
          break;
        }
        
        // Check if it's a code file
        const ext = extname(entry.name).toLowerCase();
        const codeExtensions = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".kt"];
        
        if (codeExtensions.includes(ext)) {
          // Include all code files in source directories, but exclude demo/
          const pathLower = entryPath.toLowerCase();
          const isInSourceDir = (pathLower.includes("/src/") || 
                                 pathLower.includes("/lib/") || 
                                 pathLower.includes("/packages/")) &&
                                 !pathLower.startsWith("demo/"); // Exclude demo files
          
          // Also include root-level source directories
          const isRootSourceFile = entryPath.startsWith("src/") ||
                                    entryPath.startsWith("lib/") ||
                                    entryPath.startsWith("packages/");
          
          if (isInSourceDir || isRootSourceFile) {
            foundFiles.push(fullEntryPath);
          }
        }
      }
    }

    return foundFiles;
  } catch (error) {
    // Skip directories we can't read
    log(`[LocalCodeFetcher] Error reading directory ${currentPath || repoPath}: ${error instanceof Error ? error.message : String(error)}`);
    return foundFiles;
  }
}

/**
 * Find code files in the repository that match the search query (keyword fallback)
 * @deprecated Use semantic search instead, this is only for fallback when API key is missing
 */
async function findCodeFiles(
  repoPath: string,
  searchQuery: string,
  maxFiles: number,
  currentPath: string = "",
  foundFiles: string[] = []
): Promise<string[]> {
  if (foundFiles.length >= maxFiles) {
    return foundFiles;
  }

  try {
    const fullPath = currentPath ? join(repoPath, currentPath) : repoPath;
    const entries = await readdir(fullPath, { withFileTypes: true });

    // Search terms from query
    const searchTerms = searchQuery.toLowerCase().split(/\s+/).filter(term => term.length > 2);
    
    for (const entry of entries) {
      if (foundFiles.length >= maxFiles) break;

      const entryPath = currentPath ? join(currentPath, entry.name) : entry.name;
      const fullEntryPath = join(repoPath, entryPath);

      // Skip common directories
      if (entry.isDirectory()) {
        const dirName = entry.name.toLowerCase();
        if (
          dirName === "node_modules" ||
          dirName === "dist" ||
          dirName === "build" ||
          dirName === ".git" ||
          dirName === "coverage" ||
          dirName === ".next" ||
          dirName === ".nuxt" ||
          dirName === "vendor" ||
          dirName === ".cache" ||
          dirName === ".turbo"
        ) {
          continue;
        }

        // Recursively search subdirectories
        const subFiles = await findCodeFiles(repoPath, searchQuery, maxFiles, entryPath, foundFiles);
        foundFiles.push(...subFiles);
      } else if (entry.isFile()) {
        // Check if it's a code file
        const ext = extname(entry.name).toLowerCase();
        const codeExtensions = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".kt"];
        
        if (codeExtensions.includes(ext)) {
          // Simple relevance check: filename or path contains search terms
          const fileName = entry.name.toLowerCase();
          const pathLower = entryPath.toLowerCase();
          
          // Check if filename or path matches search terms
          const matches = searchTerms.length > 0 && searchTerms.some(term => 
            fileName.includes(term) || pathLower.includes(term)
          );
          
          // Also include files in common source directories (src, lib, app, etc.)
          const isInSourceDir = pathLower.includes("/src/") || 
                                pathLower.includes("/lib/") || 
                                pathLower.includes("/app/") ||
                                pathLower.includes("/packages/");
          
          // If no search terms (broad query) or search terms match or in source dir, include file
          if (searchTerms.length === 0 || matches || isInSourceDir) {
            foundFiles.push(fullEntryPath);
          }
        }
      }
    }

    return foundFiles;
  } catch (error) {
    // Skip directories we can't read
    return foundFiles;
  }
}

/**
 * Extract key information from code file (function names, class names, exports, etc.)
 * This helps understand what the code does without including full file content
 */
function extractKeyCodeInfo(content: string, filePath: string): string | null {
  const lines = content.split('\n');
  const keyInfo: string[] = [];
  
  // Extract exports, functions, classes, interfaces
  const exportPattern = /export\s+(?:async\s+)?(?:function|const|class|interface|type|enum)\s+(\w+)/g;
  const functionPattern = /(?:async\s+)?function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s+)?\(/g;
  const classPattern = /class\s+(\w+)/g;
  const interfacePattern = /interface\s+(\w+)/g;
  
  const found = new Set<string>();
  
  // Find exports
  let match;
  while ((match = exportPattern.exec(content)) !== null) {
    found.add(match[1]);
  }
  
  // Find functions
  while ((match = functionPattern.exec(content)) !== null) {
    const name = match[1] || match[2];
    if (name) found.add(name);
  }
  
  // Find classes
  while ((match = classPattern.exec(content)) !== null) {
    found.add(match[1]);
  }
  
  // Find interfaces
  while ((match = interfacePattern.exec(content)) !== null) {
    found.add(match[1]);
  }
  
  if (found.size > 0) {
    keyInfo.push(`Exports/Functions: ${Array.from(found).slice(0, 20).join(', ')}`);
  }
  
  // Extract API routes (common patterns)
  const routePatterns = [
    /(?:router|app|route)\.(?:get|post|put|delete|patch)\s*\(['"`]([^'"`]+)['"`]/g,
    /@(?:GET|POST|PUT|DELETE|PATCH)\s*\(['"`]([^'"`]+)['"`]/g,
  ];
  
  const routes = new Set<string>();
  for (const pattern of routePatterns) {
    while ((match = pattern.exec(content)) !== null) {
      routes.add(match[1]);
    }
  }
  
  if (routes.size > 0) {
    keyInfo.push(`API Routes: ${Array.from(routes).slice(0, 10).join(', ')}`);
  }
  
  // If no key info found, include first few lines as context
  if (keyInfo.length === 0 && lines.length > 0) {
    const preview = lines.slice(0, 10).join('\n');
    if (preview.trim().length > 0) {
      keyInfo.push(preview);
    }
  }
  
  return keyInfo.length > 0 ? keyInfo.join('\n') : null;
}

