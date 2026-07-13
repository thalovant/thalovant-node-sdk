import { randomBytes, randomUUID } from "node:crypto";
import { ThalovantApiError, ThalovantUnsupportedProtocolError } from "./errors.js";
import { ThalovantIdentity } from "./identity.js";
import {
  DEFAULT_PROTOCOL_PREFERENCE,
  endpointFromDomain,
  HubDataPlaneEndpoints,
  HubProtocol,
  HubProtocolSettings,
  SelectedHubEndpoint,
  selectDataPlaneEndpoint,
} from "./protocols.js";

export const DEFAULT_CONTROL_API_URL = "https://api.thalovant.com";
const DEFAULT_CONTROL_USER_AGENT = "ThalovantNodeSDK/0.2.19";

type JsonRecord = Record<string, unknown>;

export type OperationStatus =
  | "requested"
  | "committed"
  | "applied"
  | "ready"
  | "failed"
  | "timed_out";

export interface OperationResource {
  id: string;
  kind: string;
  aggregate_type: string;
  aggregate_id: string | null;
  status: OperationStatus;
  details: JsonRecord;
  git_commit_sha: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  committed_at: string | null;
  applied_at: string | null;
  ready_at: string | null;
  terminal_at: string | null;
  links: Record<string, string | null>;
}

export interface BootstrapIdentityResult {
  identity: ThalovantIdentity;
  hub: JsonRecord;
  client: JsonRecord;
  endpoint?: SelectedHubEndpoint;
  selectedProtocol?: HubProtocol;
  asObject(options?: { includeSecrets?: boolean }): Record<string, unknown>;
}

export interface CreateClientIdentityOptions {
  name: string;
  siteId?: string;
  spec?: JsonRecord;
  ownerId?: string;
  active?: boolean;
  preferredProtocols?: readonly HubProtocol[];
  idempotencyKey?: string;
}

export interface AnalyticsOverviewOptions {
  admin?: boolean;
  range?: string;
  bucket?: string;
  ownerId?: string;
  hubId?: string;
  clientId?: string;
  country?: string;
  message?: string;
  utterance?: string;
  intent?: string;
  timeStart?: string;
  timeEnd?: string;
  weekday?: number;
  hour?: number;
}

export type MemoryScope = "personal" | "workspace" | "hub";
export type MemoryKind = "note" | "preference" | "fact";

export interface MemoryListOptions {
  scope?: MemoryScope;
  kind?: MemoryKind;
  ownerId?: string;
  hubId?: string;
  query?: string;
  includeDeleted?: boolean;
  includeExpired?: boolean;
  limit?: number;
  offset?: number;
}

export interface MemoryCreatePayload {
  scope?: MemoryScope;
  kind?: MemoryKind;
  title?: string | null;
  content: string;
  tags?: string[];
  ownerId?: string;
  hubId?: string;
  source?: string;
  metadata?: Record<string, unknown>;
  consentScope?: string;
  consentVersion?: string | null;
  retentionPolicy?: string;
  expiresAt?: string | null;
}

export interface MemoryUpdatePayload {
  kind?: MemoryKind;
  title?: string | null;
  content?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  consentScope?: string;
  consentVersion?: string | null;
  retentionPolicy?: string;
  expiresAt?: string | null;
  clearExpiresAt?: boolean;
}

export class ThalovantControlPlane {
  readonly apiUrl: string;
  accessToken?: string;
  readonly userAgent: string;

  constructor(apiUrl = DEFAULT_CONTROL_API_URL, options: { accessToken?: string; userAgent?: string } = {}) {
    this.apiUrl = normalizeControlApiUrl(apiUrl);
    this.accessToken = options.accessToken;
    this.userAgent = options.userAgent ?? DEFAULT_CONTROL_USER_AGENT;
  }

  async login(email: string, password: string, options: { scope?: string } = {}): Promise<JsonRecord> {
    const body: JsonRecord = { email, password };
    if (options.scope) body.scope = options.scope;
    const token = await this.request("POST", "/v1/auth/token", { body, auth: false });
    const accessToken = token.access_token;
    if (typeof accessToken !== "string" || !accessToken) {
      throw new ThalovantApiError("Thalovant API token response did not include access_token.");
    }
    this.accessToken = accessToken;
    return token;
  }

  listHubs(options: { limit?: number; cursor?: string; ownerId?: string } = {}): Promise<JsonRecord> {
    const params = new URLSearchParams({ limit: String(options.limit ?? 100) });
    if (options.cursor) params.set("cursor", options.cursor);
    if (options.ownerId) params.set("owner_id", options.ownerId);
    return this.request("GET", `/v1/hubs?${params.toString()}`);
  }

  listPublicHubs(options: { limit?: number; cursor?: string } = {}): Promise<JsonRecord> {
    const params = new URLSearchParams({ limit: String(options.limit ?? 24) });
    if (options.cursor) params.set("cursor", options.cursor);
    return this.request("GET", `/v1/public/hubs?${params.toString()}`, { auth: false });
  }

  async getOperation(operationId: string): Promise<OperationResource> {
    return (await this.request(
      "GET",
      `/v1/operations/${encodeURIComponent(operationId)}`,
    )) as unknown as OperationResource;
  }

  listMemoryItems(options: MemoryListOptions = {}): Promise<JsonRecord> {
    const params = new URLSearchParams();
    setStringParam(params, "scope", options.scope);
    setStringParam(params, "kind", options.kind);
    setStringParam(params, "owner_id", options.ownerId);
    setStringParam(params, "hub_id", options.hubId);
    setStringParam(params, "q", options.query);
    if (options.includeDeleted) params.set("include_deleted", "true");
    if (options.includeExpired) params.set("include_expired", "true");
    if (typeof options.limit === "number") params.set("limit", String(options.limit));
    if (typeof options.offset === "number") params.set("offset", String(options.offset));
    const query = params.toString();
    return this.request("GET", query ? `/v1/memory?${query}` : "/v1/memory");
  }

  getMemorySummary(options: { ownerId?: string } = {}): Promise<JsonRecord> {
    const params = new URLSearchParams();
    setStringParam(params, "owner_id", options.ownerId);
    const query = params.toString();
    return this.request("GET", query ? `/v1/memory/summary?${query}` : "/v1/memory/summary");
  }

  createMemoryItem(payload: MemoryCreatePayload): Promise<JsonRecord> {
    return this.request("POST", "/v1/memory", { body: memoryPayload(payload) });
  }

  getMemoryItem(memoryId: string): Promise<JsonRecord> {
    return this.request("GET", `/v1/memory/${encodeURIComponent(memoryId)}`);
  }

  updateMemoryItem(memoryId: string, payload: MemoryUpdatePayload): Promise<JsonRecord> {
    return this.request("PATCH", `/v1/memory/${encodeURIComponent(memoryId)}`, { body: memoryPayload(payload) });
  }

  async deleteMemoryItem(memoryId: string): Promise<void> {
    await this.request("DELETE", `/v1/memory/${encodeURIComponent(memoryId)}`);
  }

  getAnalyticsOverview(options: AnalyticsOverviewOptions = {}): Promise<JsonRecord> {
    const endpoint = options.admin ? "/v1/admin/analytics/overview" : "/v1/analytics/overview";
    const params = new URLSearchParams();
    setStringParam(params, "range", options.range);
    setStringParam(params, "bucket", options.bucket);
    if (options.admin) setStringParam(params, "owner_id", options.ownerId);
    setStringParam(params, "hub_id", options.hubId);
    setStringParam(params, "client_id", options.clientId);
    setStringParam(params, "country", options.country);
    setStringParam(params, "message", options.message);
    setStringParam(params, "utterance", options.utterance);
    setStringParam(params, "intent", options.intent);
    setStringParam(params, "time_start", options.timeStart);
    setStringParam(params, "time_end", options.timeEnd);
    if (typeof options.weekday === "number") params.set("weekday", String(options.weekday));
    if (typeof options.hour === "number") params.set("hour", String(options.hour));
    const query = params.toString();
    return this.request("GET", query ? `${endpoint}?${query}` : endpoint);
  }

  getHub(hubId: string): Promise<JsonRecord> {
    return this.request("GET", `/v1/hubs/${encodeURIComponent(hubId)}`);
  }

  getPublicHub(hubRef: string): Promise<JsonRecord> {
    return this.request("GET", `/v1/public/hubs/${encodeURIComponent(hubRef)}`, { auth: false });
  }

  createClient(payload: JsonRecord, options: { idempotencyKey?: string } = {}): Promise<JsonRecord> {
    return this.request("POST", "/v1/clients", {
      body: payload,
      headers: { "Idempotency-Key": options.idempotencyKey ?? randomUUID() },
    });
  }

  async createClientIdentity(hub: string | JsonRecord, options: CreateClientIdentityOptions): Promise<BootstrapIdentityResult> {
    const hubResource = typeof hub === "string" ? await this.getHub(hub) : hub;
    const hubId = requiredString(hubResource, "id");
    const siteId = cleanSiteId(options.siteId ?? options.name);
    const apiKey = newSecret();
    const password = newSecret();
    const cryptoKey = newSecret();
    const spec: JsonRecord = {
      ...(options.spec ?? {}),
      version: String(options.spec?.version ?? "1"),
      apiKey,
      password,
      cryptoKey,
      siteId,
    };
    const payload: JsonRecord = {
      hub_id: hubId,
      name: options.name,
      spec,
      active: options.active ?? true,
    };
    if (options.ownerId) payload.owner_id = options.ownerId;

    const client = await this.createClient(payload, { idempotencyKey: options.idempotencyKey });
    const protocols = HubProtocolSettings.from(hubResource);
    const endpoints = HubDataPlaneEndpoints.fromHub(hubResource);
    const endpoint = selectDataPlaneEndpoint(
      endpoints,
      protocols,
      options.preferredProtocols ?? DEFAULT_PROTOCOL_PREFERENCE,
    );
    const initialIdentify = isRecord(client.initial_identify) ? client.initial_identify : undefined;
    const identity = new ThalovantIdentity(initialIdentify ? {
      ...initialIdentify,
      data_plane_endpoints: endpoints.asObject(),
      protocols: protocols.asObject(),
    } : {
      access_key: apiKey,
      password,
      crypto_key: cryptoKey,
      site_id: siteId,
      default_master: defaultMaster(hubResource, endpoints, endpoint),
      default_port: 443,
      data_plane_endpoints: endpoints.asObject(),
      protocols: protocols.asObject(),
    });
    return {
      identity,
      hub: hubResource,
      client,
      endpoint,
      selectedProtocol: endpoint?.protocol,
      asObject(resultOptions: { includeSecrets?: boolean } = {}) {
        return {
          identity: identity.asObject(resultOptions.includeSecrets ?? false),
          hub: hubResource,
          client,
          selectedProtocol: endpoint?.protocol,
          selectedEndpoint: endpoint?.endpoint,
        };
      },
    };
  }

  requireRuntimeProtocol(result: BootstrapIdentityResult, protocol?: HubProtocol): SelectedHubEndpoint {
    protocol = protocol ?? result.selectedProtocol ?? DEFAULT_PROTOCOL_PREFERENCE[0];
    if (protocol === "mqtt" && !result.identity.mqtt) {
      throw new ThalovantUnsupportedProtocolError(
        "MQTT is enabled, but the API did not return client-scoped MQTT broker credentials.",
      );
    }
    const endpoint = result.identity.endpointFor(protocol);
    if (!endpoint) {
      throw new ThalovantUnsupportedProtocolError(`This hub does not expose a ${protocol.toUpperCase()} endpoint for the SDK runtime.`);
    }
    return { protocol, endpoint };
  }

  private async request(
    method: string,
    path: string,
    options: { body?: JsonRecord; headers?: Record<string, string>; auth?: boolean } = {},
  ): Promise<JsonRecord> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": this.userAgent,
      ...(options.headers ?? {}),
    };
    if (options.body) headers["content-type"] = "application/json";
    if (options.auth ?? true) {
      if (!this.accessToken) throw new ThalovantApiError("Missing Thalovant API access token.");
      headers.authorization = `Bearer ${this.accessToken}`;
    }
    const response = await fetch(new URL(path.replace(/^\/+/, ""), this.apiUrl), {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (!response.ok) {
      throw new ThalovantApiError(`Thalovant API request failed with HTTP ${response.status}: ${await response.text()}`);
    }
    const text = await response.text();
    if (!text.trim()) {
      return {};
    }
    const body = JSON.parse(text) as unknown;
    if (!isRecord(body)) {
      throw new ThalovantApiError("Thalovant API returned an unexpected response shape.");
    }
    return body;
  }
}

function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

function normalizeControlApiUrl(apiUrl: string): string {
  let normalized = (apiUrl || DEFAULT_CONTROL_API_URL).trim().replace(/\/+$/, "");
  if (normalized.endsWith("/v1")) {
    normalized = normalized.slice(0, -3);
  }
  return `${normalized.replace(/\/+$/, "")}/`;
}

function setStringParam(params: URLSearchParams, key: string, value?: string): void {
  if (value?.trim()) {
    params.set(key, value);
  }
}

function memoryPayload(payload: MemoryCreatePayload | MemoryUpdatePayload): JsonRecord {
  const result: JsonRecord = { ...payload };
  renameKey(result, "ownerId", "owner_id");
  renameKey(result, "hubId", "hub_id");
  renameKey(result, "consentScope", "consent_scope");
  renameKey(result, "consentVersion", "consent_version");
  renameKey(result, "retentionPolicy", "retention_policy");
  renameKey(result, "expiresAt", "expires_at");
  renameKey(result, "clearExpiresAt", "clear_expires_at");
  return result;
}

function renameKey(values: JsonRecord, from: string, to: string): void {
  if (Object.prototype.hasOwnProperty.call(values, from)) {
    values[to] = values[from];
    delete values[from];
  }
}

function requiredString(values: JsonRecord, key: string): string {
  const value = values[key];
  if (typeof value !== "string" || !value) {
    throw new ThalovantApiError(`Hub resource is missing ${key}.`);
  }
  return value;
}

function cleanSiteId(value: string): string {
  return value.trim().replace(/_+/g, "-").replace(/\s+/g, "-") || `thalovant-client-${randomBytes(4).toString("hex")}`;
}

function defaultMaster(hub: JsonRecord, endpoints: HubDataPlaneEndpoints, selected?: SelectedHubEndpoint): string {
  if (endpoints.https) return stripPath(endpoints.https);
  if (typeof hub.domain === "string" && hub.domain.trim()) return endpointFromDomain(hub.domain, "https");
  if (selected) return stripPath(selected.endpoint);
  throw new ThalovantApiError("Hub resource does not expose a usable data-plane endpoint.");
}

function stripPath(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return endpoint.replace(/\/+$/, "");
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
