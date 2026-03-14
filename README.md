# geni-mcp

An MCP (Model Context Protocol) server that gives Claude access to [Geni](https://www.geni.com) — the collaborative genealogy platform. Use Claude to browse, search, correct, and extend your family tree.

## Features

| Tool | Description |
|---|---|
| `get_authorization_url` | Start the OAuth flow — get the URL to authorize Claude |
| `exchange_code` | Complete OAuth — exchange the code for tokens |
| `get_my_profile` | Get your own Geni profile |
| `get_profile` | Look up any profile by ID |
| `update_profile` | Correct names, dates, locations, biography |
| `create_profile` | Add a new person to Geni |
| `get_immediate_family` | Get parents, siblings, spouses, children |
| `get_union` | Get a family unit (couple + children) |
| `add_relation` | Add a parent, child, sibling, or spouse |
| `search_profiles` | Search by name with optional birth/death filters |
| `get_merge_candidates` | Find potential duplicate profiles |
| `merge_profiles` | Merge a duplicate into a base profile |

## Prerequisites

1. A Geni account at [geni.com](https://www.geni.com)
2. A registered Geni app — create one at [geni.com/platform/developer/apps](https://www.geni.com/platform/developer/apps)
3. Node.js 20+

## Setup

### 1. Clone & install

```bash
git clone https://github.com/raphink/geni-mcp.git
cd geni-mcp
npm install
npm run build
```

### 2. Create a Geni developer app

1. Go to [geni.com/platform/developer/apps](https://www.geni.com/platform/developer/apps)
2. Create a new app
3. Set the **Redirect URI** to:
   - **Local use:** `http://localhost:3000/oauth/callback`
   - **GCP Functions:** `https://YOUR_FUNCTION_URL/oauth/callback`
4. Note your **App ID** (client ID) and **App Secret**

### 3. Configure environment variables

```bash
export GENI_CLIENT_ID="your_app_id"
export GENI_CLIENT_SECRET="your_app_secret"
export GENI_REDIRECT_URI="http://localhost:3000/oauth/callback"

# Optional — skip OAuth flow if you already have a token:
export GENI_ACCESS_TOKEN="your_access_token"
export GENI_REFRESH_TOKEN="your_refresh_token"  # enables auto-renewal
```

## Running locally (Claude Code / Claude Desktop)

### Stdio mode (recommended for Claude Code)

Add to your Claude Code MCP config (`.claude/mcp.json` or `~/.claude/mcp.json`):

```json
{
  "mcpServers": {
    "geni": {
      "command": "node",
      "args": ["/path/to/geni-mcp/dist/index.js"],
      "env": {
        "GENI_CLIENT_ID": "your_app_id",
        "GENI_CLIENT_SECRET": "your_app_secret",
        "GENI_REDIRECT_URI": "http://localhost:3000/oauth/callback"
      }
    }
  }
}
```

### Claude Desktop config

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "geni": {
      "command": "node",
      "args": ["/path/to/geni-mcp/dist/index.js"],
      "env": {
        "GENI_CLIENT_ID": "your_app_id",
        "GENI_CLIENT_SECRET": "your_app_secret",
        "GENI_REDIRECT_URI": "http://localhost:3000/oauth/callback"
      }
    }
  }
}
```

## Deploying to GCP Cloud Functions

```bash
gcloud functions deploy geni-mcp \
  --gen2 \
  --runtime=nodejs22 \
  --region=europe-west1 \
  --source=. \
  --entry-point=geniMcp \
  --trigger-http \
  --allow-unauthenticated \
  --set-env-vars "GENI_CLIENT_ID=your_app_id,GENI_CLIENT_SECRET=your_app_secret,GENI_REDIRECT_URI=https://YOUR_FUNCTION_URL/oauth/callback"
```

The function exposes two endpoints:
- `POST /mcp` — MCP protocol (StreamableHTTP)
- `GET /oauth/callback` — OAuth redirect handler

### Using the deployed function with Claude Code

```json
{
  "mcpServers": {
    "geni": {
      "type": "streamable-http",
      "url": "https://YOUR_FUNCTION_URL/mcp"
    }
  }
}
```

> **Note on token persistence:** Cloud Functions are stateless. For production use, store tokens in [Cloud Secret Manager](https://cloud.google.com/secret-manager) or [Firestore](https://cloud.google.com/firestore) by implementing a custom `TokenStore`.

## First use — OAuth flow

The first time you use the server (without pre-set tokens), ask Claude:

> "Authorize my Geni account"

Claude will:
1. Call `get_authorization_url` and give you a link
2. You visit the link in your browser and click "Allow"
3. Geni redirects to your callback URL with a `code` parameter
4. Tell Claude the code (or Claude will read it from the URL)
5. Claude calls `exchange_code` and you're authenticated

After authenticating, Claude can do things like:

> "Find all profiles named 'Johann Schmidt' born in the 1800s in Germany"

> "Show me the immediate family of profile-123456789"

> "Correct the birth date for profile-123456789 to 15 March 1847 in London, England"

> "Find duplicate profiles for profile-123456789 and merge them"

## Project structure

```
src/
  index.ts          # Stdio MCP server (local use)
  gcpFunction.ts    # GCP Cloud Functions HTTP handler
  tools.ts          # MCP tool definitions and handlers
  geni-client.ts    # Geni REST API client
  oauth.ts          # OAuth 2.0 flow helpers
  types.ts          # TypeScript types for Geni API
  zod-to-json.ts    # Zod → JSON Schema converter
dist/               # Compiled output (after npm run build)
```

## Development

```bash
npm run dev         # Run with tsx (no compile step)
npm run build       # Compile TypeScript
npm run lint        # Type-check only
```

## License

MIT
