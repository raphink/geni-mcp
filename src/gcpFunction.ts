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
// Trust exactly one proxy hop (Cloud Run's load balancer) so req.protocol and
// req.ip are correct. Using a number (not `true`) satisfies express-rate-limit.
app.set("trust proxy", 1);

// Derive server URL from environment. On Cloud Run / Cloud Functions gen2 the
// K_SERVICE env var is set automatically; fall back to SERVER_URL if provided.
function getServerUrl(): string {
  if (process.env.SERVER_URL) return process.env.SERVER_URL;
  const service = process.env.K_SERVICE;
  const region = process.env.FUNCTION_REGION ?? "europe-west1";
  const projectNumber = process.env.GOOGLE_CLOUD_PROJECT_NUMBER;
  if (service && projectNumber) {
    return `https://${service}-${projectNumber}.${region}.run.app`;
  }
  // Fallback: use the known deployed URL
  return "https://geni-mcp-368386322346.europe-west1.run.app";
}

// ── OAuth authorization server (requires GENI_CLIENT_ID / GENI_CLIENT_SECRET) ─
let provider: GeniOAuthProvider | null = null;
if (oauthConfig) {
  const serverUrl = getServerUrl();
  provider = new GeniOAuthProvider(oauthConfig, serverUrl);

  // Create auth router at init time (express-rate-limit requires this).
  app.use(mcpAuthRouter({
    provider,
    issuerUrl: new URL(serverUrl),
    resourceName: "Geni Genealogy MCP",
    scopesSupported: ["basic", "offline", "collaborate"],
  }));

  // Geni redirects here after the user grants access.
  app.get("/oauth/callback", (req, res) => {
    const code = req.query["code"] as string | undefined;
    const error = req.query["error"] as string | undefined;
    const state = req.query["state"] as string | undefined;
    provider!.handleGeniCallback(code, error, state, res).catch((err) => {
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
