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
    
    console.error(`[GitHub Token Manager] Initialized with ${this.tokens.length} PAT(s) and ${this.githubAppAuths.length} GitHub App(s)`);
  }

  /**
   * Get the current active token
   * Strategy: GitHub App (primary) -> PAT (fallback for user-context or when App exhausted)
   * Automatically skips exhausted tokens
   */
  async getCurrentToken(): Promise<string> {
    // Primary: GitHub App installation token (only if not exhausted)
    if (this.githubAppAuths.length > 0) {
      try {
        const appAuth = this.githubAppAuths[this.currentAppIndex];
        const token = await appAuth.getInstallationToken();
        
        // Check if we already have this token in our list
        const existingToken = this.tokens.find(t => t.isAppToken && t.token === token);
        if (existingToken) {
          // Check if this token is exhausted - silently fall through to PAT if so
          if (this.hasAvailableRequestsForToken(existingToken)) {
            return token;
          }
          // App token exhausted, fall through to PAT (no log - would be too noisy)
        } else {
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
        }
      } catch (error) {
        console.error(`[GitHub Token Manager] Failed to get token from GitHub App, falling back to PAT: ${error}`);
        // Fall through to regular tokens
      }
    }
    
    // Fallback: Regular PAT tokens (find first with available requests)
    const regularTokens = this.tokens.filter(t => !t.isAppToken);
    for (const tokenInfo of regularTokens) {
      if (this.hasAvailableRequestsForToken(tokenInfo)) {
        return tokenInfo.token;
      }
    }
    
    // All tokens exhausted - return first regular token anyway (let the API call fail and trigger rotation)
    if (regularTokens.length > 0) {
      return regularTokens[0].token;
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
   * Update rate limit info for a token from API response
   * If tokenString is provided, finds the matching token; otherwise uses current token
   */
  updateRateLimitFromResponse(response: Response, tokenString?: string): void {
    const remaining = response.headers.get('X-RateLimit-Remaining');
    const limit = response.headers.get('X-RateLimit-Limit');
    const reset = response.headers.get('X-RateLimit-Reset');

    if (remaining !== null && limit && reset) {
      let tokenInfo: TokenInfo | undefined;
      
      if (tokenString) {
        // Find the token that was actually used
        tokenInfo = this.tokens.find(t => t.token === tokenString);
      }
      
      // If not found by string or no string provided, use current token
      if (!tokenInfo && this.tokens.length > 0) {
        tokenInfo = this.tokens[this.currentIndex];
      }
      
      if (tokenInfo) {
        tokenInfo.remaining = parseInt(remaining);
        tokenInfo.limit = parseInt(limit);
        tokenInfo.resetAt = parseInt(reset) * 1000;
        tokenInfo.lastUsed = Date.now();
        
        const tokenType = tokenInfo.isAppToken ? 'GitHub App' : 'regular';
        const tokenIndex = this.tokens.indexOf(tokenInfo) + 1;
        console.error(`[GitHub Token Manager] ${tokenType} token ${tokenIndex}/${this.tokens.length}: ${tokenInfo.remaining}/${tokenInfo.limit} remaining`);
      }
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
   * Get the next available token with proper fallback strategy
   * Strategy: GitHub App (primary) -> PAT (fallback when App exhausted)
   * Returns null if all tokens are exhausted
   */
  async getNextAvailableToken(): Promise<string | null> {
    const regularTokenCount = this.tokens.filter(t => !t.isAppToken).length;
    const appTokenCount = this.tokens.filter(t => t.isAppToken).length;
    
    console.error(`[GitHub Token Manager] Checking token availability...`);
    console.error(`[GitHub Token Manager]   - GitHub Apps configured: ${this.githubAppAuths.length}`);
    console.error(`[GitHub Token Manager]   - Regular PATs: ${regularTokenCount}`);
    console.error(`[GitHub Token Manager]   - App tokens cached: ${appTokenCount}`);
    
    // Primary: Try GitHub App tokens first (they have separate rate limits per installation)
    if (this.githubAppAuths.length > 0) {
      const appToken = await this.tryGetAppToken();
      if (appToken) {
        return appToken;
      }
      console.error(`[GitHub Token Manager] All GitHub App tokens exhausted, falling back to PAT...`);
    }
    
    // Fallback: Try regular PAT tokens
    const patToken = this.tryGetRegularToken();
    if (patToken) {
      return patToken;
    }
    
    // All tokens exhausted - log reset times
    this.logExhaustedTokens();
    return null;
  }

  /**
   * Try to get an available GitHub App token
   * Returns null if no app tokens are available
   */
  private async tryGetAppToken(): Promise<string | null> {
    if (this.githubAppAuths.length === 0) {
      return null;
    }
    
    // Try each GitHub App installation
    for (let i = 0; i < this.githubAppAuths.length; i++) {
      const appIndex = (this.currentAppIndex + i) % this.githubAppAuths.length;
      
      try {
        const appAuth = this.githubAppAuths[appIndex];
        const token = await appAuth.getInstallationToken();
        
        // Check if we have this token in cache with rate limit info
        const existingToken = this.tokens.find(t => t.isAppToken && t.token === token);
        
        if (existingToken) {
          const isAvailable = this.hasAvailableRequestsForToken(existingToken);
          const resetMin = Math.ceil((existingToken.resetAt - Date.now()) / 1000 / 60);
          
          if (isAvailable) {
            console.error(`[GitHub Token Manager] GitHub App token: ${existingToken.remaining}/${existingToken.limit} remaining (reset in ${resetMin} min)`);
            return token;
          } else {
            console.error(`[GitHub Token Manager] GitHub App token exhausted: 0/${existingToken.limit} (reset in ${resetMin} min)`);
          }
        } else {
          // Fresh app token - add to cache and use it
          console.error(`[GitHub Token Manager] Fresh GitHub App token obtained`);
          this.tokens.push({
            token,
            remaining: 5000,
            limit: 5000,
            resetAt: Date.now() + 3600000,
            lastUsed: Date.now(),
            isAppToken: true,
          });
          return token;
        }
      } catch (error) {
        console.error(`[GitHub Token Manager] GitHub App ${appIndex + 1} error: ${error}`);
      }
    }
    
    return null;
  }

  /**
   * Try to get an available regular PAT token
   * Returns null if no PAT tokens are available
   */
  private tryGetRegularToken(): string | null {
    const regularTokens = this.tokens.filter(t => !t.isAppToken);
    
    if (regularTokens.length === 0) {
      return null;
    }
    
    // Find first available PAT
    for (let i = 0; i < regularTokens.length; i++) {
      const tokenInfo = regularTokens[i];
      const isAvailable = this.hasAvailableRequestsForToken(tokenInfo);
      const resetMin = Math.ceil((tokenInfo.resetAt - Date.now()) / 1000 / 60);
      
      if (isAvailable) {
        console.error(`[GitHub Token Manager] PAT ${i + 1}: ${tokenInfo.remaining}/${tokenInfo.limit} remaining (reset in ${resetMin} min)`);
        return tokenInfo.token;
      } else {
        console.error(`[GitHub Token Manager] PAT ${i + 1} exhausted: 0/${tokenInfo.limit} (reset in ${resetMin} min)`);
      }
    }
    
    return null;
  }

  /**
   * Log details about exhausted tokens for debugging
   */
  private logExhaustedTokens(): void {
    const appTokens = this.tokens.filter(t => t.isAppToken);
    const regularTokens = this.tokens.filter(t => !t.isAppToken);
    
    const resetTimes: number[] = [];
    
    if (appTokens.length > 0) {
      console.error(`[GitHub Token Manager] GitHub App tokens exhausted:`);
      appTokens.forEach((t, i) => {
        const resetMin = Math.ceil((t.resetAt - Date.now()) / 1000 / 60);
        console.error(`[GitHub Token Manager]   - App ${i + 1}: reset in ${resetMin} min`);
        resetTimes.push(t.resetAt);
      });
    }
    
    if (regularTokens.length > 0) {
      console.error(`[GitHub Token Manager] PAT tokens exhausted:`);
      regularTokens.forEach((t, i) => {
        const resetMin = Math.ceil((t.resetAt - Date.now()) / 1000 / 60);
        console.error(`[GitHub Token Manager]   - PAT ${i + 1}: reset in ${resetMin} min`);
        resetTimes.push(t.resetAt);
      });
    }
    
    if (resetTimes.length > 0) {
      const nextReset = Math.min(...resetTimes);
      const waitMinutes = Math.ceil((nextReset - Date.now()) / 1000 / 60);
      console.error(`[GitHub Token Manager] All tokens exhausted. Earliest reset in ~${waitMinutes} minutes`);
    } else {
      console.error(`[GitHub Token Manager] No tokens available.`);
    }
  }

  /**
   * Check if a specific token has available requests
   * @param minRemaining Minimum remaining requests to consider "available" (default: 1)
   */
  private hasAvailableRequestsForToken(tokenInfo: TokenInfo, minRemaining: number = 1): boolean {
    // If reset time has passed, assume limit is reset
    if (Date.now() >= tokenInfo.resetAt) {
      tokenInfo.remaining = tokenInfo.limit;
      tokenInfo.resetAt = Date.now() + 3600000;
      return true;
    }
    
    return tokenInfo.remaining >= minRemaining;
  }

  /**
   * Check if we should proactively rotate to avoid hitting rate limit
   * Returns true if current token has <= threshold remaining
   */
  shouldRotateProactively(tokenString?: string, threshold: number = 2): boolean {
    const tokenInfo = tokenString 
      ? this.tokens.find(t => t.token === tokenString)
      : this.tokens[this.currentIndex];
    
    if (!tokenInfo) return false;
    
    // If reset time has passed, no need to rotate
    if (Date.now() >= tokenInfo.resetAt) {
      return false;
    }
    
    return tokenInfo.remaining <= threshold;
  }

  /**
   * Get token with proactive rotation - rotates BEFORE hitting limit
   * If current token has <= threshold remaining, tries to get another token first
   */
  async getTokenWithProactiveRotation(threshold: number = 2): Promise<string> {
    const currentToken = await this.getCurrentToken();
    const tokenInfo = this.tokens.find(t => t.token === currentToken);
    
    if (tokenInfo && tokenInfo.remaining <= threshold && tokenInfo.remaining > 0) {
      // Log the proactive rotation
      const tokenType = tokenInfo.isAppToken ? 'GitHub App' : 'regular';
      console.error(`[GitHub Token Manager] Proactive rotation: ${tokenType} token has only ${tokenInfo.remaining} requests remaining`);
      
      // Try to find another token with more remaining
      const otherTokens = this.tokens.filter(t => t.token !== currentToken && !t.isAppToken);
      for (const other of otherTokens) {
        if (this.hasAvailableRequestsForToken(other, threshold + 1)) {
          console.error(`[GitHub Token Manager] Rotating to token with ${other.remaining} remaining`);
          return other.token;
        }
      }
      
      // No better token found, use current
      console.error(`[GitHub Token Manager] No better token available, using current (${tokenInfo.remaining} remaining)`);
    }
    
    return currentToken;
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
   * Get reset times grouped by token type (GitHub App vs regular)
   */
  getResetTimesByType(): { appTokens: Array<{ index: number; resetAt: number; resetIn: number }>; regularTokens: Array<{ index: number; resetAt: number; resetIn: number }> } {
    const appTokens: Array<{ index: number; resetAt: number; resetIn: number }> = [];
    const regularTokens: Array<{ index: number; resetAt: number; resetIn: number }> = [];
    
    this.tokens.forEach((token, index) => {
      const resetIn = Math.max(0, Math.ceil((token.resetAt - Date.now()) / 1000 / 60));
      const tokenInfo = {
        index: index + 1,
        resetAt: token.resetAt,
        resetIn,
      };
      
      if (token.isAppToken) {
        appTokens.push(tokenInfo);
      } else {
        regularTokens.push(tokenInfo);
      }
    });
    
    return { appTokens, regularTokens };
  }

  /**
   * Check if a token string is from a GitHub App or regular token
   */
  getTokenType(tokenString: string): 'app' | 'regular' | 'unknown' {
    const tokenInfo = this.tokens.find(t => t.token === tokenString);
    if (tokenInfo) {
      return tokenInfo.isAppToken ? 'app' : 'regular';
    }
    return 'unknown';
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

