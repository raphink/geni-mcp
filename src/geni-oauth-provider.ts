// GeniOAuthProvider — MCP OAuth 2.0 Authorization Server backed by Geni OAuth.
//
// Flow:
//  1. Claude.ai → GET /authorize  (MCP auth router handles this, calls provider.authorize)
//  2. provider.authorize → stores PKCE/state, redirects to Geni's OAuth
//  3. Geni → GET /oauth/callback  (gcpFunction route, calls provider.handleGeniCallback)
//  4. handleGeniCallback → exchanges code with Geni, generates MCP code, redirects to Claude.ai
//  5. Claude.ai → POST /token  (MCP auth router handles this, SDK validates PKCE, calls provider.exchangeAuthorizationCode)
//  6. provider.exchangeAuthorizationCode → returns Geni tokens to Claude.ai
//  7. Claude.ai → POST /mcp with Bearer <geni_access_token>
//  8. provider.verifyAccessToken → verifies against Geni API

import crypto from "node:crypto";
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { buildAuthorizationUrl, exchangeCodeForTokens, refreshAccessToken } from "./oauth.js";
import type { OAuthConfig } from "./oauth.js";

const GENI_API_BASE = "https://www.geni.com/api";

// TTL for pending entries (10 minutes)
const PENDING_TTL_MS = 10 * 60 * 1000;

interface PendingAuth {
  codeChallenge: string;
  redirectUri: string;
  state?: string;
  clientId: string;
  expiresAt: number;
}

interface PendingToken {
  geniTokens: OAuthTokens;
  codeChallenge: string;
  expiresAt: number;
}

export class GeniOAuthProvider implements OAuthServerProvider {
  // SDK validates PKCE locally using challengeForAuthorizationCode() — no need to forward code_verifier to Geni.
  readonly skipLocalPkceValidation = false;

  private readonly pendingAuths = new Map<string, PendingAuth>();  // geniState → pending auth
  private readonly pendingTokens = new Map<string, PendingToken>(); // mcpCode → pending token
  private readonly registeredClients = new Map<string, OAuthClientInformationFull>();

  constructor(
    private readonly oauthConfig: OAuthConfig,
    private readonly serverUrl: string
  ) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (clientId: string) =>
        this.registeredClients.get(clientId),

      registerClient: async (
        client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">
      ): Promise<OAuthClientInformationFull> => {
        const full: OAuthClientInformationFull = {
          ...client,
          client_id: crypto.randomUUID(),
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        this.registeredClients.set(full.client_id, full);
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

    const config = { ...this.oauthConfig, redirectUri: `${this.serverUrl}/oauth/callback` };
    res.redirect(buildAuthorizationUrl(config, geniState));
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
    _client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    _resource?: URL
  ): Promise<OAuthTokens> {
    const raw = await refreshAccessToken(this.oauthConfig, refreshToken);
    return {
      access_token: raw.access_token,
      token_type: "Bearer",
      ...(raw.refresh_token && { refresh_token: raw.refresh_token }),
      ...(raw.expires_in !== undefined && { expires_in: raw.expires_in }),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const url = new URL(`${GENI_API_BASE}/profile`);
    url.searchParams.set("access_token", token);
    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(`Token verification failed: ${res.status}`);
    }
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

    const config = { ...this.oauthConfig, redirectUri: `${this.serverUrl}/oauth/callback` };
    let geniTokens: OAuthTokens;
    try {
      const raw = await exchangeCodeForTokens(config, code);
      geniTokens = {
        access_token: raw.access_token,
        token_type: "Bearer",
        ...(raw.refresh_token && { refresh_token: raw.refresh_token }),
        ...(raw.expires_in !== undefined && { expires_in: raw.expires_in }),
      };
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

  private evictExpired(): void {
    const now = Date.now();
    for (const [k, v] of this.pendingAuths) if (now > v.expiresAt) this.pendingAuths.delete(k);
    for (const [k, v] of this.pendingTokens) if (now > v.expiresAt) this.pendingTokens.delete(k);
  }
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
