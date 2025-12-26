/**
 * Discord message caching utilities
 */

export interface DiscordMessage {
  id: string;
  author: {
    id: string;
    username: string;
    discriminator: string;
    bot: boolean;
    avatar: string | null;
  };
  content: string;
  created_at: string;
  edited_at: string | null;
  timestamp: string; // Message timestamp (ISO)
  channel_id: string;
  channel_name?: string;
  guild_id?: string;
  guild_name?: string;
  attachments: Array<{
    id: string;
    filename: string;
    url: string;
    size: number;
    content_type?: string;
  }>;
  embeds: number;
  mentions: string[]; // User IDs mentioned
  reactions: Array<{
    emoji: string;
    count: number;
  }>;
  thread?: {
    id: string;
    name: string;
  };
  message_reference?: {
    message_id: string;
    channel_id: string;
    guild_id?: string;
  };
  url?: string; // Discord message URL
}

export interface ThreadMessages {
  thread_id: string;
  thread_name: string;
  message_count: number;
  oldest_message_date: string | null;
  newest_message_date: string | null;
  messages: DiscordMessage[];
}

export interface DiscordCache {
  fetched_at: string;
  channel_id: string;
  channel_name?: string;
  total_count: number;
  oldest_message_date: string | null;
  newest_message_date: string | null;
  threads: Record<string, ThreadMessages>; // thread_id -> thread data
  main_messages: DiscordMessage[]; // Messages not in any thread
}

/**
 * Load Discord messages from JSON cache file
 * Handles backward compatibility with old format (messages array)
 */
export async function loadDiscordCache(
  cachePath: string
): Promise<DiscordCache> {
  const { readFile } = await import("fs/promises");
  const { join } = await import("path");
  
  const filePath = cachePath.startsWith("/")
    ? cachePath
    : join(process.cwd(), cachePath);

  const content = await readFile(filePath, "utf-8");
  const data = JSON.parse(content) as any;
  
  // Handle backward compatibility: convert old format (messages array) to new format (threads + main_messages)
  if (data.messages && !data.threads) {
    const { threads, mainMessages } = organizeMessagesByThread(data.messages);
    return {
      ...data,
      threads,
      main_messages: mainMessages,
      messages: undefined, // Remove old format
    } as DiscordCache;
  }
  
  // Ensure threads and main_messages exist even if empty
  if (!data.threads) {
    data.threads = {};
  }
  if (!data.main_messages) {
    data.main_messages = [];
  }
  
  return data as DiscordCache;
}

/**
 * Get all messages from cache (from both threads and main channel)
 */
export function getAllMessagesFromCache(cache: DiscordCache): DiscordMessage[] {
  const allMessages: DiscordMessage[] = [...(cache.main_messages || [])];
  
  if (cache.threads) {
    Object.values(cache.threads).forEach(thread => {
      allMessages.push(...thread.messages);
    });
  }
  
  return allMessages;
}

/**
 * Get all messages from a specific thread
 */
export function getThreadMessages(
  cache: DiscordCache,
  threadId: string
): DiscordMessage[] | null {
  const thread = cache.threads?.[threadId];
  if (!thread) {
    return null;
  }
  
  // Return messages sorted by creation date (oldest first)
  return [...thread.messages].sort((a, b) =>
    new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
}

/**
 * Get thread ID for a message
 */
export function getThreadIdForMessage(
  message: DiscordMessage
): string | null {
  return message.thread?.id || null;
}

/**
 * Get all messages from the thread that contains the given message
 * Returns the messages if the message is in a thread, or just the message itself if not
 */
export function getThreadContextForMessage(
  cache: DiscordCache,
  message: DiscordMessage
): DiscordMessage[] {
  const threadId = getThreadIdForMessage(message);
  
  if (threadId) {
    const threadMessages = getThreadMessages(cache, threadId);
    if (threadMessages && threadMessages.length > 0) {
      return threadMessages;
    }
  }
  
  // Message is not in a thread, return just this message
  return [message];
}

/**
 * Get the most recent message date from cache (checks both created_at and edited_at)
 * Returns the ISO date string of the most recent date, or undefined if cache is empty
 */
export function getMostRecentMessageDate(cache: DiscordCache): string | undefined {
  const allMessages = getAllMessagesFromCache(cache);
  
  if (allMessages.length === 0) {
    return undefined;
  }

  // Find the most recent timestamp from either created_at or edited_at
  let mostRecentTime = 0;

  allMessages.forEach(message => {
    const createdTime = new Date(message.created_at).getTime();
    const editedTime = message.edited_at ? new Date(message.edited_at).getTime() : 0;
    const maxTime = Math.max(createdTime, editedTime);
    
    if (maxTime > mostRecentTime) {
      mostRecentTime = maxTime;
    }
  });

  return mostRecentTime > 0 ? new Date(mostRecentTime).toISOString() : undefined;
}

/**
 * Organize messages by thread
 */
export function organizeMessagesByThread(messages: DiscordMessage[]): {
  threads: Record<string, ThreadMessages>;
  mainMessages: DiscordMessage[];
} {
  const threads: Record<string, ThreadMessages> = {};
  const mainMessages: DiscordMessage[] = [];

  messages.forEach(message => {
    if (message.thread) {
      const threadId = message.thread.id;
      
      if (!threads[threadId]) {
        threads[threadId] = {
          thread_id: threadId,
          thread_name: message.thread.name,
          message_count: 0,
          oldest_message_date: null,
          newest_message_date: null,
          messages: [],
        };
      }
      
      threads[threadId].messages.push(message);
    } else {
      mainMessages.push(message);
    }
  });

  // Sort messages in each thread and update thread metadata
  Object.values(threads).forEach(thread => {
    thread.messages.sort((a, b) => 
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
    
    thread.message_count = thread.messages.length;
    
    if (thread.messages.length > 0) {
      const dates = thread.messages.map(m => new Date(m.created_at).getTime());
      thread.oldest_message_date = new Date(Math.min(...dates)).toISOString();
      thread.newest_message_date = new Date(Math.max(...dates)).toISOString();
    }
  });

  // Sort main messages
  mainMessages.sort((a, b) => 
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  return { threads, mainMessages };
}

/**
 * Merge new messages with existing cache
 * Updates existing messages (by ID) and adds new ones, organized by thread
 */
export function mergeMessagesByThread(
  existingCache: DiscordCache,
  newMessages: DiscordMessage[]
): DiscordCache {
  const messageMap = new Map<string, DiscordMessage>();

  // Add all existing messages to map
  const allExistingMessages = getAllMessagesFromCache(existingCache);
  allExistingMessages.forEach(msg => messageMap.set(msg.id, msg));

  // Update/add new messages
  newMessages.forEach(msg => messageMap.set(msg.id, msg));

  // Organize merged messages by thread
  const allMessages = Array.from(messageMap.values());
  const { threads, mainMessages } = organizeMessagesByThread(allMessages);
  
  // Update cache structure
  const totalCount = allMessages.length;
  const dates = allMessages.map(m => new Date(m.created_at).getTime());
  const oldestDate = dates.length > 0 ? new Date(Math.min(...dates)).toISOString() : null;
  const newestDate = dates.length > 0 ? new Date(Math.max(...dates)).toISOString() : null;

  return {
    ...existingCache,
    fetched_at: new Date().toISOString(),
    total_count: totalCount,
    oldest_message_date: oldestDate,
    newest_message_date: newestDate,
    threads,
    main_messages: mainMessages,
  };
}
