// Main entry point: stdio MCP server (for local use with Claude Code / Claude Desktop)
//
// Run with:
//   GENI_CLIENT_ID=xxx GENI_CLIENT_SECRET=yyy node dist/index.js
//   or:
//   GENI_ACCESS_TOKEN=xxx node dist/index.js

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";
import { EnvTokenStore, getOAuthConfig } from "./oauth.js";

async function main() {
  const tokenStore = new EnvTokenStore();
  const oauthConfig = getOAuthConfig();
  const server = createMcpServer(tokenStore, oauthConfig);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Geni MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
