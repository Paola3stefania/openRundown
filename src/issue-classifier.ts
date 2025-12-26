/**
 * Classify Discord messages by matching them with GitHub issues
 */

import { searchGitHubIssues, type GitHubIssue } from "./github-integration.js";
import { log, logError, logWarn } from "./logger.js";

// Re-export for convenience
export type { GitHubIssue };

export interface DiscordMessage {
  id: string;
  author: string;
  content: string;
  timestamp: string;
  url?: string;
}

export interface ClassifiedMessage {
  message: DiscordMessage;
  relatedIssues: Array<{
    issue: GitHubIssue;
    similarityScore: number;
    matchedTerms: string[];
  }>;
}

// Term sets for weighted scoring (shared across functions)
const TECHNICAL_CONCEPTS = new Set([
  "csrf", "xss", "sql", "injection", "cors", "origin", "origins",
  "trusted", "trustedorigins", "trusted-origins", "trusted_origins", "trusted origins",
  "baseurl", "base-url", "base_url", "base url",
  "apikey", "api-key", "api_key", "api key",
  "jwt", "oauth2", "openid", "saml", "sso",
  "cookie", "cookies", "sessionid", "session-id", "session id",
  "refresh", "refresh-token", "refresh_token", "refresh token", "refreshtoken",
  "access", "access-token", "access_token", "access token", "accesstoken",
  "middleware", "adapter",
  "hook", "hooks", "callback", "callbacks",
  "migration", "migrations", "schema", "schemas",
  "endpoint", "endpoints", "route", "routes", "path", "paths",
  "headers", "header"
]);

const IMPORTANT_TERMS = new Set([
  "name", "product", "identity", "account", "profile", "credential",
  "authentication", "authorization", "configuration", "settings",
  "environment", "deployment", "production", "development"
]);

const TECHNICAL_TERMS = new Set([
  "secret", "token", "email", "password", "auth", "plugin", "session",
  "user", "signup", "signin", "login", "logout", "verify", "verification",
  "reset", "error", "bug", "issue", "feature", "api", "endpoint", "webhook",
  "database", "schema", "migration", "model", "field", "admin", "oauth",
  "sso", "oidc", "stripe", "subscription", "payment", "organization",
  "role", "permission", "access", "security", "validation", "type",
  "typescript", "javascript", "react", "nextjs", "express", "hono",
  "headers", "header"
]);

// ORM and database product names (should be weighted highly)
const ORM_AND_DB_PRODUCTS = new Set([
  // ORMs
  "drizzle", "prisma", "sequelize", "typeorm", "knex", "bookshelf",
  "waterline", "mongoose", "objection", "kysely", "mikro-orm", "mikroorm",
  "typegoose", "doctrine", "orm", "orms",
  
  // Database products and services
  "supabase", "firebase", "postgres", "postgresql", "mysql", "mariadb",
  "sqlite", "mongodb", "couchdb", "redis", "elasticsearch", "dynamodb",
  "neon", "planetscale", "vercel", "turso", "cockroachdb", "cockroach",
  "timescale", "timescaledb", "aurora", "rds", "cosmosdb", "cosmos",
  
  // Database adapters and drivers
  "pg", "mysql2", "better-sqlite3", "sqlite3", "mongodb-driver",
  "ioredis", "redis-client", "node-postgres", "node-mysql",
  
  // Frameworks (important for context)
  "nextjs", "next.js"
]);

/**
 * Extract keywords from text for matching
 * Improved version that focuses on technical terms and important concepts
 */
function extractKeywords(text: string): string[] {
  // Remove URLs first
  text = text.replace(/https?:\/\/[^\s]+/g, "");
  
  // Remove common words and extract meaningful terms
  const stopWords = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
    "have", "has", "had", "do", "does", "did", "will", "would", "should",
    "could", "may", "might", "can", "this", "that", "these", "those",
    "i", "you", "he", "she", "it", "we", "they", "what", "which", "who",
    "when", "where", "why", "how", "all", "each", "every", "both", "few",
    "more", "most", "other", "some", "such", "no", "nor", "not", "only",
    "own", "same", "so", "than", "too", "very", "just", "now", "here",
    "there", "current", "latest", "release", "breaking", "since", "only",
    "chars", "long", "introduced", "throw", "replaces", "instead", "existing",
    "implementations", "dont", "break", "after", "updating", "could", "not",
    "find", "guide", "migrate", "rotate", "there", "existing", "guide"
  ]);

  // Technical terms that should be weighted higher
  const technicalTerms = new Set([
    "secret", "token", "email", "password", "auth", "plugin", "session",
    "user", "signup", "signin", "login", "logout", "verify", "verification",
    "reset", "error", "bug", "issue", "feature", "api", "endpoint", "webhook",
    "database", "schema", "migration", "model", "field", "admin", "oauth",
    "sso", "oidc", "stripe", "subscription", "payment", "organization",
    "role", "permission", "access", "security", "validation", "type",
    "typescript", "javascript", "react", "nextjs", "express", "hono"
  ]);


  // Normalize text: preserve hyphens and underscores for compound terms
  const normalizedText = text.toLowerCase()
    .replace(/[^\w\s\-_]/g, " ") // Keep hyphens and underscores
    .replace(/\b\d+\b/g, ""); // Remove standalone numbers

  // Extract words (splitting on spaces, but preserving hyphenated/underscored terms)
  const words = normalizedText.split(/\s+/).filter(w => w.trim().length > 0);
  
  const normalized: string[] = [];
  const compoundTerms: string[] = [];

  words.forEach(word => {
    const cleanWord = word.trim();
    
    // Skip stop words and very short words
    if (cleanWord.length <= 2 || stopWords.has(cleanWord) || cleanWord.match(/^[a-z]{1,2}$/)) {
      return;
    }

    // Add the word as-is (preserving hyphens/underscores)
    normalized.push(cleanWord);

    // Extract compound term variations (hyphenated, underscored, camelCase, etc.)
    if (cleanWord.includes('-')) {
      // Hyphenated term: keep original, add without hyphens, add with underscores
      compoundTerms.push(cleanWord);
      compoundTerms.push(cleanWord.replace(/-/g, ''));
      compoundTerms.push(cleanWord.replace(/-/g, '_'));
    } else if (cleanWord.includes('_')) {
      // Underscored term: keep original, add without underscores, add with hyphens
      compoundTerms.push(cleanWord);
      compoundTerms.push(cleanWord.replace(/_/g, ''));
      compoundTerms.push(cleanWord.replace(/_/g, '-'));
    }
    
    // Also extract individual parts from compound terms (e.g., "trusted-origins" -> "trusted", "origins")
    const parts = cleanWord.split(/[-_]/).filter(p => p.length > 2 && !stopWords.has(p));
    normalized.push(...parts);
  });

  // Combine and deduplicate
  const allTerms = [...new Set([...normalized, ...compoundTerms])];
  
  // Categorize terms by importance
  const conceptMatches = allTerms.filter(k => TECHNICAL_CONCEPTS.has(k));
  const importantMatches = allTerms.filter(k => IMPORTANT_TERMS.has(k));
  const productMatches = allTerms.filter(k => ORM_AND_DB_PRODUCTS.has(k));
  const technicalMatches = allTerms.filter(k => TECHNICAL_TERMS.has(k));
  const otherTerms = allTerms.filter(k => 
    !TECHNICAL_CONCEPTS.has(k) && 
    !IMPORTANT_TERMS.has(k) && 
    !ORM_AND_DB_PRODUCTS.has(k) &&
    !TECHNICAL_TERMS.has(k)
  );
  
  // Return in order of importance: concepts > important > products > technical > other
  return [...conceptMatches, ...importantMatches, ...productMatches, ...technicalMatches, ...otherTerms];
}

/**
 * Extract phrases (2-3 word combinations) from text
 * Only extracts unique phrases, filtering out duplicates and same-word phrases
 */
function extractPhrases(keywords: string[]): string[] {
  const phrases = new Set<string>();
  
  // Remove duplicates from keywords first
  const uniqueKeywords = Array.from(new Set(keywords));
  
  // Extract 2-word phrases (skip if words are the same)
  for (let i = 0; i < uniqueKeywords.length - 1; i++) {
    const word1 = uniqueKeywords[i];
    const word2 = uniqueKeywords[i + 1];
    if (word1 !== word2) {
      phrases.add(`${word1} ${word2}`);
    }
  }
  
  // Extract 3-word phrases (skip if any consecutive words are the same)
  for (let i = 0; i < uniqueKeywords.length - 2; i++) {
    const word1 = uniqueKeywords[i];
    const word2 = uniqueKeywords[i + 1];
    const word3 = uniqueKeywords[i + 2];
    if (word1 !== word2 && word2 !== word3) {
      phrases.add(`${word1} ${word2} ${word3}`);
    }
  }
  
  return Array.from(phrases);
}

/**
 * Calculate similarity between message and issue
 * Improved algorithm with phrase matching and weighted matching
 */
function calculateSimilarity(
  messageKeywords: string[],
  messagePhrases: string[],
  issueTitle: string,
  issueBody: string
): { score: number; matchedTerms: string[] } {
  const issueText = `${issueTitle} ${issueBody}`.toLowerCase();
  const issueKeywords = extractKeywords(issueText);
  const issuePhrases = extractPhrases(issueKeywords);
  
  // Find matching phrases (exact phrase matches are very valuable)
  const matchedPhrases: string[] = [];
  for (const msgPhrase of messagePhrases) {
    if (issuePhrases.includes(msgPhrase) || issueText.includes(msgPhrase)) {
      matchedPhrases.push(msgPhrase);
    }
  }
  
  // Find matching keywords with exact and partial matches
  const matchedTerms: string[] = [];
  const exactMatches = new Set<string>();
  const partialMatches = new Set<string>();
  
  for (const msgKeyword of messageKeywords) {
    // Check for exact matches first
    if (issueKeywords.includes(msgKeyword)) {
      exactMatches.add(msgKeyword);
      matchedTerms.push(msgKeyword);
    } else {
      // Check for partial matches (one contains the other)
      const partial = issueKeywords.find(issueKeyword =>
        issueKeyword.includes(msgKeyword) || msgKeyword.includes(issueKeyword)
      );
      if (partial) {
        partialMatches.add(msgKeyword);
        matchedTerms.push(msgKeyword);
      }
    }
  }
  
  // Calculate weighted score
  // Phrase matches are worth the most, then exact word matches, then partial
  let weightedScore = 0;
  const uniqueMatched = new Set(matchedTerms);
  
  // Score phrase matches (highest weight - phrases indicate strong relevance)
  for (const phrase of matchedPhrases) {
    const words = phrase.split(" ");
    const conceptCount = words.filter(w => TECHNICAL_CONCEPTS.has(w)).length;
    const importantCount = words.filter(w => IMPORTANT_TERMS.has(w)).length;
    const productCount = words.filter(w => ORM_AND_DB_PRODUCTS.has(w)).length;
    const technicalCount = words.filter(w => TECHNICAL_TERMS.has(w)).length;
    
    // Base score for phrase match
    const baseScore = phrase.split(" ").length === 3 ? 10 : 7;
    
    // Weighted bonuses based on term importance
    // Technical concepts are most valuable, then important terms, then products, then technical terms
    const conceptBonus = conceptCount * 4; // Highest weight for concepts like CSRF, trusted origins
    const importantBonus = importantCount * 2.5; // High weight for important terms
    const productBonus = productCount * 3; // High weight for ORM/database products (drizzle, supabase, etc.)
    const technicalBonus = technicalCount * 1.5; // Medium weight for technical terms
    
    weightedScore += baseScore + conceptBonus + importantBonus + productBonus + technicalBonus;
  }
  
  // Score word matches (excluding words already counted in phrases)
  const phraseWordSet = new Set(matchedPhrases.flatMap(p => p.split(" ")));
  for (const term of uniqueMatched) {
    if (phraseWordSet.has(term)) {
      // Already counted in phrase, skip or give smaller bonus
      continue;
    }
    
    // Determine term weight based on category
    let termWeight = 2; // Base weight for exact match
    let partialWeight = 1; // Base weight for partial match
    
    if (TECHNICAL_CONCEPTS.has(term)) {
      // Technical concepts get highest weight (e.g., CSRF, trusted origins, base url)
      termWeight = 6;
      partialWeight = 3;
    } else if (IMPORTANT_TERMS.has(term)) {
      // Important terms get high weight (e.g., name, product, identity)
      termWeight = 4;
      partialWeight = 2;
    } else if (ORM_AND_DB_PRODUCTS.has(term)) {
      // ORM and database product names get high weight (e.g., drizzle, supabase, prisma)
      termWeight = 5;
      partialWeight = 2.5;
    } else if (TECHNICAL_TERMS.has(term)) {
      // Technical terms get medium weight
      termWeight = 3;
      partialWeight = 1.5;
    }
    
    if (exactMatches.has(term)) {
      weightedScore += termWeight;
    } else if (partialMatches.has(term)) {
      weightedScore += partialWeight;
    }
  }
  
  // Normalize score using a more balanced approach
  // Consider both phrase and word matches, but don't penalize too heavily
  const baseScore = weightedScore;
  
  // Base normalization on actual matches found, not theoretical maximum
  // This prevents scores from being too low when we have good matches
  const matchRatio = matchedPhrases.length > 0 || uniqueMatched.size > 0
    ? (matchedPhrases.length + uniqueMatched.size) / Math.max(messageKeywords.length, 1)
    : 0;
  
  // Normalize: base score represents quality, match ratio represents coverage
  const normalizedScore = Math.min((baseScore / Math.max(messageKeywords.length * 2, 10)) * 50 + (matchRatio * 50), 100);
  
  // Boost score if title has strong matches (titles are more important)
  const titleKeywords = extractKeywords(issueTitle);
  const titlePhrases = extractPhrases(titleKeywords);
  const titlePhraseMatches = messagePhrases.filter(p => 
    titlePhrases.includes(p) || issueTitle.toLowerCase().includes(p)
  ).length;
  const titleWordMatches = messageKeywords.filter(k => titleKeywords.includes(k)).length;
  
  const titlePhraseBoost = (titlePhraseMatches / Math.max(messagePhrases.length, 1)) * 25;
  const titleWordBoost = (titleWordMatches / Math.max(messageKeywords.length, 1)) * 15;
  
  const finalScore = Math.min(normalizedScore + titlePhraseBoost + titleWordBoost, 100);
  
  // Combine matched phrases and terms for display
  // Remove words from individual matches that are already in phrases
  const phraseWordSetDisplay = new Set(matchedPhrases.flatMap(p => p.split(" ")));
  const individualTerms = Array.from(uniqueMatched).filter(t => !phraseWordSetDisplay.has(t));
  const allMatchedTerms = [...matchedPhrases.map(p => `"${p}"`), ...individualTerms];
  
  return {
    score: finalScore,
    matchedTerms: allMatchedTerms,
  };
}

/**
 * Match Discord message with GitHub issues from a provided list
 */
export function matchMessageToIssuesFromList(
  message: DiscordMessage,
  issues: GitHubIssue[]
): ClassifiedMessage {
  const messageKeywords = extractKeywords(message.content);
  const messagePhrases = extractPhrases(messageKeywords);
  
  if (messageKeywords.length === 0) {
    return {
      message,
      relatedIssues: [],
    };
  }

  // Calculate similarity for each issue
  const relatedIssues = issues
    .map((issue) => {
      const similarity = calculateSimilarity(
        messageKeywords,
        messagePhrases,
        issue.title,
        issue.body || ""
      );
      return {
        issue,
        similarityScore: similarity.score,
        matchedTerms: similarity.matchedTerms,
      };
    })
    .sort((a, b) => b.similarityScore - a.similarityScore)
    .slice(0, 5); // Top 5 matches

  return {
    message,
    relatedIssues,
  };
}

/**
 * Match Discord message with GitHub issues (legacy - searches GitHub API)
 * @deprecated Use matchMessageToIssuesFromList with cached issues instead
 */
export async function matchMessageToIssues(
  message: DiscordMessage,
  githubToken?: string
): Promise<ClassifiedMessage> {
  const messageKeywords = extractKeywords(message.content);
  
  if (messageKeywords.length === 0) {
    return {
      message,
      relatedIssues: [],
    };
  }

  // Search GitHub issues using the message content as query
  const searchQuery = messageKeywords.slice(0, 5).join(" "); // Use top 5 keywords
  const results = await searchGitHubIssues(searchQuery, githubToken);
  const messagePhrases = extractPhrases(messageKeywords);

  // Calculate similarity for each issue
  const relatedIssues = results.items
    .map((issue) => {
      const similarity = calculateSimilarity(
        messageKeywords,
        messagePhrases,
        issue.title,
        issue.body || ""
      );
      return {
        issue,
        similarityScore: similarity.score,
        matchedTerms: similarity.matchedTerms,
      };
    })
    // Don't filter here - let the caller decide the threshold
    // .filter((match) => match.similarityScore > 5)
    .sort((a, b) => b.similarityScore - a.similarityScore)
    .slice(0, 5); // Top 5 matches

  return {
    message,
    relatedIssues,
  };
}

/**
 * Classify multiple Discord messages using a cached list of issues
 * Uses keyword-based matching by default, or LLM-based semantic matching if enabled
 */
export async function classifyMessagesWithCache(
  messages: DiscordMessage[],
  issues: GitHubIssue[],
  minSimilarity = 20,
  useSemantic = false
): Promise<ClassifiedMessage[]> {
  // Use semantic classification if enabled and available
  if (useSemantic) {
    try {
      const { classifyMessagesSemantic, isLLMClassificationAvailable } = await import("./semantic-classifier.js");
      if (isLLMClassificationAvailable()) {
        return await classifyMessagesSemantic(messages, issues, minSimilarity);
      } else {
        logWarn("Semantic classification requested but OPENAI_API_KEY not found. Falling back to keyword-based classification.");
      }
    } catch (error) {
      logError("Error using semantic classification, falling back to keyword-based:", error);
    }
  }

  // Default to keyword-based classification
  const classified: ClassifiedMessage[] = [];

  for (const message of messages) {
    try {
      const classifiedMsg = matchMessageToIssuesFromList(message, issues);
      
      // Only include messages with at least one related issue above threshold
      if (classifiedMsg.relatedIssues.length > 0) {
        classifiedMsg.relatedIssues = classifiedMsg.relatedIssues.filter(
          (match) => match.similarityScore >= minSimilarity
        );
        
        if (classifiedMsg.relatedIssues.length > 0) {
          classified.push(classifiedMsg);
        }
      }
    } catch (error) {
      logError(`Error classifying message ${message.id}:`, error);
    }
  }

  return classified;
}

/**
 * Classify multiple Discord messages (legacy - searches GitHub API for each message)
 * @deprecated Use classifyMessagesWithCache with cached issues instead
 */
export async function classifyMessages(
  messages: DiscordMessage[],
  githubToken?: string,
  minSimilarity = 20
): Promise<ClassifiedMessage[]> {
  const classified: ClassifiedMessage[] = [];

  for (const message of messages) {
    try {
      const classifiedMsg = await matchMessageToIssues(message, githubToken);
      
      // Only include messages with at least one related issue above threshold
      if (classifiedMsg.relatedIssues.length > 0) {
        classifiedMsg.relatedIssues = classifiedMsg.relatedIssues.filter(
          (match) => match.similarityScore >= minSimilarity
        );
        
        if (classifiedMsg.relatedIssues.length > 0) {
          classified.push(classifiedMsg);
        }
      }
      
      // Add a delay to respect rate limits (longer delay without token)
      const delay = githubToken ? 200 : 2000; // 200ms with token, 2s without
      await new Promise((resolve) => setTimeout(resolve, delay));
    } catch (error) {
      logError(`Error classifying message ${message.id}:`, error);
    }
  }

  return classified;
}

