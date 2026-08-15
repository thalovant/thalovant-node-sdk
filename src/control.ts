import { bytesToBase64Url, bytesToHex } from "./bytes.js";
import { ThalovantApiError, ThalovantTimeoutError, ThalovantUnsupportedProtocolError } from "./errors.js";
import { ThalovantIdentity } from "./identity.js";
import { openExternalUrl, randomBytes, randomUUID } from "./platform/node.js";
import {
  DEFAULT_PROTOCOL_PREFERENCE,
  endpointFromDomain,
  HubDataPlaneEndpoints,
  HubProtocol,
  HubProtocolSettings,
  SelectedHubEndpoint,
  selectDataPlaneEndpoint,
} from "./protocols.js";
import { USER_AGENT } from "./version.js";

export const DEFAULT_CONTROL_API_URL = "https://api.thalovant.com";
/** Control-plane user agent. Derived from the one version constant, never pinned. */
const DEFAULT_CONTROL_USER_AGENT = USER_AGENT;

const DEFAULT_DEVICE_POLL_INTERVAL_MS = 5_000;
const DEVICE_SLOW_DOWN_STEP_MS = 5_000;
const DEFAULT_DEVICE_LOGIN_TIMEOUT_MS = 900_000;

/** Placeholder shown instead of secret values in debug/log output. */
const REDACTED = "[redacted]";

/**
 * Node's `util.inspect` extension point (used by `console.log`). Registered
 * through `Symbol.for`, which exists on every platform, so this file stays
 * browser-safe; browsers simply never call the method.
 */
const customInspect: unique symbol = Symbol.for("nodejs.util.inspect.custom");

/** Upper bound for the server detail kept in thrown API error messages. */
const MAX_ERROR_DETAIL_LENGTH = 160;

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
  range?: string;
  bucket?: string;
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

/**
 * Hub create and update body.
 *
 * `name` and `spec` are required by the create route; every field is optional
 * on update. camelCase keys are sent as the snake_case names the API takes, and
 * unknown keys pass through untouched.
 */
export interface HubPayload {
  name?: string;
  slug?: string;
  namespace?: string;
  domain?: string;
  active?: boolean;
  visibility?: string;
  spec?: JsonRecord;
  /** Sent as `owner_id`. */
  ownerId?: string;
  /** Sent as `runtime_group_id`. */
  runtimeGroupId?: string;
  /** Sent as `capacity_profile`. `"standard"` (the API default) or `"autoscaling"`. */
  capacityProfile?: string;
  /** Sent as `is_locked`. */
  isLocked?: boolean;
  [key: string]: unknown;
}

/**
 * Optimistic-locking options for the hub write routes.
 *
 * `PATCH` and `DELETE /v1/hubs/{id}` require `If-Match`, so `etag` is required:
 * a stale or missing value fails with HTTP 412 and changes nothing.
 */
export interface HubWriteOptions {
  /** The `etag` of the hub resource you read, sent as `If-Match`. */
  etag: string;
}

/**
 * Runtime group create and update body.
 *
 * `name` is required by the create route. camelCase keys are sent as the
 * snake_case names the API takes, and unknown keys pass through untouched.
 */
export interface RuntimeGroupPayload {
  name?: string;
  description?: string;
  environment?: string;
  spec?: JsonRecord;
  /** Sent as `owner_id`. */
  ownerId?: string;
  /** Sent as `clone_from_default`. */
  cloneFromDefault?: boolean;
  [key: string]: unknown;
}

/**
 * Release-apply options shared by `releaseHub` and `releaseRuntimeGroup`.
 *
 * Every option is optional; omitted fields fall back to the workspace release
 * policy. Passing `images` switches to `custom` mode unless `mode` is also set.
 */
export interface ReleaseOptions {
  channel?: string;
  mode?: string;
  version?: string;
  images?: Record<string, string>;
  reason?: string;
}

/** Options for `listRuntimeGroups`. */
export interface RuntimeGroupListOptions {
  /** Sent as `owner_id`. Admin tokens only. */
  ownerId?: string;
}

/** Options for `updateRuntimeGroupConfig`. */
export interface RuntimeGroupConfigOptions {
  /** Replaces the stored personas. Left untouched when omitted. */
  personas?: JsonRecord;
}

/** Options for `installRuntimeGroupSkill`. */
export interface RuntimeGroupSkillInstallOptions {
  /** Sent as `marketplace_skill_id`. */
  marketplaceSkillId?: string;
  /** Sent as `source_type`. Defaults to `"catalog"`. */
  sourceType?: string;
  /** Sent as `source_ref`. Required for `git` installs. */
  sourceRef?: string;
  /** Sent as `version_pin`. */
  versionPin?: string;
  /** Sent as `active`. Defaults to `true`. */
  active?: boolean;
}

/** Options for `listMarketplaceSkills`. */
export interface MarketplaceSkillListOptions {
  /** Sent as `owner_id`. Honored for admin tokens only. */
  ownerId?: string;
  /** Sent as `include_inactive`. Honored for admin tokens only. */
  includeInactive?: boolean;
  /** Sent as `force_refresh`. Re-syncs the global catalog first, which is slower. */
  forceRefresh?: boolean;
}

/** Options for `listRuntimeGroupMarketplace`. */
export interface RuntimeGroupMarketplaceOptions {
  /** Sent as `refresh_inventory`. Forces a live operator read. */
  refreshInventory?: boolean;
}

/** Options for `listRuntimeGroupInventory`. */
export interface RuntimeGroupInventoryOptions {
  /** Sent as `refresh`. Forces a live operator read. */
  refresh?: boolean;
}

/** Payload returned by `POST /v1/auth/device/authorize`. */
export interface DeviceAuthorizationGrant {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
  [key: string]: unknown;
}

export interface LoginWithBrowserOptions {
  /** Token scopes to request. Omitted entirely when not provided; the server applies its default. */
  scopes?: string[];
  /** Human-readable name shown on the dashboard token list. */
  clientName?: string;
  /** Open `verification_uri_complete` in the default browser (best-effort). Default `true`. */
  openBrowser?: boolean;
  /** Present the sign-in instructions yourself instead of the default console message. */
  prompt?: (grant: DeviceAuthorizationGrant) => void;
  /** How long to wait for browser approval before giving up. Default 900000 (15 minutes). */
  timeoutMs?: number;
  /** Override the best-effort browser opener. Intended for tests. */
  openUrl?: (url: string) => unknown;
}

/**
 * Options for the internal device-token poll loop.
 *
 * @internal
 */
export interface DevicePollOptions {
  /** Initial poll interval in milliseconds. Default 5000. */
  intervalMs?: number;
  /** Overall deadline in milliseconds. Default 900000 (15 minutes). */
  timeoutMs?: number;
  /** Injectable sleep so tests can drive the loop without real waiting. */
  sleep?: (ms: number) => Promise<void> | void;
  /** Injectable monotonic clock (milliseconds) paired with `sleep`. */
  now?: () => number;
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

  /**
   * Human-readable form that never contains the bearer token. Debug/display
   * only — requests keep reading `accessToken` directly.
   */
  toString(): string {
    return `ThalovantControlPlane ${JSON.stringify({
      apiUrl: this.apiUrl,
      userAgent: this.userAgent,
      accessToken: this.accessToken ? REDACTED : undefined,
    })}`;
  }

  /** Node `console.log`/`util.inspect` print the redacted form, never the token. */
  [customInspect](): string {
    return this.toString();
  }

  async login(
    email: string,
    password: string,
    options: { scope?: string; otpCode?: string; recoveryCode?: string } = {},
  ): Promise<JsonRecord> {
    const body: JsonRecord = { email, password };
    if (options.scope) body.scope = options.scope;
    if (options.otpCode !== undefined) body.otp_code = options.otpCode;
    if (options.recoveryCode !== undefined) body.recovery_code = options.recoveryCode;
    const token = await this.request("POST", "/v1/auth/token", { body, auth: false });
    const accessToken = token.access_token;
    if (typeof accessToken !== "string" || !accessToken) {
      throw new ThalovantApiError("Thalovant API token response did not include access_token.");
    }
    this.accessToken = accessToken;
    return token;
  }

  /**
   * Sign in through the browser device flow and store the API token.
   *
   * This is the sign-in path for accounts without a password (for example
   * Google sign-in). It requests a device authorization, tells the user to
   * visit `verification_uri` and enter the short `user_code` (pass a `prompt`
   * callback receiving the authorization payload to present it yourself),
   * optionally opens the browser at `verification_uri_complete`, and polls
   * until the request is approved, denied, expired, or `timeoutMs` elapses.
   *
   * On approval the returned `access_token` is a durable scoped API token and
   * is stored on `this.accessToken` exactly like `login()`.
   */
  async loginWithBrowser(options: LoginWithBrowserOptions = {}): Promise<JsonRecord> {
    const body: JsonRecord = {};
    if (options.scopes !== undefined) body.scopes = [...options.scopes];
    if (options.clientName) body.client_name = options.clientName;
    const grant = await this.request("POST", "/v1/auth/device/authorize", { body, auth: false });

    const deviceCode = grant.device_code;
    const userCode = grant.user_code;
    const verificationUri = grant.verification_uri;
    for (const value of [deviceCode, userCode, verificationUri]) {
      if (typeof value !== "string" || !value) {
        throw new ThalovantApiError("Thalovant API device authorization response was incomplete.");
      }
    }
    const rawInterval = grant.interval;
    const intervalMs =
      typeof rawInterval === "number" && Number.isFinite(rawInterval) && rawInterval >= 0
        ? rawInterval * 1000
        : DEFAULT_DEVICE_POLL_INTERVAL_MS;

    if (options.prompt) {
      options.prompt(grant as DeviceAuthorizationGrant);
    } else {
      console.log(`To sign in, visit ${verificationUri} and enter the code ${userCode}`);
    }
    if (options.openBrowser ?? true) {
      const completeUri = grant.verification_uri_complete;
      if (typeof completeUri === "string" && completeUri) {
        try {
          await (options.openUrl ?? openExternalUrl)(completeUri);
        } catch {
          // Browser availability is best-effort; the printed URL always works.
        }
      }
    }

    const token = await this.pollDeviceToken(deviceCode as string, {
      intervalMs,
      timeoutMs: options.timeoutMs ?? DEFAULT_DEVICE_LOGIN_TIMEOUT_MS,
    });
    const accessToken = token.access_token;
    if (typeof accessToken !== "string" || !accessToken) {
      throw new ThalovantApiError("Thalovant API token response did not include access_token.");
    }
    this.accessToken = accessToken;
    return token;
  }

  /**
   * Poll `POST /v1/auth/device/token` until approval or a terminal state.
   *
   * `sleep` and `now` are injectable so tests can drive the loop without real
   * waiting. Use `loginWithBrowser()` instead: this poll loop is an
   * implementation detail of the device flow (kept internal in every other
   * Thalovant SDK) and is not part of the public API surface.
   *
   * @internal
   */
  async pollDeviceToken(deviceCode: string, options: DevicePollOptions = {}): Promise<JsonRecord> {
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const now = options.now ?? (() => Date.now());
    const deadline = now() + (options.timeoutMs ?? DEFAULT_DEVICE_LOGIN_TIMEOUT_MS);
    let waitMs = options.intervalMs ?? DEFAULT_DEVICE_POLL_INTERVAL_MS;
    for (;;) {
      const response = await this.send("POST", "/v1/auth/device/token", {
        body: { device_code: deviceCode },
        auth: false,
      });
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      if (response.ok) {
        if (!isRecord(parsed)) {
          throw new ThalovantApiError("Thalovant API returned an unexpected response shape.");
        }
        return parsed;
      }
      const error = response.status === 400 && isRecord(parsed) ? parsed.error : undefined;
      if (error === "slow_down") {
        waitMs += DEVICE_SLOW_DOWN_STEP_MS;
      } else if (error === "access_denied") {
        throw new ThalovantApiError("The device sign-in request was denied in the browser.");
      } else if (error === "expired_token") {
        throw new ThalovantApiError(
          "The device sign-in code expired before it was approved. " +
            "Call loginWithBrowser() again to request a new code.",
        );
      } else if (error !== "authorization_pending") {
        throw new ThalovantApiError(apiErrorMessage(response.status, text));
      }
      const remaining = deadline - now();
      if (remaining <= 0) {
        throw new ThalovantTimeoutError("Timed out waiting for the device sign-in to be approved.");
      }
      await sleep(Math.min(waitMs, remaining));
    }
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
    const endpoint = "/v1/analytics/overview";
    const params = new URLSearchParams();
    setStringParam(params, "range", options.range);
    setStringParam(params, "bucket", options.bucket);
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

  /**
   * Create a hub.
   *
   * `payload` mirrors the API's hub create body: `name` and `spec` are
   * required, and `slug`, `namespace`, `runtimeGroupId`, `domain`, `active`,
   * `visibility`, `capacityProfile`, and `ownerId` are optional. camelCase keys
   * are sent as snake_case.
   *
   * The request is idempotent: a generated `Idempotency-Key` is sent unless you
   * pass your own, so a retried create returns the first hub instead of making
   * a second one.
   *
   * Requires a paid plan and a token with the `hubs:write` scope.
   */
  createHub(payload: HubPayload, options: { idempotencyKey?: string } = {}): Promise<JsonRecord> {
    return this.request("POST", "/v1/hubs", {
      body: hubPayload(payload),
      headers: { "Idempotency-Key": options.idempotencyKey ?? randomUUID() },
    });
  }

  /**
   * Partially update a hub.
   *
   * The API enforces optimistic locking on this route: pass the `etag` from the
   * hub resource you read, which is sent as `If-Match`. A stale or missing
   * value fails with HTTP 412 and no change is made; re-read the hub with
   * `getHub()` and retry with the new `etag`.
   *
   * Requires a paid plan and a token with the `hubs:write` scope.
   */
  updateHub(hubId: string, payload: HubPayload, options: HubWriteOptions): Promise<JsonRecord> {
    return this.request("PATCH", `/v1/hubs/${encodeURIComponent(hubId)}`, {
      body: hubPayload(payload),
      headers: { "If-Match": options.etag },
    });
  }

  /**
   * Delete a hub and its dependent clients and ACLs.
   *
   * Like `updateHub()` this route requires the hub's current `etag`, sent as
   * `If-Match`; a stale or missing value fails with HTTP 412.
   *
   * Requires a paid plan and a token with the `hubs:write` scope.
   */
  async deleteHub(hubId: string, options: HubWriteOptions): Promise<void> {
    await this.request("DELETE", `/v1/hubs/${encodeURIComponent(hubId)}`, {
      headers: { "If-Match": options.etag },
    });
  }

  /**
   * Apply a hub release policy and return the updated hub.
   *
   * Every option is optional; omitted fields fall back to the workspace release
   * policy. Passing `images` switches the hub to `custom` mode unless you also
   * pass `mode`.
   *
   * Requires a paid plan and a token with the `hubs:write` scope.
   */
  releaseHub(hubId: string, options: ReleaseOptions = {}): Promise<JsonRecord> {
    return this.request("POST", `/v1/hubs/${encodeURIComponent(hubId)}/release`, {
      body: releasePayload(options),
    });
  }

  /**
   * Rate a public hub from 1 to 5 and return the updated hub.
   *
   * Only public hubs can be rated, and owners cannot rate their own hubs.
   * Requires a token with the `hubs:write` scope; no paid plan is needed.
   */
  setHubRating(hubId: string, rating: number): Promise<JsonRecord> {
    return this.request("PUT", `/v1/hubs/${encodeURIComponent(hubId)}/rating`, { body: { rating } });
  }

  /**
   * Remove the caller's rating from a public hub and return the hub.
   *
   * Requires a token with the `hubs:write` scope; no paid plan is needed.
   */
  clearHubRating(hubId: string): Promise<JsonRecord> {
    return this.request("DELETE", `/v1/hubs/${encodeURIComponent(hubId)}/rating`);
  }

  /**
   * Read the live skill and intent inventory a hub runtime exposes.
   *
   * Requires a token with the `hubs:inspect` scope. The API answers HTTP 409
   * when the hub has no connected client that can report inventory.
   */
  getHubRuntimeCapabilities(hubId: string): Promise<JsonRecord> {
    return this.request("GET", `/v1/hubs/${encodeURIComponent(hubId)}/runtime-capabilities`);
  }

  /**
   * List runtime groups visible to the authenticated user.
   *
   * Requires a token with the `hubs:read` scope.
   */
  listRuntimeGroups(options: RuntimeGroupListOptions = {}): Promise<JsonRecord> {
    const params = new URLSearchParams();
    setStringParam(params, "owner_id", options.ownerId);
    const query = params.toString();
    return this.request("GET", query ? `/v1/runtime-groups?${query}` : "/v1/runtime-groups");
  }

  /**
   * Fetch one runtime group.
   *
   * Requires a token with the `hubs:read` scope.
   */
  getRuntimeGroup(runtimeGroupId: string): Promise<JsonRecord> {
    return this.request("GET", `/v1/runtime-groups/${encodeURIComponent(runtimeGroupId)}`);
  }

  /**
   * Create a runtime group.
   *
   * `payload` takes the API's create body: `name` is required, and
   * `description`, `environment`, `ownerId`, and `cloneFromDefault` are
   * optional. camelCase keys are sent as snake_case.
   *
   * Requires a paid plan and a token with the `hubs:write` scope.
   */
  createRuntimeGroup(payload: RuntimeGroupPayload): Promise<JsonRecord> {
    return this.request("POST", "/v1/runtime-groups", { body: runtimeGroupPayload(payload) });
  }

  /**
   * Update a runtime group's `name`, `description`, or `spec`.
   *
   * `spec` patches `replicas` and container `resources`. This route does not
   * use `If-Match`.
   *
   * Requires a paid plan and a token with the `hubs:write` scope.
   */
  updateRuntimeGroup(runtimeGroupId: string, payload: RuntimeGroupPayload): Promise<JsonRecord> {
    return this.request("PATCH", `/v1/runtime-groups/${encodeURIComponent(runtimeGroupId)}`, {
      body: runtimeGroupPayload(payload),
    });
  }

  /**
   * Read a runtime group's runtime configuration and personas.
   *
   * Requires a token with the `hubs:read` scope.
   */
  getRuntimeGroupConfig(runtimeGroupId: string): Promise<JsonRecord> {
    return this.request("GET", `/v1/runtime-groups/${encodeURIComponent(runtimeGroupId)}/config`);
  }

  /**
   * Merge runtime configuration into a runtime group.
   *
   * The API merges `config` into the stored configuration rather than replacing
   * it, and marks the group pending so the runtime operator reconciles the
   * change. `personas` is replaced only when provided.
   *
   * Requires a paid plan and a token with the `hubs:write` scope.
   */
  updateRuntimeGroupConfig(
    runtimeGroupId: string,
    config: JsonRecord,
    options: RuntimeGroupConfigOptions = {},
  ): Promise<JsonRecord> {
    const body: JsonRecord = { config };
    if (options.personas !== undefined) body.personas = options.personas;
    return this.request("PATCH", `/v1/runtime-groups/${encodeURIComponent(runtimeGroupId)}/config`, { body });
  }

  /**
   * Apply a runtime image policy and return the updated runtime group.
   *
   * Options behave like `releaseHub()`.
   *
   * Requires a paid plan and a token with the `hubs:write` scope.
   */
  releaseRuntimeGroup(runtimeGroupId: string, options: ReleaseOptions = {}): Promise<JsonRecord> {
    return this.request("POST", `/v1/runtime-groups/${encodeURIComponent(runtimeGroupId)}/release`, {
      body: releasePayload(options),
    });
  }

  /**
   * Delete a runtime group.
   *
   * The API answers HTTP 409 for the workspace default group and for a group
   * that still has hubs attached.
   *
   * Requires a paid plan and a token with the `hubs:write` scope.
   */
  async deleteRuntimeGroup(runtimeGroupId: string): Promise<void> {
    await this.request("DELETE", `/v1/runtime-groups/${encodeURIComponent(runtimeGroupId)}`);
  }

  /**
   * List the marketplace skill catalog visible to the authenticated user.
   *
   * Returns `{ data: [...] }` where each entry carries the catalog fields an
   * install needs — `skill_id`, `source_type`, `source_ref`, `package_name`,
   * `version` compatibility, `config_schema` and `secret_schema` — alongside
   * presentation and access fields such as `category`, `tags`, `verified`,
   * `access_tier` and `billing_sku`. Global catalog entries and the caller's own
   * tenant entries are both included.
   *
   * `ownerId` and `includeInactive` are honored for admin tokens only; the API
   * silently scopes a non-admin caller to their own tenant and to active
   * entries. `forceRefresh` re-syncs the global catalog from its source before
   * answering, which is slower.
   *
   * Requires a token with the `hubs:read` scope. Unlike the provisioning routes
   * this catalog is **not** paid-gated, so free-tier callers can browse the
   * marketplace before upgrading — only the install itself needs a paid plan.
   */
  listMarketplaceSkills(options: MarketplaceSkillListOptions = {}): Promise<JsonRecord> {
    const params = new URLSearchParams();
    setStringParam(params, "owner_id", options.ownerId);
    if (options.includeInactive) params.set("include_inactive", "true");
    if (options.forceRefresh) params.set("force_refresh", "true");
    const query = params.toString();
    return this.request("GET", query ? `/v1/marketplace/skills?${query}` : "/v1/marketplace/skills");
  }

  /**
   * List the marketplace catalog resolved against one runtime group.
   *
   * This is the discovery view to use before installing: every catalog entry is
   * returned with the group's own state folded in — whether the skill is
   * desired (`active`, `version_pin`, `source_type`), whether it was observed
   * running (`observed_source`, `observed_at`, intent counts), operator status
   * fields, and the access verdict for the tenant plan (`purchase_required`,
   * `installable`, `access_message`). The envelope also carries
   * `runtime_group_id`, `observed_at`, `source`, `operator_phase` and
   * `operator_message`.
   *
   * `refreshInventory` forces a live read from the runtime operator instead of
   * answering from the cached inventory snapshot; without it the envelope
   * `source` is `runtime-group-cache` (or `runtime-group-cache-empty` when
   * nothing has been observed yet), never a live operator read.
   *
   * Requires a token with the `hubs:inspect` scope; no paid plan is needed to
   * browse. The API answers HTTP 404 for an unknown group and HTTP 403 when the
   * caller does not own it.
   */
  listRuntimeGroupMarketplace(
    runtimeGroupId: string,
    options: RuntimeGroupMarketplaceOptions = {},
  ): Promise<JsonRecord> {
    const params = new URLSearchParams();
    if (options.refreshInventory) params.set("refresh_inventory", "true");
    const query = params.toString();
    const path = `/v1/runtime-groups/${encodeURIComponent(runtimeGroupId)}/marketplace`;
    return this.request("GET", query ? `${path}?${query}` : path);
  }

  /**
   * List the skills a runtime group is actually observed running.
   *
   * Where `listRuntimeGroupMarketplace()` answers "what could be installed
   * here", this answers "what is loaded right now": each entry carries
   * `skill_id`, `version`, `source`, `active`, `adapt_intents`,
   * `padatious_intents`, `total_intents` and `observed_at`. The envelope reports
   * `source` — the observation's provenance, one of `ovos-runtime-operator`,
   * `runtime-group-cache` or `ovos-runtime-operator-pending` — plus
   * `operator_phase` and `operator_message`.
   *
   * `refresh` forces a live operator read; the API also refreshes on its own
   * when it holds no cached snapshot. Unlike `getHubRuntimeCapabilities()` this
   * route does not answer HTTP 409 when nothing is reporting — it returns an
   * empty `data` list with a pending `source` instead.
   *
   * Requires a token with the `hubs:inspect` scope; no paid plan is needed.
   */
  listRuntimeGroupInventory(
    runtimeGroupId: string,
    options: RuntimeGroupInventoryOptions = {},
  ): Promise<JsonRecord> {
    const params = new URLSearchParams();
    if (options.refresh) params.set("refresh", "true");
    const query = params.toString();
    const path = `/v1/runtime-groups/${encodeURIComponent(runtimeGroupId)}/inventory`;
    return this.request("GET", query ? `${path}?${query}` : path);
  }

  /**
   * Install (or re-install) a skill in a runtime group.
   *
   * The default `sourceType` of `catalog` installs a marketplace skill and
   * requires the skill to exist in the catalog. `git` installs need a
   * `sourceRef` repository URL. Installing a skill that is already present
   * updates the existing entry.
   *
   * Requires a paid plan and a token with the `hubs:write` scope. Paid
   * marketplace skills also need marketplace access on the tenant plan.
   */
  installRuntimeGroupSkill(
    runtimeGroupId: string,
    skillId: string,
    options: RuntimeGroupSkillInstallOptions = {},
  ): Promise<JsonRecord> {
    const body: JsonRecord = {
      skill_id: skillId,
      source_type: options.sourceType ?? "catalog",
      active: options.active ?? true,
    };
    if (options.marketplaceSkillId !== undefined) body.marketplace_skill_id = options.marketplaceSkillId;
    if (options.sourceRef !== undefined) body.source_ref = options.sourceRef;
    if (options.versionPin !== undefined) body.version_pin = options.versionPin;
    return this.request("POST", `/v1/runtime-groups/${encodeURIComponent(runtimeGroupId)}/skills`, { body });
  }

  /**
   * Remove a skill from a runtime group.
   *
   * Requires a paid plan and a token with the `hubs:write` scope.
   */
  async uninstallRuntimeGroupSkill(runtimeGroupId: string, skillId: string): Promise<void> {
    await this.request(
      "DELETE",
      `/v1/runtime-groups/${encodeURIComponent(runtimeGroupId)}/skills/${encodeURIComponent(skillId)}`,
    );
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
        const includeSecrets = resultOptions.includeSecrets ?? false;
        return {
          identity: identity.asObject(includeSecrets),
          // The raw client record carries the POST /v1/clients secrets (the
          // initial_identify credential bundle plus the echoed spec apiKey/
          // password/cryptoKey), so both records are scrubbed unless the
          // caller explicitly opts in — the same gate the identity uses.
          hub: includeSecrets ? hubResource : withoutSecretKeys(hubResource),
          client: includeSecrets ? client : withoutSecretKeys(client),
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
    const response = await this.send(method, path, options);
    if (!response.ok) {
      throw new ThalovantApiError(apiErrorMessage(response.status, await response.text()));
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

  private async send(
    method: string,
    path: string,
    options: { body?: JsonRecord; headers?: Record<string, string>; auth?: boolean } = {},
  ): Promise<Response> {
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
    return fetch(new URL(path.replace(/^\/+/, ""), this.apiUrl), {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  }
}

function newSecret(): string {
  return bytesToBase64Url(randomBytes(32));
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

function hubPayload(payload: HubPayload): JsonRecord {
  const result: JsonRecord = { ...payload };
  renameKey(result, "ownerId", "owner_id");
  renameKey(result, "runtimeGroupId", "runtime_group_id");
  renameKey(result, "capacityProfile", "capacity_profile");
  renameKey(result, "isLocked", "is_locked");
  return result;
}

function runtimeGroupPayload(payload: RuntimeGroupPayload): JsonRecord {
  const result: JsonRecord = { ...payload };
  renameKey(result, "ownerId", "owner_id");
  renameKey(result, "cloneFromDefault", "clone_from_default");
  return result;
}

/** Build a release-apply body, omitting the options the caller left unset. */
function releasePayload(options: ReleaseOptions): JsonRecord {
  const body: JsonRecord = {};
  if (options.channel !== undefined) body.channel = options.channel;
  if (options.mode !== undefined) body.mode = options.mode;
  if (options.version !== undefined) body.version = options.version;
  if (options.images !== undefined) body.images = { ...options.images };
  if (options.reason !== undefined) body.reason = options.reason;
  return body;
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
  return value.trim().replace(/_+/g, "-").replace(/\s+/g, "-") || `thalovant-client-${bytesToHex(randomBytes(4))}`;
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

/**
 * Key names holding secrets in control-plane hub/client records, compared
 * after lowercasing and removing `_`/`-` so both spellings of each key match
 * (`apiKey`/`api_key`, `cryptoKey`/`crypto_key`, ...). `initial_identify` is
 * the whole credential bundle `POST /v1/clients` returns.
 */
const SECRET_RECORD_KEYS = new Set([
  "initialidentify",
  "initialidentifytoken",
  "accesskey",
  "apikey",
  "clientsecret",
  "cryptokey",
  "password",
  "privatekey",
  "secret",
]);

function isSecretRecordKey(key: string): boolean {
  return SECRET_RECORD_KEYS.has(key.toLowerCase().replace(/[_-]/g, ""));
}

/**
 * Deep copy of a control-plane record with secret-named keys omitted, the
 * same way `ThalovantIdentity.asObject()` omits its secrets by default. Used
 * only for the human-facing `asObject()` view; wire payloads and the
 * `includeSecrets: true` path never go through it.
 */
function withoutSecretKeys(value: JsonRecord): JsonRecord {
  const result: JsonRecord = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isSecretRecordKey(key)) continue;
    result[key] = withoutNestedSecretKeys(entry);
  }
  return result;
}

function withoutNestedSecretKeys(value: unknown): unknown {
  if (isRecord(value)) {
    return withoutSecretKeys(value);
  }
  if (Array.isArray(value)) {
    return value.map(entry => withoutNestedSecretKeys(entry));
  }
  return value;
}

/**
 * Build a thrown-error message from an HTTP status and response body without
 * ever embedding the raw body: bodies can echo request secrets (for example
 * `POST /v1/clients` validation errors repeating the sent spec). Structured
 * JSON keeps only a short string detail field; non-JSON bodies keep a
 * newline-stripped snippet bounded to {@link MAX_ERROR_DETAIL_LENGTH}.
 */
function apiErrorMessage(status: number, bodyText: string): string {
  const detail = apiErrorDetail(bodyText);
  return detail
    ? `Thalovant API request failed with HTTP ${status}: ${detail}`
    : `Thalovant API request failed with HTTP ${status}.`;
}

function apiErrorDetail(bodyText: string): string {
  let detail: string | undefined;
  let isJsonBody = false;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    isJsonBody = true;
    if (isRecord(parsed)) {
      for (const key of ["detail", "error_description", "message", "error", "title", "code"]) {
        detail = detailString(parsed[key]);
        if (detail) break;
      }
    }
  } catch {
    // Not JSON; fall through to the bounded plain-text snippet.
  }
  // A JSON body without a recognized string detail is dropped entirely rather
  // than quoted: unknown JSON shapes are exactly where echoed secrets hide.
  const source = detail ?? (isJsonBody ? "" : bodyText);
  const compact = source.replace(/\s+/g, " ").trim();
  return compact.length > MAX_ERROR_DETAIL_LENGTH
    ? `${compact.slice(0, MAX_ERROR_DETAIL_LENGTH)}…`
    : compact;
}

/** First short human-readable string in a JSON error detail value. */
function detailString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = detailString(entry);
      if (nested) return nested;
    }
    return undefined;
  }
  if (isRecord(value)) {
    return detailString(value.msg ?? value.message ?? value.detail);
  }
  return undefined;
}
