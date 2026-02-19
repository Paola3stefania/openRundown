# GitHub Integration

OpenRundown requires GitHub authentication to fetch issues and comments. Choose one method:

## Option 1: Personal Access Token (Simple)

1. Create a token at https://github.com/settings/tokens
2. Set in `.env`:
   ```
   GITHUB_TOKEN=your_token_here
   ```
3. Rate limit: 5,000 requests/hour

## Option 2: GitHub App (Recommended - Highest Rate Limits)

1. Create a GitHub App at https://github.com/settings/apps/new
2. Install the app on your repository
3. Download the private key (.pem file)
4. Set in `.env`:
   ```
   GITHUB_APP_ID=your_app_id
   GITHUB_APP_INSTALLATION_ID=your_installation_id
   GITHUB_APP_PRIVATE_KEY_PATH=/path/to/your-app.pem
   ```
5. Rate limit: 5,000 requests/hour per installation

**Note:** Without authentication, rate limit is 60 requests/hour.
