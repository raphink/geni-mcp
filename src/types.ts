// Geni API type definitions

export interface GeniDate {
  year?: number;
  month?: number;
  day?: number;
  circa?: boolean;
  range?: boolean;
}

export interface GeniLocation {
  city?: string;
  county?: string;
  state?: string;
  country?: string;
  country_code?: string;
  lat?: number;
  lng?: number;
  place_name?: string;
}

export interface GeniEvent {
  date?: GeniDate;
  location?: GeniLocation;
}

export interface GeniProfile {
  id: string;
  guid?: string;
  name?: string;
  first_name?: string;
  middle_name?: string;
  last_name?: string;
  maiden_name?: string;
  suffix?: string;
  display_name?: string;
  gender?: "male" | "female" | "unknown";
  is_alive?: boolean;
  public?: boolean;
  big_tree?: boolean;
  claimed?: boolean;
  master_profile?: boolean;
  url?: string;
  profile_url?: string;
  photo_urls?: {
    thumb?: string;
    medium?: string;
    large?: string;
  };
  birth?: GeniEvent;
  death?: GeniEvent;
  burial?: GeniEvent;
  baptism?: GeniEvent;
  about_me?: string;
  unions?: string[];
  nationalities?: string[];
  created_at?: string;
  updated_at?: string;
  manager?: { id: string; name: string };
}

export interface GeniProfileUpdatePayload {
  first_name?: string;
  middle_name?: string;
  last_name?: string;
  maiden_name?: string;
  suffix?: string;
  gender?: "male" | "female" | "unknown";
  is_alive?: boolean;
  about_me?: string;
  birth?: GeniEvent;
  death?: GeniEvent;
  burial?: GeniEvent;
  baptism?: GeniEvent;
  nationalities?: string[];
}

export interface GeniFamilyNode {
  id: string;
  name?: string;
  display_name?: string;
  first_name?: string;
  last_name?: string;
  gender?: string;
  birth?: GeniEvent;
  death?: GeniEvent;
  is_alive?: boolean;
  relationship?: string;
  profile_url?: string;
}

export interface GeniFamilyEdge {
  rel: string;
  union?: string;
}

export interface GeniImmediateFamily {
  focus: GeniFamilyNode;
  nodes: Record<string, GeniFamilyNode>;
  edges: Record<string, GeniFamilyEdge>;
}

export interface GeniRelationshipPathStep {
  id: string;
  rel?: string;
}

export interface GeniRelationshipPathResponse {
  status?: string;
  message?: string;
  path?: string[];
  relationships?: GeniRelationshipPathStep[];
  nodes?: Record<string, GeniFamilyNode>;
  [key: string]: unknown;
}

export interface GeniUnion {
  id: string;
  partners?: string[];
  children?: string[];
  status?: string;
  marriage?: GeniEvent;
  divorce?: GeniEvent;
}

export interface GeniSearchResult {
  id: string;
  name?: string;
  display_name?: string;
  gender?: string;
  birth?: GeniEvent;
  death?: GeniEvent;
  url?: string;
  is_alive?: boolean;
}

export interface GeniSearchResponse {
  results: GeniSearchResult[];
  total?: number;
  page?: number;
}

export interface GeniMergeCandidate {
  id: string;
  name?: string;
  display_name?: string;
  gender?: string;
  birth?: GeniEvent;
  death?: GeniEvent;
  score?: number;
  url?: string;
}

export interface GeniMergeCandidatesResponse {
  candidates: GeniMergeCandidate[];
}

export interface GeniTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
}

export interface GeniApiError {
  error: string;
  message?: string;
  status?: number;
}

export type RelationshipType =
  | "parent"
  | "child"
  | "sibling"
  | "spouse"
  | "half_sibling";
