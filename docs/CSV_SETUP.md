# Organization Members CSV Setup

The PR-based sync can automatically build user mappings from a CSV file exported from your organization.

## CSV Format

Your CSV file should have the following columns:
- **Name** (required)
- **Email** (required) - Used to match with Linear users
- **Role** (optional)
- **Teams** (optional)
- **Active** (required) - Should be "active" for active members
- **GitHub Username** (optional but recommended) - GitHub username for each member

### Example CSV

```csv
Name,Email,Role,Teams,Active,GitHub Username
"Maria Young",maria@google.com,member,"Engineering; Open Source",active,maria-young
```

## How It Works

1. **Parse CSV**: Reads the CSV file and extracts member information
2. **Match to Linear**: Matches emails from CSV to Linear users by email address
3. **Build Mapping**: Creates GitHub username → Linear user ID mapping automatically
4. **Filter Engineers**: Only includes members marked as "active"

## Setup

1. Export your organization members to CSV (make sure to include GitHub usernames if available)
2. Add a "GitHub Username" column if it doesn't exist
3. Place the CSV file in your project root as `members.csv`, or set `MEMBERS_CSV_PATH` environment variable
4. The sync will automatically:
   - Load organization engineers from CSV
   - Match their emails to Linear users
   - Build GitHub username → Linear user ID mappings

## Configuration

Set in your `.env` file:
```bash
MEMBERS_CSV_PATH=members.csv
```

Or place `members.csv` in the project root (default location).

## Manual Override

If you prefer manual configuration, you can still use:
- `ORGANIZATION_ENGINEERS` - List of GitHub usernames
- `USER_MAPPINGS` - Manual GitHub username → Linear user ID mappings

These will take precedence over CSV if provided.

