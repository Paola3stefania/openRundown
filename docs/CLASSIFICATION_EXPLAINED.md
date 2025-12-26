# How Message Classification Works

## Process Overview

The classification system analyzes Discord messages and matches them with GitHub issues using a smart keyword-based similarity algorithm.

## Step-by-Step Process

### 1. **Read Messages from Channel**
   - Fetches the last N messages (default: 30) from the specified Discord channel
   - Example: Reads 30 most recent messages from #development

### 2. **For Each Message:**
   
   **a. Extract Keywords**
   - Removes common stop words (the, a, and, etc.)
   - Extracts meaningful keywords (length > 2 characters)
   - Example: "How do I fix the stripe plugin error?"
     → Keywords: ["fix", "stripe", "plugin", "error"]

   **b. Search GitHub Issues**
   - Uses top 5 keywords to search GitHub API
   - Searches in the configured repository (set via GITHUB_OWNER and GITHUB_REPO)
   - GitHub API returns up to **20 matching issues** per search
   - Example search: `repo:{owner}/{repo} stripe plugin error type:issue`

   **c. Calculate Similarity**
   - Compares message keywords with each issue's:
     - Title
     - Body/description
   - Calculates similarity score (0-100%) based on:
     - Number of matched keywords
     - Keyword overlap percentage
   - Example: Message has 5 keywords, 3 match issue → 60% similarity

   **d. Filter & Rank**
   - Only includes issues with similarity ≥ threshold (default: 20%)
   - Sorts by similarity score (highest first)
   - Returns top 5 matches per message

### 3. **Return Results**
   - Each classified message includes:
     - Original message details
     - List of related GitHub issues (with similarity scores)
     - Matched terms highlighting why they match

## Important Notes

### WARNING: **Not All Issues, Just Matching Ones**

- **Does NOT** compare against all GitHub issues at once
- **Does** search GitHub API using message keywords
- GitHub API returns up to 20 results per search
- Only issues that match the keywords are considered
- Only issues above similarity threshold are returned

### **Performance**

- One GitHub API call per message
- With 30 messages = 30 API calls
- Rate limit: 60 requests/hour (without token) or 5000/hour (with token)
- Includes 500ms delay between searches to respect rate limits

### **Similarity Threshold**

- Default: 20% similarity
- Lower threshold = more matches (but less accurate)
- Higher threshold = fewer matches (but more relevant)
- Adjustable via `min_similarity` parameter

## Example

**Discord Message:**
> "I'm having trouble with stripe plugin subscription webhooks not updating the database"

**Process:**
1. Keywords: ["trouble", "stripe", "plugin", "subscription", "webhooks", "updating", "database"]
2. GitHub search: `repo:{owner}/{repo} stripe plugin subscription webhooks type:issue`
3. Finds issue #5535: "Stripe - cancel at the period end not working"
4. Calculates similarity: 45% (matched: "stripe", "plugin", "subscription")
5. Includes in results if > 20% threshold

**Result:**
- Message linked to issue #5535 with 45% similarity
- Matched terms: ["stripe", "plugin", "subscription"]

## Limitations

1. **Keyword-based**: Only matches on keywords, not semantic meaning
2. **GitHub API limits**: Max 20 results per search
3. **One search per message**: Can miss related issues if keywords don't match
4. **Rate limiting**: May need GitHub token for large batches

## Improving Results

To get better matches:
1. **Lower similarity threshold** (e.g., 15% instead of 20%)
2. **Use GitHub token** for higher rate limits
3. **Process in smaller batches** to avoid rate limits
4. **Adjust keywords extraction** algorithm for better matching

