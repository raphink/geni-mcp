// Shared MCP server factory used by both the stdio and GCP Functions entry points.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { tools } from "./tools.js";
import { GeniClient } from "./geni-client.js";
import type { OAuthConfig, TokenStore } from "./oauth.js";

export const SERVER_NAME = "geni-mcp";
export const SERVER_VERSION = "1.0.0";

// Pre-compute the tool manifest once at module load — it never changes.
const toolManifest = tools.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: zodToJsonSchema(t.inputSchema),
}));

// Pre-build a name→tool lookup map for O(1) dispatch.
const toolMap = new Map(tools.map((t) => [t.name, t]));

export function createMcpServer(
  tokenStore: TokenStore,
  oauthConfig: OAuthConfig
): Server {
  const client = new GeniClient(tokenStore, oauthConfig);

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolManifest,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = toolMap.get(request.params.name);
    if (!tool) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${request.params.name}` }],
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
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}
