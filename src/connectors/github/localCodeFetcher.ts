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
  maxFiles: number = 20
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

    // Collect all code files from source directories (no keyword filtering)
    const allCodeFiles = await findAllCodeFiles(resolvedPath);
    log(`[LocalCodeFetcher] Found ${allCodeFiles.length} code files in repository`);

    if (allCodeFiles.length === 0) {
      log(`[LocalCodeFetcher] No code files found in repository`);
      return "";
    }

    // Use semantic search to rank files by relevance
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      log(`[LocalCodeFetcher] OPENAI_API_KEY not set, falling back to keyword matching`);
      // Fallback to keyword matching if no API key
      const codeFiles = await findCodeFiles(resolvedPath, searchQuery, maxFiles);
      return await readAndFormatFiles(codeFiles, resolvedPath);
    }

    // Compute embedding for search query
    const { createEmbedding } = await import("../../core/classify/semantic.js");
    log(`[LocalCodeFetcher] Computing embedding for search query...`);
    const queryEmbedding = await createEmbedding(searchQuery, apiKey);
    
    // Read files and compute similarities
    const fileSimilarities: Array<{ filePath: string; relativePath: string; similarity: number; content: string }> = [];
    
    log(`[LocalCodeFetcher] Computing embeddings and similarities for ${allCodeFiles.length} files...`);
    for (let i = 0; i < allCodeFiles.length; i++) {
      const filePath = allCodeFiles[i];
      try {
        const content = await readFile(filePath, "utf-8");
        const relativePath = relative(resolvedPath, filePath);
        const keyInfo = extractKeyCodeInfo(content, relativePath);
        
        if (keyInfo) {
          // Create text representation: file path + key info
          const fileText = `${relativePath}\n${keyInfo}`;
          
          // Compute embedding for file
          const fileEmbedding = await createEmbedding(fileText, apiKey);
          
          // Compute cosine similarity
          const similarity = computeCosineSimilarity(queryEmbedding, fileEmbedding);
          
          fileSimilarities.push({
            filePath,
            relativePath,
            similarity,
            content: keyInfo
          });
        }
        
        // Log progress every 10 files
        if ((i + 1) % 10 === 0) {
          log(`[LocalCodeFetcher] Processed ${i + 1}/${allCodeFiles.length} files...`);
        }
      } catch (error) {
        log(`[LocalCodeFetcher] Failed to process file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Sort by similarity and take top N
    fileSimilarities.sort((a, b) => b.similarity - a.similarity);
    const topFiles = fileSimilarities.slice(0, maxFiles);
    
    log(`[LocalCodeFetcher] Selected top ${topFiles.length} files by semantic similarity (range: ${topFiles[topFiles.length - 1]?.similarity.toFixed(3)} - ${topFiles[0]?.similarity.toFixed(3)})`);

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
  maxFiles: number = 200 // Limit to prevent excessive processing
): Promise<string[]> {
  if (foundFiles.length >= maxFiles) {
    return foundFiles;
  }

  try {
    const fullPath = currentPath ? join(repoPath, currentPath) : repoPath;
    const entries = await readdir(fullPath, { withFileTypes: true });
    
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

        // Only recurse into source directories to limit scope
        const pathLower = entryPath.toLowerCase();
        const isSourceDir = pathLower.includes("/src/") || 
                          pathLower.includes("/lib/") || 
                          pathLower.includes("/app/") ||
                          pathLower.includes("/packages/") ||
                          entryPath === "src" ||
                          entryPath === "lib" ||
                          entryPath === "app" ||
                          entryPath.startsWith("packages/");

        if (isSourceDir || currentPath === "") {
          // Recursively search subdirectories
          const subFiles = await findAllCodeFiles(repoPath, entryPath, foundFiles, maxFiles);
          foundFiles.push(...subFiles);
        }
      } else if (entry.isFile()) {
        // Check if it's a code file
        const ext = extname(entry.name).toLowerCase();
        const codeExtensions = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".kt"];
        
        if (codeExtensions.includes(ext)) {
          // Include all code files in source directories
          const pathLower = entryPath.toLowerCase();
          const isInSourceDir = pathLower.includes("/src/") || 
                                pathLower.includes("/lib/") || 
                                pathLower.includes("/app/") ||
                                pathLower.includes("/packages/");
          
          if (isInSourceDir) {
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

