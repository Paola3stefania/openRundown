/**
 * Feature extractor using LLM
 * Analyzes documentation and extracts product features
 */

import { log, logError, logWarn } from "../logger.js";
import { ProductFeature } from "./types.js";
import { DocumentationContent } from "./documentation-fetcher.js";

/**
 * Extract product features from documentation using LLM
 */
export async function extractFeaturesFromDocumentation(
  documentation: DocumentationContent | DocumentationContent[],
  apiKey?: string
): Promise<ProductFeature[]> {
  const openaiKey = apiKey || process.env.OPENAI_API_KEY;
  
  if (!openaiKey) {
    throw new Error("OPENAI_API_KEY environment variable is required for feature extraction");
  }

  const docs = Array.isArray(documentation) ? documentation : [documentation];
  
  // Combine all documentation content
  const combinedContent = docs
    .map(doc => {
      if (doc.title) {
        return `# ${doc.title}\n\n${doc.content}`;
      }
      return doc.content;
    })
    .join("\n\n---\n\n");

  // Truncate if too long (OpenAI has token limits)
  const maxChars = 200000; // ~50k tokens
  const contentToAnalyze = combinedContent.length > maxChars 
    ? combinedContent.substring(0, maxChars) + "\n\n[... content truncated ...]"
    : combinedContent;

  log(`Extracting features from ${docs.length} documentation source(s) (${contentToAnalyze.length} characters)`);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini", // Using mini for cost efficiency
        messages: [
          {
            role: "system",
            content: `You are a product manager analyzing documentation to extract product features. 
Extract distinct features, capabilities, and functionalities from the documentation.

For each feature, provide:
- A clear, concise name
- A description of what it does
- Relevant keywords/terms that users might use when discussing it
- Category (optional, e.g., "Authentication", "Database", "API", etc.)
- Priority based on how central it is to the product (high/medium/low)

Return the result as a JSON array of features. Each feature should have:
{
  "name": "Feature Name",
  "description": "Clear description of the feature",
  "category": "Category name (optional)",
  "related_keywords": ["keyword1", "keyword2", ...],
  "priority": "high|medium|low"
}

Focus on user-facing features and capabilities, not implementation details.`
          },
          {
            role: "user",
            content: `Analyze the following documentation and extract all distinct product features:\n\n${contentToAnalyze}`
          }
        ],
        response_format: { type: "json_object" },
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    const content = data.choices[0]?.message?.content;
    
    if (!content) {
      throw new Error("No content in OpenAI response");
    }

    const parsed = JSON.parse(content);
    
    // Handle both {features: [...]} and direct array formats
    const features = Array.isArray(parsed) ? parsed : (parsed.features || parsed.feature || []);
    
    // Add IDs and normalize
    const normalizedFeatures: ProductFeature[] = features.map((feature: any, index: number) => ({
      id: feature.id || `feature-${index + 1}`,
      name: feature.name,
      description: feature.description,
      category: feature.category,
      documentation_section: feature.documentation_section,
      related_keywords: feature.related_keywords || [],
      priority: feature.priority || "medium",
    }));

    log(`Extracted ${normalizedFeatures.length} features from documentation`);
    
    return normalizedFeatures;
  } catch (error) {
    logError("Error extracting features:", error);
    throw error;
  }
}

/**
 * Enhance features with additional context (can be extended with more analysis)
 */
export async function enhanceFeatures(
  features: ProductFeature[],
  githubIssues?: any[],
  discordMessages?: any[]
): Promise<ProductFeature[]> {
  // Future: Could use LLM to enhance features based on actual usage patterns
  // from GitHub issues and Discord messages
  return features;
}

