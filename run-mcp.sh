#!/bin/bash
# Set the project directory
PROJECT_DIR="/Users/user/Projects/discord-mcp"

# Change to the project directory
cd "$PROJECT_DIR" || {
  echo "Error: Could not change to directory: $PROJECT_DIR" >&2
  exit 1
}

# Ensure we're in the right directory
if [ ! -f "dist/index.js" ]; then
  echo "Error: dist/index.js not found in $PROJECT_DIR. Please run 'npm run build' first." >&2
  exit 1
fi

# Ensure node_modules exists
if [ ! -d "node_modules" ]; then
  echo "Error: node_modules not found in $PROJECT_DIR. Please run 'npm install' first." >&2
  exit 1
fi

# Run the MCP server
exec node dist/index.js

