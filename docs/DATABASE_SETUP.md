# Database Setup

PostgreSQL is optional - JSON files are used by default.

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
docker run --name unmute-postgres -e POSTGRES_PASSWORD=password -e POSTGRES_DB=unmute -p 5432:5432 -d postgres:14
```

### 2. Create Database

**macOS:**
```bash
createdb unmute
```

**Linux:**
```bash
psql -U postgres -c "CREATE DATABASE unmute;"
```

### 3. Set Environment Variable

Add to `.env`:
```env
DATABASE_URL=postgresql://user@localhost:5432/unmute
```

**Note:** On macOS, no password needed. On Linux, use: `postgresql://postgres:password@localhost:5432/unmute`

### 4. Run Migrations

```bash
npm run db:migrate
```

## Switch Back to JSON

```env
STORAGE_BACKEND=json
```
