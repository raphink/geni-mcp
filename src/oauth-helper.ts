// Standalone local OAuth callback server
// Run once to get your tokens, then set GENI_ACCESS_TOKEN / GENI_REFRESH_TOKEN.
//
// Usage:
//   node dist/oauth-helper.js
//   (or: npx tsx src/oauth-helper.ts)
//
// It will:
//   1. Print the authorization URL
//   2. Start a local server on port 3000
//   3. Wait for Geni to redirect back with the code
//   4. Exchange the code for tokens and print them

import { createServer } from "node:http";
import { getOAuthConfig, buildAuthorizationUrl, exchangeCodeForTokens } from "./oauth.js";

const PORT = 3000;

async function main() {
  const config = getOAuthConfig();
  const authUrl = buildAuthorizationUrl(config);

  console.log("\n=== Geni OAuth Helper ===\n");
  console.log("1. Open this URL in your browser to authorize:\n");
  console.log(`   ${authUrl}\n`);
  console.log(`2. Waiting for callback on http://localhost:${PORT}/oauth/callback ...\n`);

  await new Promise<void>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

      if (!url.pathname.startsWith("/oauth/callback")) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<h2>Authorization failed: ${error}</h2>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h2>Missing code parameter</h2>");
        return;
      }

      try {
        const tokens = await exchangeCodeForTokens(config, code);

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          `<h2>✅ Authorization successful!</h2>` +
          `<p>You can close this window.</p>` +
          `<p>Tokens have been printed to your terminal.</p>`
        );

        console.log("✅ Authorization successful!\n");
        console.log("Add these to your environment (or .env file):\n");
        console.log(`GENI_ACCESS_TOKEN=${tokens.access_token}`);
        if (tokens.refresh_token) {
          console.log(`GENI_REFRESH_TOKEN=${tokens.refresh_token}`);
        }
        if (tokens.expires_in) {
          console.log(`\n(Token expires in ${tokens.expires_in} seconds)`);
        }
        console.log("\nOr for the MCP server claude_desktop_config.json / .claude/mcp.json:");
        console.log(JSON.stringify({
          env: {
            GENI_CLIENT_ID: config.clientId,
            GENI_CLIENT_SECRET: config.clientSecret,
            GENI_ACCESS_TOKEN: tokens.access_token,
            ...(tokens.refresh_token ? { GENI_REFRESH_TOKEN: tokens.refresh_token } : {}),
          }
        }, null, 2));

        server.close(() => resolve());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(`<h2>Token exchange failed</h2><p>${msg}</p>`);
        server.close();
        reject(err);
      }
    });

    server.listen(PORT, "127.0.0.1", () => {
      // Server is ready
    });

    server.on("error", reject);
  });
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
