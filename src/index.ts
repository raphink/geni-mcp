// Main entry point: stdio MCP server (for local use with Claude Code / Claude Desktop)
//
// Run with:
//   GENI_CLIENT_ID=xxx GENI_CLIENT_SECRET=yyy node dist/index.js
//   or:
//   GENI_ACCESS_TOKEN=xxx node dist/index.js

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "./zod-to-json.js";
import { tools } from "./tools.js";
import { GeniClient } from "./geni-client.js";
import { EnvTokenStore, getOAuthConfig } from "./oauth.js";

async function main() {
  const tokenStore = new EnvTokenStore();
  const oauthConfig = getOAuthConfig();
  const client = new GeniClient(tokenStore, oauthConfig);

  const server = new Server(
    { name: "geni-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  // List all available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema),
    })),
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) {
      return {
        content: [
          {
            type: "text",
            text: `Unknown tool: ${request.params.name}`,
          },
        ],
        isError: true,
      };
    }

    try {
      return await tool.handler(request.params.arguments ?? {}, {
        client,
        tokenStore,
        oauthConfig,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Geni MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
