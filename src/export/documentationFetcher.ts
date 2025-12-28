/**
 * Documentation fetcher
 * Fetches and parses documentation from URLs or local file paths
 * Supports caching via storage backend (database or JSON)
 */

import { log, logError } from "../mcp/logger.js";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join, isAbsolute } from "path";
import { getStorage } from "../storage/factory.js";

export interface DocumentationContent {
  url: string;
  title?: string;
  content: string;
  sections?: Array<{
    title: string;
    content: string;
    url?: string;
  }>;
  fetched_at: string;
}

/**
 * Clean text by removing control characters and other problematic characters
 * Removes: zero-width spaces, zero-width non-joiners, control characters (except newlines/tabs),
 * and other invisible/special characters that might cause issues in database/JSON storage
 */
function cleanText(text: string): string {
  if (!text) return text;
  
  return text
    // Remove zero-width characters
    .replace(/[\u200B-\u200D\uFEFF]/g, "") // Zero-width space, zero-width non-joiner, zero-width joiner, zero-width no-break space
    // Remove control characters except newline (\n), carriage return (\r), and tab (\t)
    .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, "")
    // Remove other problematic Unicode characters
    .replace(/[\u2028-\u2029]/g, "") // Line/paragraph separators (replace with newline)
    .replace(/[\uFFFE-\uFFFF]/g, ""); // Invalid Unicode characters
}

/**
 * Parse HTML content using LLM to extract clean text and structured sections
 * This provides much better results than regex-based parsing
 */
async function parseHTMLWithLLM(
  html: string,
  url: string,
  apiKey?: string
): Promise<{ title?: string; content: string; sections?: Array<{ title: string; content: string; url?: string }> }> {
  const openaiKey = apiKey || process.env.OPENAI_API_KEY;
  
  if (!openaiKey) {
    throw new Error("OPENAI_API_KEY is required for LLM-based HTML parsing");
  }

  // Truncate HTML if too long (OpenAI has token limits)
  // Keep a reasonable amount for context
  const maxHtmlChars = 100000; // ~25k tokens
  const htmlToParse = html.length > maxHtmlChars 
    ? html.substring(0, maxHtmlChars) + "\n\n[... HTML truncated ...]"
    : html;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini", // Using mini for cost efficiency
        messages: [
          {
            role: "system",
            content: `You are an expert at parsing HTML documentation pages. Extract clean, readable text content and identify logical sections.

Your task:
1. Extract the main title from the page (usually in <title> tag or the first major heading)
2. Extract all the main text content, removing navigation, menus, ads, footers, and other non-content elements
3. Identify logical sections based on headings (h1-h6) and their content
4. For each section, provide a clear title and the relevant content

Return a JSON object with this structure:
{
  "title": "Page title",
  "content": "Full clean text content of the page",
  "sections": [
    {
      "title": "Section heading",
      "content": "Section content text"
    }
  ]
}

Focus on actual documentation content. Ignore navigation menus, headers, footers, sidebars, and other UI elements.
Preserve the logical structure and hierarchy of the content.`
          },
          {
            role: "user",
            content: `Parse this HTML documentation page and extract the content and sections:\n\n${htmlToParse}`
          }
        ],
        response_format: { type: "json_object" },
        temperature: 0.1, // Low temperature for consistent, accurate parsing
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    const content = data.choices[0]?.message?.content;
    
    if (!content) {
      throw new Error("No content in OpenAI response");
    }

    const parsed = JSON.parse(content);
    
    // Normalize and clean the response
    const title = parsed.title ? cleanText(parsed.title) : undefined;
    const contentText = cleanText(parsed.content || "");
    const sections = parsed.sections && Array.isArray(parsed.sections)
      ? parsed.sections.map((section: { title?: string; content?: string }) => ({
          title: cleanText(section.title || ""),
          content: cleanText(section.content || ""),
          url: `${url}#${(section.title || "").toLowerCase().replace(/\s+/g, "-")}`,
        })).filter((s: { title: string; content: string; url: string }): s is { title: string; content: string; url: string } => !!s.title && !!s.content)
      : undefined;

    return {
      title,
      content: contentText,
      sections,
    };
  } catch (error) {
    logError("Error parsing HTML with LLM:", error);
    throw error;
  }
}

/**
 * Fetch documentation from a URL or local file path
 * Supports:
 * - HTTP/HTTPS URLs (HTML pages, Markdown files, plain text)
 * - Local file paths (absolute or relative to process.cwd())
 *   - .md, .txt, .html files
 */
export async function fetchDocumentation(urlOrPath: string): Promise<DocumentationContent> {
  try {
    // Log removed to avoid interfering with MCP JSON protocol
    // log(`Fetching documentation from: ${urlOrPath}`);
    
    // Check if it's a URL (starts with http:// or https://)
    const isUrl = urlOrPath.startsWith("http://") || urlOrPath.startsWith("https://");
    
    let content: string;
    let title: string | undefined;
    let sections: Array<{ title: string; content: string; url?: string }> | undefined;
    
    if (isUrl) {
      // Fetch from URL
      const response = await fetch(urlOrPath, {
        headers: {
          "User-Agent": "Discord-MCP-Bot/1.0",
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch documentation: ${response.status} ${response.statusText}`);
      }

      const contentType = response.headers.get("content-type") || "";
      content = await response.text();

      // Extract text content and sections from HTML if needed
      if (contentType.includes("text/html")) {
        // Try LLM-based parsing if API key is available
        const openaiKey = process.env.OPENAI_API_KEY;
        if (openaiKey) {
          try {
            const parsed = await parseHTMLWithLLM(content, urlOrPath, openaiKey);
            title = parsed.title;
            content = parsed.content;
            sections = parsed.sections;
          } catch (error) {
            // Fall back to regex parsing if LLM parsing fails
            logError("LLM parsing failed, falling back to regex parsing:", error);
            const titleMatch = content.match(/<title>(.*?)<\/title>/i);
            if (titleMatch) {
              title = cleanText(titleMatch[1].trim());
            }
            sections = extractSectionsFromHTML(content, urlOrPath);
            content = extractTextFromHTML(content);
          }
        } else {
          // Fall back to regex parsing if no API key
          const titleMatch = content.match(/<title>(.*?)<\/title>/i);
          if (titleMatch) {
            title = cleanText(titleMatch[1].trim());
          }
          sections = extractSectionsFromHTML(content, urlOrPath);
          content = extractTextFromHTML(content);
        }
      }
    } else {
      // Read from local file
      const filePath = isAbsolute(urlOrPath) ? urlOrPath : join(process.cwd(), urlOrPath);
      
      if (!existsSync(filePath)) {
        throw new Error(`Documentation file not found: ${filePath}`);
      }
      
      content = await readFile(filePath, "utf-8");
      
      // Extract title from markdown if it's a .md file
      if (filePath.endsWith(".md")) {
        const titleMatch = content.match(/^#\s+(.+)$/m);
        if (titleMatch) {
          title = cleanText(titleMatch[1].trim());
        }
      }
      
      // Use filename as title if no title found
      if (!title) {
        const fileName = filePath.split("/").pop() || filePath.split("\\").pop();
        title = cleanText(fileName?.replace(/\.[^/.]+$/, "") || urlOrPath);
      }
    }

    // Log removed to avoid interfering with MCP JSON protocol
    // log(`Fetched ${content.length} characters from documentation`);

    return {
      url: urlOrPath,
      title: title ? cleanText(title) : title,
      content: cleanText(content.trim()),
      sections: sections?.map(section => ({
        title: cleanText(section.title),
        content: cleanText(section.content),
        url: section.url,
      })),
      fetched_at: new Date().toISOString(),
    };
  } catch (error) {
    logError(`Error fetching documentation from ${urlOrPath}:`, error);
    throw error;
  }
}

/**
 * Extract sections from HTML based on headings (h1-h6)
 */
function extractSectionsFromHTML(html: string, baseUrl: string): Array<{ title: string; content: string; url?: string }> {
  const sections: Array<{ title: string; content: string; url?: string }> = [];
  
  // Match headings and their content
  // This regex matches h1-h6 tags and captures everything until the next heading
  const headingRegex = /<h([1-6])[^>]*>(.*?)<\/h[1-6]>/gi;
  const headingMatches: Array<{ level: number; title: string; index: number }> = [];
  
  let match;
  while ((match = headingRegex.exec(html)) !== null) {
    const level = parseInt(match[1]);
    let headingText = match[2].replace(/<[^>]+>/g, "").trim(); // Remove any HTML tags from heading
    headingText = cleanText(headingText); // Clean strange characters
    if (headingText) {
      headingMatches.push({
        level,
        title: headingText,
        index: match.index,
      });
    }
  }
  
  // Extract content for each section
  for (let i = 0; i < headingMatches.length; i++) {
    const currentHeading = headingMatches[i];
    const nextHeadingIndex = i < headingMatches.length - 1 
      ? headingMatches[i + 1].index 
      : html.length;
    
    // Extract content between this heading and the next
    const sectionHtml = html.substring(currentHeading.index, nextHeadingIndex);
    
    // Extract text content from this section
    let sectionContent = extractTextFromHTML(sectionHtml);
    
    // Remove the heading text from the content (it's already in the title)
    sectionContent = sectionContent.replace(new RegExp(`^${currentHeading.title}\\s*`, "i"), "").trim();
    
    // Clean strange characters from section content
    sectionContent = cleanText(sectionContent);
    
    if (sectionContent.length > 0) {
      sections.push({
        title: cleanText(currentHeading.title), // Ensure title is clean too
        content: sectionContent,
        url: `${baseUrl}#${currentHeading.title.toLowerCase().replace(/\s+/g, "-")}`,
      });
    }
  }
  
  return sections;
}

/**
 * Extract text content from HTML
 */
function extractTextFromHTML(html: string): string {
  // Remove script and style tags
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  
  // Convert HTML entities
  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  
  // Remove HTML tags but preserve structure with newlines
  text = text.replace(/<h[1-6][^>]*>/gi, "\n\n");
  text = text.replace(/<\/h[1-6]>/gi, "\n");
  text = text.replace(/<p[^>]*>/gi, "\n\n");
  text = text.replace(/<\/p>/gi, "");
  text = text.replace(/<br[^>]*>/gi, "\n");
  text = text.replace(/<div[^>]*>/gi, "\n");
  text = text.replace(/<\/div>/gi, "");
  text = text.replace(/<li[^>]*>/gi, "\n- ");
  text = text.replace(/<\/li>/gi, "");
  text = text.replace(/<ul[^>]*>/gi, "\n");
  text = text.replace(/<\/ul>/gi, "\n");
  text = text.replace(/<ol[^>]*>/gi, "\n");
  text = text.replace(/<\/ol>/gi, "\n");
  
  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");
  
  // Clean up whitespace
  text = text.replace(/\n\s*\n\s*\n/g, "\n\n");
  text = text.replace(/[ \t]+/g, " ");
  text = text.trim();
  
  // Clean strange characters before returning
  text = cleanText(text);
  
  return text;
}

/**
 * Crawl all documentation pages from a base URL
 * Follows links and fetches all pages under the docs path
 * Checks cache for individual pages before fetching
 */
export async function crawlDocumentation(baseUrl: string, maxPages = 100, useCache = true): Promise<DocumentationContent[]> {
  // Log removed to avoid interfering with MCP JSON protocol
  // log(`Crawling documentation from: ${baseUrl} (max ${maxPages} pages)`);
  
  const storage = useCache ? getStorage() : null;
  const visited = new Set<string>();
  const toVisit: string[] = [baseUrl];
  const results: DocumentationContent[] = [];
  
  while (toVisit.length > 0 && visited.size < maxPages) {
    const currentUrl = toVisit.shift()!;
    
    if (visited.has(currentUrl)) {
      continue;
    }
    
    visited.add(currentUrl);
    
    // Check cache first
    if (storage) {
      const cached = await storage.getDocumentation(currentUrl);
      if (cached) {
        results.push(cached);
        // Still extract links from cached content to discover new pages
        // For now, we'll need to fetch the HTML to extract links, but we can optimize this later
        // by storing links in the cache or parsing from cached content
        try {
          const response = await fetch(currentUrl, {
            headers: {
              "User-Agent": "Discord-MCP-Bot/1.0",
            },
          });
          if (response.ok) {
            const rawHtml = await response.text();
            const links = extractLinksFromHTML(rawHtml, baseUrl);
            for (const link of links) {
              const normalizedLink = link.split("#")[0].replace(/\/$/, "");
              if (normalizedLink.startsWith(baseUrl.replace(/\/$/, "")) && 
                  !visited.has(normalizedLink) && 
                  !toVisit.includes(normalizedLink)) {
                toVisit.push(normalizedLink);
              }
            }
          }
        } catch (error) {
          // If we can't fetch for link extraction, continue with cached content
        }
        continue;
      }
    }
    
    try {
      // Log removed to avoid interfering with MCP JSON protocol
      // log(`Fetching: ${currentUrl} (${visited.size}/${maxPages})`);
      
      // Fetch raw HTML first to extract links
      const response = await fetch(currentUrl, {
        headers: {
          "User-Agent": "Discord-MCP-Bot/1.0",
        },
      });

      if (!response.ok) {
        logError(`Failed to fetch ${currentUrl}: ${response.status} ${response.statusText}`);
        continue;
      }

      const contentType = response.headers.get("content-type") || "";
      const rawHtml = await response.text();
      
      // Extract links from raw HTML before processing
      const links = extractLinksFromHTML(rawHtml, baseUrl);
      for (const link of links) {
        // Normalize the link (remove fragments, trailing slashes)
        const normalizedLink = link.split("#")[0].replace(/\/$/, "");
        // Only follow links that are under the docs path
        if (normalizedLink.startsWith(baseUrl.replace(/\/$/, "")) && 
            !visited.has(normalizedLink) && 
            !toVisit.includes(normalizedLink)) {
          toVisit.push(normalizedLink);
        }
      }
      
      // Now process the content for the documentation
      let content = rawHtml;
      let title: string | undefined;
      let sections: Array<{ title: string; content: string; url?: string }> | undefined;
      
      if (contentType.includes("text/html")) {
        // Try LLM-based parsing if API key is available
        const openaiKey = process.env.OPENAI_API_KEY;
        if (openaiKey) {
          try {
            const parsed = await parseHTMLWithLLM(rawHtml, currentUrl, openaiKey);
            title = parsed.title;
            content = parsed.content;
            sections = parsed.sections;
          } catch (error) {
            // Fall back to regex parsing if LLM parsing fails
            logError(`LLM parsing failed for ${currentUrl}, falling back to regex parsing:`, error);
            const titleMatch = rawHtml.match(/<title>(.*?)<\/title>/i);
            if (titleMatch) {
              title = cleanText(titleMatch[1].trim());
            }
            sections = extractSectionsFromHTML(rawHtml, currentUrl);
            content = extractTextFromHTML(rawHtml);
          }
        } else {
          // Fall back to regex parsing if no API key
          const titleMatch = rawHtml.match(/<title>(.*?)<\/title>/i);
          if (titleMatch) {
            title = cleanText(titleMatch[1].trim());
          }
          sections = extractSectionsFromHTML(rawHtml, currentUrl);
          content = extractTextFromHTML(rawHtml);
        }
      }
      
      const doc: DocumentationContent = {
        url: currentUrl,
        title: title ? cleanText(title) : title,
        content: cleanText(content.trim()),
        sections: sections?.map(section => ({
          title: cleanText(section.title),
          content: cleanText(section.content),
          url: section.url,
        })),
        fetched_at: new Date().toISOString(),
      };
      
      results.push(doc);
      
      // Cache immediately
      if (storage) {
        try {
          await storage.saveDocumentation(doc);
        } catch (error) {
          // Continue even if caching fails
        }
      }
      
    } catch (error) {
      logError(`Failed to fetch ${currentUrl}:`, error);
    }
    
    // Small delay to be respectful (only for actual fetches, not cached)
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  
  // Log removed to avoid interfering with MCP JSON protocol
  // log(`Crawled ${results.length} documentation pages`);
  return results;
}

/**
 * Extract links from HTML content
 */
function extractLinksFromHTML(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
  
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1];
    
    // Skip anchors, mailto, tel, etc.
    if (href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) {
      continue;
    }
    
    // Resolve relative URLs
    try {
      const resolvedUrl = new URL(href, baseUrl);
      const baseUrlObj = new URL(baseUrl);
      
      // Only include links that are on the same domain and under /docs path
      if (resolvedUrl.hostname === baseUrlObj.hostname && 
          (resolvedUrl.pathname.startsWith("/docs") || resolvedUrl.pathname.startsWith(baseUrlObj.pathname))) {
        links.push(resolvedUrl.href);
      }
    } catch {
      // Invalid URL, skip
    }
  }
  
  return [...new Set(links)]; // Remove duplicates
}

/**
 * Fetch multiple documentation URLs or crawl docs directories
 * If a URL ends with /docs, it will crawl all pages under it
 * Uses cached documentation if available, otherwise fetches and caches
 */
export async function fetchMultipleDocumentation(urls: string[], crawlDocs = true, useCache = true): Promise<DocumentationContent[]> {
  const storage = getStorage();
  const results: DocumentationContent[] = [];
  const urlsToFetch: string[] = [];
  
  // Check cache first if enabled
  if (useCache) {
    const cachedDocs = await storage.getDocumentationMultiple(urls);
    const cachedUrls = new Set(cachedDocs.map(d => d.url));
    
    // Add cached docs to results
    results.push(...cachedDocs);
    
    // Find URLs that need to be fetched
    for (const urlOrPath of urls) {
      if (!cachedUrls.has(urlOrPath)) {
        urlsToFetch.push(urlOrPath);
      }
    }
  } else {
    urlsToFetch.push(...urls);
  }
  
  // Fetch missing documentation
  const fetchedDocs: DocumentationContent[] = [];
  for (const urlOrPath of urlsToFetch) {
    try {
      // Check if it's a docs directory URL that should be crawled
      if (crawlDocs && urlOrPath.startsWith("http") && (urlOrPath.endsWith("/docs") || urlOrPath.includes("/docs/"))) {
        // Log removed to avoid interfering with MCP JSON protocol
        // log(`Crawling docs directory: ${urlOrPath}`);
        const crawledDocs = await crawlDocumentation(urlOrPath);
        fetchedDocs.push(...crawledDocs);
      } else {
        // Single page fetch
        const doc = await fetchDocumentation(urlOrPath);
        fetchedDocs.push(doc);
      }
    } catch (error) {
      logError(`Failed to fetch ${urlOrPath}:`, error);
    }
  }
  
  // Cache fetched documentation
  if (fetchedDocs.length > 0 && useCache) {
    try {
      await storage.saveDocumentationMultiple(fetchedDocs);
    } catch (error) {
      logError("Failed to cache documentation:", error);
      // Continue even if caching fails
    }
  }
  
  // Combine cached and fetched results
  results.push(...fetchedDocs);
  
  return results;
}

