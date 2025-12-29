/**
 * Fetch code files from GitHub repository to enhance feature understanding
 */

import { log } from "../../mcp/logger.js";

export interface GitHubRepoInfo {
  owner: string;
  repo: string;
}

/**
 * Parse GitHub repository URL to extract owner and repo
 */
export function parseGitHubRepoUrl(url: string): GitHubRepoInfo | null {
  try {
    // Handle various GitHub URL formats:
    // https://github.com/owner/repo
    // https://github.com/owner/repo.git
    // git@github.com:owner/repo.git
    // owner/repo
    
    let cleanUrl = url.trim();
    
    // Remove .git suffix
    if (cleanUrl.endsWith('.git')) {
      cleanUrl = cleanUrl.slice(0, -4);
    }
    
    // Handle git@ format
    if (cleanUrl.startsWith('git@github.com:')) {
      cleanUrl = cleanUrl.replace('git@github.com:', 'https://github.com/');
    }
    
    // Handle https:// or http://
    if (cleanUrl.startsWith('https://github.com/') || cleanUrl.startsWith('http://github.com/')) {
      cleanUrl = cleanUrl.replace(/^https?:\/\/github\.com\//, '');
    }
    
    // Handle github.com/ format
    if (cleanUrl.startsWith('github.com/')) {
      cleanUrl = cleanUrl.replace('github.com/', '');
    }
    
    const parts = cleanUrl.split('/').filter(Boolean);
    if (parts.length >= 2) {
      return {
        owner: parts[0],
        repo: parts[1],
      };
    }
    
    return null;
  } catch (error) {
    log(`Failed to parse GitHub repo URL: ${url} - ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Fetch file tree from GitHub repository
 * Returns relevant code files that might help understand features
 */
export async function fetchRepositoryCodeContext(
  repoInfo: GitHubRepoInfo,
  token?: string,
  maxFiles: number = 20
): Promise<string> {
  const { owner, repo } = repoInfo;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    // Fetch repository tree (main/master branch)
    const branchesResponse = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/branches`,
      { headers }
    );

    if (!branchesResponse.ok) {
      throw new Error(`GitHub API error: ${branchesResponse.status} ${branchesResponse.statusText}`);
    }

    const branches = await branchesResponse.json();
    const defaultBranch = branches.find((b: { name: string }) => b.name === 'main' || b.name === 'master') || branches[0];
    
    if (!defaultBranch) {
      throw new Error("No branches found in repository");
    }

    // Fetch tree recursively
    const treeResponse = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${defaultBranch.commit.sha}?recursive=1`,
      { headers }
    );

    if (!treeResponse.ok) {
      throw new Error(`GitHub API error: ${treeResponse.status} ${treeResponse.statusText}`);
    }

    const tree = await treeResponse.json();
    
    // Filter for relevant code files (exclude node_modules, dist, etc.)
    const codeExtensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.kt'];
    const excludeDirs = ['node_modules', 'dist', 'build', '.git', 'coverage', '.next', '.nuxt', 'vendor'];
    
    const relevantFiles = tree.tree
      .filter((item: { path: string; type: string }) => {
        if (item.type !== 'blob') return false;
        const path = item.path.toLowerCase();
        return codeExtensions.some(ext => path.endsWith(ext)) &&
               !excludeDirs.some(dir => path.includes(`/${dir}/`) || path.startsWith(`${dir}/`));
      })
      .slice(0, maxFiles);

    // Fetch content for relevant files
    const codeContexts: string[] = [];
    
    for (const file of relevantFiles) {
      try {
        const fileResponse = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/${file.path}`,
          { headers }
        );

        if (fileResponse.ok) {
          const fileData = await fileResponse.json();
          if (fileData.content && fileData.encoding === 'base64') {
            const content = Buffer.from(fileData.content, 'base64').toString('utf-8');
            // Extract key information: function names, class names, exports, API routes
            const keyInfo = extractKeyCodeInfo(content, file.path);
            if (keyInfo) {
              codeContexts.push(`File: ${file.path}\n${keyInfo}`);
            }
          }
        }
      } catch (error) {
        // Skip files that fail to fetch
        log(`Failed to fetch file ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return codeContexts.join('\n\n');
  } catch (error) {
    log(`Failed to fetch repository code context: ${error instanceof Error ? error.message : String(error)}`);
    return '';
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
  
  return keyInfo.length > 0 ? keyInfo.join('\n') : null;
}

