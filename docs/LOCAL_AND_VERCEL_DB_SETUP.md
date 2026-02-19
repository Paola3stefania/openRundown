# Local PostgreSQL + Vercel Database Setup

This guide shows how to set up:
- **Local PostgreSQL** for development
- **Vercel Postgres** for production deployment

## Step 1: Start Local PostgreSQL

### macOS
```bash
# Start PostgreSQL service
brew services start postgresql@14
# Or if using different version:
brew services start postgresql

# Verify it's running
psql -l
```

### If PostgreSQL is not installed:
```bash
brew install postgresql@14
brew services start postgresql@14
```

## Step 2: Create Local Database

```bash
# Create database
createdb openrundown

# Verify it was created
psql -l | grep openrundown
```

If you get permission errors, try:
```bash
# Check PostgreSQL is running
brew services list | grep postgresql

# If not running, start it
brew services start postgresql@14
```

## Step 3: Configure Local .env

Create/update your `.env` file:

```env
# =============================================================================
# Local Development Database
# =============================================================================
DATABASE_URL=postgresql://$(whoami)@localhost:5432/openrundown

# On macOS, usually no password needed. If you have a password:
# DATABASE_URL=postgresql://username:password@localhost:5432/openrundown

# =============================================================================
# Your other config...
# =============================================================================
DISCORD_TOKEN=your_token
GITHUB_TOKEN=your_token
GITHUB_REPO_URL=owner/repo
# ... etc
```

**Note:** The `$(whoami)` will use your macOS username. You can also hardcode it:
```env
DATABASE_URL=postgresql://your_username@localhost:5432/openrundown
```

## Step 4: Run Migrations Locally

```bash
# Generate Prisma Client and apply migrations
npm run db:migrate

# Or for development (creates migration files)
npm run db:migrate:dev
```

## Step 5: Set Up Vercel Postgres (Production)

### In Vercel Dashboard:

1. Go to your project → **Storage** → **Create Database** → **Postgres**
2. Create the database
3. Copy the connection string (looks like: `postgres://...@...vercel-storage.com/...`)
4. Go to **Settings** → **Environment Variables**
5. Add:
   - **Key**: `DATABASE_URL`
   - **Value**: `[your Vercel Postgres connection string]`
   - **Environment**: Select **Production** (and Preview if you want)

### Run Migrations on Vercel

After deploying, migrations run automatically, or you can run manually:

```bash
# Set Vercel DATABASE_URL temporarily
export DATABASE_URL="postgres://...@...vercel-storage.com/..."

# Run migrations
npm run db:migrate
```

Or use Vercel CLI:
```bash
vercel env pull .env.production
npm run db:migrate
```

## Step 6: Environment-Specific Configuration

### Local Development (.env)
```env
DATABASE_URL=postgresql://$(whoami)@localhost:5432/openrundown
```

### Vercel Production (Environment Variables in Dashboard)
```env
DATABASE_URL=postgres://...@...vercel-storage.com/...
```

## Testing Local Database

```bash
# Connect to database
psql openrundown

# List tables
\dt

# Exit
\q
```

Or use Prisma Studio:
```bash
npx prisma studio
# Opens at http://localhost:5555
```

## Troubleshooting

### PostgreSQL not running
```bash
# Check status
brew services list | grep postgresql

# Start if stopped
brew services start postgresql@14
```

### Permission denied
```bash
# Check your username
whoami

# Use that in DATABASE_URL
DATABASE_URL=postgresql://$(whoami)@localhost:5432/openrundown
```

### Database already exists
```bash
# Drop and recreate (WARNING: deletes all data)
dropdb openrundown
createdb openrundown
npm run db:migrate
```

## Summary

- **Local**: `DATABASE_URL=postgresql://username@localhost:5432/openrundown` in `.env`
- **Vercel**: `DATABASE_URL=postgres://...@...vercel-storage.com/...` in Vercel Environment Variables
- Both use the same Prisma schema and migrations
- Run `npm run db:migrate` for both environments

