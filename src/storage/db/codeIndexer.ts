/**
 * Lazy code indexing service
 * Automatically indexes code when matching features - only indexes what's needed
 * Also supports proactive indexing for all features (similar to documentation workflow)
 */

import { PrismaClient } from "@prisma/client";
import { createHash } from "crypto";
import { log } from "../../mcp/logger.js";

const prisma = new PrismaClient();

/**
 * Get code context for a feature using lazy indexing
 * - Checks if code is already indexed for this feature
 * - If not, searches and indexes code
 * - Returns code context to use in embeddings
 */
export async function getCodeContextForFeature(
  featureId: string,
  featureName: string,
  featureKeywords: string[],
  repositoryUrl?: string
): Promise<string> {
  const { hasDatabaseConfig } = await import("../factory.js");
  if (!hasDatabaseConfig()) {
    log(`[CodeIndexer] Database not configured, skipping code indexing`);
    return "";
  }

  try {
    // Check if we have existing code mappings for this feature
    const existingMappings = await prisma.featureCodeMapping.findMany({
      where: { featureId },
      include: {
        codeSection: {
          include: {
            codeFile: {
              include: {
                codeSearch: true,
              },
            },
          },
        },
      },
      orderBy: { similarity: "desc" },
      take: 10, // Top 10 most relevant code sections
    });

    if (existingMappings.length > 0) {
      log(`[CodeIndexer] Found ${existingMappings.length} existing code mappings for feature "${featureName}"`);
      
      // Check if any files have changed
      const codeContexts: string[] = [];
      const filesToReindex: string[] = [];

      for (const mapping of existingMappings) {
        const codeFile = mapping.codeSection.codeFile;
        
        // File change detection: contentHash is already checked when indexing new files
        // When reusing existing mappings, we trust the stored contentHash
        // Files are re-indexed automatically when their contentHash changes during new searches
        // This avoids unnecessary API calls while still detecting changes
        
        codeContexts.push(
          `File: ${codeFile.filePath}\n` +
          `${mapping.codeSection.sectionType}: ${mapping.codeSection.sectionName}\n` +
          `${mapping.codeSection.sectionContent}`
        );
      }

      if (codeContexts.length > 0) {
        const context = codeContexts.join("\n\n");
        log(`[CodeIndexer] Using existing code context (${context.length} characters) for feature "${featureName}"`);
        return context;
      }
    }

    // No existing mappings - need to search and index
    if (!repositoryUrl) {
      const { getConfig } = await import("../../config/index.js");
      const config = getConfig();
      repositoryUrl = config.pmIntegration?.github_repo_url;
    }

    if (!repositoryUrl) {
      log(`[CodeIndexer] No repository URL configured, cannot index code for feature "${featureName}"`);
      return "";
    }

    log(`[CodeIndexer] No code indexed for feature "${featureName}", searching and indexing...`);
    
    // Search for code related to this feature
    const searchQuery = buildSearchQuery(featureName, featureKeywords);
    const codeContext = await searchAndIndexCode(
      searchQuery,
      repositoryUrl,
      featureId,
      featureName
    );

    return codeContext;
  } catch (error) {
    log(`[CodeIndexer] Error getting code context for feature "${featureName}": ${error instanceof Error ? error.message : String(error)}`);
    return "";
  }
}

/**
 * Build search query from feature name and keywords
 */
function buildSearchQuery(featureName: string, keywords: string[]): string {
  const queryParts = [featureName];
  
  // Add keywords if they're meaningful (not too short)
  for (const keyword of keywords) {
    if (keyword.length > 2 && !queryParts.includes(keyword)) {
      queryParts.push(keyword);
    }
  }
  
  return queryParts.join(" ");
}

/**
 * Search for code and index it
 * This is called when we don't have code indexed for a feature yet
 */
export async function searchAndIndexCode(
  searchQuery: string,
  repositoryUrl: string,
  featureId: string,
  featureName: string,
  force: boolean = false
): Promise<string> {
  try {
    // Check if we've searched for this query before
    const searchId = createHash("md5")
      .update(`${searchQuery}:${repositoryUrl}`)
      .digest("hex");

    let codeSearch = await prisma.codeSearch.findUnique({
      where: { id: searchId },
      include: {
        codeFiles: {
          include: {
            codeSections: true,
          },
        },
      },
    });

    // If search exists and not forcing, use it (cached!)
    if (!force && codeSearch && codeSearch.codeFiles.length > 0) {
      log(`[CodeIndexer] Found existing search for "${searchQuery}", using cached results (${codeSearch.codeFiles.length} files)`);
      
      // Map to feature if not already mapped (if featureId provided)
      if (featureId) {
        await mapCodeToFeature(codeSearch.codeFiles, featureId, featureName);
      }
      
      // Return code context (from cache - no re-indexing needed!)
      return buildCodeContext(codeSearch.codeFiles);
    }
    
    if (force && codeSearch) {
      log(`[CodeIndexer] Force mode enabled - re-indexing code for "${searchQuery}"`);
    }

    // Need to search - try local repo first, then fallback to GitHub API
    log(`[CodeIndexer] Searching codebase for "${searchQuery}"...`);
    
    let rawCodeContext = "";
    
    // First, try local repository if configured
    const { getConfig } = await import("../../config/index.js");
    const config = getConfig();
    const localRepoPath = config.pmIntegration?.local_repo_path;
    
    if (localRepoPath) {
      log(`[CodeIndexer] Attempting to fetch code from local repository: ${localRepoPath}`);
      const { fetchLocalCodeContext } = await import("../../connectors/github/localCodeFetcher.js");
      rawCodeContext = await fetchLocalCodeContext(localRepoPath, searchQuery, 20);
      
      if (rawCodeContext) {
        log(`[CodeIndexer] Successfully fetched code from local repository (${rawCodeContext.length} characters)`);
      } else {
        log(`[CodeIndexer] No code found in local repository, falling back to GitHub API`);
      }
    }
    
    // Fallback to GitHub API if local didn't work
    if (!rawCodeContext && repositoryUrl) {
      log(`[CodeIndexer] Fetching code from GitHub API...`);
      const { parseGitHubRepoUrl, fetchRepositoryCodeContext } = await import("../../connectors/github/codeFetcher.js");
      const repoInfo = parseGitHubRepoUrl(repositoryUrl);
      
      if (repoInfo) {
        const githubToken = process.env.GITHUB_TOKEN;
        rawCodeContext = await fetchRepositoryCodeContext(repoInfo, githubToken, 20);
      } else {
        log(`[CodeIndexer] Failed to parse repository URL: ${repositoryUrl} (skipping GitHub API)`);
      }
    }
    
    if (!rawCodeContext) {
      log(`[CodeIndexer] No code found for search "${searchQuery}" (tried local and GitHub API)`);
      return "";
    }

    // Parse and index the code
    const codeFiles = await parseAndIndexCode(
      rawCodeContext,
      searchId,
      searchQuery,
      repositoryUrl
    );

    // Map to feature (if featureId provided)
    if (featureId) {
      await mapCodeToFeature(codeFiles, featureId, featureName);
    }

    // Return code context
    return buildCodeContext(codeFiles);
  } catch (error) {
    log(`[CodeIndexer] Error searching and indexing code: ${error instanceof Error ? error.message : String(error)}`);
    return "";
  }
}

/**
 * Parse code context and store in database
 */
async function parseAndIndexCode(
  codeContext: string,
  searchId: string,
  searchQuery: string,
  repositoryUrl: string
): Promise<Array<{ id: string; codeSections: any[] }>> {
  // Create or get code search
  const codeSearch = await prisma.codeSearch.upsert({
    where: { id: searchId },
    create: {
      id: searchId,
      searchQuery,
      repositoryUrl,
      searchType: "semantic",
    },
    update: {
      updatedAt: new Date(),
    },
  });

  // Parse code context (format: "File: path\ncontent...")
  const fileBlocks = codeContext.split(/\n\n(?=File:)/);
  const codeFiles: Array<{ id: string; codeSections: any[] }> = [];

  for (const block of fileBlocks) {
    const lines = block.split("\n");
    if (lines.length < 2 || !lines[0].startsWith("File: ")) continue;

    const filePath = lines[0].replace("File: ", "").trim();
    const fileName = filePath.split("/").pop() || filePath;
    const fileContent = lines.slice(1).join("\n");
    const contentHash = createHash("md5").update(fileContent).digest("hex");
    const language = getLanguageFromPath(filePath);

    // Check if file already indexed
    const existingFile = await prisma.codeFile.findFirst({
      where: {
        codeSearchId: searchId,
        filePath,
      },
    });

    let codeFile;
    if (existingFile && existingFile.contentHash === contentHash) {
      // File unchanged, but check if file embedding exists
      const fileWithEmbedding = await prisma.codeFile.findUnique({
        where: { id: existingFile.id },
        include: { embeddings: true },
      });
      
      if (!fileWithEmbedding?.embeddings) {
        // File exists but no embedding - compute it now
        log(`[CodeIndexer] File ${filePath} exists but missing file embedding, computing now...`);
        try {
          const apiKey = process.env.OPENAI_API_KEY;
          if (apiKey) {
            const { createEmbedding } = await import("../../core/classify/semantic.js");
            const { saveCodeFileEmbedding } = await import("./embeddings.js");
            
            // Build text for embedding: file path and content
            const fileText = `File: ${filePath}\n${fileContent}`;
            const embedding = await createEmbedding(fileText, apiKey);
            
            await saveCodeFileEmbedding(existingFile.id, embedding, contentHash);
            log(`[CodeIndexer] Computed and saved file embedding for ${filePath}`);
          }
        } catch (embeddingError) {
          log(`[CodeIndexer] Failed to compute file embedding for ${filePath}: ${embeddingError instanceof Error ? embeddingError.message : String(embeddingError)}`);
        }
      } else {
        log(`[CodeIndexer] File ${filePath} unchanged (hash: ${contentHash.substring(0, 8)}...), reusing existing index with embedding`);
      }
      codeFile = existingFile;
    } else {
      // File new or changed, index it
      const fileId = createHash("md5").update(`${searchId}:${filePath}`).digest("hex");
      
      codeFile = await prisma.codeFile.upsert({
        where: { id: fileId },
        create: {
          id: fileId,
          codeSearchId: searchId,
          filePath,
          fileName,
          fileContent,
          language,
          contentHash,
        },
        update: {
          fileContent,
          contentHash,
          lastIndexedAt: new Date(),
        },
      });
      
      // Delete old file embedding if file changed (will be recomputed below)
      // Check if embeddings exist for this file
      const existingEmbeddings = await prisma.codeFileEmbedding.findMany({
        where: { codeFileId: fileId },
      });
      if (existingEmbeddings.length > 0) {
        await prisma.codeFileEmbedding.deleteMany({
          where: { codeFileId: fileId },
        });
        log(`[CodeIndexer] Deleted old file embedding for changed file ${filePath}`);
      }
      
      // Compute and save file embedding
      try {
        const apiKey = process.env.OPENAI_API_KEY;
        if (apiKey) {
          const { createEmbedding } = await import("../../core/classify/semantic.js");
          const { saveCodeFileEmbedding } = await import("./embeddings.js");
          
          // Build text for embedding: file path and content
          const fileText = `File: ${filePath}\n${fileContent}`;
          log(`[CodeIndexer] Computing file embedding for ${filePath} (${fileText.length} chars)...`);
          const embedding = await createEmbedding(fileText, apiKey);
          
          log(`[CodeIndexer] Saving file embedding for ${filePath} (embedding length: ${embedding.length})...`);
          await saveCodeFileEmbedding(fileId, embedding, contentHash);
          log(`[CodeIndexer] Successfully computed and saved file embedding for ${filePath} (id: ${fileId})`);
        } else {
          log(`[CodeIndexer] OPENAI_API_KEY not set, skipping file embedding computation for ${filePath}`);
        }
      } catch (embeddingError) {
        log(`[CodeIndexer] Failed to compute file embedding for ${filePath}: ${embeddingError instanceof Error ? embeddingError.message : String(embeddingError)}`);
        if (embeddingError instanceof Error && embeddingError.stack) {
          log(`[CodeIndexer] Error stack: ${embeddingError.stack}`);
        }
      }

      // Parse into sections (functions, classes, etc.)
      const sections = parseCodeIntoSections(fileContent, filePath, language);
      
      // Delete old sections
      await prisma.codeSection.deleteMany({
        where: { codeFileId: fileId },
      });

      // Create new sections
      for (const section of sections) {
        const sectionId = createHash("md5")
          .update(`${fileId}:${section.name}:${section.startLine}`)
          .digest("hex");
        
        const sectionHash = createHash("md5").update(section.content).digest("hex");
        
        // Check if section already exists
        const existingSection = await prisma.codeSection.findUnique({
          where: { id: sectionId },
          include: { embedding: true },
        });
        
        if (existingSection && existingSection.contentHash === sectionHash) {
          // Section unchanged, but check if embedding exists
          if (!existingSection.embedding) {
            // Section exists but no embedding - compute it now
            log(`[CodeIndexer] Section ${section.name} exists but missing embedding, computing now...`);
            try {
              const apiKey = process.env.OPENAI_API_KEY;
              if (apiKey) {
                const { createEmbedding } = await import("../../core/classify/semantic.js");
                const { saveCodeSectionEmbedding } = await import("./embeddings.js");
                
                // Build text for embedding: section type, name, and content
                const sectionText = `${section.type}: ${section.name}\n${section.content}`;
                const embedding = await createEmbedding(sectionText, apiKey);
                
                await saveCodeSectionEmbedding(sectionId, embedding, sectionHash);
                log(`[CodeIndexer] Computed and saved embedding for existing code section ${section.name}`);
              } else {
                log(`[CodeIndexer] OPENAI_API_KEY not set, skipping embedding computation for section ${section.name}`);
              }
            } catch (embeddingError) {
              log(`[CodeIndexer] Failed to compute embedding for existing section ${section.name}: ${embeddingError instanceof Error ? embeddingError.message : String(embeddingError)}`);
            }
          } else {
            // Section unchanged and has embedding, reuse
            log(`[CodeIndexer] Section ${section.name} unchanged with existing embedding, reusing`);
          }
        } else {
          // Create or update section
          await prisma.codeSection.upsert({
            where: { id: sectionId },
            create: {
              id: sectionId,
              codeFileId: fileId,
              sectionType: section.type,
              sectionName: section.name,
              sectionContent: section.content,
              startLine: section.startLine,
              endLine: section.endLine,
              contentHash: sectionHash,
            },
            update: {
              sectionContent: section.content,
              contentHash: sectionHash,
            },
          });
          
          // Delete old embedding if section changed (will be recomputed below)
          if (existingSection?.embedding) {
            await prisma.codeSectionEmbedding.deleteMany({
              where: { codeSectionId: sectionId },
            });
            log(`[CodeIndexer] Deleted old embedding for changed section ${section.name}`);
          }
          
          // Compute and save embedding for this code section
          try {
            const apiKey = process.env.OPENAI_API_KEY;
            if (apiKey) {
              const { createEmbedding } = await import("../../core/classify/semantic.js");
              const { saveCodeSectionEmbedding } = await import("./embeddings.js");
              
              // Build text for embedding: section type, name, and content
              const sectionText = `${section.type}: ${section.name}\n${section.content}`;
              log(`[CodeIndexer] Computing embedding for section ${section.name} (${sectionText.length} chars)...`);
              const embedding = await createEmbedding(sectionText, apiKey);
              
              log(`[CodeIndexer] Saving embedding for section ${section.name} (embedding length: ${embedding.length})...`);
              await saveCodeSectionEmbedding(sectionId, embedding, sectionHash);
              log(`[CodeIndexer] Successfully computed and saved embedding for code section ${section.name} (id: ${sectionId})`);
            } else {
              log(`[CodeIndexer] OPENAI_API_KEY not set, skipping embedding computation for section ${section.name}`);
            }
          } catch (embeddingError) {
            log(`[CodeIndexer] Failed to compute embedding for section ${section.name}: ${embeddingError instanceof Error ? embeddingError.message : String(embeddingError)}`);
            if (embeddingError instanceof Error && embeddingError.stack) {
              log(`[CodeIndexer] Error stack: ${embeddingError.stack}`);
            }
            // Continue even if embedding fails - section is still indexed
          }
        }
      }

      // Reload with sections
      codeFile = await prisma.codeFile.findUnique({
        where: { id: fileId },
        include: { codeSections: true },
      });
    }

    if (codeFile) {
      codeFiles.push(codeFile as any);
    }
  }

  return codeFiles;
}

/**
 * Parse code file into sections (functions, classes, etc.)
 */
function parseCodeIntoSections(
  content: string,
  filePath: string,
  language?: string | null
): Array<{
  type: string;
  name: string;
  content: string;
  startLine: number;
  endLine: number;
}> {
  const sections: Array<{
    type: string;
    name: string;
    content: string;
    startLine: number;
    endLine: number;
  }> = [];

  const lines = content.split("\n");
  let currentSection: {
    type: string;
    name: string;
    content: string;
    startLine: number;
    endLine: number;
  } | null = null;

  // Patterns for different languages
  const patterns = {
    ts: [
      { type: "function", regex: /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g },
      { type: "class", regex: /(?:export\s+)?class\s+(\w+)/g },
      { type: "interface", regex: /(?:export\s+)?interface\s+(\w+)/g },
      { type: "type", regex: /(?:export\s+)?type\s+(\w+)/g },
    ],
    js: [
      { type: "function", regex: /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g },
      { type: "class", regex: /(?:export\s+)?class\s+(\w+)/g },
    ],
  };

  const lang = language?.toLowerCase() || "ts";
  const langPatterns = patterns[lang as keyof typeof patterns] || patterns.ts;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Check for section start
    for (const pattern of langPatterns) {
      const match = pattern.regex.exec(line);
      if (match) {
        // Save previous section
        if (currentSection) {
          currentSection.endLine = i - 1;
          sections.push(currentSection);
        }
        
        // Start new section
        currentSection = {
          type: pattern.type,
          name: match[1],
          content: line,
          startLine: i + 1,
          endLine: i + 1,
        };
        break;
      }
    }
    
    // Continue current section
    if (currentSection) {
      currentSection.content += "\n" + line;
      currentSection.endLine = i + 1;
    }
  }

  // Save last section
  if (currentSection) {
    sections.push(currentSection);
  }

  return sections;
}

/**
 * Get language from file path
 */
function getLanguageFromPath(filePath: string): string | null {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    ts: "ts",
    tsx: "ts",
    js: "js",
    jsx: "js",
    py: "py",
    go: "go",
    rs: "rs",
    java: "java",
  };
  return langMap[ext || ""] || null;
}

/**
 * Map code sections to feature using semantic similarity
 */
async function mapCodeToFeature(
  codeFiles: Array<{ codeSections: any[] }>,
  featureId: string,
  featureName: string
): Promise<void> {
  // Get feature embedding for semantic similarity
  const { getFeatureEmbedding } = await import("./embeddings.js");
  const featureEmbedding = await getFeatureEmbedding(featureId);
  
  for (const file of codeFiles) {
    for (const section of file.codeSections) {
      // Check if mapping already exists
      const existing = await prisma.featureCodeMapping.findUnique({
        where: {
          featureId_codeSectionId: {
            featureId,
            codeSectionId: section.id,
          },
        },
      });

      if (!existing) {
        let similarity = 0;
        let matchType = "keyword";
        
        // Use semantic similarity if both embeddings are available
        if (featureEmbedding) {
          const { getCodeSectionEmbedding } = await import("./embeddings.js");
          const sectionContentHash = createHash("md5").update(section.sectionContent).digest("hex");
          const sectionEmbedding = await getCodeSectionEmbedding(section.id, sectionContentHash);
          
          if (sectionEmbedding) {
            // Compute cosine similarity
            similarity = computeCosineSimilarity(featureEmbedding, sectionEmbedding);
            matchType = similarity > 0.7 ? "exact" : similarity > 0.5 ? "semantic" : "keyword";
          } else {
            // Fallback to keyword-based similarity if section embedding not available
            similarity = computeSimpleSimilarity(featureName, section.sectionName, section.sectionContent);
            matchType = similarity > 0.7 ? "exact" : similarity > 0.5 ? "keyword" : "semantic";
          }
        } else {
          // Fallback to keyword-based similarity if feature embedding not available
          similarity = computeSimpleSimilarity(featureName, section.sectionName, section.sectionContent);
          matchType = similarity > 0.7 ? "exact" : similarity > 0.5 ? "keyword" : "semantic";
        }
        
        // Lower threshold to 0.2 to catch more matches (was 0.3)
        // This matches the threshold in matchTextToFeaturesUsingCode
        if (similarity > 0.2) {
          try {
            await prisma.featureCodeMapping.create({
              data: {
                id: createHash("md5").update(`${featureId}:${section.id}`).digest("hex"),
                featureId,
                codeSectionId: section.id,
                similarity,
                matchType,
                searchQuery: featureName,
              },
            });
            log(`[CodeIndexer] Created mapping: ${section.sectionName} -> ${featureName} (similarity: ${similarity.toFixed(3)}, type: ${matchType})`);
          } catch (error) {
            // Mapping might already exist, ignore
            log(`[CodeIndexer] Mapping already exists or error: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }
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
 * Simple similarity computation (will be replaced with embedding-based)
 */
function computeSimpleSimilarity(
  featureName: string,
  sectionName: string,
  sectionContent: string
): number {
  const featureLower = featureName.toLowerCase();
  const sectionLower = sectionName.toLowerCase();
  const contentLower = sectionContent.toLowerCase();

  // Exact name match
  if (sectionLower.includes(featureLower) || featureLower.includes(sectionLower)) {
    return 0.9;
  }

  // Keyword match in content
  const featureWords = featureLower.split(/\s+/);
  let matches = 0;
  for (const word of featureWords) {
    if (word.length > 2 && contentLower.includes(word)) {
      matches++;
    }
  }

  return Math.min(0.8, matches / featureWords.length);
}

/**
 * Build code context string from code files
 */
function buildCodeContext(codeFiles: Array<{ codeSections: any[] }>): string {
  const contexts: string[] = [];
  
  for (const file of codeFiles) {
    for (const section of file.codeSections) {
      contexts.push(
        `${section.sectionType}: ${section.sectionName}\n${section.sectionContent}`
      );
    }
  }
  
  return contexts.join("\n\n");
}

/**
 * Match text (group/thread/issue) to features using code embeddings
 * Reuses saved embeddings from database if code unchanged
 * Focuses on function-level code sections for better matching
 */
export async function matchTextToFeaturesUsingCode(
  text: string,
  repositoryUrl: string,
  features: Array<{ id: string; name: string; related_keywords?: string[] }>
): Promise<{
  codeContext: string;
  featureSimilarities: Map<string, number>; // featureId -> similarity
}> {
  const featureSimilarities = new Map<string, number>();
  let codeContext = "";
  
  try {
    // Search for code related to this text
    const searchQuery = text;
    const searchId = createHash("md5")
      .update(`${searchQuery}:${repositoryUrl}`)
      .digest("hex");

    let codeSearch = await prisma.codeSearch.findUnique({
      where: { id: searchId },
      include: {
        codeFiles: {
          include: {
            codeSections: {
              include: {
                featureMappings: {
                  include: {
                    feature: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    // If search doesn't exist, search and index
    if (!codeSearch || codeSearch.codeFiles.length === 0) {
      log(`[CodeIndexer] Searching code for: "${text.substring(0, 100)}..."...`);
      
      let rawCodeContext = "";
      
      // First, try local repository if configured
      const { getConfig } = await import("../../config/index.js");
      const config = getConfig();
      const localRepoPath = config.pmIntegration?.local_repo_path;
      
      if (localRepoPath) {
        log(`[CodeIndexer] Attempting to fetch code from local repository: ${localRepoPath}`);
        const { fetchLocalCodeContext } = await import("../../connectors/github/localCodeFetcher.js");
        rawCodeContext = await fetchLocalCodeContext(localRepoPath, text, 20);
        
        if (rawCodeContext) {
          log(`[CodeIndexer] Successfully fetched code from local repository (${rawCodeContext.length} characters)`);
        } else {
          log(`[CodeIndexer] No code found in local repository, falling back to GitHub API`);
        }
      }
      
      // Fallback to GitHub API if local didn't work
      if (!rawCodeContext) {
        log(`[CodeIndexer] Fetching code from GitHub API...`);
        const { parseGitHubRepoUrl, fetchRepositoryCodeContext } = await import("../../connectors/github/codeFetcher.js");
        const repoInfo = parseGitHubRepoUrl(repositoryUrl);
        
        if (repoInfo) {
          const githubToken = process.env.GITHUB_TOKEN;
          rawCodeContext = await fetchRepositoryCodeContext(repoInfo, githubToken, 20);
        }
      }
      
      if (rawCodeContext) {
        const codeFiles = await parseAndIndexCode(
          rawCodeContext,
          searchId,
          searchQuery,
          repositoryUrl
        );
        
        // Reload with sections and feature mappings
        codeSearch = await prisma.codeSearch.findUnique({
          where: { id: searchId },
          include: {
            codeFiles: {
              include: {
                codeSections: {
                  include: {
                    featureMappings: {
                      include: {
                        feature: true,
                      },
                    },
                  },
                },
              },
            },
          },
        });
      }
    }

    if (!codeSearch || codeSearch.codeFiles.length === 0) {
      return { codeContext: "", featureSimilarities };
    }

    // Build code context
    codeContext = buildCodeContext(codeSearch.codeFiles);

    // Match code sections (functions) to features using saved embeddings
    // First, check database for existing mappings (if code unchanged, reuse them)
    // Then, use embeddings for semantic similarity matching
    const { getCodeSectionEmbedding, getFeatureEmbedding } = await import("./embeddings.js");
    
    // Pre-load all feature embeddings for efficiency
    const featureEmbeddings = new Map<string, number[]>();
    for (const feature of features) {
      const featureEmb = await getFeatureEmbedding(feature.id);
      if (featureEmb) {
        featureEmbeddings.set(feature.id, featureEmb);
      }
    }
    log(`[CodeIndexer] Loaded ${featureEmbeddings.size} feature embeddings from database`);
    
    // Match each code section (function) to features
    for (const file of codeSearch.codeFiles) {
      for (const section of file.codeSections) {
        // Focus on function-level sections (most relevant for feature matching)
        if (section.sectionType !== "function" && section.sectionType !== "class" && section.sectionType !== "interface") {
          continue; // Skip non-function sections for now
        }
        
        // Check existing mappings first (if code unchanged, reuse saved mappings)
        if (section.featureMappings && section.featureMappings.length > 0) {
          log(`[CodeIndexer] Using ${section.featureMappings.length} existing mappings for ${section.sectionType} ${section.sectionName}`);
          for (const mapping of section.featureMappings) {
            const currentSim = featureSimilarities.get(mapping.featureId) || 0;
            // Take max similarity (best match)
            featureSimilarities.set(
              mapping.featureId,
              Math.max(currentSim, Number(mapping.similarity))
            );
          }
        } else {
          // No existing mappings - compute similarity using embeddings from database
          // Only reuse if content hasn't changed (check contentHash)
          log(`[CodeIndexer] Computing new mappings for ${section.sectionType} ${section.sectionName} using embeddings`);
          const sectionContentHash = createHash("md5").update(section.sectionContent).digest("hex");
          const sectionEmbedding = await getCodeSectionEmbedding(section.id, sectionContentHash);
          
          // Match to all features
          for (const feature of features) {
            let similarity = 0;
            let matchType = "keyword";
            
            if (sectionEmbedding) {
              // Use semantic similarity if section embedding exists
              const featureEmbedding = featureEmbeddings.get(feature.id);
              
              if (featureEmbedding) {
                // Compute cosine similarity using saved embeddings
                similarity = computeCosineSimilarity(featureEmbedding, sectionEmbedding);
                matchType = similarity > 0.7 ? "exact" : similarity > 0.5 ? "semantic" : "keyword";
                log(`[CodeIndexer] Semantic similarity for ${section.sectionName} -> ${feature.name}: ${similarity.toFixed(3)}`);
              } else {
                // Feature embedding not available, fall back to keyword matching
                similarity = computeSimpleSimilarity(feature.name, section.sectionName, section.sectionContent);
                matchType = similarity > 0.7 ? "exact" : similarity > 0.5 ? "keyword" : "semantic";
                log(`[CodeIndexer] Keyword similarity (no feature embedding) for ${section.sectionName} -> ${feature.name}: ${similarity.toFixed(3)}`);
              }
            } else {
              // No section embedding - fall back to keyword matching
              similarity = computeSimpleSimilarity(feature.name, section.sectionName, section.sectionContent);
              matchType = similarity > 0.7 ? "exact" : similarity > 0.5 ? "keyword" : "semantic";
              log(`[CodeIndexer] Keyword similarity (no section embedding) for ${section.sectionName} -> ${feature.name}: ${similarity.toFixed(3)}`);
            }
            
            // Lower threshold to 0.2 to catch more matches (was 0.3)
            if (similarity > 0.2) {
              const currentSim = featureSimilarities.get(feature.id) || 0;
              featureSimilarities.set(feature.id, Math.max(currentSim, similarity));
              
              // Save mapping to database for future reuse (if code unchanged)
              try {
                await prisma.featureCodeMapping.upsert({
                  where: {
                    featureId_codeSectionId: {
                      featureId: feature.id,
                      codeSectionId: section.id,
                    },
                  },
                  create: {
                    id: createHash("md5").update(`${feature.id}:${section.id}`).digest("hex"),
                    featureId: feature.id,
                    codeSectionId: section.id,
                    similarity,
                    matchType,
                    searchQuery: text,
                  },
                  update: {
                    similarity,
                    matchType,
                    searchQuery: text,
                  },
                });
                log(`[CodeIndexer] Saved mapping: ${section.sectionName} -> ${feature.name} (similarity: ${similarity.toFixed(3)}, type: ${matchType})`);
              } catch (error) {
                // Mapping might already exist, ignore
                log(`[CodeIndexer] Mapping already exists or error: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
          }
        }
      }
    }

    log(`[CodeIndexer] Code maps to ${featureSimilarities.size} features`);
    return { codeContext, featureSimilarities };
  } catch (error) {
    log(`[CodeIndexer] Error matching text to features using code: ${error instanceof Error ? error.message : String(error)}`);
    return { codeContext: "", featureSimilarities };
  }
}

/**
 * Search and index code for a group, then match it to features
 * This is called when matching groups to features - we look at the code to see which features it relates to
 * @deprecated Use matchTextToFeaturesUsingCode instead
 */
export async function searchAndIndexCodeForGroup(
  groupText: string,
  repositoryUrl: string,
  features: Array<{ id: string; name: string; related_keywords?: string[] }>
): Promise<{
  codeContext: string;
  featureSimilarities: Map<string, number>; // featureId -> similarity
}> {
  return matchTextToFeaturesUsingCode(groupText, repositoryUrl, features);
}

/**
 * Proactively index code for all features (similar to documentation workflow)
 * OPTIMIZED: Indexes codebase once with a broad query, then matches all code sections to all features
 * This is much faster than indexing per feature
 * @param repositoryUrl Optional repository URL (uses config if not provided)
 * @param force If true, re-indexes even if code is already indexed
 * @param onProgress Optional progress callback
 */
export async function indexCodeForAllFeatures(
  repositoryUrl?: string,
  force: boolean = false,
  onProgress?: (processed: number, total: number) => void,
  localRepoPathOverride?: string
): Promise<{ indexed: number; matched: number; total: number }> {
  const { getConfig } = await import("../../config/index.js");
  const config = getConfig();
  const repoUrl = repositoryUrl || config.pmIntegration?.github_repo_url;
  const localRepoPath = localRepoPathOverride || config.pmIntegration?.local_repo_path;
  
  // Check repository configuration
  log(`[CodeIndexer] Checking repository configuration...`);
  if (localRepoPath) {
    log(`[CodeIndexer] LOCAL_REPO_PATH configured: ${localRepoPath}`);
    try {
      const { existsSync, statSync } = await import("fs");
      if (existsSync(localRepoPath)) {
        const stats = statSync(localRepoPath);
        if (stats.isDirectory()) {
          log(`[CodeIndexer] Local repository path exists and is a directory`);
          // Check if it looks like a git repository
          const gitPath = `${localRepoPath}/.git`;
          if (existsSync(gitPath)) {
            log(`[CodeIndexer] Found .git directory - repository is valid`);
          } else {
            log(`[CodeIndexer] Warning: No .git directory found - may not be a git repository`);
          }
        } else {
          log(`[CodeIndexer] Error: LOCAL_REPO_PATH exists but is not a directory`);
        }
      } else {
        log(`[CodeIndexer] Error: LOCAL_REPO_PATH does not exist: ${localRepoPath}`);
      }
    } catch (error) {
      log(`[CodeIndexer] Error checking local repository path: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    log(`[CodeIndexer] LOCAL_REPO_PATH not configured`);
  }
  
  if (repoUrl) {
    log(`[CodeIndexer] GITHUB_REPO_URL configured: ${repoUrl}`);
  } else {
    log(`[CodeIndexer] GITHUB_REPO_URL not configured`);
  }
  
  if (!repoUrl && !localRepoPath) {
    log(`[CodeIndexer] Error: Neither GITHUB_REPO_URL nor LOCAL_REPO_PATH is configured, cannot index code for features`);
    return { indexed: 0, matched: 0, total: 0 };
  }

  // Get all features
  const allFeatures = await prisma.feature.findMany({
    orderBy: { id: "asc" },
    select: {
      id: true,
      name: true,
      relatedKeywords: true,
    },
  });

  if (allFeatures.length === 0) {
    log(`[CodeIndexer] No features found in database`);
    return { indexed: 0, matched: 0, total: 0 };
  }

  log(`[CodeIndexer] Starting optimized code indexing for ${allFeatures.length} features...`);

  // OPTIMIZATION: Index codebase once with a broad query that covers all features
  // Collect all unique keywords from all features
  const allKeywords = new Set<string>();
  for (const feature of allFeatures) {
    allKeywords.add(feature.name.toLowerCase());
    const keywords = Array.isArray(feature.relatedKeywords) ? feature.relatedKeywords : [];
    for (const keyword of keywords) {
      if (keyword.length > 2) {
        allKeywords.add(keyword.toLowerCase());
      }
    }
  }

  // Create a broad search query (limit to reasonable size to avoid issues)
  const broadQuery = Array.from(allKeywords).slice(0, 50).join(" ");
  log(`[CodeIndexer] Indexing codebase with broad query covering all features (${allKeywords.size} unique keywords)...`);
  log(`[CodeIndexer] Search query: "${broadQuery.substring(0, 200)}${broadQuery.length > 200 ? '...' : ''}"`);

  // Index code once with the broad query (no specific feature - just index the code)
  // Use localRepoPath if available, otherwise repoUrl
  const repoIdentifier = localRepoPath || repoUrl || "";
  log(`[CodeIndexer] Using repository identifier: ${repoIdentifier}`);
  
  const codeContext = await searchAndIndexCode(
    broadQuery,
    repoIdentifier,
    "", // No specific feature ID - just index code
    "all_features",
    force
  );

  if (!codeContext) {
    log(`[CodeIndexer] No code found with broad query. This could mean:`);
    log(`[CodeIndexer]   - Repository path is incorrect`);
    log(`[CodeIndexer]   - Search query didn't match any code`);
    log(`[CodeIndexer]   - Code fetching failed (check logs for errors)`);
    return { indexed: 0, matched: 0, total: allFeatures.length };
  }
  
  log(`[CodeIndexer] Successfully indexed code (${codeContext.length} characters)`);

  log(`[CodeIndexer] Code indexed successfully. Now matching all code sections to all features...`);

  // Get all indexed code sections
  const searchId = createHash("md5").update(`${broadQuery}:${repoIdentifier}`).digest("hex");
  const codeSearch = await prisma.codeSearch.findUnique({
    where: { id: searchId },
    include: {
      codeFiles: {
        include: {
          codeSections: true,
        },
      },
    },
  });

  if (!codeSearch || codeSearch.codeFiles.length === 0) {
    log(`[CodeIndexer] No code files found after indexing`);
    return { indexed: 0, matched: 0, total: allFeatures.length };
  }

  // Now match all code sections to all features in one pass
  let matched = 0;
  const codeFiles = codeSearch.codeFiles;

  for (let i = 0; i < allFeatures.length; i++) {
    const feature = allFeatures[i];
    
    try {
      log(`[CodeIndexer] Matching code sections to feature "${feature.name}" (${i + 1}/${allFeatures.length})...`);
      
      // Match code sections to this feature
      await mapCodeToFeature(codeFiles, feature.id, feature.name);
      
      // Count mappings created for this feature
      const mappings = await prisma.featureCodeMapping.findMany({
        where: { featureId: feature.id },
      });
      matched += mappings.length;
      
      log(`[CodeIndexer] Matched ${mappings.length} code sections to feature "${feature.name}"`);
    } catch (error) {
      log(`[CodeIndexer] Failed to match code to feature "${feature.name}": ${error instanceof Error ? error.message : String(error)}`);
    }

    if (onProgress) {
      onProgress(i + 1, allFeatures.length);
    }
  }

  log(`[CodeIndexer] Completed optimized code indexing: 1 codebase index, ${matched} total code-to-feature mappings created`);
  return { indexed: 1, matched, total: allFeatures.length };
}

