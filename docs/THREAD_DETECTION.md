# How We Detect Threads When Fetching Messages

## Detection Mechanism

When fetching messages from Discord, we detect if a message is part of a thread by checking the `msg.thread` property provided by Discord.js.

### Discord.js Message Object

Discord.js automatically includes thread information when fetching messages:

```typescript
// From scripts/fetch-discord-messages.ts (lines 110-113)
thread: msg.thread ? {
  id: msg.thread.id,
  name: msg.thread.name,
} : undefined,
```

**Key Points:**
- If `msg.thread` exists → message is part of a thread
- If `msg.thread` is `null` or `undefined` → message is standalone (not in a thread)

## How Messages Are Organized

When we fetch messages, they are organized by the `organizeMessagesByThread` function:

```typescript
// From src/discord-cache.ts (lines 206-224)
messages.forEach(message => {
  if (message.thread) {
    // Message is in a thread
    const threadId = message.thread.id;
    // Add to threads[threadId].messages
    threads[threadId].messages.push(message);
  } else {
    // Message is standalone
    mainMessages.push(message);
  }
});
```

## What Happens When a Standalone Message Becomes a Thread

### Scenario
1. **Initial fetch**: Message A is standalone → stored in `main_messages[]`
2. **Later**: Someone creates a thread from Message A
3. **Next fetch**: Message A now has `msg.thread` property → moved to `threads[threadId].messages[]`

### How It's Handled

1. **Cache Update** (`mergeMessagesByThread`):
   - Messages are updated by ID using a Map: `messageMap.set(msg.id, msg)`
   - When Message A is fetched again with `thread` property, it overwrites the old entry
   - `organizeMessagesByThread` is called again on all messages
   - Message A moves from `main_messages` to `threads[threadId].messages`

2. **Classification History Migration**:
   - If Message A was previously classified as standalone (using `message.id` as thread ID)
   - The `migrateStandaloneToThread` function detects this and migrates the classification
   - Old classification: `history.threads[messageId]` (standalone)
   - New classification: `history.threads[threadId]` (real thread)

## Code Flow

```
Fetch Messages from Discord
    ↓
Discord.js provides msg.thread property
    ↓
Format message with thread info (if present)
    ↓
Merge with existing cache (updates by message ID)
    ↓
organizeMessagesByThread() separates:
    - Messages with thread → threads[threadId].messages
    - Messages without thread → main_messages[]
    ↓
If message was standalone before but now has thread:
    - migrateStandaloneToThread() handles classification history
```

## Example

```typescript
// First fetch - Message is standalone
{
  id: "123456789",
  content: "How do I do X?",
  thread: undefined  // No thread
}
// → Stored in main_messages[]

// Second fetch - Message is now in a thread
{
  id: "123456789",  // Same ID
  content: "How do I do X?",
  thread: {         // Now has thread!
    id: "987654321",
    name: "Question about X"
  }
}
// → Updated in cache, moved to threads["987654321"].messages[]
// → Classification history migrated from thread["123456789"] to thread["987654321"]
```

## Important Notes

- **Message ID never changes**: The message ID stays the same even when it becomes part of a thread
- **Thread ID is different**: The thread ID is separate from the message ID
- **Automatic detection**: Discord.js handles this automatically - we just check `msg.thread`
- **Cache is updated incrementally**: When merging, old entries are replaced with new ones by message ID

