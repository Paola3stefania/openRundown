# Database Setup

PostgreSQL is optional - JSON files are used by default.

**Important:** When `DATABASE_URL` is set, database saves are **required**. Operations will fail if the database is unavailable (no silent fallback to JSON). To use JSON storage, ensure `DATABASE_URL` is not set.

## Quick Setup

### 1. Install PostgreSQL

**macOS:**
```bash
brew install postgresql@14
brew services start postgresql@14
```

**Linux:**
```bash
sudo apt-get install postgresql
sudo systemctl start postgresql
```

**Docker:**
```bash
docker run --name openrundown-postgres -e POSTGRES_PASSWORD=password -e POSTGRES_DB=openrundown -p 5432:5432 -d postgres:14
```

### 2. Create Database

**macOS:**
```bash
createdb openrundown
```

**Linux:**
```bash
psql -U postgres -c "CREATE DATABASE openrundown;"
```

### 3. Set Environment Variable

Add to `.env`:
```env
DATABASE_URL=postgresql://user@localhost:5432/openrundown
```

**Note:** On macOS, no password needed. On Linux, use: `postgresql://postgres:password@localhost:5432/openrundown`

### 4. Run Migrations

```bash
# Generate Prisma Client and apply migrations
npx prisma migrate deploy

# Or for development (creates migration files)
npx prisma migrate dev
```

## Switch Back to JSON

To switch back to JSON file storage, you can either:

**Option 1: Remove DATABASE_URL** (Recommended)
```bash
# Remove DATABASE_URL from .env file, or unset it
unset DATABASE_URL
```

**Option 2: Force JSON mode**
```env
STORAGE_BACKEND=json
```

This forces JSON storage even if `DATABASE_URL` is set (useful for testing).

**Important:** When `DATABASE_URL` is set and `STORAGE_BACKEND` is not explicitly set to `json`, database saves are **required**. Operations will fail if the database is unavailable (no silent fallback to JSON). To use JSON storage, either unset `DATABASE_URL` or set `STORAGE_BACKEND=json`.
