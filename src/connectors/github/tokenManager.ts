/**
 * GitHub Token Manager with rotation support
 * Handles multiple tokens and rotates when rate limits are hit
 * Also supports GitHub App authentication
 */

import type { GitHubAppAuth } from "./githubAppAuth.js";

interface TokenInfo {
  token: string;
  remaining: number;
  limit: number;
  resetAt: number; // timestamp in ms
  lastUsed: number; // timestamp in ms
  isAppToken?: boolean; // true if this is a GitHub App installation token
}

export class GitHubTokenManager {
  private tokens: TokenInfo[] = [];
  private currentIndex = 0;
  private githubAppAuths: GitHubAppAuth[] = [];
  private currentAppIndex = 0;

  constructor(tokens: string[], githubAppAuths: GitHubAppAuth[] = []) {
    // Filter out empty tokens and initialize
    this.tokens = tokens
      .filter(t => t && t.trim().length > 0)
      .map(token => ({
        token: token.trim(),
        remaining: 5000, // Assume full limit initially
        limit: 5000,
        resetAt: Date.now() + 3600000, // 1 hour from now
        lastUsed: 0,
        isAppToken: false,
      }));
    
    this.githubAppAuths = githubAppAuths;
    
    if (this.tokens.length === 0 && this.githubAppAuths.length === 0) {
      throw new Error('No valid GitHub tokens or GitHub Apps provided');
    }
    
    const totalSources = this.tokens.length + this.githubAppAuths.length;
    console.error(`[GitHub Token Manager] Initialized with ${this.tokens.length} token(s) and ${this.githubAppAuths.length} GitHub App installation(s) (total: ${totalSources})`);
  }

  /**
   * Get the current active token
   * If using GitHub App, fetches a fresh installation token
   */
  async getCurrentToken(): Promise<string> {
    // If we have GitHub Apps, try to get token from them first
    if (this.githubAppAuths.length > 0) {
      try {
        const appAuth = this.githubAppAuths[this.currentAppIndex];
        const token = await appAuth.getInstallationToken();
        
        // Check if we already have this token in our list
        const existingToken = this.tokens.find(t => t.isAppToken && t.token === token);
        if (existingToken) {
          return token;
        }
        
        // Add the app token to our list if not already there
        this.tokens.push({
          token,
          remaining: 5000,
          limit: 5000,
          resetAt: Date.now() + 3600000,
          lastUsed: Date.now(),
          isAppToken: true,
        });
        
        return token;
      } catch (error) {
        console.error(`[GitHub Token Manager] Failed to get token from GitHub App, falling back to regular tokens: ${error}`);
        // Fall through to regular tokens
      }
    }
    
    // Fall back to regular tokens
    if (this.tokens.length > 0) {
      return this.tokens[this.currentIndex].token;
    }
    
    throw new Error('No tokens available');
  }

  /**
   * Get all available tokens (for fallback scenarios)
   */
  getAllTokens(): string[] {
    return this.tokens.map(t => t.token);
  }

  /**
   * Update rate limit info for the current token from API response
   */
  updateRateLimitFromResponse(response: Response): void {
    const remaining = response.headers.get('X-RateLimit-Remaining');
    const limit = response.headers.get('X-RateLimit-Limit');
    const reset = response.headers.get('X-RateLimit-Reset');

    if (remaining !== null && limit && reset) {
      const tokenInfo = this.tokens[this.currentIndex];
      tokenInfo.remaining = parseInt(remaining);
      tokenInfo.limit = parseInt(limit);
      tokenInfo.resetAt = parseInt(reset) * 1000;
      tokenInfo.lastUsed = Date.now();
      
      console.error(`[GitHub Token Manager] Token ${this.currentIndex + 1}/${this.tokens.length}: ${tokenInfo.remaining}/${tokenInfo.limit} remaining`);
    }
  }

  /**
   * Check if current token has available requests
   */
  hasAvailableRequests(): boolean {
    if (this.tokens.length === 0) {
      // If we have GitHub Apps, assume they're available
      return this.githubAppAuths.length > 0;
    }
    
    const tokenInfo = this.tokens[this.currentIndex];
    return this.hasAvailableRequestsForToken(tokenInfo);
  }

  /**
   * Get the next available token, rotating if necessary
   * Returns null if no tokens are available
   * For GitHub Apps, automatically fetches fresh tokens
   * Falls back between GitHub App tokens and regular tokens when rate limits are hit
   */
  async getNextAvailableToken(): Promise<string | null> {
    // Try both GitHub Apps and regular tokens, checking availability
    const allTokenSources: Array<{ type: 'app' | 'token'; index: number; tokenInfo?: TokenInfo }> = [];
    
    // Add GitHub App sources
    for (let i = 0; i < this.githubAppAuths.length; i++) {
      allTokenSources.push({ type: 'app', index: i });
    }
    
    // Add regular token sources (excluding app tokens that are already in the list)
    for (let i = 0; i < this.tokens.length; i++) {
      if (!this.tokens[i].isAppToken) {
        allTokenSources.push({ type: 'token', index: i, tokenInfo: this.tokens[i] });
      }
    }
    
    // Try each source, starting from current indices
    const startAppIndex = this.currentAppIndex;
    const startTokenIndex = this.currentIndex;
    let attempts = 0;
    const maxAttempts = allTokenSources.length * 2; // Try all sources twice
    
    while (attempts < maxAttempts) {
      // Try GitHub Apps first if available
      if (this.githubAppAuths.length > 0) {
        try {
          const appAuth = this.githubAppAuths[this.currentAppIndex];
          const token = await appAuth.getInstallationToken();
          
          // Check if we have this token in cache and check its rate limit status
          const existingToken = this.tokens.find(t => t.isAppToken && t.token === token);
          if (existingToken) {
            // Check if this cached app token has available requests
            if (this.hasAvailableRequestsForToken(existingToken)) {
              return token;
            } else {
              // App token exhausted, try next app or fall back to regular tokens
              console.error(`[GitHub Token Manager] GitHub App ${this.currentAppIndex + 1} token exhausted (${existingToken.remaining} remaining, resets in ${Math.ceil((existingToken.resetAt - Date.now()) / 1000 / 60)} min), trying next source...`);
              this.currentAppIndex = (this.currentAppIndex + 1) % this.githubAppAuths.length;
              attempts++;
              // Fall through to try regular tokens
            }
          } else {
            // Fresh app token, use it (assume it has available requests)
            return token;
          }
        } catch (error) {
          console.error(`[GitHub Token Manager] Failed to get token from GitHub App ${this.currentAppIndex + 1}: ${error}`);
          this.currentAppIndex = (this.currentAppIndex + 1) % this.githubAppAuths.length;
          attempts++;
          // Fall through to try regular tokens
        }
      }
      
      // Try regular tokens
      if (this.tokens.length > 0) {
        // Find next non-app token
        let tokenAttempts = 0;
        while (tokenAttempts < this.tokens.length) {
          const tokenInfo = this.tokens[this.currentIndex];
          
          // Skip app tokens (they're handled above)
          if (tokenInfo.isAppToken) {
            this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
            tokenAttempts++;
            continue;
          }
          
          // Check if this token is available
          if (this.hasAvailableRequestsForToken(tokenInfo)) {
            return tokenInfo.token;
          }
          
          // Token exhausted, try next one
          console.error(`[GitHub Token Manager] Regular token ${this.currentIndex + 1} exhausted (${tokenInfo.remaining} remaining, resets in ${Math.ceil((tokenInfo.resetAt - Date.now()) / 1000 / 60)} min), trying next source...`);
          this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
          tokenAttempts++;
          attempts++;
          
          // After trying all regular tokens, try apps again (they might have reset)
          if (tokenAttempts >= this.tokens.filter(t => !t.isAppToken).length) {
            break; // Break to outer loop to try apps again
          }
        }
      }
      
      attempts++;
      
      // If we've tried everything, check if we should wait or give up
      if (attempts >= maxAttempts) {
        break;
      }
    }
    
    // All tokens exhausted - calculate next reset time
    const allTokens = this.tokens;
    const appTokens = allTokens.filter(t => t.isAppToken);
    const regularTokens = allTokens.filter(t => !t.isAppToken);
    
    const resetTimes: number[] = [];
    if (appTokens.length > 0) {
      resetTimes.push(...appTokens.map(t => t.resetAt));
    }
    if (regularTokens.length > 0) {
      resetTimes.push(...regularTokens.map(t => t.resetAt));
    }
    
    if (resetTimes.length > 0) {
      const nextReset = Math.min(...resetTimes);
      const waitMinutes = Math.ceil((nextReset - Date.now()) / 1000 / 60);
      console.error(`[GitHub Token Manager] All tokens (GitHub App and regular) exhausted. Next reset in ~${waitMinutes} minutes`);
    } else {
      console.error(`[GitHub Token Manager] All tokens exhausted.`);
    }
    
    return null;
  }

  /**
   * Check if a specific token has available requests
   */
  private hasAvailableRequestsForToken(tokenInfo: TokenInfo): boolean {
    // If reset time has passed, assume limit is reset
    if (Date.now() >= tokenInfo.resetAt) {
      tokenInfo.remaining = tokenInfo.limit;
      tokenInfo.resetAt = Date.now() + 3600000;
      return true;
    }
    
    return tokenInfo.remaining > 0;
  }

  /**
   * Rotate to next token (even if current is available)
   * Useful for load balancing
   */
  rotateToken(): void {
    this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
  }

  /**
   * Get status of all tokens
   */
  getStatus(): Array<{ index: number; remaining: number; limit: number; resetIn: number }> {
    return this.tokens.map((token, index) => {
      const resetIn = Math.max(0, Math.ceil((token.resetAt - Date.now()) / 1000 / 60));
      return {
        index: index + 1,
        remaining: token.remaining,
        limit: token.limit,
        resetIn,
      };
    });
  }

  /**
   * Add a new token to the manager
   */
  addToken(token: string): void {
    this.tokens.push({
      token: token.trim(),
      remaining: 5000,
      limit: 5000,
      resetAt: Date.now() + 3600000,
      lastUsed: 0,
    });
    console.error(`[GitHub Token Manager] Added new token. Total: ${this.tokens.length}`);
  }

  /**
   * Check if all tokens are exhausted
   */
  areAllTokensExhausted(): boolean {
    return this.tokens.every(token => {
      if (Date.now() >= token.resetAt) {
        token.remaining = token.limit;
        token.resetAt = Date.now() + 3600000;
        return false;
      }
      return token.remaining === 0;
    });
  }

  /**
   * Create token manager from environment variable only
   * Supports comma-separated tokens: GITHUB_TOKEN=token1,token2,token3
   * Also supports GitHub Apps: GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY_PATH
   * Tokens are kept in memory only - no database persistence
   */
  static async fromEnvironment(): Promise<GitHubTokenManager | null> {
    // Get tokens from environment
    const tokenEnv = process.env.GITHUB_TOKEN;
    const envTokens = tokenEnv 
      ? tokenEnv.split(',').map(t => t.trim()).filter(t => t.length > 0)
      : [];
    
    // Get GitHub App auths
    const { GitHubAppAuth } = await import("./githubAppAuth.js");
    const githubAppAuths = GitHubAppAuth.fromEnvironmentMultiple();
    
    if (envTokens.length === 0 && githubAppAuths.length === 0) {
      // No tokens or apps in environment - will request via OAuth when needed
      return null;
    }

    try {
      const manager = new GitHubTokenManager(envTokens, githubAppAuths);
      return manager;
    } catch (error) {
      console.error(`[GitHub Token Manager] Failed to initialize: ${error}`);
      return null;
    }
  }
}

