/**
 * OAuth Client Manager
 * Handles multiple OAuth client IDs and rotates when rate limits are hit
 * Each client ID has its own independent rate limit (5,000/hour)
 */

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  lastUsed: number; // timestamp in ms
}

export class OAuthClientManager {
  private clients: OAuthClient[] = [];
  private currentIndex = 0;
  private usedClients: Set<number> = new Set(); // Track which clients have been used in current session

  constructor(clients: Array<{ clientId: string; clientSecret: string }>) {
    // Filter out empty clients and initialize
    this.clients = clients
      .filter(c => c.clientId && c.clientId.trim().length > 0 && c.clientSecret && c.clientSecret.trim().length > 0)
      .map(client => ({
        clientId: client.clientId.trim(),
        clientSecret: client.clientSecret.trim(),
        lastUsed: 0,
      }));
    
    if (this.clients.length === 0) {
      throw new Error('No valid OAuth clients provided');
    }
    
    console.error(`[OAuth Client Manager] Initialized with ${this.clients.length} client(s)`);
  }

  /**
   * Get the current active client
   */
  getCurrentClient(): OAuthClient {
    return this.clients[this.currentIndex];
  }

  /**
   * Get all available clients
   */
  getAllClients(): OAuthClient[] {
    return [...this.clients];
  }

  /**
   * Get the next available client (for rotation)
   * Returns null if all clients have been tried
   */
  getNextClient(): OAuthClient | null {
    const startIndex = this.currentIndex;
    let attempts = 0;
    
    while (attempts < this.clients.length) {
      const client = this.clients[this.currentIndex];
      this.currentIndex = (this.currentIndex + 1) % this.clients.length;
      attempts++;
      
      // Return this client (we rotate through all of them)
      client.lastUsed = Date.now();
      this.usedClients.add(this.currentIndex === 0 ? this.clients.length - 1 : this.currentIndex - 1);
      return client;
    }
    
    return null;
  }

  /**
   * Get a client that hasn't been used yet (preferred for initial token generation)
   */
  getUnusedClient(): OAuthClient | null {
    // Find first unused client
    for (let i = 0; i < this.clients.length; i++) {
      const index = (this.currentIndex + i) % this.clients.length;
      if (!this.usedClients.has(index)) {
        this.currentIndex = index;
        const client = this.clients[index];
        client.lastUsed = Date.now();
        this.usedClients.add(index);
        return client;
      }
    }
    
    // All clients used, reset and return first one
    this.usedClients.clear();
    this.currentIndex = 0;
    const client = this.clients[0];
    client.lastUsed = Date.now();
    this.usedClients.add(0);
    return client;
  }

  /**
   * Rotate to next client (even if current is available)
   */
  rotateClient(): void {
    this.currentIndex = (this.currentIndex + 1) % this.clients.length;
  }

  /**
   * Get status of all clients
   */
  getStatus(): Array<{ index: number; clientId: string; lastUsed: number }> {
    return this.clients.map((client, index) => ({
      index: index + 1,
      clientId: client.clientId.substring(0, 8) + '...', // Show first 8 chars only
      lastUsed: client.lastUsed,
    }));
  }

  /**
   * Create client manager from environment variable
   * Supports comma-separated client IDs and secrets:
   * GITHUB_OAUTH_CLIENT_ID=id1,id2,id3
   * GITHUB_OAUTH_CLIENT_SECRET=secret1,secret2,secret3
   */
  static fromEnvironment(): OAuthClientManager | null {
    const clientIdEnv = process.env.GITHUB_OAUTH_CLIENT_ID;
    const clientSecretEnv = process.env.GITHUB_OAUTH_CLIENT_SECRET;
    
    if (!clientIdEnv || !clientSecretEnv) {
      return null;
    }
    
    const clientIds = clientIdEnv.split(',').map(id => id.trim()).filter(id => id.length > 0);
    const clientSecrets = clientSecretEnv.split(',').map(secret => secret.trim()).filter(secret => secret.length > 0);
    
    if (clientIds.length === 0 || clientSecrets.length === 0) {
      return null;
    }
    
    // Ensure we have matching counts
    if (clientIds.length !== clientSecrets.length) {
      console.error(`[OAuth Client Manager] Warning: Number of client IDs (${clientIds.length}) doesn't match number of secrets (${clientSecrets.length}). Using minimum count.`);
    }
    
    const minCount = Math.min(clientIds.length, clientSecrets.length);
    const clients = [];
    
    for (let i = 0; i < minCount; i++) {
      clients.push({
        clientId: clientIds[i],
        clientSecret: clientSecrets[i],
      });
    }
    
    try {
      const manager = new OAuthClientManager(clients);
      return manager;
    } catch (error) {
      console.error(`[OAuth Client Manager] Failed to initialize: ${error}`);
      return null;
    }
  }
}



