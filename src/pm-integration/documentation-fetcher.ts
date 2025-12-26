/**
 * Documentation fetcher
 * Fetches and parses documentation from URLs or local file paths
 */

import { log, logError } from "../logger.js";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join, isAbsolute } from "path";

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
 * Fetch documentation from a URL or local file path
 * Supports:
 * - HTTP/HTTPS URLs (HTML pages, Markdown files, plain text)
 * - Local file paths (absolute or relative to process.cwd())
 *   - .md, .txt, .html files
 */
export async function fetchDocumentation(urlOrPath: string): Promise<DocumentationContent> {
  try {
    log(`Fetching documentation from: ${urlOrPath}`);
    
    // Check if it's a URL (starts with http:// or https://)
    const isUrl = urlOrPath.startsWith("http://") || urlOrPath.startsWith("https://");
    
    let content: string;
    let title: string | undefined;
    
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

      // Extract text content from HTML if needed
      if (contentType.includes("text/html")) {
        content = extractTextFromHTML(content);
        
        // Extract title from HTML if available
        const titleMatch = content.match(/<title>(.*?)<\/title>/i);
        if (titleMatch) {
          title = titleMatch[1].trim();
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
          title = titleMatch[1].trim();
        }
      }
      
      // Use filename as title if no title found
      if (!title) {
        const fileName = filePath.split("/").pop() || filePath.split("\\").pop();
        title = fileName?.replace(/\.[^/.]+$/, "") || urlOrPath;
      }
    }

    log(`Fetched ${content.length} characters from documentation`);

    return {
      url: urlOrPath,
      title,
      content: content.trim(),
      fetched_at: new Date().toISOString(),
    };
  } catch (error) {
    logError(`Error fetching documentation from ${urlOrPath}:`, error);
    throw error;
  }
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
  
  return text;
}

/**
 * Crawl all documentation pages from a base URL
 * Follows links and fetches all pages under the docs path
 */
export async function crawlDocumentation(baseUrl: string, maxPages = 100): Promise<DocumentationContent[]> {
  log(`Crawling documentation from: ${baseUrl} (max ${maxPages} pages)`);
  
  const visited = new Set<string>();
  const toVisit: string[] = [baseUrl];
  const results: DocumentationContent[] = [];
  
  while (toVisit.length > 0 && visited.size < maxPages) {
    const currentUrl = toVisit.shift()!;
    
    if (visited.has(currentUrl)) {
      continue;
    }
    
    visited.add(currentUrl);
    
    try {
      log(`Fetching: ${currentUrl} (${visited.size}/${maxPages})`);
      
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
      
      if (contentType.includes("text/html")) {
        // Extract title before processing HTML
        const titleMatch = rawHtml.match(/<title>(.*?)<\/title>/i);
        if (titleMatch) {
          title = titleMatch[1].trim();
        }
        
        content = extractTextFromHTML(rawHtml);
      }
      
      results.push({
        url: currentUrl,
        title,
        content: content.trim(),
        fetched_at: new Date().toISOString(),
      });
      
    } catch (error) {
      logError(`Failed to fetch ${currentUrl}:`, error);
    }
    
    // Small delay to be respectful
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  
  log(`Crawled ${results.length} documentation pages`);
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
 */
export async function fetchMultipleDocumentation(urls: string[], crawlDocs = true): Promise<DocumentationContent[]> {
  const results: DocumentationContent[] = [];
  
  for (const urlOrPath of urls) {
    try {
      // Check if it's a docs directory URL that should be crawled
      if (crawlDocs && urlOrPath.startsWith("http") && (urlOrPath.endsWith("/docs") || urlOrPath.includes("/docs/"))) {
        log(`Crawling docs directory: ${urlOrPath}`);
        const crawledDocs = await crawlDocumentation(urlOrPath);
        results.push(...crawledDocs);
      } else {
        // Single page fetch
        const doc = await fetchDocumentation(urlOrPath);
        results.push(doc);
      }
    } catch (error) {
      logError(`Failed to fetch ${urlOrPath}:`, error);
    }
  }
  
  return results;
}

