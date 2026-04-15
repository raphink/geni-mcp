// GeniOAuthProvider — MCP OAuth 2.0 Authorization Server backed by Geni OAuth.
//
// The Geni app credentials (client_id / client_secret) are NOT stored as env vars.
// Instead, they are provided by the connecting client (e.g. Claude.ai) during the
// OAuth flow — the client_id and client_secret registered with this server are
// the same credentials used to call Geni's OAuth endpoints.
//
// Flow:
//  1. Claude.ai → GET /authorize  (MCP auth router, calls provider.authorize)
//  2. provider.authorize → stores PKCE/state, redirects to Geni OAuth
//  3. Geni → GET /oauth/callback  (gcpFunction route, calls provider.handleGeniCallback)
//  4. handleGeniCallback → exchanges code with Geni, generates MCP code, redirects to Claude.ai
//  5. Claude.ai → POST /token  (MCP auth router, SDK validates PKCE, calls provider.exchangeAuthorizationCode)
//  6. provider.exchangeAuthorizationCode → returns Geni tokens to Claude.ai
//  7. Claude.ai → POST /mcp with Bearer <geni_access_token>
//  8. provider.verifyAccessToken → verifies against Geni API

import crypto from "node:crypto";
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

const GENI_AUTH_URL = "https://www.geni.com/oauth/authorize";
const GENI_TOKEN_URL = "https://www.geni.com/oauth/token";
const GENI_API_BASE = "https://www.geni.com/api";
const GENI_SCOPES = "basic offline";

// TTL for pending entries (10 minutes)
const PENDING_TTL_MS = 10 * 60 * 1000;

interface PendingAuth {
  clientId: string;       // The registered client — used to look up Geni credentials
  codeChallenge: string;
  redirectUri: string;
  state?: string;
  expiresAt: number;
}

interface PendingToken {
  geniTokens: OAuthTokens;
  codeChallenge: string;
  expiresAt: number;
}

export class GeniOAuthProvider implements OAuthServerProvider {
  // SDK validates PKCE locally — no need to forward code_verifier to Geni.
  readonly skipLocalPkceValidation = false;

  private readonly pendingAuths = new Map<string, PendingAuth>();
  private readonly pendingTokens = new Map<string, PendingToken>();
  private readonly clients = new Map<string, OAuthClientInformationFull>();

  constructor(
    private readonly serverUrl: string,
    defaultClient?: { client_id: string; client_secret: string }
  ) {
    if (defaultClient) {
      this.clients.set(defaultClient.client_id, {
        client_id: defaultClient.client_id,
        client_secret: defaultClient.client_secret,
        client_id_issued_at: 0,
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      });
      console.log(`[oauth] pre-seeded client ${defaultClient.client_id}`);
    }
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (clientId: string) => {
        const client = this.clients.get(clientId);
        console.log(`[oauth] getClient ${clientId} → ${client ? "found" : "not found"}`);
        return client;
      },

      registerClient: async (
        client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">
      ): Promise<OAuthClientInformationFull> => {
        // The TypeScript type omits client_id, but RFC 7591 allows clients to
        // submit their own. Claude passes the Geni OAuth client_id here so we
        // must preserve it rather than replace it with a random UUID.
        const submittedId = (client as Record<string, unknown>)["client_id"] as string | undefined;
        const full: OAuthClientInformationFull = {
          ...client,
          client_id: submittedId ?? crypto.randomUUID(),
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        this.clients.set(full.client_id, full);
        console.log(`[oauth] registerClient submitted=${submittedId ?? "(none)"} assigned=${full.client_id} hasSecret=${!!full.client_secret}`);
        return full;
      },
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    this.evictExpired();

    const geniState = crypto.randomUUID();
    this.pendingAuths.set(geniState, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      state: params.state,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });

    const qs = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: `${this.serverUrl}/oauth/callback`,
      response_type: "code",
      scope: GENI_SCOPES,
      state: geniState,
    });
    console.log(`[oauth] authorize client=${client.client_id} geniState=${geniState} redirectUri=${params.redirectUri}`);
    res.redirect(`${GENI_AUTH_URL}?${qs}`);
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    code: string
  ): Promise<string> {
    const challenge = this.pendingTokens.get(code)?.codeChallenge ?? "";
    console.log(`[oauth] challengeForAuthorizationCode code=${code.slice(0, 8)}… found=${!!challenge}`);
    return challenge;
  }

  async exchangeAuthorizationCode(
    _client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    _redirectUri?: string,
    _resource?: URL
  ): Promise<OAuthTokens> {
    const pending = this.pendingTokens.get(code);
    if (!pending) {
      console.error(`[oauth] exchangeAuthorizationCode code=${code.slice(0, 8)}… not found`);
      throw new Error("Invalid or expired authorization code");
    }
    this.pendingTokens.delete(code);
    console.log(`[oauth] exchangeAuthorizationCode code=${code.slice(0, 8)}… ok`);
    return pending.geniTokens;
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    _resource?: URL
  ): Promise<OAuthTokens> {
    console.log(`[oauth] exchangeRefreshToken client=${client.client_id}`);
    return this.callGeniToken({
      grant_type: "refresh_token",
      client_id: client.client_id,
      client_secret: client.client_secret ?? "",
      refresh_token: refreshToken,
    });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const url = new URL(`${GENI_API_BASE}/profile`);
    url.searchParams.set("access_token", token);
    const res = await fetch(url.toString());
    if (!res.ok) {
      console.error(`[oauth] verifyAccessToken failed status=${res.status}`);
      throw new Error(`Token verification failed: ${res.status}`);
    }
    const profile = await res.json() as { id?: string };
    console.log(`[oauth] verifyAccessToken ok profileId=${profile.id}`);
    return {
      token,
      clientId: "geni",
      scopes: ["basic"],
      ...(profile.id && { extra: { profileId: profile.id } }),
    };
  }

  /** Called from the /oauth/callback route after Geni redirects back. */
  async handleGeniCallback(
    code: string | undefined,
    error: string | undefined,
    geniState: string | undefined,
    res: Response
  ): Promise<void> {
    console.log(`[oauth] handleGeniCallback geniState=${geniState} code=${code ? "present" : "missing"} error=${error ?? "none"}`);
    if (error) {
      console.error(`[oauth] handleGeniCallback error from Geni: ${error}`);
      res.status(400).send(`<h2>Authorization failed</h2><p>${escapeHtml(error)}</p>`);
      return;
    }
    if (!code || !geniState) {
      console.error(`[oauth] handleGeniCallback missing code or state`);
      res.status(400).send("<h2>Missing code or state parameter</h2>");
      return;
    }

    const pending = this.pendingAuths.get(geniState);
    if (!pending || Date.now() > pending.expiresAt) {
      console.error(`[oauth] handleGeniCallback unknown/expired geniState=${geniState} pendingAuths.size=${this.pendingAuths.size}`);
      this.pendingAuths.delete(geniState);
      res.status(400).send("<h2>Unknown or expired authorization session</h2>");
      return;
    }
    this.pendingAuths.delete(geniState);
    console.log(`[oauth] handleGeniCallback found pending for clientId=${pending.clientId}`);

    const client = await this.clientsStore.getClient(pending.clientId);
    console.log(`[oauth] handleGeniCallback client lookup: ${client ? "found" : "not found"} hasSecret=${!!client?.client_secret}`);

    let geniTokens: OAuthTokens;
    try {
      geniTokens = await this.callGeniToken({
        grant_type: "authorization_code",
        client_id: pending.clientId,
        client_secret: client?.client_secret ?? "",
        redirect_uri: `${this.serverUrl}/oauth/callback`,
        code,
      });
      console.log(`[oauth] handleGeniCallback token exchange ok hasRefresh=${!!geniTokens.refresh_token}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[oauth] handleGeniCallback token exchange failed: ${msg}`);
      res.status(500).send(`<h2>Token exchange failed</h2><p>${escapeHtml(msg)}</p>`);
      return;
    }

    const mcpCode = crypto.randomUUID();
    this.pendingTokens.set(mcpCode, {
      geniTokens,
      codeChallenge: pending.codeChallenge,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });

    const redirectUrl = new URL(pending.redirectUri);
    redirectUrl.searchParams.set("code", mcpCode);
    if (pending.state) redirectUrl.searchParams.set("state", pending.state);
    console.log(`[oauth] handleGeniCallback redirecting to ${pending.redirectUri}`);
    res.redirect(redirectUrl.toString());
  }

  private async callGeniToken(params: Record<string, string>): Promise<OAuthTokens> {
    console.log(`[oauth] callGeniToken grant_type=${params["grant_type"]} client_id=${params["client_id"]}`);
    const res = await fetch(GENI_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Geni token request failed (${res.status}): ${text}`);
    }
    const data = await res.json() as Record<string, unknown>;
    return {
      access_token: data["access_token"] as string,
      token_type: "Bearer",
      ...(data["refresh_token"] ? { refresh_token: data["refresh_token"] as string } : {}),
      ...(data["expires_in"] !== undefined ? { expires_in: data["expires_in"] as number } : {}),
    };
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [k, v] of this.pendingAuths) if (now > v.expiresAt) this.pendingAuths.delete(k);
    for (const [k, v] of this.pendingTokens) if (now > v.expiresAt) this.pendingTokens.delete(k);
  }
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
