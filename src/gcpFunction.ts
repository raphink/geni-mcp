// GCP Cloud Functions HTTP handler (MCP over StreamableHTTP transport)
//
// Deploy with:
//   gcloud functions deploy geni-mcp \
//     --gen2 \
//     --runtime=nodejs22 \
//     --region=YOUR_REGION \
//     --source=. \
//     --entry-point=geniMcp \
//     --trigger-http \
//     --allow-unauthenticated \
//     --set-env-vars GENI_CLIENT_ID=xxx,GENI_CLIENT_SECRET=yyy,GENI_REDIRECT_URI=https://YOUR_FUNCTION_URL/oauth/callback
//
// The function exposes:
//   POST /mcp  — MCP protocol endpoint (StreamableHTTP)
//   GET  /oauth/callback — OAuth redirect handler

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { zodToJsonSchema } from "./zod-to-json.js";
import { tools } from "./tools.js";
import { GeniClient } from "./geni-client.js";
import {
  EnvTokenStore,
  getOAuthConfig,
  exchangeCodeForTokens,
} from "./oauth.js";

// Shared token store across function invocations (best-effort — use a real
// persistent store like Cloud Secret Manager for production).
const tokenStore = new EnvTokenStore();

function createServer() {
  const oauthConfig = getOAuthConfig();
  const client = new GeniClient(tokenStore, oauthConfig);

  const server = new Server(
    { name: "geni-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
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

  return { server, oauthConfig };
}

/** GCP Cloud Functions HTTP entry point */
export async function geniMcp(
  req: IncomingMessage & { url?: string; method?: string },
  res: ServerResponse
): Promise<void> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  // ── OAuth callback handler ──────────────────────────────────────────────
  if (url.startsWith("/oauth/callback")) {
    const callbackUrl = new URL(url, "http://localhost");
    const code = callbackUrl.searchParams.get("code");
    const error = callbackUrl.searchParams.get("error");

    if (error) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(
        `<h2>Authorization failed</h2><p>Error: ${escapeHtml(error)}</p>`
      );
      return;
    }

    if (!code) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end("<h2>Missing code parameter</h2>");
      return;
    }

    try {
      const oauthConfig = getOAuthConfig();
      const tokens = await exchangeCodeForTokens(oauthConfig, code);
      tokenStore.setTokens(
        tokens.access_token,
        tokens.refresh_token,
        tokens.expires_in
      );
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<h2>✅ Geni authorization successful!</h2>` +
          `<p>You can close this window. Claude can now access your Geni account.</p>` +
          (tokens.refresh_token
            ? `<p>A refresh token was obtained — the session will auto-renew.</p>`
            : `<p>⚠️ No refresh token received. You may need to re-authorize when the token expires.</p>`)
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { "Content-Type": "text/html" });
      res.end(`<h2>Token exchange failed</h2><p>${escapeHtml(msg)}</p>`);
    }
    return;
  }

  // ── MCP StreamableHTTP endpoint ─────────────────────────────────────────
  if (url === "/mcp" || url === "/mcp/") {
    const { server } = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode for Cloud Functions
    });

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, await readBody(req));
    return;
  }

  // ── Health check ────────────────────────────────────────────────────────
  if (url === "/" || url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", server: "geni-mcp", version: "1.0.0" }));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
