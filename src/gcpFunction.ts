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

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import {
  EnvTokenStore,
  getOAuthConfig,
  exchangeCodeForTokens,
} from "./oauth.js";

// Shared token store across function invocations (best-effort — use a real
// persistent store like Cloud Secret Manager for production).
const tokenStore = new EnvTokenStore();
// Config is immutable — read once at module load.
const oauthConfig = getOAuthConfig();

const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MB guard

/** GCP Cloud Functions HTTP entry point */
export async function geniMcp(
  req: IncomingMessage & { url?: string; method?: string },
  res: ServerResponse
): Promise<void> {
  const url = req.url ?? "/";

  // ── OAuth callback handler ──────────────────────────────────────────────
  if (url.startsWith("/oauth/callback")) {
    const callbackUrl = new URL(url, "http://localhost");
    const code = callbackUrl.searchParams.get("code");
    const error = callbackUrl.searchParams.get("error");

    if (error) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(`<h2>Authorization failed</h2><p>Error: ${escapeHtml(error)}</p>`);
      return;
    }

    if (!code) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end("<h2>Missing code parameter</h2>");
      return;
    }

    try {
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
    const body = await readBody(req);
    const server = createMcpServer(tokenStore, oauthConfig);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode for Cloud Functions
    });

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    return;
  }

  // ── Health check ────────────────────────────────────────────────────────
  if (url === "/" || url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION }));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

// Read and size-cap the request body before passing to the MCP transport.
async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (!body) { resolve({}); return; }
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
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}
