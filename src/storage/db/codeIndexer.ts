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
 * Represents a code section (function, class, interface, etc.)
 */
interface CodeSection {
  id: string;
  sectionType: string;
  sectionName: string;
  sectionContent: string;
  startLine: number | null;
  endLine: number | null;
  featureMappings?: Array<{
    featureId: string;
    similarity: number | string | { toNumber(): number };
    matchType: string;
    feature?: { id: string; name: string };
  }>;
}

/**
 * Represents a code file with its sections
 */
interface CodeFile {
  id: string;
  codeSections: CodeSection[];
}

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
 * @param chunkSize Number of files to process per chunk (default: 100)
 * @param maxFiles Maximum number of files to fetch per batch (default: null = process all files). If set, processes files in batches of this size until all files are processed.
 */
export async function searchAndIndexCode(
  searchQuery: string,
  repositoryUrl: string,
  featureId: string,
  featureName: string,
  force: boolean = false,
  chunkSize: number = 100,
  maxFiles: number | null = null // null = process all files
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
    
    // Determine if repositoryUrl is a local path or GitHub URL
    const { existsSync, statSync } = await import("fs");
    const { parseGitHubRepoUrl } = await import("../../connectors/github/codeFetcher.js");
    const isGitHubUrl = parseGitHubRepoUrl(repositoryUrl) !== null;
    const isLocalPath = !isGitHubUrl && repositoryUrl && (existsSync(repositoryUrl) || repositoryUrl.startsWith("/") || repositoryUrl.startsWith("./") || repositoryUrl.startsWith("../"));
    
    // ALWAYS prefer local repository from config first, then check if repositoryUrl is a local path
    const { getConfig } = await import("../../config/index.js");
    const config = getConfig();
    let localRepoPath: string | undefined = config.pmIntegration?.local_repo_path;
    
    // If repositoryUrl is a local path, use it (overrides config if provided as parameter)
    if (isLocalPath) {
      localRepoPath = repositoryUrl;
      log(`[CodeIndexer] repositoryUrl is a local path, using it directly: ${localRepoPath}`);
    } else if (localRepoPath) {
      log(`[CodeIndexer] Using local repository path from config: ${localRepoPath}`);
    }
    
    // First, try local repository if available (ALWAYS prefer local over GitHub)
    if (localRepoPath) {
      log(`[CodeIndexer] Attempting to fetch code from local repository: ${localRepoPath}`);
      const { fetchLocalCodeContext } = await import("../../connectors/github/localCodeFetcher.js");
      rawCodeContext = await fetchLocalCodeContext(localRepoPath, searchQuery, maxFiles);
      
      if (rawCodeContext) {
        log(`[CodeIndexer] Successfully fetched code from local repository (${rawCodeContext.length} characters)`);
      } else {
        log(`[CodeIndexer] No code found in local repository, falling back to GitHub API`);
      }
    }
    
    // Fallback to GitHub API if local didn't work and repositoryUrl is a GitHub URL
    if (!rawCodeContext && isGitHubUrl) {
      log(`[CodeIndexer] Fetching code from GitHub API...`);
      const { fetchRepositoryCodeContext } = await import("../../connectors/github/codeFetcher.js");
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
      repositoryUrl,
      chunkSize // Use the chunkSize parameter
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
 * OPTIMIZED: Uses batch processing for embeddings and is resumable
 * @param chunkSize Number of files to process per chunk (default: 100)
 */
async function parseAndIndexCode(
  codeContext: string,
  searchId: string,
  searchQuery: string,
  repositoryUrl: string,
  chunkSize: number = 100
): Promise<CodeFile[]> {
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
  log(`[CodeIndexer] Saved code search to database: "${searchQuery}" (id: ${searchId})`);

  // Parse code context (format: "File: path\ncontent...")
  const fileBlocks = codeContext.split(/\n\n(?=File:)/);
  const codeFiles: CodeFile[] = [];
  
  let skippedFiles = 0;
  let processedFiles = 0;
  let skippedSections = 0;
  let processedSections = 0;

  // Collect all files and sections that need embeddings for batch processing
  interface FileEmbeddingTask {
    fileId: string;
    filePath: string;
    fileText: string;
    contentHash: string;
  }

  interface SectionEmbeddingTask {
    sectionId: string;
    sectionText: string;
    contentHash: string;
    fileId: string;
  }

  const fileEmbeddingTasks: FileEmbeddingTask[] = [];
  const sectionEmbeddingTasks: SectionEmbeddingTask[] = [];
  const fileDataMap = new Map<string, {
    fileId: string;
    filePath: string;
    fileName: string;
    fileContent: string;
    contentHash: string;
    language: string | null;
    sections: Array<{
      type: string;
      name: string;
      content: string;
      startLine: number;
      endLine: number;
    }>;
  }>();

  // PHASE 1: Parse all files, save to DB, and collect embedding tasks
  // Process in chunks for resumability
  const totalFiles = fileBlocks.length;
  log(`[CodeIndexer] Phase 1: Parsing ${totalFiles} files in chunks of ${chunkSize}...`);
  
  // Process files in chunks
  for (let chunkStart = 0; chunkStart < fileBlocks.length; chunkStart += chunkSize) {
    const chunkEnd = Math.min(chunkStart + chunkSize, fileBlocks.length);
    const chunk = fileBlocks.slice(chunkStart, chunkEnd);
    const chunkNum = Math.floor(chunkStart / chunkSize) + 1;
    const totalChunks = Math.ceil(fileBlocks.length / chunkSize);
    
    log(`[CodeIndexer] Processing chunk ${chunkNum}/${totalChunks} (files ${chunkStart + 1}-${chunkEnd} of ${totalFiles})...`);
    
    // Clear tasks for this chunk
    const chunkFileTasks: FileEmbeddingTask[] = [];
    const chunkSectionTasks: SectionEmbeddingTask[] = [];
    interface ChunkFileData {
      fileId: string;
      filePath: string;
      fileName: string;
      fileContent: string;
      contentHash: string;
      language: string | null;
      existingFile?: { id: string; codeSections: Array<{ id: string; sectionName: string; startLine: number | null; embedding: unknown }> };
      sections: Array<{
        type: string;
        name: string;
        content: string;
        startLine: number;
        endLine: number;
      }>;
    }
    const chunkFileData: ChunkFileData[] = [];
    
    // PHASE 1.1: Parse files in this chunk and collect embedding tasks
    // Track processed files to avoid duplicates within the same chunk
    const processedFilePaths = new Set<string>();
    
    for (const block of chunk) {
      const lines = block.split("\n");
      if (lines.length < 2 || !lines[0].startsWith("File: ")) continue;

      let filePath = lines[0].replace("File: ", "").trim();
      
      // Normalize path: remove leading slashes, normalize separators, ensure it's relative
      filePath = filePath.replace(/^\/+/, ""); // Remove leading slashes
      filePath = filePath.replace(/\\/g, "/"); // Normalize Windows separators to forward slashes
      filePath = filePath.replace(/\/+/g, "/"); // Remove duplicate slashes
      
      // Skip if we've already processed this file in this chunk
      if (processedFilePaths.has(filePath)) {
        log(`[CodeIndexer] Skipping duplicate file in chunk: ${filePath}`);
        continue;
      }
      processedFilePaths.add(filePath);
      
      const fileName = filePath.split("/").pop() || filePath;
      const fileContent = lines.slice(1).join("\n");
      const contentHash = createHash("md5").update(fileContent).digest("hex");
      const language = getLanguageFromPath(filePath);
      
      log(`[CodeIndexer] Processing file path: "${filePath}" (normalized relative path, will be stored in database)`);

      // Check if file already indexed with embedding
      const existingFile = await prisma.codeFile.findFirst({
        where: {
          codeSearchId: searchId,
          filePath,
        },
        include: { 
          embeddings: true,
          codeSections: {
            include: { embedding: true },
          },
        },
      });

      const fileId = existingFile?.id || createHash("md5").update(`${searchId}:${filePath}`).digest("hex");
      
      if (existingFile && existingFile.contentHash === contentHash) {
        // File unchanged - check if fully processed
        const hasFileEmbedding = !!existingFile.embeddings;
        const sectionsNeedingEmbeddings = existingFile.codeSections.filter(s => !s.embedding);
        
        if (hasFileEmbedding && sectionsNeedingEmbeddings.length === 0) {
          // File fully processed - skip it
          log(`[CodeIndexer] Skipping ${filePath} - already indexed and embedded (${existingFile.codeSections.length} sections)`);
          skippedFiles++;
          skippedSections += existingFile.codeSections.length;
          // Convert Prisma result to CodeFile interface
          codeFiles.push({
            id: existingFile.id,
            codeSections: existingFile.codeSections.map(s => ({
              id: s.id,
              sectionType: s.sectionType,
              sectionName: s.sectionName,
              sectionContent: s.sectionContent,
              startLine: s.startLine,
              endLine: s.endLine,
            })),
          });
          continue;
        }
        
        // File exists but missing file embedding or some sections missing embeddings
        if (!hasFileEmbedding) {
          // Add to file embedding tasks
          chunkFileTasks.push({
            fileId: existingFile.id,
            filePath,
            fileText: `File: ${filePath}\n${fileContent}`,
            contentHash,
          });
        }
        
        // Parse sections from file content (even if file exists, sections might be missing)
        const sections = parseCodeIntoSections(fileContent, filePath, language);
        log(`[CodeIndexer] Parsed ${sections.length} sections from existing file ${filePath} (language: ${language || "unknown"})`);
        
        // Get existing sections for this file
        const existingSectionsMap = new Map(
          existingFile.codeSections.map(s => [
            createHash("md5").update(`${existingFile.id}:${s.sectionName}:${s.startLine}`).digest("hex"),
            s
          ])
        );
        
        // Process sections - create missing ones, update changed ones
        for (const section of sections) {
          const sectionId = createHash("md5")
            .update(`${existingFile.id}:${section.name}:${section.startLine}`)
            .digest("hex");
          
          const sectionHash = createHash("md5").update(section.content).digest("hex");
          const existingSection = existingSectionsMap.get(sectionId);
          
          if (existingSection && existingSection.contentHash === sectionHash) {
            // Section unchanged - check if embedding exists
            if (existingSection.embedding) {
              skippedSections++;
            } else {
              // Section exists but no embedding - add to tasks
              chunkSectionTasks.push({
                sectionId,
                sectionText: `${section.type}: ${section.name}\n${section.content}`,
                contentHash: sectionHash,
                fileId: existingFile.id,
              });
            }
          } else {
            // Section new or changed - create/update it
            await prisma.codeSection.upsert({
              where: { id: sectionId },
              create: {
                id: sectionId,
                codeFileId: existingFile.id,
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
            log(`[CodeIndexer] Saved code section to database: ${section.name} (${section.type}) in ${filePath} (id: ${sectionId})`);
            processedSections++; // Count section as processed
            
            // Delete old embedding if section changed
            if (existingSection?.embedding) {
              await prisma.codeSectionEmbedding.deleteMany({
                where: { codeSectionId: sectionId },
              });
              log(`[CodeIndexer] Deleted old embedding for changed section ${section.name}`);
            }
            
            // Add to section embedding tasks
            chunkSectionTasks.push({
              sectionId,
              sectionText: `${section.type}: ${section.name}\n${section.content}`,
              contentHash: sectionHash,
              fileId: existingFile.id,
            });
          }
        }
        
        // Store file data for later processing
        chunkFileData.push({
          fileId: existingFile.id,
          filePath,
          fileName,
          fileContent,
          contentHash,
          language,
          existingFile,
          sections,
        });
      } else {
        // File new or changed, save it first
        const newFileId = createHash("md5").update(`${searchId}:${filePath}`).digest("hex");
        
        const codeFile = await prisma.codeFile.upsert({
          where: { id: newFileId },
          create: {
            id: newFileId,
            codeSearchId: searchId,
            filePath,
            fileName,
            fileContent,
            language,
            contentHash,
          },
          update: {
            codeSearchId: searchId, // Ensure codeSearchId is set on update too
            fileContent,
            contentHash,
            lastIndexedAt: new Date(),
          },
        });
        log(`[CodeIndexer] Saved code file to database - path: "${filePath}", fileName: "${fileName}", language: ${language || "unknown"}, id: ${newFileId}`);
        
        // Delete old file embedding if file changed
        const existingEmbeddings = await prisma.codeFileEmbedding.findMany({
          where: { codeFileId: newFileId },
        });
        if (existingEmbeddings.length > 0) {
          await prisma.codeFileEmbedding.deleteMany({
            where: { codeFileId: newFileId },
          });
          log(`[CodeIndexer] Deleted old file embedding for changed file ${filePath}`);
        }
        
        // Add to file embedding tasks
        chunkFileTasks.push({
          fileId: newFileId,
          filePath,
          fileText: `File: ${filePath}\n${fileContent}`,
          contentHash,
        });
        
        // Parse into sections
        const sections = parseCodeIntoSections(fileContent, filePath, language);
        log(`[CodeIndexer] Parsed ${sections.length} sections from new/changed file ${filePath} (language: ${language || "unknown"})`);
        
        // Get existing sections for this file
        const existingSections = await prisma.codeSection.findMany({
          where: { codeFileId: newFileId },
          include: { embedding: true },
        });
        
        const existingSectionsMap = new Map(
          existingSections.map(s => [s.id, s])
        );
        
        // Process sections - create/update and collect embedding tasks
        for (const section of sections) {
          const sectionId = createHash("md5")
            .update(`${newFileId}:${section.name}:${section.startLine}`)
            .digest("hex");
          
          const sectionHash = createHash("md5").update(section.content).digest("hex");
          const existingSection = existingSectionsMap.get(sectionId);
          
          if (existingSection && existingSection.contentHash === sectionHash) {
            // Section unchanged - check if embedding exists
            if (existingSection.embedding) {
              skippedSections++;
            } else {
              // Section exists but no embedding - add to tasks
              chunkSectionTasks.push({
                sectionId,
                sectionText: `${section.type}: ${section.name}\n${section.content}`,
                contentHash: sectionHash,
                fileId: newFileId,
              });
            }
          } else {
            // Section new or changed - create/update it
            await prisma.codeSection.upsert({
              where: { id: sectionId },
              create: {
                id: sectionId,
                codeFileId: newFileId,
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
            log(`[CodeIndexer] Saved code section to database: ${section.name} (${section.type}) in ${filePath} (id: ${sectionId})`);
            processedSections++; // Count section as processed
            
            // Delete old embedding if section changed
            if (existingSection?.embedding) {
              await prisma.codeSectionEmbedding.deleteMany({
                where: { codeSectionId: sectionId },
              });
              log(`[CodeIndexer] Deleted old embedding for changed section ${section.name}`);
            }
            
            // Add to section embedding tasks
            chunkSectionTasks.push({
              sectionId,
              sectionText: `${section.type}: ${section.name}\n${section.content}`,
              contentHash: sectionHash,
              fileId: newFileId,
            });
          }
        }
        
        // Delete sections that no longer exist in the file
        const currentSectionIds = sections.map(s => 
          createHash("md5").update(`${newFileId}:${s.name}:${s.startLine}`).digest("hex")
        );
        const sectionsToDelete = existingSections.filter(s => !currentSectionIds.includes(s.id));
        if (sectionsToDelete.length > 0) {
          await prisma.codeSection.deleteMany({
            where: { 
              id: { in: sectionsToDelete.map(s => s.id) },
            },
          });
          log(`[CodeIndexer] Deleted ${sectionsToDelete.length} obsolete sections from ${filePath}`);
        }
        
        // Store file data
        chunkFileData.push({
          fileId: newFileId,
          filePath,
          fileName,
          fileContent,
          contentHash,
          language,
          sections,
        });
      }
    }
    
    // PHASE 1.2: Batch process file embeddings for this chunk
    if (chunkFileTasks.length > 0) {
      log(`[CodeIndexer] Chunk ${chunkNum}: Batch processing ${chunkFileTasks.length} file embeddings...`);
      const apiKey = process.env.OPENAI_API_KEY;
      if (apiKey) {
        try {
          const { createEmbeddings } = await import("../../core/classify/semantic.js");
          const { saveCodeFileEmbedding } = await import("./embeddings.js");
          
          // Batch create embeddings (OpenAI supports up to 2048 inputs per request)
          const BATCH_SIZE_EMBEDDINGS = 100; // Process 100 at a time to stay within limits
          for (let i = 0; i < chunkFileTasks.length; i += BATCH_SIZE_EMBEDDINGS) {
            const batch = chunkFileTasks.slice(i, i + BATCH_SIZE_EMBEDDINGS);
            const texts = batch.map(t => t.fileText);
            
            log(`[CodeIndexer] Computing embeddings for file batch ${Math.floor(i / BATCH_SIZE_EMBEDDINGS) + 1}/${Math.ceil(chunkFileTasks.length / BATCH_SIZE_EMBEDDINGS)} (${batch.length} files)...`);
            const embeddings = await createEmbeddings(texts, apiKey);
            
            // Save embeddings
            for (let j = 0; j < batch.length; j++) {
              try {
                await saveCodeFileEmbedding(batch[j].fileId, embeddings[j], batch[j].contentHash);
                processedFiles++;
                log(`[CodeIndexer] Saved file embedding for ${batch[j].filePath}`);
              } catch (error) {
                log(`[CodeIndexer] Failed to save file embedding for ${batch[j].filePath}: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
          }
        } catch (error) {
          log(`[CodeIndexer] Batch file embedding failed, falling back to individual: ${error instanceof Error ? error.message : String(error)}`);
          // Fallback to individual processing
          for (const task of chunkFileTasks) {
            try {
              const apiKey = process.env.OPENAI_API_KEY;
              if (apiKey) {
                const { createEmbedding } = await import("../../core/classify/semantic.js");
                const { saveCodeFileEmbedding } = await import("./embeddings.js");
                const embedding = await createEmbedding(task.fileText, apiKey);
                await saveCodeFileEmbedding(task.fileId, embedding, task.contentHash);
                processedFiles++;
              }
            } catch (embeddingError) {
              log(`[CodeIndexer] Failed to compute file embedding for ${task.filePath}: ${embeddingError instanceof Error ? embeddingError.message : String(embeddingError)}`);
            }
          }
        }
      }
    }
    
    // PHASE 1.3: Batch process section embeddings for this chunk
    if (chunkSectionTasks.length > 0) {
      log(`[CodeIndexer] Chunk ${chunkNum}: Batch processing ${chunkSectionTasks.length} section embeddings...`);
      const apiKey = process.env.OPENAI_API_KEY;
      if (apiKey) {
        try {
          const { createEmbeddings } = await import("../../core/classify/semantic.js");
          const { saveCodeSectionEmbedding } = await import("./embeddings.js");
          
          // Batch create embeddings
          const BATCH_SIZE_EMBEDDINGS = 100; // Process 100 at a time
          for (let i = 0; i < chunkSectionTasks.length; i += BATCH_SIZE_EMBEDDINGS) {
            const batch = chunkSectionTasks.slice(i, i + BATCH_SIZE_EMBEDDINGS);
            const texts = batch.map(t => t.sectionText);
            
            log(`[CodeIndexer] Computing embeddings for section batch ${Math.floor(i / BATCH_SIZE_EMBEDDINGS) + 1}/${Math.ceil(chunkSectionTasks.length / BATCH_SIZE_EMBEDDINGS)} (${batch.length} sections)...`);
            const embeddings = await createEmbeddings(texts, apiKey);
            
            // Save embeddings
            for (let j = 0; j < batch.length; j++) {
              try {
                await saveCodeSectionEmbedding(batch[j].sectionId, embeddings[j], batch[j].contentHash);
                processedSections++;
              } catch (error) {
                log(`[CodeIndexer] Failed to save section embedding: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
          }
        } catch (error) {
          log(`[CodeIndexer] Batch section embedding failed, falling back to individual: ${error instanceof Error ? error.message : String(error)}`);
          // Fallback to individual processing
          for (const task of chunkSectionTasks) {
            try {
              const apiKey = process.env.OPENAI_API_KEY;
              if (apiKey) {
                const { createEmbedding } = await import("../../core/classify/semantic.js");
                const { saveCodeSectionEmbedding } = await import("./embeddings.js");
                const embedding = await createEmbedding(task.sectionText, apiKey);
                await saveCodeSectionEmbedding(task.sectionId, embedding, task.contentHash);
                processedSections++;
              }
            } catch (embeddingError) {
              log(`[CodeIndexer] Failed to compute section embedding: ${embeddingError instanceof Error ? embeddingError.message : String(embeddingError)}`);
            }
          }
        }
      }
    }
    
    // PHASE 1.4: Reload all files with sections for this chunk
    for (const fileData of chunkFileData) {
      const codeFile = await prisma.codeFile.findUnique({
        where: { id: fileData.fileId },
        include: { 
          codeSections: {
            include: {
              embedding: true,
              featureMappings: true,
            },
          },
        },
      });
      if (codeFile) {
        log(`[CodeIndexer] Reloaded file ${fileData.filePath} with ${codeFile.codeSections.length} sections`);
        // Convert Prisma result to CodeFile interface
        codeFiles.push({
          id: codeFile.id,
          codeSections: codeFile.codeSections.map(s => ({
            id: s.id,
            sectionType: s.sectionType,
            sectionName: s.sectionName,
            sectionContent: s.sectionContent,
            startLine: s.startLine,
            endLine: s.endLine,
            featureMappings: s.featureMappings?.map(m => ({
              featureId: m.featureId,
              similarity: m.similarity,
              matchType: m.matchType,
            })),
          })),
        });
      } else {
        log(`[CodeIndexer] WARNING: Could not reload file ${fileData.filePath} (id: ${fileData.fileId}) from database`);
      }
    }
    
    // Update codeSearch.updatedAt to track progress after each batch
    await prisma.codeSearch.update({
      where: { id: searchId },
      data: { updatedAt: new Date() },
    });
    
    log(`[CodeIndexer] Chunk ${chunkNum}/${totalChunks} complete. Progress: ${chunkEnd}/${totalFiles} files processed.`);
  }
  
  log(`[CodeIndexer] Indexing summary: ${processedFiles} files processed, ${skippedFiles} files skipped, ${processedSections} sections processed, ${skippedSections} sections skipped`);

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
  codeFiles: CodeFile[],
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
        // Use BOTH semantic (LLM) and keyword matching for better results
        let semanticSimilarity = 0;
        let keywordSimilarity = 0;
        let matchType = "keyword";
        
        // Compute semantic similarity using LLM embeddings
        if (featureEmbedding) {
          const { getCodeSectionEmbedding } = await import("./embeddings.js");
          const sectionContentHash = createHash("md5").update(section.sectionContent).digest("hex");
          const sectionEmbedding = await getCodeSectionEmbedding(section.id, sectionContentHash);
          
          if (sectionEmbedding) {
            // Compute cosine similarity from LLM embeddings
            semanticSimilarity = computeCosineSimilarity(featureEmbedding, sectionEmbedding);
          }
        }
        
        // Always compute keyword similarity (complements semantic search)
        keywordSimilarity = computeSimpleSimilarity(featureName, section.sectionName, section.sectionContent);
        
        // Combine semantic and keyword similarity
        // Weight: 70% semantic (LLM understanding), 30% keywords (exact matches)
        const combinedSimilarity = (semanticSimilarity * 0.7) + (keywordSimilarity * 0.3);
        
        // Determine match type based on combined score
        if (combinedSimilarity > 0.7 || (semanticSimilarity > 0.6 && keywordSimilarity > 0.5)) {
          matchType = "exact";
        } else if (semanticSimilarity > 0.5 || keywordSimilarity > 0.5) {
          matchType = "semantic";
        } else {
          matchType = "keyword";
        }
        
        // Lower threshold to 0.2 to catch more matches (was 0.3)
        // This matches the threshold in matchTextToFeaturesUsingCode
        if (combinedSimilarity > 0.2) {
          try {
            await prisma.featureCodeMapping.create({
              data: {
                id: createHash("md5").update(`${featureId}:${section.id}`).digest("hex"),
                featureId,
                codeSectionId: section.id,
                similarity: combinedSimilarity,
                matchType,
                searchQuery: featureName,
              },
            });
            log(`[CodeIndexer] Saved feature-code mapping: ${section.sectionName} -> ${featureName} (semantic: ${semanticSimilarity.toFixed(3)}, keyword: ${keywordSimilarity.toFixed(3)}, combined: ${combinedSimilarity.toFixed(3)}, type: ${matchType})`);
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
function buildCodeContext(codeFiles: CodeFile[]): string {
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
    // OPTIMIZATION: First check if code is already indexed for features
    // This avoids re-indexing code multiple times when matching groups to features
    // Look for any existing code search for this repository that has indexed code
    const { getConfig } = await import("../../config/index.js");
    const config = getConfig();
    const repoIdentifier = config.pmIntegration?.local_repo_path || repositoryUrl || "";
    
    // Define searchId and searchQuery for use when indexing new code
    // Use repoIdentifier consistently (local path preferred over GitHub URL)
    const searchQuery = text;
    const searchId = createHash("md5")
      .update(`${searchQuery}:${repoIdentifier}`)
      .digest("hex");
    
    // First, check if code is already indexed for this specific text query
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
    
    // If not found, look for ANY existing code search for this repository
    // This would be from indexCodeForAllFeatures - reuse it to avoid re-indexing
    if (!codeSearch || codeSearch.codeFiles.length === 0) {
      const existingSearches = await prisma.codeSearch.findMany({
        where: {
          repositoryUrl: repoIdentifier,
        },
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
        orderBy: {
          updatedAt: "desc",
        },
        take: 1, // Get the most recent one
      });
      
      if (existingSearches.length > 0 && existingSearches[0].codeFiles.length > 0) {
        codeSearch = existingSearches[0];
        log(`[CodeIndexer] Reusing existing code indexed for repository (${codeSearch.codeFiles.length} files from search "${codeSearch.searchQuery?.substring(0, 50)}...")`);
      }
    } else {
      log(`[CodeIndexer] Found existing code search for this query (${codeSearch.codeFiles.length} files)`);
    }

    // If search doesn't exist, search and index
    if (!codeSearch || codeSearch.codeFiles.length === 0) {
      log(`[CodeIndexer] Code not yet indexed - searching code for: "${text.substring(0, 100)}..."...`);
      
      let rawCodeContext = "";
      
      // First, try local repository if configured
      const localRepoPath = config.pmIntegration?.local_repo_path;
      
      if (localRepoPath) {
        log(`[CodeIndexer] Attempting to fetch code from local repository: ${localRepoPath}`);
        const { fetchLocalCodeContext } = await import("../../connectors/github/localCodeFetcher.js");
        rawCodeContext = await fetchLocalCodeContext(localRepoPath, text, 100); // Default to 100 for matchTextToFeaturesUsingCode
        
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
          repoIdentifier, // Use repoIdentifier consistently (local path preferred)
          100 // Default chunk size
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
    const { getCodeSectionEmbeddingsBatch, getFeatureEmbedding } = await import("./embeddings.js");

    // Pre-load all feature embeddings for efficiency
    const featureEmbeddings = new Map<string, number[]>();
    for (const feature of features) {
      const featureEmb = await getFeatureEmbedding(feature.id);
      if (featureEmb) {
        featureEmbeddings.set(feature.id, featureEmb);
      }
    }
    log(`[CodeIndexer] Loaded ${featureEmbeddings.size} feature embeddings from database`);

    // Pre-load all code section embeddings in a single batch query (avoids N+1)
    const allSectionIds: string[] = [];
    for (const file of codeSearch.codeFiles) {
      for (const section of file.codeSections) {
        if (section.sectionType === "function" || section.sectionType === "class" || section.sectionType === "interface") {
          allSectionIds.push(section.id);
        }
      }
    }
    const sectionEmbeddingsMap = await getCodeSectionEmbeddingsBatch(allSectionIds);
    log(`[CodeIndexer] Loaded ${sectionEmbeddingsMap.size} code section embeddings from database`);

    // Match each code section (function) to features
    let totalSections = 0;
    let processedSections = 0;
    let skippedSections = 0;

    for (const file of codeSearch.codeFiles) {
      for (const section of file.codeSections) {
        totalSections++;
        // Focus on function-level sections (most relevant for feature matching)
        if (section.sectionType !== "function" && section.sectionType !== "class" && section.sectionType !== "interface") {
          skippedSections++;
          continue; // Skip non-function sections for now
        }
        processedSections++;

        // Check existing mappings first (if code unchanged, reuse saved mappings)
        if (section.featureMappings && section.featureMappings.length > 0) {
          for (const mapping of section.featureMappings) {
            const currentSim = featureSimilarities.get(mapping.featureId) || 0;
            // Take max similarity (best match)
            featureSimilarities.set(
              mapping.featureId,
              Math.max(currentSim, Number(mapping.similarity))
            );
          }
        } else {
          // No existing mappings - compute similarity using pre-loaded embeddings
          const sectionEmbedding = sectionEmbeddingsMap.get(section.id) || null;
          
          if (!sectionEmbedding) {
            log(`[CodeIndexer] WARNING: No embedding found for ${section.sectionType} ${section.sectionName} (id: ${section.id}). Will rely on keyword matching only.`);
          }
          
          // Match to all features using BOTH semantic and keyword matching
          for (const feature of features) {
            let semanticSimilarity = 0;
            let keywordSimilarity = 0;
            let matchType = "keyword";
            
            // Compute semantic similarity using LLM embeddings
            if (sectionEmbedding) {
              const featureEmbedding = featureEmbeddings.get(feature.id);
              
              if (featureEmbedding) {
                // Compute cosine similarity using saved embeddings (LLM-based)
                semanticSimilarity = computeCosineSimilarity(featureEmbedding, sectionEmbedding);
              }
            }
            
            // Always compute keyword similarity (complements semantic search)
            keywordSimilarity = computeSimpleSimilarity(feature.name, section.sectionName, section.sectionContent);
            
            // Combine semantic and keyword similarity
            // Weight: 70% semantic (LLM understanding), 30% keywords (exact matches)
            const combinedSimilarity = (semanticSimilarity * 0.7) + (keywordSimilarity * 0.3);
            
            // Determine match type based on combined score
            if (combinedSimilarity > 0.7 || (semanticSimilarity > 0.6 && keywordSimilarity > 0.5)) {
              matchType = "exact";
            } else if (semanticSimilarity > 0.5 || keywordSimilarity > 0.5) {
              matchType = "semantic";
            } else {
              matchType = "keyword";
            }
            
            log(`[CodeIndexer] Combined similarity for ${section.sectionName} -> ${feature.name}: semantic=${semanticSimilarity.toFixed(3)}, keyword=${keywordSimilarity.toFixed(3)}, combined=${combinedSimilarity.toFixed(3)}`);
            
            // Lower threshold to 0.2 to catch more matches (was 0.3)
            if (combinedSimilarity > 0.2) {
              const currentSim = featureSimilarities.get(feature.id) || 0;
              featureSimilarities.set(feature.id, Math.max(currentSim, combinedSimilarity));
              
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
                    similarity: combinedSimilarity,
                    matchType,
                    searchQuery: text,
                  },
                  update: {
                    similarity: combinedSimilarity,
                    matchType,
                    searchQuery: text,
                  },
                });
                log(`[CodeIndexer] Saved feature-code mapping: ${section.sectionName} -> ${feature.name} (semantic: ${semanticSimilarity.toFixed(3)}, keyword: ${keywordSimilarity.toFixed(3)}, combined: ${combinedSimilarity.toFixed(3)}, type: ${matchType})`);
              } catch (error) {
                // Mapping might already exist, ignore
                log(`[CodeIndexer] Mapping already exists or error: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
          }
        }
      }
    }

    log(`[CodeIndexer] Processed ${processedSections} code sections (${skippedSections} skipped, ${totalSections} total)`);
    log(`[CodeIndexer] Code maps to ${featureSimilarities.size} features`);
    
    if (featureSimilarities.size === 0 && processedSections > 0) {
      log(`[CodeIndexer] WARNING: Processed ${processedSections} sections but found 0 feature matches. This may indicate:`);
      log(`[CodeIndexer]   - Code section embeddings not computed yet`);
      log(`[CodeIndexer]   - All similarity scores below 0.2 threshold`);
      log(`[CodeIndexer]   - Feature embeddings missing`);
    }
    
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
 * @param localRepoPathOverride Optional local repo path override
 * @param chunkSize Number of files to process per chunk (default: 100)
 * @param maxFiles Maximum number of files to index (default: 100). Limits total files processed, not just chunk size.
 */
export async function indexCodeForAllFeatures(
  repositoryUrl?: string,
  force: boolean = false,
  onProgress?: (processed: number, total: number) => void,
  localRepoPathOverride?: string,
  chunkSize: number = 100,
  maxFiles: number | null = null // null = process all files in chunks
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

  // Get all features with descriptions for better semantic search
  const allFeatures = await prisma.feature.findMany({
    orderBy: { id: "asc" },
    select: {
      id: true,
      name: true,
      description: true,
      relatedKeywords: true,
    },
  });

  if (allFeatures.length === 0) {
    log(`[CodeIndexer] No features found in database`);
    return { indexed: 0, matched: 0, total: 0 };
  }

  log(`[CodeIndexer] Starting optimized code indexing for ${allFeatures.length} features using LLM-based semantic search...`);

  // OPTIMIZATION: Index codebase once with a broad semantic query that covers all features
  // Build a comprehensive search query using feature names, descriptions, and keywords
  // This will be used with LLM embeddings for semantic code search
  const queryParts: string[] = [];
  for (const feature of allFeatures) {
    // Add feature name (most important)
    queryParts.push(feature.name);
    
    // Add description if available (provides semantic context for LLM)
    if (feature.description && feature.description.length > 10) {
      // Extract key phrases from description (first 50 words)
      const descWords = feature.description.split(/\s+/).slice(0, 50).join(" ");
      queryParts.push(descWords);
    }
    
    // Add related keywords
    const keywords = Array.isArray(feature.relatedKeywords) ? feature.relatedKeywords : [];
    for (const keyword of keywords) {
      if (keyword.length > 2 && !queryParts.includes(keyword)) {
        queryParts.push(keyword);
      }
    }
  }

  // Create a broad semantic search query (LLM will use embeddings to find relevant code)
  // Limit to reasonable size but include semantic context from descriptions
  const broadQuery = queryParts.slice(0, 100).join(" ");
  log(`[CodeIndexer] Indexing codebase with LLM-based semantic search covering all ${allFeatures.length} features...`);
  log(`[CodeIndexer] Semantic search query (${queryParts.length} parts): "${broadQuery.substring(0, 200)}${broadQuery.length > 200 ? '...' : ''}"`);
  log(`[CodeIndexer] This query will be converted to embeddings and used to find semantically relevant code files`);

  // Index code once with the broad query (no specific feature - just index the code)
  // ALWAYS prefer localRepoPath over repoUrl (local > GitHub)
  const repoIdentifier = localRepoPath || repoUrl || "";
  log(`[CodeIndexer] Using repository identifier: ${repoIdentifier} (preferring local over GitHub)`);
  
  const codeContext = await searchAndIndexCode(
    broadQuery,
    repoIdentifier,
    "", // No specific feature ID - just index code
    "all_features",
    force,
    chunkSize,
    maxFiles
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

