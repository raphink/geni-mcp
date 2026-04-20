// MCP tool definitions and handlers for Geni

import { z } from "zod";
import type { GeniClient } from "./geni-client.js";
import type { OAuthConfig, TokenStore } from "./oauth.js";
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
} from "./oauth.js";
import type {
  GeniEvent,
  GeniLocation,
  GeniDate,
  GeniProfile,
  GeniFamilyNode,
  GeniSearchResult,
  GeniMergeCandidate,
  GeniRelationshipPathResponse,
} from "./types.js";

// ── Zod schemas ──────────────────────────────────────────────────────────────

const GeniDateSchema = z.object({
  year: z.number().int().optional().describe("4-digit year"),
  month: z.number().int().min(1).max(12).optional().describe("Month (1-12)"),
  day: z.number().int().min(1).max(31).optional().describe("Day of month"),
  circa: z.boolean().optional().describe("True if date is approximate"),
});

const GeniLocationSchema = z.object({
  city: z.string().optional().describe("City or town"),
  county: z.string().optional().describe("County or district"),
  state: z.string().optional().describe("State or province"),
  country: z.string().optional().describe("Country name"),
  place_name: z.string().optional().describe("Full place name if city/country not available"),
});

const GeniEventSchema = z.object({
  date: GeniDateSchema.optional(),
  location: GeniLocationSchema.optional(),
});

const ProfileUpdateSchema = z.object({
  first_name: z.string().optional().describe("First name"),
  middle_name: z.string().optional().describe("Middle name"),
  last_name: z.string().optional().describe("Last (family) name"),
  maiden_name: z.string().optional().describe("Birth surname (for married women)"),
  suffix: z.string().optional().describe("e.g. Jr., Sr., III"),
  gender: z.enum(["male", "female", "unknown"]).optional().describe("Gender"),
  is_alive: z.boolean().optional().describe("Whether the person is living"),
  about_me: z.string().optional().describe("Biography / notes"),
  birth: GeniEventSchema.optional().describe("Birth date and place"),
  death: GeniEventSchema.optional().describe("Death date and place"),
  burial: GeniEventSchema.optional().describe("Burial date and place"),
  nationalities: z.array(z.string()).optional().describe("List of nationalities"),
});

// ── Tool result helpers ───────────────────────────────────────────────────────

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function formatDate(d?: GeniDate): string {
  if (!d) return "unknown";
  const parts: string[] = [];
  if (d.day) parts.push(String(d.day));
  if (d.month) parts.push(String(d.month));
  if (d.year) parts.push(String(d.year));
  const date = parts.join("/");
  return d.circa ? `c. ${date}` : date;
}

function formatLocation(l?: GeniLocation): string {
  if (!l) return "unknown";
  return (
    [l.place_name, l.city, l.county, l.state, l.country]
      .filter(Boolean)
      .join(", ") || "unknown"
  );
}

function formatEvent(e?: GeniEvent, label?: string): string {
  if (!e) return "";
  const date = formatDate(e.date);
  const loc = formatLocation(e.location);
  const base =
    date !== "unknown" && loc !== "unknown"
      ? `${date} in ${loc}`
      : date !== "unknown"
      ? date
      : loc !== "unknown"
      ? loc
      : "";
  return label && base ? `${label}: ${base}` : base;
}

// ── Tool definitions ─────────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: (
    input: unknown,
    ctx: ToolContext
  ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

export interface ToolContext {
  client: GeniClient;
  tokenStore: TokenStore;
  oauthConfig: OAuthConfig | null;
}

export const tools: ToolDefinition[] = [
  // ── OAuth ──────────────────────────────────────────────────────────────────

  {
    name: "get_authorization_url",
    description:
      "Get the Geni OAuth authorization URL. The user must visit this URL in a browser to grant access. " +
      "After granting access, Geni redirects to the callback URL with a 'code' parameter. " +
      "Pass that code to 'exchange_code' to complete authentication.",
    inputSchema: z.object({}),
    async handler(_input, { oauthConfig }) {
      if (!oauthConfig) return { content: [{ type: "text" as const, text: "OAuth is managed externally — no client credentials configured on this server." }], isError: true };
      const url = buildAuthorizationUrl(oauthConfig);
      return ok(
        `Visit this URL to authorize access to your Geni account:\n\n${url}\n\n` +
          `After authorizing, you will be redirected to:\n  ${oauthConfig.redirectUri}?code=XXXX\n\n` +
          `Copy the 'code' value from the URL and pass it to the 'exchange_code' tool.`
      );
    },
  },

  {
    name: "exchange_code",
    description:
      "Exchange an OAuth authorization code for access tokens. " +
      "Run this after visiting the URL from 'get_authorization_url' and copying the code parameter.",
    inputSchema: z.object({
      code: z.string().describe("The authorization code from the Geni callback URL"),
    }),
    async handler(input, { tokenStore, oauthConfig }) {
      if (!oauthConfig) return { content: [{ type: "text" as const, text: "OAuth is managed externally — no client credentials configured on this server." }], isError: true };
      const { code } = input as { code: string };
      const tokens = await exchangeCodeForTokens(oauthConfig, code);
      tokenStore.setTokens(
        tokens.access_token,
        tokens.refresh_token,
        tokens.expires_in
      );
      return ok(
        `✅ Authentication successful!\n\n` +
          `Access token obtained. ` +
          (tokens.refresh_token
            ? "A refresh token was also obtained — the session will auto-renew."
            : "No refresh token received. Re-authenticate when the token expires.") +
          (tokens.expires_in
            ? `\nToken expires in ${tokens.expires_in} seconds.`
            : "") +
          `\n\nTip: Set GENI_ACCESS_TOKEN and GENI_REFRESH_TOKEN as environment variables ` +
          `to persist authentication across restarts.`
      );
    },
  },

  // ── Profile read ───────────────────────────────────────────────────────────

  {
    name: "get_my_profile",
    description: "Get the profile of the currently authenticated Geni user.",
    inputSchema: z.object({}),
    async handler(_input, { client }) {
      const profile = await client.getMyProfile();
      return ok(formatProfile(profile));
    },
  },

  {
    name: "get_profile",
    description:
      "Get a Geni profile by ID. Accepts formats: 'profile-123456789', '123456789', " +
      "or the Big Tree format 'G6000000012345678'.",
    inputSchema: z.object({
      profile_id: z.string().describe("Geni profile ID"),
    }),
    async handler(input, { client }) {
      const { profile_id } = input as { profile_id: string };
      const profile = await client.getProfile(profile_id);
      return ok(formatProfile(profile));
    },
  },

  // ── Profile write ──────────────────────────────────────────────────────────

  {
    name: "update_profile",
    description:
      "Update fields on a Geni profile. You can only update profiles you manage. " +
      "Provide only the fields you want to change — unspecified fields are left untouched.",
    inputSchema: z.object({
      profile_id: z.string().describe("Geni profile ID to update"),
      updates: ProfileUpdateSchema.describe("Fields to update"),
    }),
    async handler(input, { client }) {
      const { profile_id, updates } = input as {
        profile_id: string;
        updates: z.infer<typeof ProfileUpdateSchema>;
      };
      const profile = await client.updateProfile(profile_id, updates);
      return ok(`✅ Profile updated successfully.\n\n${formatProfile(profile)}`);
    },
  },

  {
    name: "create_profile",
    description:
      "Create a new Geni profile. First name is required. " +
      "Use add_relation to link the new profile to an existing family member instead.",
    inputSchema: z.object({
      first_name: z.string().describe("First name (required)"),
      last_name: z.string().optional().describe("Last (family) name"),
      middle_name: z.string().optional().describe("Middle name"),
      maiden_name: z.string().optional().describe("Birth surname (for married women)"),
      gender: z.enum(["male", "female", "unknown"]).optional().describe("Gender"),
      is_alive: z.boolean().optional().describe("Whether the person is living"),
      birth: GeniEventSchema.optional().describe("Birth date and place"),
      death: GeniEventSchema.optional().describe("Death date and place"),
      about_me: z.string().optional().describe("Biography / notes"),
    }),
    async handler(input, { client }) {
      const data = input as { first_name: string } & z.infer<typeof ProfileUpdateSchema>;
      const profile = await client.createProfile(data);
      return ok(`✅ Profile created.\n\n${formatProfile(profile)}`);
    },
  },

  // ── Family ─────────────────────────────────────────────────────────────────

  {
    name: "get_immediate_family",
    description:
      "Get the immediate family of a profile: parents, siblings, spouses, and children.",
    inputSchema: z.object({
      profile_id: z.string().describe("Geni profile ID"),
    }),
    async handler(input, { client }) {
      const { profile_id } = input as { profile_id: string };
      const family = await client.getImmediateFamily(profile_id);

      console.log(`[get_immediate_family] focus=${family.focus.id} nodes=${Object.keys(family.nodes).join(",")} edges=${JSON.stringify(family.edges)}`);

      const lines: string[] = [
        `Immediate family of: ${family.focus.display_name ?? family.focus.name ?? family.focus.id}`,
        "",
      ];

      // Group by relationship — Geni returns "parent" (not "father"/"mother"),
      // "child", "sibling", "half_sibling", "spouse", "partner".
      const groups: Record<string, string[]> = {
        parent: [],
        spouse: [],
        partner: [],
        sibling: [],
        half_sibling: [],
        child: [],
      };

      for (const [id, node] of Object.entries(family.nodes)) {
        if (id === family.focus.id) continue;
        const rel = node.relationship ?? family.edges?.[id]?.rel ?? "unknown";
        if (!groups[rel]) groups[rel] = [];
        groups[rel].push(formatFamilyNode(node));
      }

      const labels: Record<string, string> = {
        parent: "Parent",
        spouse: "Spouse",
        partner: "Partner",
        sibling: "Sibling",
        half_sibling: "Half-sibling",
        child: "Child",
      };

      for (const [rel, label] of Object.entries(labels)) {
        if (groups[rel]?.length) {
          lines.push(`**${label}${groups[rel].length > 1 ? "s" : ""}:**`);
          for (const entry of groups[rel]) lines.push(`  • ${entry}`);
          lines.push("");
        }
      }

      // Dump any unexpected relationship types for debugging
      for (const [rel, entries] of Object.entries(groups)) {
        if (!labels[rel] && entries.length) {
          lines.push(`**${rel}:**`);
          for (const entry of entries) lines.push(`  • ${entry}`);
          lines.push("");
        }
      }

      return ok(lines.join("\n").trimEnd());
    },
  },

  {
    name: "get_relationship_path",
    description:
      "Find the relationship path between two profiles. " +
      "Geni may return an in-progress state while searching large trees.",
    inputSchema: z.object({
      source_profile_id: z
        .string()
        .describe("Starting profile ID (e.g. 'profile-123456' or '123456')"),
      target_profile_id: z
        .string()
        .describe("Target profile ID (e.g. 'profile-987654' or '987654')"),
    }),
    async handler(input, { client }) {
      const { source_profile_id, target_profile_id } = input as {
        source_profile_id: string;
        target_profile_id: string;
      };
      const result = await client.getRelationshipPath(
        source_profile_id,
        target_profile_id
      );
      return ok(
        formatRelationshipPath(result, source_profile_id, target_profile_id)
      );
    },
  },

  {
    name: "get_union",
    description:
      "Get a Geni union (family unit: couple + their children) by union ID.",
    inputSchema: z.object({
      union_id: z.string().describe("Geni union ID (e.g. 'union-123456')"),
    }),
    async handler(input, { client }) {
      const { union_id } = input as { union_id: string };
      const union = await client.getUnion(union_id);
      const lines = [
        `Union: ${union.id}`,
        `Status: ${union.status ?? "unknown"}`,
      ];
      if (union.partners?.length)
        lines.push(`Partners: ${union.partners.join(", ")}`);
      if (union.children?.length)
        lines.push(`Children: ${union.children.join(", ")}`);
      if (union.marriage) lines.push(formatEvent(union.marriage, "Marriage"));
      if (union.divorce) lines.push(formatEvent(union.divorce, "Divorce"));
      return ok(lines.filter(Boolean).join("\n"));
    },
  },

  {
    name: "add_relation",
    description:
      "Add a new family member (parent, child, sibling, or spouse) to an existing profile. " +
      "Creates the new profile and links it in one step.",
    inputSchema: z.object({
      profile_id: z
        .string()
        .describe("The existing profile to add the relation to"),
      relationship: z
        .enum(["parent", "child", "sibling", "spouse", "half_sibling"])
        .describe("The relationship of the new person to the existing profile"),
      new_person: z
        .object({
          first_name: z.string().describe("First name (required)"),
          last_name: z.string().optional().describe("Last (family) name"),
          middle_name: z.string().optional().describe("Middle name"),
          maiden_name: z.string().optional().describe("Birth surname (for married women)"),
          gender: z.enum(["male", "female", "unknown"]).optional().describe("Gender"),
          is_alive: z.boolean().optional().describe("Whether the person is living"),
          birth: GeniEventSchema.optional().describe("Birth date and place"),
          death: GeniEventSchema.optional().describe("Death date and place"),
          about_me: z.string().optional().describe("Biography / notes"),
        })
        .describe("Data for the new family member"),
    }),
    async handler(input, { client }) {
      const { profile_id, relationship, new_person } = input as {
        profile_id: string;
        relationship:
          | "parent"
          | "child"
          | "sibling"
          | "spouse"
          | "half_sibling";
        new_person: { first_name: string } & z.infer<typeof ProfileUpdateSchema>;
      };
      const created = await client.addRelation(
        profile_id,
        relationship,
        new_person
      );
      return ok(
        `✅ Added ${relationship} to profile ${profile_id}.\n\n${formatProfile(created)}`
      );
    },
  },

  // ── Search ─────────────────────────────────────────────────────────────────

  {
    name: "search_profiles",
    description:
      "Search Geni profiles by name with optional birth/death year and location filters.",
    inputSchema: z.object({
      name: z.string().describe("Name to search for (first, last, or full name)"),
      birth_year: z.number().int().optional().describe("Filter by birth year"),
      death_year: z.number().int().optional().describe("Filter by death year"),
      birth_location: z
        .string()
        .optional()
        .describe("Filter by birth location (city or country)"),
      page: z.number().int().min(1).optional().describe("Page number for pagination"),
    }),
    async handler(input, { client }) {
      const { name, birth_year, death_year, birth_location, page } =
        input as {
          name: string;
          birth_year?: number;
          death_year?: number;
          birth_location?: string;
          page?: number;
        };

      const results = await client.searchProfiles(name, {
        birthYear: birth_year,
        deathYear: death_year,
        birthLocation: birth_location,
        page,
      });

      if (!results.results?.length) {
        return ok(`No profiles found matching "${name}".`);
      }

      const lines = [
        `Found ${results.total ?? results.results.length} result(s) for "${name}":`,
        "",
      ];

      for (const r of results.results) {
        lines.push(formatSearchHit(r));
      }

      return ok(lines.join("\n"));
    },
  },

  // ── Merge ───────────────────────────────────────────────────────────────────

  {
    name: "get_merge_candidates",
    description:
      "Get a list of potential duplicate profiles (merge candidates) for a given profile. " +
      "Review these before using merge_profiles.",
    inputSchema: z.object({
      profile_id: z.string().describe("Geni profile ID to find duplicates for"),
    }),
    async handler(input, { client }) {
      const { profile_id } = input as { profile_id: string };
      const resp = await client.getMergeCandidates(profile_id);

      if (!resp.candidates?.length) {
        return ok(`No merge candidates found for profile ${profile_id}.`);
      }

      const lines = [
        `Merge candidates for ${profile_id} (${resp.candidates.length} found):`,
        "",
      ];

      for (const c of resp.candidates) {
        lines.push(formatSearchHit(c, c.score !== undefined ? `[score: ${c.score}]` : undefined));
      }

      return ok(lines.join("\n"));
    },
  },

  {
    name: "merge_profiles",
    description:
      "Merge two Geni profiles. The base profile survives and absorbs data from the duplicate. " +
      "⚠️ This action cannot be easily undone — verify both profiles first with get_profile. " +
      "Requires the 'collaborate' OAuth scope.",
    inputSchema: z.object({
      base_profile_id: z
        .string()
        .describe("The profile to keep (base/surviving profile)"),
      duplicate_profile_id: z
        .string()
        .describe("The profile to merge into the base (will be removed)"),
    }),
    async handler(input, { client }) {
      const { base_profile_id, duplicate_profile_id } = input as {
        base_profile_id: string;
        duplicate_profile_id: string;
      };
      const merged = await client.mergeProfiles(
        base_profile_id,
        duplicate_profile_id
      );
      return ok(
        `✅ Profiles merged. Duplicate (${duplicate_profile_id}) merged into base (${base_profile_id}).\n\n` +
          formatProfile(merged)
      );
    },
  },
];

// ── Formatting helpers ───────────────────────────────────────────────────────

function formatProfile(p: GeniProfile): string {
  const lines: string[] = [];

  const displayName = p.display_name ?? p.name ?? ([p.first_name, p.middle_name, p.last_name].filter(Boolean).join(" ") || "Unknown");
  lines.push(`**${displayName}**`);
  lines.push(`ID: ${p.id}`);

  if (p.gender) lines.push(`Gender: ${p.gender}`);
  if (p.maiden_name) lines.push(`Maiden name: ${p.maiden_name}`);
  if (p.suffix) lines.push(`Suffix: ${p.suffix}`);
  if (p.is_alive !== undefined) lines.push(`Living: ${p.is_alive ? "yes" : "no"}`);
  if (p.nationalities?.length) lines.push(`Nationalities: ${p.nationalities.join(", ")}`);

  const birth = formatEvent(p.birth);
  if (birth) lines.push(`Born: ${birth}`);

  const death = formatEvent(p.death);
  if (death) lines.push(`Died: ${death}`);

  const burial = formatEvent(p.burial);
  if (burial) lines.push(`Buried: ${burial}`);

  if (p.unions?.length) lines.push(`Family units: ${p.unions.join(", ")}`);
  if (p.big_tree) lines.push(`Big Tree: yes`);
  if (p.claimed) lines.push(`Claimed: yes`);
  if (p.profile_url) lines.push(`Profile URL: ${p.profile_url}`);
  else if (p.url) lines.push(`URL: ${p.url}`);

  if (p.about_me) {
    lines.push("");
    lines.push(`Bio: ${p.about_me.slice(0, 500)}${p.about_me.length > 500 ? "…" : ""}`);
  }

  return lines.join("\n");
}

function formatFamilyNode(node: GeniFamilyNode): string {
  const name = node.display_name ?? node.name ?? ([node.first_name, node.last_name].filter(Boolean).join(" ") || "Unknown");
  const born = formatDate(node.birth?.date);
  const died = formatDate(node.death?.date);
  const life =
    born !== "unknown" || died !== "unknown"
      ? ` (${[born !== "unknown" ? `b. ${born}` : "", died !== "unknown" ? `d. ${died}` : ""].filter(Boolean).join(", ")})`
      : "";
  return `${name}${life} [${node.id}]`;
}

function formatRelationshipPath(
  result: GeniRelationshipPathResponse,
  sourceProfileId: string,
  targetProfileId: string
): string {
  const status = typeof result.status === "string" ? result.status : undefined;
  const message = typeof result.message === "string" ? result.message : undefined;

  if (status === "running" || /running/i.test(message ?? "")) {
    return (
      `Relationship path search is still running between ${sourceProfileId} and ${targetProfileId}.\n` +
      `Please try again in a few seconds.`
    );
  }

  const nodes = result.nodes ?? {};

  if (Array.isArray(result.path) && result.path.length > 0) {
    const steps = result.path.map((id) => {
      const node = nodes[id];
      const name =
        node?.display_name ??
        node?.name ??
        [node?.first_name, node?.last_name].filter(Boolean).join(" ") ??
        id;
      return `${name} [${id}]`;
    });

    return [
      `Relationship path (${steps.length - 1} hop${steps.length - 1 === 1 ? "" : "s"}):`,
      ...steps.map((step, i) => `${i + 1}. ${step}`),
    ].join("\n");
  }

  if (Array.isArray(result.relationships) && result.relationships.length > 0) {
    const lines = [
      `Relationship path (${result.relationships.length} step${result.relationships.length === 1 ? "" : "s"}):`,
    ];
    for (const [idx, step] of result.relationships.entries()) {
      const node = nodes[step.id];
      const name =
        node?.display_name ??
        node?.name ??
        [node?.first_name, node?.last_name].filter(Boolean).join(" ") ??
        step.id;
      lines.push(
        `${idx + 1}. ${name} [${step.id}]${step.rel ? ` (${step.rel})` : ""}`
      );
    }
    return lines.join("\n");
  }

  if (message) {
    return `Relationship path lookup returned: ${message}`;
  }

  return (
    `No relationship path found between ${sourceProfileId} and ${targetProfileId}, ` +
    `or the API returned an unrecognized response format.`
  );
}

/** Shared formatter for search results and merge candidates. */
function formatSearchHit(item: GeniSearchResult | GeniMergeCandidate, badge?: string): string {
  const name = item.display_name ?? item.name ?? "Unknown";
  const born = formatEvent(item.birth);
  const died = formatEvent(item.death);
  const life =
    born || died
      ? ` (${[born ? `b. ${born}` : "", died ? `d. ${died}` : ""].filter(Boolean).join(", ")})`
      : "";
  return (
    `• ${name}${badge ? ` ${badge}` : ""}${life}\n  ID: ${item.id}` +
    (item.url ? `\n  URL: ${item.url}` : "")
  );
}
