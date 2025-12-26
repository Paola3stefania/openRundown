# Discord Bot Permissions for Reading Messages

## Required Permissions

To read messages from Discord channels, your bot needs these permissions:

### 1. Server-Level Permissions (Bot Role)
The bot needs these permissions at the server (guild) level:
- **View Channels** - Allows the bot to see the channel exists
- **Read Message History** - Allows the bot to read past messages
- **Send Messages** (optional, if you want the bot to respond)

### 2. Channel-Level Permissions
For specific channels like #bug-reports, the bot also needs:
- **View Channel** permission in that specific channel
- **Read Message History** permission in that specific channel

## Why #bug-reports is Inaccessible

Channels like #bug-reports, #moderator-only, #security, etc. are typically:
1. **Role-restricted** - Only certain roles can access them
2. **Permission-denied by default** - New members/bots don't get access automatically
3. **Manually managed** - Admins control who can access them

## How to Grant Permissions

### Option 1: Server Admin Grants Channel Access
1. Server admin goes to **Server Settings** → **Roles**
2. Find your bot's role (or @everyone if bot uses default permissions)
3. Go to the specific channel (#bug-reports)
4. Enable permissions for the bot's role:
   - View Channel
   - Read Message History

### Option 2: Channel-Specific Permissions
1. Right-click on the channel (#bug-reports)
2. Select **Edit Channel** → **Permissions**
3. Add your bot or bot's role
4. Enable:
   - View Channel
   - Read Message History

### Option 3: Use a Bot with Higher Privileges
If you're the server owner, you can:
1. Go to **Server Settings** → **Roles**
2. Create or edit a role with appropriate permissions
3. Assign that role to your bot
4. Make sure that role has access to restricted channels

## Current Bot Status

Your bot (Cursor#1137) currently has access to **15 public channels** but **cannot access 9 restricted channels**:
- #bug-reports (likely requires moderator/admin access)
- #moderator-only (clearly restricted)
- #security (restricted for security reasons)
- #feature-requests (may require contributor role)
- #sponsor-lounge (sponsor-only)
- #faq-queue (moderation queue)
- #project (may be team-only)
- #ask-bot-txt (specific bot channel)
- #faq (one of the FAQ channels is restricted)

## Recommendation

For reading bug reports and feature requests, you would need a server admin to:
1. Grant your bot's role access to those specific channels, OR
2. Give your bot a role (like "Contributor" or "Developer") that has access to those channels

The bot is working correctly - it just needs permission to be granted by a server administrator.


