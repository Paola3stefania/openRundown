#!/bin/bash
# Set the project directory
PROJECT_DIR="/Users/user/Projects/openrundown"

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

# Set up logging if MCP_LOG_FILE is not set but we want to enable it
# Uncomment the line below to enable file logging:
# export MCP_LOG_FILE="$PROJECT_DIR/logs/mcp-server.log"

# Run the MCP server
exec node dist/index.js

