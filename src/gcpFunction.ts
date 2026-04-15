// GCP Cloud Functions HTTP handler (MCP over StreamableHTTP + MCP OAuth server)
//
// Deploy with:
//   ./deploy.sh
//
// The function exposes:
//   GET  /.well-known/oauth-authorization-server  — OAuth discovery metadata
//   GET  /authorize                               — OAuth authorization endpoint
//   POST /token                                   — OAuth token endpoint
//   POST /register                                — Dynamic client registration
//   GET  /oauth/callback                          — Geni OAuth redirect handler
//   POST /mcp                                     — MCP protocol endpoint (StreamableHTTP)
//   GET  /health                                  — Health check

import express from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { EnvTokenStore, getOAuthConfig } from "./oauth.js";
import { GeniOAuthProvider } from "./geni-oauth-provider.js";

const oauthConfig = (() => {
  try {
    return getOAuthConfig();
  } catch {
    return null;
  }
})();

// Fallback token store for env-var tokens (used when no Bearer header is present).
const envTokenStore = new EnvTokenStore();

const app = express();
// Trust Cloud Run's load balancer so req.protocol reflects the original scheme.
app.set("trust proxy", true);

// ── OAuth authorization server (requires GENI_CLIENT_ID / GENI_CLIENT_SECRET) ─
if (oauthConfig) {
  let provider: GeniOAuthProvider | null = null;
  let authHandler: express.RequestHandler | null = null;

  // Lazily initialize on the first request so we can derive the server URL
  // from the incoming Host header instead of a hard-coded env var.
  app.use((req, res, next) => {
    if (!authHandler) {
      const serverUrl = `${req.protocol}://${req.get("host")}`;
      provider = new GeniOAuthProvider(oauthConfig!, serverUrl);
      authHandler = mcpAuthRouter({
        provider,
        issuerUrl: new URL(serverUrl),
        resourceName: "Geni Genealogy MCP",
        scopesSupported: ["basic", "offline", "collaborate"],
      });
    }
    authHandler(req, res, next);
  });

  // Geni redirects here after the user grants access.
  app.get("/oauth/callback", (req, res) => {
    if (!provider) {
      res.status(500).send("<h2>Not initialized</h2>");
      return;
    }
    const code = req.query["code"] as string | undefined;
    const error = req.query["error"] as string | undefined;
    const state = req.query["state"] as string | undefined;
    provider.handleGeniCallback(code, error, state, res).catch((err) => {
      console.error("OAuth callback error:", err);
      res.status(500).send("<h2>Internal server error</h2>");
    });
  });
}

// ── MCP StreamableHTTP endpoint ───────────────────────────────────────────────
app.post("/mcp", express.json({ limit: "1mb" }), async (req, res) => {
  const authHeader = req.headers["authorization"];
  const bearerToken = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : undefined;

  const tokenStore = bearerToken
    ? {
        getAccessToken: () => bearerToken,
        getRefreshToken: () => undefined as string | undefined,
        setTokens: () => {},
      }
    : envTokenStore;

  const server = createMcpServer(tokenStore, oauthConfig);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode for Cloud Functions
  });

  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body ?? {});
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get(["/", "/health"], (_req, res) => {
  res.json({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION });
});

export const geniMcp = app;
