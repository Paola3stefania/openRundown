/**
 * Adapter to transform X API responses into database records and Signals.
 */

import type { XApiTweet, XApiUser } from "./client.js";
import type { Signal } from "../../types/signal.js";

export interface XPostRecord {
  id: string;
  authorId: string;
  authorUsername: string;
  authorName: string | null;
  authorFollowers: number;
  content: string;
  hashtags: string[];
  urls: string[];
  likeCount: number;
  retweetCount: number;
  replyCount: number;
  quoteCount: number;
  lang: string | null;
  conversationId: string | null;
  inReplyToUserId: string | null;
  query: string | null;
  postedAt: Date;
}

export function tweetToPostRecord(
  tweet: XApiTweet,
  users: Map<string, XApiUser>,
  query?: string,
): XPostRecord {
  const author = tweet.author_id ? users.get(tweet.author_id) : undefined;

  return {
    id: tweet.id,
    authorId: tweet.author_id ?? "unknown",
    authorUsername: author?.username ?? "unknown",
    authorName: author?.name ?? null,
    authorFollowers: author?.public_metrics?.followers_count ?? 0,
    content: tweet.text,
    hashtags: tweet.entities?.hashtags?.map((h) => h.tag) ?? [],
    urls: tweet.entities?.urls?.map((u) => u.expanded_url) ?? [],
    likeCount: tweet.public_metrics?.like_count ?? 0,
    retweetCount: tweet.public_metrics?.retweet_count ?? 0,
    replyCount: tweet.public_metrics?.reply_count ?? 0,
    quoteCount: tweet.public_metrics?.quote_count ?? 0,
    lang: tweet.lang ?? null,
    conversationId: tweet.conversation_id ?? null,
    inReplyToUserId: tweet.in_reply_to_user_id ?? null,
    query: query ?? null,
    postedAt: tweet.created_at ? new Date(tweet.created_at) : new Date(),
  };
}

export function tweetsToPostRecords(
  tweets: XApiTweet[],
  users: Map<string, XApiUser>,
  query?: string,
): XPostRecord[] {
  return tweets.map((t) => tweetToPostRecord(t, users, query));
}

export function xPostToSignal(post: XPostRecord): Signal {
  return {
    source: "x" as Signal["source"],
    sourceId: post.id,
    permalink: `https://x.com/${post.authorUsername}/status/${post.id}`,
    title: undefined,
    body: post.content,
    createdAt: post.postedAt.toISOString(),
    metadata: {
      authorUsername: post.authorUsername,
      authorName: post.authorName,
      authorFollowers: post.authorFollowers,
      hashtags: post.hashtags,
      likeCount: post.likeCount,
      retweetCount: post.retweetCount,
      replyCount: post.replyCount,
      quoteCount: post.quoteCount,
      engagement: post.likeCount + post.retweetCount + post.quoteCount,
    },
  };
}
