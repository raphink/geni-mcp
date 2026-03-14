// OAuth 2.0 helper for Geni
// Geni uses standard OAuth 2.0 Authorization Code flow.
//
// Setup:
//   1. Register your app at https://www.geni.com/platform/developer/apps
//   2. Set GENI_CLIENT_ID and GENI_CLIENT_SECRET environment variables.
//   3. Set GENI_REDIRECT_URI to your callback URL (e.g. http://localhost:3000/oauth/callback).
//
// The token is stored in GENI_ACCESS_TOKEN / GENI_REFRESH_TOKEN env vars.
// For persistent deployments, override TokenStore with your own implementation
// (e.g. Cloud Secret Manager, Firestore).

import type { GeniTokenResponse } from "./types.js";

const GENI_AUTH_URL = "https://www.geni.com/oauth/authorize";
const GENI_TOKEN_URL = "https://www.geni.com/oauth/token";

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface TokenStore {
  getAccessToken(): string | undefined;
  getRefreshToken(): string | undefined;
  setTokens(access: string, refresh?: string, expiresIn?: number): void;
}

/** Default in-memory token store backed by environment variables on startup. */
export class EnvTokenStore implements TokenStore {
  private accessToken: string | undefined;
  private refreshToken: string | undefined;
  private expiresAt: number | undefined;

  constructor() {
    this.accessToken = process.env.GENI_ACCESS_TOKEN;
    this.refreshToken = process.env.GENI_REFRESH_TOKEN;
  }

  getAccessToken(): string | undefined {
    if (this.expiresAt && Date.now() >= this.expiresAt) {
      return undefined; // expired
    }
    return this.accessToken;
  }

  getRefreshToken(): string | undefined {
    return this.refreshToken;
  }

  setTokens(access: string, refresh?: string, expiresIn?: number): void {
    this.accessToken = access;
    if (refresh) this.refreshToken = refresh;
    if (expiresIn) {
      // Subtract 60s buffer so we refresh before actual expiry
      this.expiresAt = Date.now() + (expiresIn - 60) * 1000;
    }
  }
}

export function getOAuthConfig(): OAuthConfig {
  const clientId = process.env.GENI_CLIENT_ID;
  const clientSecret = process.env.GENI_CLIENT_SECRET;
  const redirectUri =
    process.env.GENI_REDIRECT_URI ?? "http://localhost:3000/oauth/callback";

  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing GENI_CLIENT_ID or GENI_CLIENT_SECRET environment variables. " +
        "Register your app at https://www.geni.com/platform/developer/apps"
    );
  }

  return { clientId, clientSecret, redirectUri };
}

/**
 * Build the URL to redirect the user to for authorization.
 * Scopes: basic (required), email, offline (required for refresh token), collaborate (for merges)
 */
export function buildAuthorizationUrl(
  config: OAuthConfig,
  state?: string
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: "basic email offline collaborate",
  });
  if (state) params.set("state", state);
  return `${GENI_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeCodeForTokens(
  config: OAuthConfig,
  code: string
): Promise<GeniTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    code,
  });

  const res = await fetch(GENI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<GeniTokenResponse>;
}

/**
 * Refresh an expired access token using the refresh token.
 */
export async function refreshAccessToken(
  config: OAuthConfig,
  refreshToken: string
): Promise<GeniTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
  });

  const res = await fetch(GENI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<GeniTokenResponse>;
}
