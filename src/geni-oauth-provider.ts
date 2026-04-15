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

  constructor(private readonly serverUrl: string) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (clientId: string) => this.clients.get(clientId),

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
    res.redirect(`${GENI_AUTH_URL}?${qs}`);
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    code: string
  ): Promise<string> {
    return this.pendingTokens.get(code)?.codeChallenge ?? "";
  }

  async exchangeAuthorizationCode(
    _client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    _redirectUri?: string,
    _resource?: URL
  ): Promise<OAuthTokens> {
    const pending = this.pendingTokens.get(code);
    if (!pending) throw new Error("Invalid or expired authorization code");
    this.pendingTokens.delete(code);
    return pending.geniTokens;
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    _resource?: URL
  ): Promise<OAuthTokens> {
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
    if (!res.ok) throw new Error(`Token verification failed: ${res.status}`);
    const profile = await res.json() as { id?: string };
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
    if (error) {
      res.status(400).send(`<h2>Authorization failed</h2><p>${escapeHtml(error)}</p>`);
      return;
    }
    if (!code || !geniState) {
      res.status(400).send("<h2>Missing code or state parameter</h2>");
      return;
    }

    const pending = this.pendingAuths.get(geniState);
    if (!pending || Date.now() > pending.expiresAt) {
      this.pendingAuths.delete(geniState);
      res.status(400).send("<h2>Unknown or expired authorization session</h2>");
      return;
    }
    this.pendingAuths.delete(geniState);

    const client = await this.clientsStore.getClient(pending.clientId);

    let geniTokens: OAuthTokens;
    try {
      geniTokens = await this.callGeniToken({
        grant_type: "authorization_code",
        client_id: pending.clientId,
        client_secret: client?.client_secret ?? "",
        redirect_uri: `${this.serverUrl}/oauth/callback`,
        code,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
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
    res.redirect(redirectUrl.toString());
  }

  private async callGeniToken(params: Record<string, string>): Promise<OAuthTokens> {
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
