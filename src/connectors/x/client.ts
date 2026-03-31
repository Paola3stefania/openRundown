/**
 * X/Twitter API v2 Client
 *
 * Handles bearer token auth, rate limiting, pagination, and query building
 * for the Recent Search endpoint (GET /2/tweets/search/recent).
 *
 * Basic tier: 60 requests per 15 minutes, 7-day lookback, 10K-15K reads/month.
 */

const API_BASE = "https://api.twitter.com/2";
const MAX_RESULTS_PER_PAGE = 100;

export interface XApiTweet {
  id: string;
  text: string;
  created_at?: string;
  author_id?: string;
  conversation_id?: string;
  in_reply_to_user_id?: string;
  lang?: string;
  public_metrics?: {
    retweet_count: number;
    reply_count: number;
    like_count: number;
    quote_count: number;
  };
  entities?: {
    hashtags?: Array<{ tag: string }>;
    urls?: Array<{ expanded_url: string; display_url: string }>;
    mentions?: Array<{ username: string }>;
  };
}

export interface XApiUser {
  id: string;
  name: string;
  username: string;
  public_metrics?: {
    followers_count: number;
    following_count: number;
    tweet_count: number;
  };
}

export interface XSearchResponse {
  data?: XApiTweet[];
  includes?: {
    users?: XApiUser[];
  };
  meta?: {
    newest_id?: string;
    oldest_id?: string;
    result_count: number;
    next_token?: string;
  };
  errors?: Array<{ message: string; type: string }>;
}

export interface XSearchOptions {
  query: string;
  maxResults?: number;
  sinceId?: string;
  nextToken?: string;
}

let rateLimitRemaining = 60;
let rateLimitResetAt = 0;

function getBearerToken(): string {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) {
    throw new Error("X_BEARER_TOKEN is not set. Get one at developer.x.com (Basic tier, $200/mo).");
  }
  return token;
}

async function waitForRateLimit(): Promise<void> {
  if (rateLimitRemaining <= 1 && Date.now() < rateLimitResetAt) {
    const waitMs = rateLimitResetAt - Date.now() + 1000;
    console.error(`[X] Rate limit reached, waiting ${Math.ceil(waitMs / 1000)}s...`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

function updateRateLimits(headers: Headers): void {
  const remaining = headers.get("x-rate-limit-remaining");
  const reset = headers.get("x-rate-limit-reset");
  if (remaining !== null) rateLimitRemaining = parseInt(remaining, 10);
  if (reset !== null) rateLimitResetAt = parseInt(reset, 10) * 1000;
}

export async function searchRecentTweets(
  options: XSearchOptions,
): Promise<XSearchResponse> {
  await waitForRateLimit();

  const params = new URLSearchParams({
    query: options.query,
    max_results: String(Math.min(options.maxResults ?? MAX_RESULTS_PER_PAGE, MAX_RESULTS_PER_PAGE)),
    "tweet.fields": "created_at,author_id,conversation_id,in_reply_to_user_id,lang,public_metrics,entities",
    expansions: "author_id",
    "user.fields": "name,username,public_metrics",
  });

  if (options.sinceId) params.set("since_id", options.sinceId);
  if (options.nextToken) params.set("next_token", options.nextToken);

  const url = `${API_BASE}/tweets/search/recent?${params}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${getBearerToken()}` },
  });

  updateRateLimits(response.headers);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`X API error ${response.status}: ${body}`);
  }

  return response.json() as Promise<XSearchResponse>;
}

/**
 * Paginate through all results up to a limit.
 */
export async function searchAllRecentTweets(
  options: XSearchOptions & { totalLimit?: number },
): Promise<{ tweets: XApiTweet[]; users: Map<string, XApiUser>; newestId?: string }> {
  const tweets: XApiTweet[] = [];
  const users = new Map<string, XApiUser>();
  const totalLimit = options.totalLimit ?? 500;
  let nextToken: string | undefined;

  do {
    const response = await searchRecentTweets({
      ...options,
      nextToken,
    });

    if (response.errors?.length) {
      console.error(`[X] API errors: ${response.errors.map((e) => e.message).join(", ")}`);
    }

    if (response.data) {
      tweets.push(...response.data);
    }

    if (response.includes?.users) {
      for (const user of response.includes.users) {
        users.set(user.id, user);
      }
    }

    nextToken = response.meta?.next_token;
  } while (nextToken && tweets.length < totalLimit);

  const newestId = tweets[0]?.id;
  return { tweets: tweets.slice(0, totalLimit), users, newestId };
}

/**
 * Build a search query from users, hashtags, and keywords.
 * Combines them with OR within each group, AND between groups.
 */
export function buildSearchQuery(opts: {
  users?: string[];
  hashtags?: string[];
  keywords?: string[];
  excludeRetweets?: boolean;
}): string {
  const parts: string[] = [];

  if (opts.users?.length) {
    const userPart = opts.users.map((u) => `from:${u.replace("@", "")}`).join(" OR ");
    parts.push(opts.users.length > 1 ? `(${userPart})` : userPart);
  }

  if (opts.hashtags?.length) {
    const tagPart = opts.hashtags.map((t) => (t.startsWith("#") ? t : `#${t}`)).join(" OR ");
    parts.push(opts.hashtags.length > 1 ? `(${tagPart})` : tagPart);
  }

  if (opts.keywords?.length) {
    const kwPart = opts.keywords.map((k) => (k.includes(" ") ? `"${k}"` : k)).join(" OR ");
    parts.push(opts.keywords.length > 1 ? `(${kwPart})` : kwPart);
  }

  let query = parts.join(" ");
  if (opts.excludeRetweets !== false) query += " -is:retweet";

  return query.trim();
}
