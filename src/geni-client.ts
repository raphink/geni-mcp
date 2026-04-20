// Geni REST API client

import type {
  GeniProfile,
  GeniProfileUpdatePayload,
  GeniImmediateFamily,
  GeniUnion,
  GeniSearchResponse,
  GeniMergeCandidatesResponse,
  RelationshipType,
} from "./types.js";
import type { OAuthConfig, TokenStore } from "./oauth.js";
import { refreshAccessToken } from "./oauth.js";

const GENI_API_BASE = "https://www.geni.com/api";
const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 40;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 10_000;
const DEFAULT_MAX_429_RETRIES = 3;
const PROFILE_FIELDS = [
  "id",
  "guid",
  "name",
  "display_name",
  "first_name",
  "middle_name",
  "last_name",
  "maiden_name",
  "suffix",
  "gender",
  "is_alive",
  "public",
  "big_tree",
  "claimed",
  "master_profile",
  "url",
  "profile_url",
  "birth",
  "death",
  "burial",
  "baptism",
  "about_me",
  "unions",
  "nationalities",
  "photo_urls",
  "created_at",
  "updated_at",
  "manager",
].join(",");

export class GeniClient {
  // Coalesces concurrent refresh attempts so only one HTTP call is made.
  private refreshPromise: Promise<string> | null = null;
  // Serializes rate-limit accounting across concurrent requests.
  private rateLimitQueue: Promise<void> = Promise.resolve();
  private requestTimestamps: number[] = [];
  private readonly rateLimitMaxRequests = Number(
    process.env.GENI_RATE_LIMIT_MAX_REQUESTS ?? DEFAULT_RATE_LIMIT_MAX_REQUESTS
  );
  private readonly rateLimitWindowMs = Number(
    process.env.GENI_RATE_LIMIT_WINDOW_MS ?? DEFAULT_RATE_LIMIT_WINDOW_MS
  );
  private readonly max429Retries = Number(
    process.env.GENI_MAX_429_RETRIES ?? DEFAULT_MAX_429_RETRIES
  );

  constructor(
    private readonly tokenStore: TokenStore,
    private readonly oauthConfig: OAuthConfig | null
  ) {}

  // ── Low-level HTTP ──────────────────────────────────────────────────────────

  private async getAccessToken(): Promise<string> {
    const token = this.tokenStore.getAccessToken();
    if (token) return token;

    // Coalesce concurrent callers onto a single refresh request.
    if (!this.refreshPromise) {
      this.refreshPromise = this.doRefresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  private async doRefresh(): Promise<string> {
    const refreshToken = this.tokenStore.getRefreshToken();
    if (!refreshToken || !this.oauthConfig) {
      throw new Error(
        "No valid access token available. Run the OAuth flow first: " +
          "use the 'get_authorization_url' tool, visit the URL, then call 'exchange_code' with the returned code."
      );
    }

    const tokenResponse = await refreshAccessToken(
      this.oauthConfig,
      refreshToken
    );
    this.tokenStore.setTokens(
      tokenResponse.access_token,
      tokenResponse.refresh_token,
      tokenResponse.expires_in
    );
    return tokenResponse.access_token;
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    params?: Record<string, string>,
    body?: unknown
  ): Promise<T> {
    const token = await this.getAccessToken();
    const url = new URL(`${GENI_API_BASE}${path}`);
    url.searchParams.set("access_token", token);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }

    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }

    for (let attempt = 0; ; attempt++) {
      await this.acquireRateLimitSlot();
      const res = await fetch(url.toString(), init);

      if (res.status === 429 && attempt < this.max429Retries) {
        const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
        const waitMs = retryAfterMs ?? computeBackoffMs(attempt);
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        let msg = `Geni API error ${res.status}`;
        try {
          const json = JSON.parse(text) as { error?: string; message?: string };
          msg += `: ${json.error ?? json.message ?? text}`;
        } catch {
          msg += `: ${text}`;
        }
        throw new Error(msg);
      }

      return res.json() as Promise<T>;
    }
  }

  private async acquireRateLimitSlot(): Promise<void> {
    if (this.rateLimitMaxRequests <= 0 || this.rateLimitWindowMs <= 0) return;

    let releaseQueue: (() => void) | undefined;
    const nextQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    const prevQueue = this.rateLimitQueue;
    this.rateLimitQueue = prevQueue.then(() => nextQueue);

    await prevQueue;
    try {
      while (true) {
        const now = Date.now();
        this.requestTimestamps = this.requestTimestamps.filter(
          (ts) => now - ts < this.rateLimitWindowMs
        );

        if (this.requestTimestamps.length < this.rateLimitMaxRequests) {
          this.requestTimestamps.push(now);
          return;
        }

        const earliest = this.requestTimestamps[0] ?? now;
        const waitMs = Math.max(
          1,
          this.rateLimitWindowMs - (now - earliest) + 1
        );
        await sleep(waitMs);
      }
    } finally {
      releaseQueue?.();
    }
  }

  // ── Profile endpoints ───────────────────────────────────────────────────────

  /** Get the authenticated user's own profile. */
  async getMyProfile(): Promise<GeniProfile> {
    return this.request<GeniProfile>("GET", "/profile");
  }

  /** Get a profile by ID (e.g. "profile-123456789" or just "123456789"). */
  async getProfile(profileId: string): Promise<GeniProfile> {
    const id = normalizeProfileId(profileId);
    return this.request<GeniProfile>("GET", `/${id}`, {
      fields: PROFILE_FIELDS,
    });
  }

  /** Update fields on a profile you manage. */
  async updateProfile(
    profileId: string,
    updates: GeniProfileUpdatePayload
  ): Promise<GeniProfile> {
    const id = normalizeProfileId(profileId);
    return this.request<GeniProfile>("PUT", `/${id}`, undefined, updates);
  }

  /** Create a new profile. */
  async createProfile(
    data: GeniProfileUpdatePayload & { first_name: string }
  ): Promise<GeniProfile> {
    return this.request<GeniProfile>("POST", "/profile", undefined, data);
  }

  // ── Family endpoints ────────────────────────────────────────────────────────

  /** Get parents, siblings, spouses, and children of a profile. */
  async getImmediateFamily(profileId: string): Promise<GeniImmediateFamily> {
    const id = normalizeProfileId(profileId);
    return this.request<GeniImmediateFamily>(
      "GET",
      `/${id}/immediate-family`
    );
  }

  /** Get a union (couple + children) by union ID. */
  async getUnion(unionId: string): Promise<GeniUnion> {
    const id = normalizeUnionId(unionId);
    return this.request<GeniUnion>("GET", `/${id}`);
  }

  /** Add a relationship to a profile. */
  async addRelation(
    profileId: string,
    relationship: RelationshipType,
    newPersonData: GeniProfileUpdatePayload & { first_name: string }
  ): Promise<GeniProfile> {
    const id = normalizeProfileId(profileId);
    const endpoint = relationshipEndpoint(relationship);
    return this.request<GeniProfile>(
      "POST",
      `/${id}/${endpoint}`,
      undefined,
      newPersonData
    );
  }

  // ── Search ──────────────────────────────────────────────────────────────────

  /**
   * Search profiles by name and optional filters.
   * @param name       Name to search for
   * @param options    Additional search filters
   */
  async searchProfiles(
    name: string,
    options?: {
      birthYear?: number;
      deathYear?: number;
      birthLocation?: string;
      page?: number;
    }
  ): Promise<GeniSearchResponse> {
    const params: Record<string, string> = { names: name };
    if (options?.birthYear) params["birth_year"] = String(options.birthYear);
    if (options?.deathYear) params["death_year"] = String(options.deathYear);
    if (options?.birthLocation) params["birth_location"] = options.birthLocation;
    if (options?.page) params["page"] = String(options.page);

    return this.request<GeniSearchResponse>("GET", "/profile/search", params);
  }

  // ── Merge ───────────────────────────────────────────────────────────────────

  /** Get suggested duplicate profiles (merge candidates) for a profile. */
  async getMergeCandidates(
    profileId: string
  ): Promise<GeniMergeCandidatesResponse> {
    const id = normalizeProfileId(profileId);
    return this.request<GeniMergeCandidatesResponse>(
      "GET",
      `/${id}/merge-candidates`
    );
  }

  /**
   * Merge two profiles. The base profile survives; the duplicate is merged in.
   * Requires the 'collaborate' OAuth scope.
   */
  async mergeProfiles(
    baseProfileId: string,
    duplicateProfileId: string
  ): Promise<GeniProfile> {
    const base = normalizeProfileId(baseProfileId);
    const dup = normalizeProfileId(duplicateProfileId);
    return this.request<GeniProfile>("POST", `/${base}/merge/${dup}`);
  }

  // ── User ────────────────────────────────────────────────────────────────────

  /** Get the authenticated user's account information. */
  async getUser(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("GET", "/user");
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Normalize an entity ID to the "prefix-XXXX" form. */
function normalizeId(id: string, prefix: string): string {
  const fullPrefix = `${prefix}-`;
  if (id.startsWith(fullPrefix)) return id;
  return `${fullPrefix}${id}`;
}

/**
 * Normalize various profile ID formats to the "profile-XXXX" form.
 * Accepts: "profile-123", "123", "g123", "profile-G6000000001234567"
 */
function normalizeProfileId(id: string): string {
  return normalizeId(id, "profile");
}

function normalizeUnionId(id: string): string {
  return normalizeId(id, "union");
}

function relationshipEndpoint(rel: RelationshipType): string {
  switch (rel) {
    case "parent":
      return "add-parent";
    case "child":
      return "add-child";
    case "sibling":
      return "add-sibling";
    case "half_sibling":
      return "add-sibling"; // Geni uses the same endpoint; pass relationship type in body
    case "spouse":
      return "add-spouse";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(retryAfterHeader: string | null): number | null {
  if (!retryAfterHeader) return null;

  const seconds = Number(retryAfterHeader);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }

  const retryAt = Date.parse(retryAfterHeader);
  if (Number.isNaN(retryAt)) return null;

  return Math.max(0, retryAt - Date.now());
}

function computeBackoffMs(attempt: number): number {
  const base = Math.min(1000, 250 * 2 ** attempt);
  const jitter = Math.floor(Math.random() * 200);
  return base + jitter;
}
