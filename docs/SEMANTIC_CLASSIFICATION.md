# Semantic Classification with LLM

The classification system now supports LLM-based semantic similarity matching using OpenAI embeddings, which provides better understanding of context and related concepts compared to keyword-based matching.

## How It Works

Instead of matching keywords and phrases, semantic classification:

1. **Converts text to embeddings**: Uses OpenAI's `text-embedding-3-small` model to create vector representations of Discord messages and GitHub issues
2. **Calculates semantic similarity**: Uses cosine similarity between embedding vectors to measure how semantically similar messages are to issues
3. **Understands context**: Can connect related concepts even when exact keywords don't match (e.g., "authentication problem" matches "sign-in issue")

## Benefits

- **Better semantic understanding**: Understands synonyms, related terms, and context
- **Improved accuracy**: More accurate matching for complex technical discussions
- **Conceptual relationships**: Can connect related concepts even without exact keyword matches

## Configuration

### Enable Semantic Classification

1. **Add OpenAI API Key** to your `.env` file:
   ```bash
   OPENAI_API_KEY=your_openai_api_key_here
   ```

2. **Semantic classification is automatically enabled** when `OPENAI_API_KEY` is set

3. **To disable semantic classification** even with an API key set:
   ```bash
   USE_SEMANTIC_CLASSIFICATION=false
   ```

### Cost Considerations

- **Model used**: `text-embedding-3-small` (cost-effective)
- **Pricing**: ~$0.02 per 1M tokens (as of 2024)
- **Caching**: Embeddings are cached during classification to avoid recalculating for the same messages/issues
- **Rate limits**: Processed in batches with delays to respect OpenAI rate limits (5000 requests/minute)

## Usage

### Via MCP Tool

The `classify_discord_messages` MCP tool automatically uses semantic classification if `OPENAI_API_KEY` is configured:

```typescript
// Automatically uses semantic classification if OPENAI_API_KEY is set
await classify_discord_messages({
  channel_id: "your-channel-id",
  limit: 30,
  min_similarity: 20
});
```

### Via Script

The classification script also automatically uses semantic classification:

```bash
npm run classify-issues
```

The script will indicate which method is being used:
```
Matching messages with GitHub issues using semantic (LLM-based) classification...
```

## Comparison: Keyword vs Semantic

### Keyword-Based (Default)
- Fast and free
- Requires exact or similar keyword matches
- Limited understanding of synonyms or related concepts
- Good for exact technical term matching

### Semantic (LLM-Based)
- More accurate for complex discussions
- Understands context and relationships
- Requires OpenAI API key (costs apply)
- Better for nuanced technical conversations

## Fallback Behavior

If `OPENAI_API_KEY` is not set or semantic classification fails:
- The system automatically falls back to keyword-based classification
- A warning message is logged: `"Semantic classification requested but OPENAI_API_KEY not found. Falling back to keyword-based classification."`

## Similarity Scores

Both methods use a 0-100 similarity score scale:
- **0-20**: Weak match (may not be relevant)
- **20-40**: Moderate match (possibly related)
- **40-60**: Good match (likely related)
- **60-80**: Strong match (definitely related)
- **80-100**: Very strong match (almost certainly related)

The `min_similarity` parameter filters results by this score (default: 20).

