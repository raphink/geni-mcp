// MCP tool definitions and handlers for Geni

import { z } from "zod";
import type { GeniClient } from "./geni-client.ts";
import type { OAuthConfig, TokenStore } from "./oauth.ts";
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
} from "./oauth.ts";
import type { GeniEvent, GeniLocation, GeniDate } from "./types.ts";

// ── Zod schemas ──────────────────────────────────────────────────────────────

const GeniDateSchema = z.object({
  year: z.number().int().optional().describe("4-digit year"),
  month: z.number().int().min(1).max(12).optional().describe("Month (1-12)"),
  day: z.number().int().min(1).max(31).optional().describe("Day of month"),
  circa: z.boolean().optional().describe("True if date is approximate"),
});

const GeniLocationSchema = z.object({
  city: z.string().optional(),
  county: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  place_name: z.string().optional().describe("Full place name if city/country not available"),
});

const GeniEventSchema = z.object({
  date: GeniDateSchema.optional(),
  location: GeniLocationSchema.optional(),
});

const ProfileUpdateSchema = z.object({
  first_name: z.string().optional(),
  middle_name: z.string().optional(),
  last_name: z.string().optional(),
  maiden_name: z.string().optional().describe("Birth surname (for married women)"),
  suffix: z.string().optional().describe("e.g. Jr., Sr., III"),
  gender: z.enum(["male", "female", "unknown"]).optional(),
  is_alive: z.boolean().optional(),
  about_me: z.string().optional().describe("Biography / notes"),
  birth: GeniEventSchema.optional(),
  death: GeniEventSchema.optional(),
  burial: GeniEventSchema.optional(),
  nationalities: z.array(z.string()).optional(),
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
  oauthConfig: OAuthConfig;
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
      last_name: z.string().optional(),
      middle_name: z.string().optional(),
      maiden_name: z.string().optional(),
      gender: z.enum(["male", "female", "unknown"]).optional(),
      is_alive: z.boolean().optional(),
      birth: GeniEventSchema.optional(),
      death: GeniEventSchema.optional(),
      about_me: z.string().optional(),
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

      const lines: string[] = [
        `Immediate family of: ${family.focus.display_name ?? family.focus.name ?? family.focus.id}`,
        "",
      ];

      // Group by relationship
      const groups: Record<string, string[]> = {
        father: [],
        mother: [],
        spouse: [],
        partner: [],
        sibling: [],
        half_sibling: [],
        child: [],
      };

      for (const [id, node] of Object.entries(family.nodes)) {
        if (id === family.focus.id) continue;
        const rel = node.relationship ?? "unknown";
        if (!groups[rel]) groups[rel] = [];
        groups[rel].push(formatFamilyNode(node));
      }

      const labels: Record<string, string> = {
        father: "Father",
        mother: "Mother",
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

      return ok(lines.join("\n").trimEnd());
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
          last_name: z.string().optional(),
          middle_name: z.string().optional(),
          maiden_name: z.string().optional(),
          gender: z.enum(["male", "female", "unknown"]).optional(),
          is_alive: z.boolean().optional(),
          birth: GeniEventSchema.optional(),
          death: GeniEventSchema.optional(),
          about_me: z.string().optional(),
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
        const born = formatEvent({ date: r.birth?.date, location: r.birth?.location });
        const died = formatEvent({ date: r.death?.date, location: r.death?.location });
        const life =
          born || died
            ? ` (${[born ? `b. ${born}` : "", died ? `d. ${died}` : ""]
                .filter(Boolean)
                .join(", ")})`
            : "";
        lines.push(
          `• ${r.display_name ?? r.name ?? "Unknown"}${life}\n  ID: ${r.id}${r.url ? `\n  URL: ${r.url}` : ""}`
        );
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
        const born = formatEvent({ date: c.birth?.date, location: c.birth?.location });
        const died = formatEvent({ date: c.death?.date, location: c.death?.location });
        lines.push(
          `• ${c.display_name ?? c.name ?? "Unknown"}` +
            (c.score !== undefined ? ` [score: ${c.score}]` : "") +
            `\n  ID: ${c.id}` +
            (born ? `\n  Born: ${born}` : "") +
            (died ? `\n  Died: ${died}` : "") +
            (c.url ? `\n  URL: ${c.url}` : "")
        );
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

function formatProfile(p: {
  id: string;
  display_name?: string;
  name?: string;
  first_name?: string;
  middle_name?: string;
  last_name?: string;
  maiden_name?: string;
  suffix?: string;
  gender?: string;
  is_alive?: boolean;
  birth?: GeniEvent;
  death?: GeniEvent;
  burial?: GeniEvent;
  about_me?: string;
  url?: string;
  unions?: string[];
  nationalities?: string[];
  big_tree?: boolean;
  claimed?: boolean;
}): string {
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
  if (p.url) lines.push(`URL: ${p.url}`);

  if (p.about_me) {
    lines.push("");
    lines.push(`Bio: ${p.about_me.slice(0, 500)}${p.about_me.length > 500 ? "…" : ""}`);
  }

  return lines.join("\n");
}

function formatFamilyNode(node: {
  id: string;
  display_name?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  gender?: string;
  birth?: GeniEvent;
  death?: GeniEvent;
  is_alive?: boolean;
}): string {
  const name = node.display_name ?? node.name ?? ([node.first_name, node.last_name].filter(Boolean).join(" ") || "Unknown");
  const born = formatDate(node.birth?.date);
  const died = formatDate(node.death?.date);
  const life =
    born !== "unknown" || died !== "unknown"
      ? ` (${[born !== "unknown" ? `b. ${born}` : "", died !== "unknown" ? `d. ${died}` : ""].filter(Boolean).join(", ")})`
      : "";
  return `${name}${life} [${node.id}]`;
}
