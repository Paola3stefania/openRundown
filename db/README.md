# Database Setup

UNMute MCP uses PostgreSQL to store classification and grouping data for better scalability and querying.

## Setup

1. **Install PostgreSQL** (if not already installed)
   ```bash
   # macOS
   brew install postgresql
   brew services start postgresql
   
   # Or use Docker
   docker run --name unmute-postgres -e POSTGRES_PASSWORD=password -p 5432:5432 -d postgres
   ```

2. **Create database**
   ```sql
   CREATE DATABASE unmute_mcp;
   ```

3. **Set environment variables**
   ```bash
   # Option 1: Connection string
   DATABASE_URL=postgresql://user:password@localhost:5432/unmute_mcp
   
   # Option 2: Individual variables
   DB_HOST=localhost
   DB_PORT=5432
   DB_NAME=unmute_mcp
   DB_USER=your_user
   DB_PASSWORD=your_password
   ```

4. **Run migrations**
   ```bash
   npm run db:migrate
   ```

5. **Import existing JSON data** (optional)
   ```bash
   npm run db:import
   ```

## Schema

- **channels**: Discord channels
- **classified_threads**: Threads that have been classified
- **thread_issue_matches**: Many-to-many relationship between threads and GitHub issues
- **groups**: Issue-based groups
- **group_threads**: Many-to-many relationship between groups and threads
- **ungrouped_threads**: Threads that couldn't be grouped
- **classification_history**: Tracking for incremental updates

## Migration from JSON

The system can work with both JSON files and PostgreSQL:
- If `DATABASE_URL` is set, it uses PostgreSQL
- Otherwise, it falls back to JSON files

To migrate:
1. Set up PostgreSQL
2. Run migrations
3. Import existing JSON data
4. Update environment to use database

## Benefits

- **Better querying**: SQL queries instead of loading entire JSON files
- **Scalability**: Handles millions of records efficiently
- **Concurrent access**: Multiple processes can read/write safely
- **Data integrity**: Foreign keys and constraints
- **Incremental updates**: Efficient upserts and merges

