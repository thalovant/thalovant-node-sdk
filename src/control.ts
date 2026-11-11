import {
  assertSecureTokenExchange,
  browserAuthorizationUrl,
  canOpenBrowser,
  challengeFor,
  DEFAULT_BROWSER_LOGIN_TIMEOUT_MS,
  defaultDeviceName,
  loopbackRedirectUri,
  NativeSignInConfig,
  newState,
  newVerifier,
} from "./native-auth.js";
import { LoopbackListener } from "./loopback.js";
import { bytesToBase64Url, bytesToHex } from "./bytes.js";
import {
  bridgeChatListFromRecord,
  bridgeCreateBody,
  bridgeFromRecord,
  bridgeNetworksFromRecord,
  bridgeSecretsBody,
  bridgesFromRecord,
  bridgeTestResultFromRecord,
  bridgeTokenBody,
  bridgeUpdateBody,
  chatAppConnectorsFromRecord,
  type Bridge,
  type BridgeAvatar,
  type BridgeChanges,
  type BridgeChatList,
  type BridgeCreateOptions,
  type BridgeListOptions,
  type BridgeNetworks,
  type BridgeNetworksOptions,
  type BridgeTestResult,
  type BridgeWriteOptions,
  type ChatAppConnector,
  type SecretValue,
} from "./chat-apps.js";
import {
  announceBody,
  announcementFromRecord,
  announcementListFromRecord,
  intercomSettingsBody,
  intercomSettingsFromRecord,
  intercomSpeakerFromRecord,
  intercomSpeakersFromRecord,
  speakerUpdateBody,
  type Announcement,
  type AnnouncementList,
  type AnnouncementListOptions,
  type AnnounceOptions,
  type IntercomSettings,
  type IntercomSpeaker,
  type IntercomSpeakerChanges,
  type IntercomSpeakerList,
} from "./intercom.js";
import {
  ThalovantAdmissionFailedError,
  ThalovantAdmissionTimeoutError,
  ThalovantAlreadyLinkedError,
  ThalovantApiError,
  ThalovantApiUnreachableError,
  ThalovantAuthError,
  ThalovantDeviceLoginDeniedError,
  ThalovantDeviceLoginExpiredError,
  ThalovantDeviceLoginPendingError,
  ThalovantHubUnreachableError,
  ThalovantIntercomDisabledError,
  ThalovantPlanError,
  ThalovantRateLimitedError,
  ThalovantTimeoutError,
  ThalovantUnsupportedConnectionTypeError,
  ThalovantUnsupportedProtocolError,
} from "./errors.js";
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
import {
  REDACTED,
  redactSecretsInJson,
  redactSecretsInJsonNumbers,
  redactSecretsInString,
  redactUrlUserinfo,
  secretSpellings,
  withoutSecretKeys,
  type RedactOptions,
} from "./redact.js";
import { USER_AGENT } from "./version.js";
import { trimSlashes, trimTrailingSlashes } from "./slashes.js";

export const DEFAULT_CONTROL_API_URL = "https://api.thalovant.com";
/** Control-plane user agent. Derived from the one version constant, never pinned. */
const DEFAULT_CONTROL_USER_AGENT = USER_AGENT;

const DEFAULT_DEVICE_POLL_INTERVAL_MS = 5_000;
const DEVICE_SLOW_DOWN_STEP_MS = 5_000;
const DEFAULT_DEVICE_LOGIN_TIMEOUT_MS = 900_000;
/** Seconds a device sign-in poll waits when the API names no interval. */
const DEFAULT_DEVICE_POLL_INTERVAL_SECONDS = 5;
/** Seconds a device code lives when the API does not say. */
const DEFAULT_DEVICE_CODE_LIFETIME_SECONDS = 900;
/** Device codes whose poll interval is remembered at once; the oldest goes first. */
const MAX_REMEMBERED_DEVICE_CODES = 64;

/**
 * The scopes a Home Assistant link asks for at sign-in: reading hubs, and
 * reading and writing its own connection. They are also all a Free plan can
 * approve.
 */
export const HOME_ASSISTANT_SCOPES: readonly string[] = Object.freeze(["hubs:read", "clients:read", "clients:write"]);
/**
 * The registered app id Home Assistant signs in as (a device login's
 * `clientId`). The approval screen then shows the platform's own name for it
 * as verified, and approving it again replaces the token the last approval
 * gave it instead of counting a second one against the plan.
 */
export const HOME_ASSISTANT_CLIENT_ID = "thalovant-home-assistant";
/** `spec.connection_type` of a Home Assistant link. */
export const CONNECTION_TYPE_HOME_ASSISTANT = "home_assistant";
/** Milliseconds between two reads of an operation the caller is waiting on. */
export const DEFAULT_OPERATION_POLL_INTERVAL_MS = 2_000;
/**
 * How long `waitForAdmission()` waits by default, in milliseconds: a hub
 * admits a new connection in about ninety seconds.
 */
export const DEFAULT_ADMISSION_TIMEOUT_MS = 180_000;

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
  /** The new connection's id, when the API returned one. */
  clientId?: string;
  /** The connection type the API recorded (`spec.connection_type`), when it recorded one. */
  connectionType?: string;
  /**
   * The operation that carries the new connection to its hub, when the API
   * returned one. `waitForAdmission()` follows it.
   */
  operation?: OperationResource;
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
  /**
   * The kind of connection: `voice_satellite`, `web_chat`, `developer`,
   * `embedded`, `home_assistant` ({@link CONNECTION_TYPE_HOME_ASSISTANT}). Sent
   * as `spec.connection_type`; the kind decides what the connection may send
   * and receive. The API must answer with the same kind, or the connection it
   * made is deleted and the call throws
   * {@link ThalovantUnsupportedConnectionTypeError}.
   */
  connectionType?: string;
}

/** Options for `listClients`. */
export interface ClientListOptions {
  /** Sent as `hub_id`: only this hub's connections. */
  hubId?: string;
  /** Page size; the API default applies when omitted. Default 100. */
  limit?: number;
  cursor?: string;
  /** Sent as `owner_id`. Admin tokens only. */
  ownerId?: string;
  /** False asks the API to leave each connection's `spec` out. Default true. */
  includeSpec?: boolean;
}

/** Options for `deleteClient`. */
export interface ClientDeleteOptions {
  /**
   * The connection's current `etag`, sent as `If-Match`. When omitted the SDK
   * reads it first with `getClient()`.
   */
  etag?: string | null;
}

/** Options for `waitForAdmission`. */
export interface AdmissionWaitOptions {
  /** How long to wait, in milliseconds. Default 180000. */
  timeoutMs?: number;
  /** Milliseconds between two reads of the operation. Default 2000. */
  pollIntervalMs?: number;
  /** Stops the wait; it rejects with an `AbortError`. */
  signal?: AbortSignal;
}

/** Options for `beginDeviceLogin`. */
export interface DeviceLoginOptions {
  /**
   * Scopes the token will carry. Omitted when not given, and the API applies
   * its default. A Home Assistant link asks for {@link HOME_ASSISTANT_SCOPES}.
   */
  scopes?: readonly string[];
  /** The name the dashboard shows for the token and on the approval page. */
  clientName?: string;
  /**
   * Sign in as a registered app, such as {@link HOME_ASSISTANT_CLIENT_ID}:
   * the approval screen shows the platform's own name for the app as
   * verified (`clientName` becomes the device's label beside it), and
   * approving the app again replaces the token it already holds. Such an app
   * may ask only for its own scopes, and an id the API does not know is
   * refused (400 `unknown_client`). Left out of the request when not given.
   */
  clientId?: string | null;
}

/**
 * A started device sign-in: what to show a person, and what to poll with.
 *
 * `deviceCode` is the secret half and never needs showing; printing the object
 * with `console.log` or `util.inspect` leaves it out. `JSON.stringify` keeps it,
 * in the API's own field names, so the sign-in can be stored and resumed in
 * another process with {@link DeviceAuthorization.fromGrant}: store it as the
 * secret it is.
 */
export class DeviceAuthorization {
  readonly deviceCode: string;
  /** The short code the person types at `verificationUri`. */
  readonly userCode: string;
  readonly verificationUri: string;
  /** The URL with the code already in it, when the API sent one. */
  readonly verificationUriComplete: string | null;
  /** Seconds between two polls. */
  readonly interval: number;
  /** Seconds the device code lives. */
  readonly expiresIn: number;

  private constructor(fields: {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string | null;
    interval: number;
    expiresIn: number;
  }) {
    this.deviceCode = fields.deviceCode;
    this.userCode = fields.userCode;
    this.verificationUri = fields.verificationUri;
    this.verificationUriComplete = fields.verificationUriComplete;
    this.interval = fields.interval;
    this.expiresIn = fields.expiresIn;
  }

  /**
   * Read a `POST /v1/auth/device/authorize` answer, or a stored one.
   *
   * Both verification URLs are about to be opened in a browser, so one that is
   * not http(s), has no host, or carries credentials is refused.
   */
  static fromGrant(payload: Record<string, unknown>): DeviceAuthorization {
    const deviceCode = payload.device_code;
    const userCode = payload.user_code;
    const verificationUri = payload.verification_uri;
    for (const value of [deviceCode, userCode, verificationUri]) {
      if (typeof value !== "string" || !value) {
        throw new ThalovantApiError("Thalovant API device authorization response was incomplete.");
      }
    }
    const complete = payload.verification_uri_complete;
    for (const value of [verificationUri, complete]) {
      if (value !== undefined && value !== null) assertSafeBrowserUrl(value);
    }
    const interval = payload.interval;
    const expiresIn = payload.expires_in;
    return new DeviceAuthorization({
      deviceCode: deviceCode as string,
      userCode: userCode as string,
      verificationUri: verificationUri as string,
      verificationUriComplete: typeof complete === "string" && complete ? complete : null,
      interval: typeof interval === "number" && Number.isFinite(interval) && interval >= 0
        ? interval
        : DEFAULT_DEVICE_POLL_INTERVAL_SECONDS,
      expiresIn: typeof expiresIn === "number" && Number.isInteger(expiresIn)
        ? expiresIn
        : DEFAULT_DEVICE_CODE_LIFETIME_SECONDS,
    });
  }

  /** The API's field names, `device_code` included. */
  toJSON(): Record<string, unknown> {
    return {
      device_code: this.deviceCode,
      user_code: this.userCode,
      verification_uri: this.verificationUri,
      verification_uri_complete: this.verificationUriComplete,
      interval: this.interval,
      expires_in: this.expiresIn,
    };
  }

  toString(): string {
    return `DeviceAuthorization ${JSON.stringify({ ...this.toJSON(), device_code: REDACTED })}`;
  }

  [customInspect](): string {
    return this.toString();
  }
}

/**
 * A pending device sign-in as the person approving it sees it, read with
 * `describeDeviceLogin()`.
 *
 * `clientVerified` is true only when a registered app asked (it named its
 * `clientId`): `clientName` is then the platform's own name for that app, and
 * `deviceName` whatever the device called itself, which nothing checks.
 * Otherwise `clientName` is the device's own claim.
 */
export class DeviceLoginRequest {
  readonly scopes: readonly string[];
  readonly clientName: string | null;
  /** When the code stops working, exactly as the API wrote it (ISO 8601), or null. */
  readonly expiresAt: string | null;
  readonly clientId: string | null;
  readonly clientVerified: boolean;
  readonly deviceName: string | null;

  private constructor(fields: {
    scopes: readonly string[];
    clientName: string | null;
    expiresAt: string | null;
    clientId: string | null;
    clientVerified: boolean;
    deviceName: string | null;
  }) {
    this.scopes = Object.freeze([...fields.scopes]);
    this.clientName = fields.clientName;
    this.expiresAt = fields.expiresAt;
    this.clientId = fields.clientId;
    this.clientVerified = fields.clientVerified;
    this.deviceName = fields.deviceName;
  }

  /** Read a `GET /v1/auth/device/codes/{user_code}` answer. */
  static fromResponse(payload: Record<string, unknown>): DeviceLoginRequest {
    const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
    const scopes = Array.isArray(payload.scopes)
      ? payload.scopes.filter((scope): scope is string => typeof scope === "string")
      : [];
    const clientId = text(payload.client_id);
    return new DeviceLoginRequest({
      scopes,
      clientName: text(payload.client_name),
      expiresAt: text(payload.expires_at),
      clientId,
      // Verified only as the API says it, and only with the app named: a
      // true without an id says nothing about who asked.
      clientVerified: payload.client_verified === true && clientId !== null,
      deviceName: text(payload.device_name),
    });
  }

  /** The API's field names. */
  toJSON(): Record<string, unknown> {
    return {
      scopes: [...this.scopes],
      client_name: this.clientName,
      expires_at: this.expiresAt,
      client_id: this.clientId,
      client_verified: this.clientVerified,
      device_name: this.deviceName,
    };
  }
}

/**
 * An API token the API minted, and what it may do.
 *
 * There is no refresh token: a device-login token lives a year. Keep `tokenId`
 * to revoke it later with `revokeApiToken()`. `accessToken` is left out of
 * `console.log` and `util.inspect`; `JSON.stringify` keeps it, for storing as
 * the secret it is.
 */
export class ApiToken {
  readonly accessToken: string;
  readonly tokenType: string;
  readonly scopes: readonly string[];
  /** When the token stops working, exactly as the API wrote it (ISO 8601), or null. */
  readonly expiresAt: string | null;
  /** The token's id, for `revokeApiToken()`; null when the API did not send one. */
  readonly tokenId: string | null;

  private constructor(fields: {
    accessToken: string;
    tokenType: string;
    scopes: readonly string[];
    expiresAt: string | null;
    tokenId: string | null;
  }) {
    this.accessToken = fields.accessToken;
    this.tokenType = fields.tokenType;
    this.scopes = Object.freeze([...fields.scopes]);
    this.expiresAt = fields.expiresAt;
    this.tokenId = fields.tokenId;
  }

  /** Read a token answer; one without an `access_token` is an error. */
  static fromResponse(payload: Record<string, unknown>): ApiToken {
    const accessToken = payload.access_token;
    if (typeof accessToken !== "string" || !accessToken) {
      throw new ThalovantApiError("Thalovant API token response did not include access_token.");
    }
    const scopes = Array.isArray(payload.scopes)
      ? payload.scopes.filter((scope): scope is string => typeof scope === "string")
      : [];
    const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
    return new ApiToken({
      accessToken,
      tokenType: text(payload.token_type) ?? "bearer",
      scopes,
      expiresAt: text(payload.expires_at),
      tokenId: text(payload.token_id),
    });
  }

  /** The API's field names, `access_token` included. */
  toJSON(): Record<string, unknown> {
    return {
      access_token: this.accessToken,
      token_type: this.tokenType,
      scopes: [...this.scopes],
      expires_at: this.expiresAt,
      token_id: this.tokenId,
    };
  }

  toString(): string {
    return `ApiToken ${JSON.stringify({ ...this.toJSON(), access_token: REDACTED })}`;
  }

  [customInspect](): string {
    return this.toString();
  }
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
 * Unless the caller is a platform administrator, each image must be one the
 * platform releases for its key: a catalog pin of the stable or alpha channel,
 * the resource's current, recommended or release-policy image, or the
 * platform's default image. Runtime `core` and hub `listener` also accept any
 * tag or digest of the platform's own repository
 * (`ghcr.io/thalovant/ovos-core`, `ghcr.io/thalovant/hivemind-listener`); `bus`
 * and `preview_bridge` take only the listed images. The API refuses anything
 * else with HTTP 403 `platform_image_required`.
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
  /** Deep merge with a revision precondition by default; false explicitly replaces via PATCH. */
  merge?: boolean;
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

// ---------------------------------------------------------------------------
// Hub-scoped skills.
//
// The API contract for these routes is still being finalized. Every path,
// field name, and state value the SDK depends on lives in this block so that a
// change on the server side is a change in one place here.
// ---------------------------------------------------------------------------

/** Milliseconds between two operation reads while waiting for a hub skill change. */
export const DEFAULT_HUB_SKILL_POLL_INTERVAL_MS = 2_000;
/** Default ceiling, in milliseconds, for `wait: true` on the hub skill commands. */
export const DEFAULT_HUB_SKILL_WAIT_TIMEOUT_MS = 120_000;

/** Operation statuses after which the API will not move an operation again. */
const TERMINAL_OPERATION_STATUSES: ReadonlySet<string> = new Set(["ready", "failed", "timed_out"]);

function hubSkillsPath(hubId: string): string {
  return `/v1/hubs/${encodeURIComponent(hubId)}/skills`;
}

function hubSkillPath(hubId: string, skill: string): string {
  return `${hubSkillsPath(hubId)}/${encodeURIComponent(skill)}`;
}

/**
 * State of one skill as the hub reports it. A change in progress shows as
 * `pending`; `drifted` means the running version differs from the requested
 * one, `quarantined` that the runtime disabled the skill after repeated
 * failures, and `unmanaged` that it runs on the hub but is not managed through
 * this route.
 */
export type HubSkillState = "pending" | "installed" | "failed" | "removing" | "drifted" | "quarantined" | "unmanaged";

/**
 * State of an accepted hub skill command. `installing`, `updating`, and
 * `removing` are what the API answers at acceptance; `installed` and
 * `removed` are where a waited-for command converges.
 */
export type HubSkillOperationState = "installing" | "updating" | "removing" | "installed" | "removed" | "failed";

/** One row of `GET /v1/hubs/{hub_id}/skills`. Absent strings are `null`. */
export interface HubSkill {
  skill: string;
  title: string | null;
  marketplace_skill_id: string | null;
  package_name: string | null;
  source_type: string | null;
  install_source: string | null;
  /** The requested version (`"latest"` or an exact `x.y.z`). */
  version: string | null;
  version_pin: string | null;
  installed_version: string | null;
  observed_version: string | null;
  previous_version: string | null;
  latest_version: string | null;
  available_version: string | null;
  update_available: boolean;
  changelog: string | null;
  active: boolean;
  state: HubSkillState;
  operator_phase: string | null;
  operator_message: string | null;
  operator_last_error: string | null;
  last_transition_at: string | null;
}

/** The `GET /v1/hubs/{hub_id}/skills` envelope: one hub's skills plus where the reading came from. */
export interface HubSkillList {
  hub_id: string;
  runtime_group_id: string | null;
  observed_at: string | null;
  source: string | null;
  operator_phase: string | null;
  operator_message: string | null;
  data: HubSkill[];
}

/**
 * An accepted hub skill command, plus where it converged when waited for.
 *
 * `operation` is the last {@link OperationResource} read while waiting, and
 * `undefined` when the call returned at acceptance.
 */
export interface HubSkillOperation {
  operation_id: string;
  hub_id: string | null;
  runtime_group_id: string | null;
  skill: string;
  /** The requested version; `null` for a removal. */
  version: string | null;
  /** The version the hub carried before this change, when it carried one. */
  previous_version: string | null;
  state: HubSkillOperationState;
  operation?: OperationResource;
}

/** Wait options shared by the hub skill commands. */
export interface HubSkillWaitOptions {
  /** Poll the accepted operation until it converges. Default `false`. */
  wait?: boolean;
  /** Polling budget in milliseconds; no new read starts after expiry. Default 120000. */
  timeoutMs?: number;
  /** Poll interval in milliseconds. Default 2000. Intended for tests. */
  pollIntervalMs?: number;
  /** Injectable sleep so tests can drive the loop without real waiting. */
  sleep?: (ms: number) => Promise<void> | void;
  /** Injectable monotonic clock (milliseconds) paired with `sleep`. */
  now?: () => number;
}

/** Options for `installHubSkill`. */
export interface HubSkillInstallOptions extends HubSkillWaitOptions {
  /** `"latest"` (the default) or an exact `x.y.z`. */
  version?: string;
}

/** Options for `updateHubSkill`. */
export interface HubSkillUpdateOptions extends HubSkillWaitOptions {
  /** `"latest"` or an exact `x.y.z`. Required. */
  version: string;
}

function hubSkillListFromRecord(payload: JsonRecord): HubSkillList {
  const rows = payload.data;
  if (!Array.isArray(rows)) {
    throw new ThalovantApiError("Thalovant API returned an unexpected hub skill listing shape.");
  }
  return {
    hub_id: requiredString(payload, "hub_id"),
    runtime_group_id: optionalString(payload.runtime_group_id),
    observed_at: optionalString(payload.observed_at),
    source: optionalString(payload.source),
    operator_phase: optionalString(payload.operator_phase),
    operator_message: optionalString(payload.operator_message),
    data: rows.filter(isRecord).map(hubSkillFromRecord),
  };
}

function hubSkillFromRecord(value: JsonRecord): HubSkill {
  return {
    skill: requiredString(value, "skill"),
    title: optionalString(value.title),
    marketplace_skill_id: optionalString(value.marketplace_skill_id),
    package_name: optionalString(value.package_name),
    source_type: optionalString(value.source_type),
    install_source: optionalString(value.install_source),
    version: optionalString(value.version),
    version_pin: optionalString(value.version_pin),
    installed_version: optionalString(value.installed_version),
    observed_version: optionalString(value.observed_version),
    previous_version: optionalString(value.previous_version),
    latest_version: optionalString(value.latest_version),
    available_version: optionalString(value.available_version),
    update_available: value.update_available === true,
    changelog: optionalString(value.changelog),
    active: value.active !== false,
    state: requiredString(value, "state") as HubSkillState,
    operator_phase: optionalString(value.operator_phase),
    operator_message: optionalString(value.operator_message),
    operator_last_error: optionalString(value.operator_last_error),
    last_transition_at: optionalString(value.last_transition_at),
  };
}

function hubSkillOperationFromRecord(value: JsonRecord): HubSkillOperation {
  return {
    operation_id: requiredString(value, "operation_id"),
    hub_id: optionalString(value.hub_id),
    runtime_group_id: optionalString(value.runtime_group_id),
    skill: requiredString(value, "skill"),
    version: optionalString(value.version),
    previous_version: optionalString(value.previous_version),
    state: requiredString(value, "state") as HubSkillOperationState,
  };
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
  /** Sign in as a registered app; see {@link DeviceLoginOptions.clientId}. */
  clientId?: string | null;
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
 * How `interactiveLogin()` signs in: `auto` (the browser when this machine has
 * one and the API offers it, a device login otherwise), or one of the two,
 * forced.
 */
export type LoginMethod = "auto" | "browser" | "device";

/** Options for `browserLogin()`. */
export interface BrowserLoginOptions {
  /**
   * Scopes the token will carry. Empty strings are dropped, and none asks for
   * the API's default (`hubs:read clients:write`). Any non-admin scope may be
   * asked for; the API refuses admin or unknown scopes when the person
   * approves.
   */
  scopes?: readonly string[] | null;
  /**
   * What the consent page and the token show. Default
   * `thalovant-node-sdk on <hostname>` ({@link defaultDeviceName}); cut to 120
   * code points.
   */
  deviceName?: string | null;
  /**
   * Open the consent page in the default browser (best-effort, never
   * blocking the wait). The URL is printed either way. Default `true`.
   */
  openBrowser?: boolean;
  /** How long to wait for the browser to come back. Default 300000 (5 minutes). */
  timeoutMs?: number;
  /**
   * Show the URL yourself, in place of the printed message. It does not stop
   * the browser from opening.
   */
  prompt?: (url: string) => void;
  /** Cancels the sign-in: it rejects with an `AbortError`, and the port is closed. */
  signal?: AbortSignal;
  /**
   * Opens the consent page in place of the platform's default (`open` on
   * macOS, `xdg-open` elsewhere, `rundll32 url.dll,FileProtocolHandler` on
   * Windows). Not awaited, and a failure changes nothing: the URL was shown.
   */
  openUrl?: (url: string) => unknown;
  /**
   * How long the configuration request and the code exchange may each take.
   * Default 10000.
   *
   * @internal
   */
  requestTimeoutMs?: number;
}

/** Options for `interactiveLogin()`. */
export interface InteractiveLoginOptions {
  /** `auto` (the default), `browser` or `device`. */
  method?: LoginMethod;
  /** Scopes the token will carry; as in {@link BrowserLoginOptions.scopes} and {@link LoginWithBrowserOptions.scopes}. */
  scopes?: readonly string[] | null;
  /**
   * What the consent page shows: a browser sign-in's `deviceName`, a device
   * login's `clientName`. Default `thalovant-node-sdk on <hostname>`.
   */
  deviceName?: string | null;
  /** Open the browser (best-effort); the URL is printed either way. Default `true`. */
  openBrowser?: boolean;
  /** How long to wait. Default each method's own: 300000 for the browser, 900000 for a device login. */
  timeoutMs?: number;
  /** Cancels the sign-in, either method: it rejects with an `AbortError`. */
  signal?: AbortSignal;
  /** Opens a URL in place of the platform's default, for either method. */
  openUrl?: (url: string) => unknown;
  /**
   * How long a browser sign-in's configuration request and code exchange may
   * each take. Default 10000.
   *
   * @internal
   */
  requestTimeoutMs?: number;
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
  /** Stops the loop: it rejects with an `AbortError`. */
  signal?: AbortSignal;
}

/** Options for the {@link ThalovantControlPlane} constructor. */
export interface ControlPlaneOptions {
  accessToken?: string;
  userAgent?: string;
  /**
   * The `fetch` to send every request with, such as one bound to a host's own
   * HTTP agent or a test double. Defaults to the global `fetch`, looked up per
   * request.
   */
  fetch?: typeof fetch;
}

export class ThalovantControlPlane {
  readonly apiUrl: string;
  accessToken?: string;
  /**
   * The id of the API token in `accessToken`, when the SDK minted it (a device
   * login): what `revokeApiToken()` revokes by default.
   */
  tokenId?: string;
  readonly userAgent: string;
  private readonly fetchImpl?: typeof fetch;
  /** The token this client signed in with was revoked and forgotten; revoking it again is a no-op. */
  private revokedOwn = false;
  /** Each device code's poll interval in seconds, lengthened by every slow_down. */
  private readonly deviceIntervals = new Map<string, number>();

  constructor(apiUrl = DEFAULT_CONTROL_API_URL, options: ControlPlaneOptions = {}) {
    this.apiUrl = normalizeControlApiUrl(apiUrl);
    this.accessToken = options.accessToken;
    this.userAgent = options.userAgent ?? DEFAULT_CONTROL_USER_AGENT;
    this.fetchImpl = options.fetch;
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
    // A new sign-in replaces the token, so the id of an earlier one must not
    // outlive it: revokeApiToken() would send the new token to revoke the old.
    this.tokenId = tokenIdOf(token);
    this.revokedOwn = false;
    return token;
  }

  /**
   * Exchange an authorization code for a scoped access token and store it.
   *
   * The other half of `beginNativeSignIn()`. The verifier is sent here and
   * nowhere else; it never entered the browser, which is what makes an
   * intercepted code useless to whoever intercepted it.
   *
   * A code presented twice revokes the token the first exchange minted
   * (RFC 9700), so retrying a failed exchange with the same code destroys the
   * token it is trying to obtain. Start again from `beginNativeSignIn()`.
   */
  async completeNativeSignIn(
    code: string,
    verifier: string,
    clientId: string,
    redirectUri: string,
  ): Promise<JsonRecord> {
    assertSecureTokenExchange(this.apiUrl);
    const body: JsonRecord = {
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: redirectUri,
    };
    // Both halves of the exchange are scrubbed from any error the API returns:
    // a validation body echoing the code or the verifier would otherwise land
    // in a thrown message, and an intercepted code is redeemable by anyone who
    // also has the verifier.
    const token = await this.request("POST", "/v1/auth/native/token", {
      body,
      auth: false,
      redactSecrets: [code, verifier],
      // However short, wherever they are: as a browser sign-in's exchange.
      scrub: { everywhere: true },
    });
    const accessToken = token.access_token;
    if (typeof accessToken !== "string" || !accessToken) {
      throw new ThalovantApiError("Thalovant API token response did not include access_token.");
    }
    this.accessToken = accessToken;
    this.tokenId = tokenIdOf(token);
    this.revokedOwn = false;
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
    return this.deviceLogin(options);
  }

  /**
   * Sign in through the browser, and store the API token.
   *
   * The authorization code grant with PKCE on a loopback redirect (RFC 8252):
   * the SDK listens on `127.0.0.1` on a port the system picks, opens the
   * browser at the dashboard's consent page (read from
   * `GET /v1/auth/native/config`), and waits for the browser to come back to
   * `http://127.0.0.1:<port>/callback`. The browser that approves hands the
   * code to its own computer, so a sign-in link sent to somebody on another
   * computer delivers nothing to the sender -- which a device code, read off
   * one screen and typed in anywhere, cannot promise. A forwarded callback port
   * or another user of the same computer is another matter. Node only: a web page cannot listen
   * on a port.
   *
   * The URL is always printed as well as opened (`Opening your browser to
   * sign in to Thalovant. If it does not open, visit:` and the URL); pass
   * `prompt` to present it yourself instead, and `openBrowser: false` to only
   * show it. `scopes` are what the token carries; none asks for the API's
   * default, `hubs:read` and `clients:write`. `deviceName` is what the consent
   * page and the token show.
   *
   * Resolves with the token answer and keeps its `access_token` and
   * `token_id` exactly as a device login does, so `revokeApiToken()` revokes
   * it the same way. A tab that answers with another sign-in's `state` is
   * turned away and the wait goes on. Denied in the browser rejects with
   * {@link ThalovantDeviceLoginDeniedError}; no answer within `timeoutMs`
   * (default 300000) with {@link ThalovantDeviceLoginExpiredError}; a code the
   * API will not exchange with a `ThalovantApiError` carrying its
   * `statusCode` and `detail` (`invalid_grant`). Both of the first two have
   * no `statusCode`, because the API answered neither. An API that does not
   * offer browser sign-in answers the configuration with a 404, a
   * `ThalovantApiError`: `interactiveLogin()` falls back to a device login
   * for it. An API URL that is neither https nor loopback is refused before
   * anything is asked or opened (`TypeError`, as `completeNativeSignIn()`
   * refuses it). Neither the code, the verifier, the state nor the token
   * appears in an error.
   */
  async browserLogin(options: BrowserLoginOptions = {}): Promise<JsonRecord> {
    // Before anything is asked or opened: a code and its verifier never cross
    // the network in cleartext.
    assertSecureTokenExchange(this.apiUrl);
    assertCallbacks(options);
    const timeoutMs = waitTimeout(options.timeoutMs, DEFAULT_BROWSER_LOGIN_TIMEOUT_MS);
    if (options.signal?.aborted) throw abortError();
    const config = await this.nativeSignInConfig(options.signal, signInRequestTimeout(options));
    return this.signInThroughBrowser(config, { ...options, timeoutMs });
  }

  /**
   * Sign a person in the best way this machine allows, and store the API token.
   *
   * `method: "auto"` (the default) signs in through the browser
   * (`browserLogin()`) when this machine can show one ({@link canOpenBrowser}:
   * never over SSH or in CI; on Linux only with a display) and the API answers
   * `GET /v1/auth/native/config` with a usable configuration; otherwise it
   * uses a device login (`loginWithBrowser()`), whose code can be approved
   * from any browser. A 404, another failure, an unusable answer and a
   * cleartext API URL all mean the device login, and nothing has been opened
   * by then. `"browser"` and `"device"` force one: a forced browser sign-in
   * rejects with whatever the configuration request failed with, and a forced
   * device login never asks for the configuration. Once the browser has been
   * sent to the consent page, the browser sign-in's own outcome stands: it
   * never turns into a device login.
   *
   * `deviceName` names this machine on the consent page (a device login's
   * `clientName`). `timeoutMs` defaults to each method's own: 300000 for the
   * browser, 900000 for a device login, whose own timeout error is unchanged;
   * a negative or `NaN` one is refused before anything is sent. `openUrl`
   * opens both methods' pages. Resolves with the token answer, as both
   * methods do.
   */
  async interactiveLogin(options: InteractiveLoginOptions = {}): Promise<JsonRecord> {
    const method = options.method ?? "auto";
    if (method !== "auto" && method !== "browser" && method !== "device") {
      throw new TypeError(`method must be "auto", "browser" or "device", not ${JSON.stringify(method)}.`);
    }
    assertCallbacks(options);
    // Either method's wait, checked before either starts: a NaN would never
    // reach a device login's deadline.
    waitTimeout(options.timeoutMs, 0);
    const signal = options.signal;
    if (signal?.aborted) throw abortError();
    const scopes = options.scopes ? [...options.scopes] : undefined;
    // Only a missing name asks for the default: an empty one is the caller's
    // way of sending none, and keeps the hostname out (a device login then
    // sends no client_name either).
    const name = options.deviceName ?? defaultDeviceName();
    const requestTimeoutMs = signInRequestTimeout(options);
    let config: NativeSignInConfig | undefined;
    if (method === "browser") {
      assertSecureTokenExchange(this.apiUrl);
      config = await this.nativeSignInConfig(signal, requestTimeoutMs);
    } else if (method === "auto" && canOpenBrowser()) {
      let secure = true;
      try {
        assertSecureTokenExchange(this.apiUrl);
      } catch {
        secure = false;
      }
      if (secure) {
        try {
          config = await this.nativeSignInConfig(signal, requestTimeoutMs);
        } catch (error) {
          // An older API (404), or one that cannot say: the browser has not
          // been opened, so a device login is not a downgrade.
          if (signal?.aborted || !(error instanceof ThalovantApiError)) throw error;
          config = undefined;
        }
      }
    }
    if (!config) {
      return this.deviceLogin(
        {
          scopes,
          clientName: name,
          openBrowser: options.openBrowser,
          timeoutMs: options.timeoutMs ?? DEFAULT_DEVICE_LOGIN_TIMEOUT_MS,
          openUrl: options.openUrl ?? undefined,
        },
        signal,
      );
    }
    return this.signInThroughBrowser(config, {
      scopes,
      deviceName: name,
      openBrowser: options.openBrowser,
      timeoutMs: waitTimeout(options.timeoutMs, DEFAULT_BROWSER_LOGIN_TIMEOUT_MS),
      signal,
      openUrl: options.openUrl,
      requestTimeoutMs,
    });
  }

  /** `GET /v1/auth/native/config`: where to send the browser, where to exchange the code. */
  private async nativeSignInConfig(signal: AbortSignal | undefined, timeoutMs: number): Promise<NativeSignInConfig> {
    const { response, text } = await this.signInRequest("GET", "/v1/auth/native/config", undefined, signal, timeoutMs);
    if (response.status === 404) {
      const error = apiError(response.status, text, undefined, response.headers);
      throw new ThalovantApiError(
        "This Thalovant API does not offer browser sign-in; sign in with a device login instead.",
        { statusCode: 404, problem: error.problem },
      );
    }
    if (!response.ok) throw apiError(response.status, text, undefined, response.headers);
    // A 2xx the SDK cannot use is an error with no status, as a token
    // answer's is: the API did not refuse.
    return NativeSignInConfig.fromResponse(parseJsonBody(text)?.value);
  }

  /**
   * One request of a browser sign-in, its answer read whole, within
   * `timeoutMs`.
   *
   * Bounded as the reference bounds every request (10 seconds by default).
   * The accepted tab waits for the sign-in to end with no deadline of its own,
   * so this bound is what keeps that wait finite. A
   * request that runs out of time, or whose answer breaks off, is a
   * {@link ThalovantApiUnreachableError} with no status -- `interactiveLogin()`
   * falls back from one at the configuration -- and the caller's `signal`
   * still rejects with an `AbortError`.
   */
  private async signInRequest(
    method: string,
    path: string,
    body: JsonRecord | undefined,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<{ response: Response; text: string }> {
    const bound = boundedSignal(signal, timeoutMs);
    // Enforced here as well as by fetch: a fetch that ignores its signal (a
    // caller's own), or an answer whose body never ends, must not hold the
    // sign-in -- or the accepted tab -- past the bound or a cancel.
    const ended = new Promise<never>((_, reject) => {
      const stop = (): void => reject(abortError());
      if (bound.signal.aborted) stop();
      else bound.signal.addEventListener("abort", stop, { once: true });
    });
    ended.catch(() => undefined);
    const sending = this.send(method, path, { ...(body ? { body } : {}), auth: false, signal: bound.signal });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await Promise.race([sending, ended]);
      const reading = readAnswer(response, (active) => {
        reader = active;
      });
      reading.catch(() => undefined);
      return { response, text: await Promise.race([reading, ended]) };
    } catch (error) {
      // The body being read is cancelled, so that a producer that ignores the
      // signal stops too; an answer that arrives later is let go unread.
      void reader?.cancel().catch(() => undefined);
      void sending.then(
        (late) => (late.body && !late.body.locked ? late.body.cancel().catch(() => undefined) : undefined),
        () => undefined,
      );
      if (signal?.aborted) throw abortError();
      if (bound.expired()) {
        throw new ThalovantApiUnreachableError(`The Thalovant API did not answer within ${timeoutMs / 1000} seconds.`);
      }
      if (error instanceof ThalovantApiError) throw error;
      // The answer began and broke off; nothing it said can be read.
      throw new ThalovantApiUnreachableError("The Thalovant API's answer could not be read.");
    } finally {
      bound.dispose();
    }
  }

  /** One browser sign-in against `config`: listen, open, wait, exchange, answer the tab. */
  private async signInThroughBrowser(
    config: NativeSignInConfig,
    options: BrowserLoginOptions & { timeoutMs: number },
  ): Promise<JsonRecord> {
    assertSecureTokenExchange(this.apiUrl);
    const signal = options.signal;
    if (signal?.aborted) throw abortError();
    const verifier = newVerifier();
    const state = newState();
    const listener = new LoopbackListener(state);
    // Bound before the URL is built: the redirect names the port.
    const port = await listener.start();
    try {
      const redirectUri = loopbackRedirectUri(port);
      const url = browserAuthorizationUrl(config.authorizationEndpoint, {
        clientId: config.sdkClientId,
        redirectUri,
        codeChallenge: await challengeFor(verifier),
        state,
        scopes: options.scopes,
        deviceName: options.deviceName ?? defaultDeviceName(),
      });
      // Cancelled while the port was bound or the challenge made: nothing is
      // shown or opened for a listener that is about to close.
      if (signal?.aborted) throw abortError();
      presentBrowserLogin(url, options);
      const callback = await listener.wait(options.timeoutMs, signal);
      if (!callback) {
        throw new ThalovantDeviceLoginExpiredError(
          `The browser sign-in was not completed within ${options.timeoutMs / 1000} seconds. ` +
            "Call browserLogin() again to start a new one.",
        );
      }
      if (callback.outcome === "denied") {
        throw new ThalovantDeviceLoginDeniedError("The sign-in request was denied in the browser.");
      }
      if (!callback.code) {
        // callback.error is one of RFC 6749's codes or nothing: a value the
        // page chose could be the state or a code.
        const code = callback.error ?? undefined;
        throw new ThalovantApiError(`The browser came back without a sign-in code${code ? ` (${code}).` : "."}`, { code });
      }
      // A code is single-use: retrying the exchange would only revoke the
      // token a first exchange minted (RFC 9700), so it is never retried.
      const token = await this.exchangeBrowserCode(
        config,
        { code: callback.code, verifier, redirectUri, state },
        signal,
        signInRequestTimeout(options),
      );
      listener.finish(true);
      return token;
    } finally {
      await listener.close();
    }
  }

  /**
   * `POST {token_endpoint}` with exactly the four fields, and keep the token.
   *
   * Read as a device-login token answer is: a 2xx whose body is not a JSON
   * object, or has no `access_token`, is an error with no status -- the API
   * did not refuse, its answer could not be used -- and any other failure
   * carries the api-errors fields (`invalid_grant` for every way an exchange
   * fails). The code, the verifier and the state are scrubbed from the body,
   * as sent and once decoded, so an API that echoes the request back (a 422
   * lists each field's `input`) puts none of them in the error.
   */
  private async exchangeBrowserCode(
    config: NativeSignInConfig,
    secrets: { code: string; verifier: string; redirectUri: string; state: string },
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<JsonRecord> {
    assertSecureTokenExchange(this.apiUrl);
    const body: JsonRecord = {
      code: secrets.code,
      code_verifier: secrets.verifier,
      client_id: config.sdkClientId,
      redirect_uri: secrets.redirectUri,
    };
    const { response, text } = await this.signInRequest("POST", config.tokenEndpoint, body, signal, timeoutMs);
    if (!response.ok) {
      // Every one of the three, wherever it is and however short, taken out
      // before the message is made (a message cut to length keeps no part of
      // one). The error is a new one with no cause.
      throw apiError(response.status, text, [secrets.code, secrets.verifier, secrets.state], response.headers, {
        everywhere: true,
      });
    }
    const parsed = parseJsonBody(text)?.value;
    if (!isRecord(parsed)) {
      throw new ThalovantApiError("Thalovant API returned an unexpected response shape.");
    }
    this.acceptToken(ApiToken.fromResponse(parsed));
    return parsed;
  }

  /** The device login behind `loginWithBrowser()` and `interactiveLogin()`, which can cancel it. */
  private async deviceLogin(options: LoginWithBrowserOptions, signal?: AbortSignal): Promise<JsonRecord> {
    const body: JsonRecord = {};
    // An empty list is left out, as none is: the API requires at least one
    // scope and answers [] with a 422, and a missing field asks for its default.
    if (options.scopes?.length) body.scopes = [...options.scopes];
    if (options.clientName) body.client_name = options.clientName;
    // Sent as given, an empty string included: the API refuses one (422),
    // which is better than signing in unverified in silence.
    if (options.clientId !== undefined && options.clientId !== null) body.client_id = options.clientId;
    // With a signal, every wait ends on a cancel, even with a fetch that
    // ignores its signal; without one (loginWithBrowser()), nothing changes.
    const guard = <T>(work: Promise<T>): Promise<T> => (signal ? untilAborted(work, signal) : work);
    const grant = await guard(this.request("POST", "/v1/auth/device/authorize", { body, auth: false, signal }));

    // Parsed for its checks: the fields are there, and neither URL a browser
    // is about to open carries credentials or leaves http(s).
    const authorization = DeviceAuthorization.fromGrant(grant);
    const deviceCode = authorization.deviceCode;
    const userCode = authorization.userCode;
    const verificationUri = authorization.verificationUri;
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
          const opening = (options.openUrl ?? openExternalUrl)(completeUri);
          // Only interactiveLogin() passes a signal: an opener that never
          // returns must not outlive a cancelled sign-in.
          await (signal ? untilAborted(opening, signal) : opening);
        } catch {
          if (signal?.aborted) throw abortError();
          // Browser availability is best-effort; the printed URL always works.
        }
      }
    }

    const token = await this.pollDeviceToken(deviceCode, {
      intervalMs,
      timeoutMs: options.timeoutMs ?? DEFAULT_DEVICE_LOGIN_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    // A cancelled sign-in keeps no token, however late the answer came.
    if (signal?.aborted) throw abortError();
    this.acceptToken(ApiToken.fromResponse(token));
    return token;
  }

  /**
   * Start a device sign-in (RFC 8628): a code for a person to approve in a
   * browser, one step at a time.
   *
   * For a caller that runs its own loop -- a Home Assistant config flow shows
   * the code, then polls on its own schedule. Show the person
   * `verificationUri` and `userCode` (or `verificationUriComplete`, which
   * carries the code), then call `pollDeviceLogin()` every `interval` seconds.
   * `loginWithBrowser()` runs the whole loop instead.
   */
  async beginDeviceLogin(options: DeviceLoginOptions = {}): Promise<DeviceAuthorization> {
    const body: JsonRecord = {};
    // An empty list is left out, as none is: the API requires at least one
    // scope and answers [] with a 422, and a missing field asks for its default.
    if (options.scopes?.length) body.scopes = [...options.scopes];
    if (options.clientName) body.client_name = options.clientName;
    // Sent as given, an empty string included: the API refuses one (422),
    // which is better than signing in unverified in silence.
    if (options.clientId !== undefined && options.clientId !== null) body.client_id = options.clientId;
    const grant = await this.request("POST", "/v1/auth/device/authorize", { body, auth: false });
    const authorization = DeviceAuthorization.fromGrant(grant);
    this.rememberDeviceInterval(authorization.deviceCode, authorization.interval);
    return authorization;
  }

  /**
   * Read a pending device sign-in by its `userCode`, as its approver sees it.
   *
   * `GET /v1/auth/device/codes/{userCode}`, signed in as the person who would
   * approve it. Says which app asked and whether the platform vouches for its
   * name (`clientVerified`). A code that is unknown, expired or already
   * answered is a 404 `ThalovantApiError`.
   */
  async describeDeviceLogin(userCode: string): Promise<DeviceLoginRequest> {
    const payload = await this.request("GET", `/v1/auth/device/codes/${encodeURIComponent(userCode)}`);
    return DeviceLoginRequest.fromResponse(payload);
  }

  /**
   * Ask once whether a device sign-in was approved.
   *
   * Resolves with the token and keeps it on this client (`accessToken` and
   * `tokenId`). Otherwise rejects with {@link ThalovantDeviceLoginPendingError}
   * -- poll again after its `interval`, which a `slow_down` has already
   * lengthened -- {@link ThalovantDeviceLoginExpiredError} or
   * {@link ThalovantDeviceLoginDeniedError}, all of them `ThalovantApiError`.
   * Any other failure is an ordinary `ThalovantApiError`. Neither the device
   * code nor the token ever appears in an error.
   */
  async pollDeviceLogin(authorization: DeviceAuthorization | string): Promise<ApiToken> {
    const deviceCode = typeof authorization === "string" ? authorization : authorization.deviceCode;
    if (typeof authorization !== "string" && !this.deviceIntervals.has(deviceCode)) {
      this.rememberDeviceInterval(deviceCode, authorization.interval);
    }
    const response = await this.deviceTokenOnce(deviceCode);
    const token = ApiToken.fromResponse(response);
    this.acceptToken(token);
    return token;
  }

  /**
   * Revoke an API token; by default the one this client signed in with.
   *
   * A token may always revoke itself (`DELETE /v1/auth/api-tokens/{id}`),
   * whatever its scopes. Revoking the token in use forgets it here too, so a
   * later call fails locally rather than with a 401.
   */
  async revokeApiToken(tokenId?: string): Promise<void> {
    const target = tokenId || this.tokenId;
    if (!target) {
      // Already revoked and forgotten: revoking again changes nothing, until
      // the next sign-in.
      if (this.revokedOwn && this.accessToken === undefined) return;
      throw new ThalovantApiError("No API token id to revoke: pass tokenId, or sign in with a device login first.");
    }
    const own = target === this.tokenId;
    try {
      await this.request("DELETE", `/v1/auth/api-tokens/${encodeURIComponent(target)}`);
    } catch (error) {
      // A token revoking itself that the API no longer accepts (401) is
      // already revoked -- what was asked for -- so a second sign-out, or one
      // after a revoke from the dashboard, succeeds rather than failing.
      if (!(own && error instanceof ThalovantApiError && error.statusCode === 401)) throw error;
    }
    // Forget the token only if it is still the one revoked: a sign-in that
    // finished while the revoke was on its way installed another, and that
    // one is alive.
    if (own && this.tokenId === target) {
      this.accessToken = undefined;
      this.tokenId = undefined;
      this.revokedOwn = true;
    }
  }

  private acceptToken(token: ApiToken): void {
    this.accessToken = token.accessToken;
    // Always set, never kept: an earlier sign-in's id must not outlive its token.
    this.tokenId = token.tokenId ?? undefined;
    this.revokedOwn = false;
  }

  private rememberDeviceInterval(deviceCode: string, interval: number): void {
    this.deviceIntervals.delete(deviceCode);
    this.deviceIntervals.set(deviceCode, interval);
    // A sign-in somebody walked away from is never answered, so its entry
    // would otherwise stay for the life of the process.
    while (this.deviceIntervals.size > MAX_REMEMBERED_DEVICE_CODES) {
      const oldest = this.deviceIntervals.keys().next();
      if (oldest.done) break;
      this.deviceIntervals.delete(oldest.value);
    }
  }

  /**
   * One `POST /v1/auth/device/token`: the token answer, or why there is none.
   *
   * 400 `authorization_pending` and `slow_down` are pending -- a `slow_down`
   * adds five seconds to this code's interval, for good (RFC 8628 §3.5) --
   * `expired_token` and `access_denied` end the sign-in, and anything else is
   * the API error it is.
   */
  private async deviceTokenOnce(deviceCode: string): Promise<JsonRecord> {
    const response = await this.send("POST", "/v1/auth/device/token", {
      body: { device_code: deviceCode },
      auth: false,
    });
    const text = await response.text();
    // A refusal may echo the device code; it reaches neither the message nor
    // `problem`, which is parsed from the scrubbed text.
    const parsed = parseJsonBody(text)?.value;
    if (response.ok) {
      if (!isRecord(parsed)) {
        // No status, like a 2xx that carries no token: the API did not
        // refuse, the SDK could not use its answer.
        throw new ThalovantApiError("Thalovant API returned an unexpected response shape.");
      }
      this.deviceIntervals.delete(deviceCode);
      return parsed;
    }
    // The problem the error carries is scrubbed of the device code however
    // the body spelt it; what kind of answer it is reads the body as sent.
    const scrubbed = scrubbedJsonBody(text, [deviceCode])?.value;
    const problem = isRecord(scrubbed) ? scrubbed : undefined;
    const error = response.status === 400 && isRecord(parsed) ? parsed.error : undefined;
    let interval = this.deviceIntervals.get(deviceCode) ?? DEFAULT_DEVICE_POLL_INTERVAL_SECONDS;
    if (error === "slow_down") {
      interval += DEVICE_SLOW_DOWN_STEP_MS / 1000;
      this.rememberDeviceInterval(deviceCode, interval);
    }
    if (error === "slow_down" || error === "authorization_pending") {
      throw new ThalovantDeviceLoginPendingError("The device sign-in has not been approved yet.", {
        statusCode: response.status,
        problem,
        interval,
      });
    }
    if (error === "access_denied") {
      this.deviceIntervals.delete(deviceCode);
      throw new ThalovantDeviceLoginDeniedError("The device sign-in request was denied in the browser.", {
        statusCode: response.status,
        problem,
      });
    }
    if (error === "expired_token") {
      this.deviceIntervals.delete(deviceCode);
      throw new ThalovantDeviceLoginExpiredError(
        "The device sign-in code expired before it was approved. Begin a new sign-in to get a new code.",
        { statusCode: response.status, problem },
      );
    }
    throw apiError(response.status, text, [deviceCode], response.headers);
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
    const signal = options.signal;
    const sleep = options.sleep ?? ((ms: number) => abortableSleep(ms, signal));
    const now = options.now ?? (() => Date.now());
    const deadline = now() + (options.timeoutMs ?? DEFAULT_DEVICE_LOGIN_TIMEOUT_MS);
    let waitMs = options.intervalMs ?? DEFAULT_DEVICE_POLL_INTERVAL_MS;
    for (;;) {
      if (signal?.aborted) throw abortError();
      const guard = <T>(work: Promise<T>): Promise<T> => (signal ? untilAborted(work, signal) : work);
      const response = await guard(this.send("POST", "/v1/auth/device/token", {
        body: { device_code: deviceCode },
        auth: false,
        ...(signal ? { signal } : {}),
      }));
      const text = await guard(response.text());
      const parsed = parseJsonBody(text)?.value;
      if (response.ok) {
        if (!isRecord(parsed)) {
          // No status, as for a 2xx that carries no token.
          throw new ThalovantApiError("Thalovant API returned an unexpected response shape.");
        }
        return parsed;
      }
      // An echoed device code never reaches an error: see deviceTokenOnce().
      const scrubbed = scrubbedJsonBody(text, [deviceCode])?.value;
      const problem = isRecord(scrubbed) ? scrubbed : undefined;
      const error = response.status === 400 && isRecord(parsed) ? parsed.error : undefined;
      if (error === "slow_down") {
        waitMs += DEVICE_SLOW_DOWN_STEP_MS;
      } else if (error === "access_denied") {
        throw new ThalovantDeviceLoginDeniedError("The device sign-in request was denied in the browser.", {
          statusCode: response.status,
          problem,
        });
      } else if (error === "expired_token") {
        throw new ThalovantDeviceLoginExpiredError(
          "The device sign-in code expired before it was approved. " +
            "Call loginWithBrowser() again to request a new code.", { statusCode: response.status, problem },
        );
      } else if (error !== "authorization_pending") {
        throw apiError(response.status, text, [deviceCode], response.headers);
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

  async getOperation(operationId: string, options: { signal?: AbortSignal } = {}): Promise<OperationResource> {
    return (await this.request(
      "GET",
      `/v1/operations/${encodeURIComponent(operationId)}`,
      { signal: options.signal },
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
   * pass `mode`. Unless you are a platform administrator, each image must be
   * one the platform releases for its key: a catalog pin of the stable or alpha
   * channel, the hub's current, recommended or release-policy image, or the
   * platform's default image. `listener` also accepts any tag or digest of
   * `ghcr.io/thalovant/hivemind-listener`; `preview_bridge` takes only those
   * images. The API refuses anything else with HTTP 403
   * `platform_image_required`.
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
   * Deep merge using a revision precondition, rereading after at most two conflicts.
   * A server without revision support fails before a write. No unsafe PATCH fallback.
   * Set merge:false for explicit unconditional replacement. Personas replace only when supplied.
   * Requires hubs:read and paid hubs:write for merging; replacement needs hubs:write.
   */
  async updateRuntimeGroupConfig(
    runtimeGroupId: string,
    config: JsonRecord,
    options: RuntimeGroupConfigOptions = {},
  ): Promise<JsonRecord> {
    const path = `/v1/runtime-groups/${encodeURIComponent(runtimeGroupId)}/config`;
    const body: JsonRecord = { config };
    if (options.personas !== undefined) body.personas = options.personas;
    if (options.merge === false) return this.request("PATCH", path, { body });
    // Snapshot the caller's delta before the first asynchronous operation.
    const mergeBody = JSON.parse(JSON.stringify(body, (_key, value: unknown) => {
      // JSON.stringify otherwise silently turns NaN and infinities into null.
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new ThalovantApiError("Configuration numbers must be finite.");
      }
      return value;
    })) as JsonRecord;
    assertSafeConfigNumbers(mergeBody);
    const delta = mergeBody.config as JsonRecord;
    for (let attempt = 0; ; attempt++) {
      const snapshot = await this.getRuntimeGroupConfig(runtimeGroupId);
      if (typeof snapshot.revision !== "string" || !/^[0-9a-f]{64}$/.test(snapshot.revision)
          || !isRecord(snapshot.config)) {
        throw new ThalovantApiError("Safe configuration merge requires a valid config and revision from the API.");
      }
      assertSafeConfigNumbers(snapshot.config);
      try {
        return await this.request("PUT", path, { body: {
          ...mergeBody, config: mergeConfig(snapshot.config, delta), expected_revision: snapshot.revision,
        } });
      } catch (error) {
        if (!(error instanceof ThalovantApiError) || error.statusCode !== 412 || attempt >= 2) throw error;
      }
    }
  }

  /**
   * Apply a runtime image policy and return the updated runtime group.
   *
   * Options behave like `releaseHub()`, including the platform-image rule:
   * `core` also accepts any tag or digest of `ghcr.io/thalovant/ovos-core`, and
   * `bus` takes only the images the platform releases for it.
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

  /**
   * List the skills one hub carries, with their install state.
   *
   * Where `listRuntimeGroupInventory` describes a whole runtime group, this
   * describes **one hub**. The {@link HubSkillList} envelope says where the
   * reading came from (`source`, `observed_at`, the runtime's phase and
   * message); each {@link HubSkill} row carries the requested `version`, the
   * `installed_version` and `observed_version`, the catalog's `latest_version`
   * with `update_available`, and the `state` (`pending`, `installed`,
   * `failed`, `removing`, `drifted`, `quarantined`, `unmanaged`) with the
   * runtime's last error for a failed change. A hub can carry no skills at
   * all; that is an empty `data`, not an error.
   *
   * `hubId` is the hub's id. The authenticated hub routes do not accept slugs.
   * Hub-restricted tokens are honoured.
   *
   * Requires a token with the `hubs:inspect` scope (`hubs:read` implies it).
   */
  async listHubSkills(hubId: string): Promise<HubSkillList> {
    return hubSkillListFromRecord(await this.request("GET", hubSkillsPath(hubId)));
  }

  /** Newest-first skill events/operations for the hub's shared runtime; requires hubs:inspect. */
  listHubSkillHistory(hubId: string, options: { limit?: number } = {}): Promise<JsonRecord> {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new RangeError("limit must be an integer from 1 to 200");
    }
    return this.request("GET", `${hubSkillsPath(hubId)}/history?limit=${limit}`);
  }

  /**
   * Install a skill on the hub’s shared runtime group. All hubs sharing it are affected.
   *
   * The API accepts the change with HTTP 202 and applies it live on the hub,
   * typically within about fifteen seconds and without restarting it.
   * `version` is `"latest"` (the default) or an exact `x.y.z`.
   *
   * By default this resolves as soon as the change is accepted, with
   * `state: "installing"` and the `operation_id` to poll through
   * `getOperation`. With `wait: true` it polls that operation for you, every
   * {@link DEFAULT_HUB_SKILL_POLL_INTERVAL_MS}, and resolves with
   * `state: "installed"` once the operation is `ready`; a `failed` or
   * `timed_out` operation rejects with `ThalovantApiError` carrying the
   * operation's error message, and `timeoutMs` (default 120000) without
   * convergence rejects with `ThalovantTimeoutError`.
   *
   * Installing a skill the hub already carries at another version performs
   * an update. The API answers HTTP 409 `skill_version_already_installed`
   * for the same version, HTTP 404 `hub_without_runtime_group` when the hub
   * has no runtime group yet, and HTTP 422 for an unresolvable `"latest"` or
   * an invalid version; the problem `code` is appended to the error message
   * and is the error's `code`.
   *
   * Requires a paid plan and a token with the `hubs:write` scope; the scope
   * is checked first, so a free-plan API token sees HTTP 403, never 402.
   * Hub-restricted tokens are honoured.
   */
  async installHubSkill(hubId: string, skill: string, options: HubSkillInstallOptions = {}): Promise<HubSkillOperation> {
    const accepted = hubSkillOperationFromRecord(
      await this.request("POST", hubSkillsPath(hubId), {
        body: { skill, version: options.version ?? "latest" },
      }),
    );
    if (!options.wait) return accepted;
    return this.waitForHubSkillOperation(accepted, "installed", options);
  }

  /**
   * Move a skill on the hub's shared runtime group to another version.
   *
   * `version` is required: `"latest"` or an exact `x.y.z`. The API accepts
   * with HTTP 202 and `state: "updating"`; `wait` and `timeoutMs` behave
   * exactly as in `installHubSkill`, converging on `state: "installed"`.
   *
   * Requires a paid plan and a token with the `hubs:write` scope.
   */
  async updateHubSkill(hubId: string, skill: string, options: HubSkillUpdateOptions): Promise<HubSkillOperation> {
    if (typeof options?.version !== "string" || !options.version.trim()) {
      throw new ThalovantApiError("updateHubSkill requires a version.");
    }
    const accepted = hubSkillOperationFromRecord(
      await this.request("PATCH", hubSkillPath(hubId, skill), { body: { version: options.version } }),
    );
    if (!options.wait) return accepted;
    return this.waitForHubSkillOperation(accepted, "installed", options);
  }

  /**
   * Remove a skill from the hub’s shared runtime group.
   *
   * The API accepts with HTTP 202 and `state: "removing"`; `wait` and
   * `timeoutMs` behave exactly as in `installHubSkill`, converging on
   * `state: "removed"`. The hub keeps running throughout.
   *
   * Requires a paid plan and a token with the `hubs:write` scope.
   */
  async removeHubSkill(hubId: string, skill: string, options: HubSkillWaitOptions = {}): Promise<HubSkillOperation> {
    const accepted = hubSkillOperationFromRecord(await this.request("DELETE", hubSkillPath(hubId, skill)));
    if (!options.wait) return accepted;
    return this.waitForHubSkillOperation(accepted, "removed", options);
  }

  /**
   * Poll an accepted hub skill command until its operation is terminal.
   *
   * `ready` converges to `converged`; `failed` and `timed_out` reject with
   * `ThalovantApiError`; anything else keeps polling until `timeoutMs` has
   * elapsed, then `ThalovantTimeoutError`.
   */
  private async waitForHubSkillOperation(
    accepted: HubSkillOperation,
    converged: HubSkillOperationState,
    options: HubSkillWaitOptions,
  ): Promise<HubSkillOperation> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_HUB_SKILL_WAIT_TIMEOUT_MS;
    const intervalMs = options.pollIntervalMs ?? DEFAULT_HUB_SKILL_POLL_INTERVAL_MS;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const now = options.now ?? (() => Date.now());
    const deadline = now() + timeoutMs;
    const timeoutError = () => new ThalovantTimeoutError(
      `Timed out after ${timeoutMs}ms waiting for the hub skill change (${accepted.skill}, operation ${accepted.operation_id}) to converge.`,
    );
    while (true) {
      if (now() >= deadline) throw timeoutError();
      let operation: OperationResource;
      try {
        operation = await this.getOperation(accepted.operation_id);
      } catch (error) {
        // The request layer sanitizes API errors. Native fetch/parse errors can
        // contain response previews or credential URLs and must not become causes.
        throw new ThalovantApiError(
          `Hub skill change was accepted as operation ${accepted.operation_id}, but reading its status failed.`,
          error instanceof ThalovantApiError ? { cause: error } : undefined,
        );
      }
      if (operation.status === "ready") {
        return { ...accepted, state: converged, operation };
      }
      if (TERMINAL_OPERATION_STATUSES.has(operation.status)) {
        const detail =
          operation.error_message ||
          operation.error_code ||
          `operation ${operation.id} ended with status ${operation.status}`;
        throw new ThalovantApiError(`Hub skill change for ${accepted.skill} (operation ${accepted.operation_id}) failed: ${detail}`);
      }
      const remaining = deadline - now();
      if (remaining <= 0) throw timeoutError();
      await sleep(Math.min(intervalMs, remaining));
    }
  }

  // -------------------------------------------------------------------------
  // Intercom: `/v1/hubs/{hub_id}/intercom`.
  //
  // Announce-only text spoken aloud on a hub's speakers; not a certified
  // safety system. Reads need `intercom:read`, `announce()` `intercom:send`,
  // settings and speakers `hubs:write`. The platform never stores the text.
  // Named `announce` and `*Intercom*` because the mesh already has an
  // `intercom` frame.
  // -------------------------------------------------------------------------

  /** A hub's intercom switch and whether it can be turned on. Requires `intercom:read`. */
  async getIntercomSettings(hubId: string): Promise<IntercomSettings> {
    return intercomSettingsFromRecord(await this.request("GET", intercomPath(hubId, "settings")));
  }

  /**
   * Turn a hub's intercom on or off (`PUT .../intercom/settings`). Requires
   * `hubs:write`. A plan without intercom is a {@link ThalovantPlanError}; a
   * kid or public hub is a 422 {@link ThalovantApiError}.
   */
  async setIntercomSettings(hubId: string, enabled: boolean): Promise<IntercomSettings> {
    const body = intercomSettingsBody(enabled);
    return intercomSettingsFromRecord(await this.request("PUT", intercomPath(hubId, "settings"), { body }));
  }

  /** Every client of the hub as a speaker, with presence and policy. Requires `intercom:read`. */
  async listIntercomSpeakers(hubId: string): Promise<IntercomSpeakerList> {
    return intercomSpeakersFromRecord(await this.request("GET", intercomPath(hubId, "speakers")));
  }

  /**
   * Change a speaker's policy (`PATCH .../intercom/speakers/{client_id}`); only
   * what is present is sent, and `room: null` clears the room. A speaker is
   * spoken to only when `receive` is true. Requires `hubs:write`.
   */
  async updateIntercomSpeaker(hubId: string, clientId: string, changes: IntercomSpeakerChanges): Promise<IntercomSpeaker> {
    const body = speakerUpdateBody(changes);
    const path = intercomPath(hubId, "speakers", intercomSegment(clientId, "clientId"));
    return intercomSpeakerFromRecord(await this.request("PATCH", path, { body }));
  }

  /**
   * Say `text` aloud on a hub's speakers (`POST .../intercom/announce`). The
   * text is 1-280 characters, trimmed, with no control characters, and is
   * spoken aloud in a home; the platform keeps only its hash and length.
   * Not a certified safety system.
   *
   * An urgent announcement may carry `repeat`; it is said again until somebody
   * acknowledges, and the call returns at once with status `sending`. A normal
   * one waits up to ten seconds for the hub. With `wait`, a `sending`
   * announcement is polled with {@link getAnnouncement} until it completes or
   * `waitTimeoutMs` passes (the latest answer is returned, still `sending`).
   *
   * `idempotencyKey`, when given, is sent as `Idempotency-Key`; keep it to
   * retry after an uncertain outcome without speaking twice. Requires
   * `intercom:send`. Intercom off is {@link ThalovantIntercomDisabledError}, an
   * unreachable hub {@link ThalovantHubUnreachableError}, a rate limit
   * {@link ThalovantRateLimitedError}.
   */
  async announce(hubId: string, options: AnnounceOptions): Promise<Announcement> {
    const body = announceBody(options);
    const pollMs = options.pollIntervalMs ?? 2000;
    if (typeof pollMs !== "number" || !Number.isFinite(pollMs) || pollMs <= 0) {
      throw new RangeError("pollIntervalMs must be a positive number of milliseconds.");
    }
    const headers: Record<string, string> = {};
    if (options.idempotencyKey !== undefined) {
      if (typeof options.idempotencyKey !== "string" || !options.idempotencyKey.trim()) {
        throw new TypeError("idempotencyKey must be a non-empty string when given.");
      }
      headers["Idempotency-Key"] = options.idempotencyKey;
    }
    let announcement = announcementFromRecord(
      await this.request("POST", intercomPath(hubId, "announce"), { body, headers, signal: options.signal }),
    );
    if (!options.wait || announcement.status !== "sending") return announcement;
    const repeat = body.repeat as { times: number; interval_seconds: number } | undefined;
    const timeoutMs = options.waitTimeoutMs ?? (repeat ? repeat.times * repeat.interval_seconds * 1000 : 0) + 15000;
    const deadline = Date.now() + timeoutMs;
    while (announcement.status === "sending" && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
      announcement = await this.getAnnouncement(hubId, announcement.id, options.signal);
    }
    return announcement;
  }

  /** One announcement and its deliveries; poll it while `sending`. Requires `intercom:read`. */
  async getAnnouncement(hubId: string, announcementId: string, signal?: AbortSignal): Promise<Announcement> {
    const path = intercomPath(hubId, "announcements", intercomSegment(announcementId, "announcementId"));
    return announcementFromRecord(await this.request("GET", path, { signal }));
  }

  /** A hub's announcements, newest first; continue with `next_cursor`. Requires `intercom:read`. */
  async listAnnouncements(hubId: string, options: AnnouncementListOptions = {}): Promise<AnnouncementList> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) {
      if (!Number.isInteger(options.limit) || options.limit < 1) throw new RangeError("limit must be a positive integer.");
      params.set("limit", String(options.limit));
    }
    if (options.cursor !== undefined) {
      if (typeof options.cursor !== "string" || !options.cursor.trim()) throw new TypeError("cursor must be a non-empty string when given.");
      params.set("cursor", options.cursor);
    }
    const query = params.toString();
    const path = intercomPath(hubId, "announcements");
    return announcementListFromRecord(await this.request("GET", query ? `${path}?${query}` : path));
  }

  // -------------------------------------------------------------------------
  // Chat apps: `/v1/bridges`.
  //
  // Reads need the `hubs:read` scope and writes `hubs:write`. A bridge is
  // visible to its hub's owner, the tenant's members above basic, and platform
  // administrators; anybody else gets 404. Every refusal is a
  // ThalovantApiError whose `code` says which (`bridge_token_invalid`,
  // `bridge_settings_invalid` ...) and whose `fields` names the settings or
  // secrets it is about. A token or secret is never part of an error.
  // -------------------------------------------------------------------------

  /**
   * The chat apps a bridge can connect to (`GET /v1/bridges/connectors`): each
   * one's copy, settings form (`config_schema`), the secrets it needs, what a
   * chat id looks like (`targets`), its options and its helpers. `offered`
   * says whether a bridge can be created for it now; hidden ones are left out.
   */
  async listChatAppConnectors(): Promise<ChatAppConnector[]> {
    return chatAppConnectorsFromRecord(await this.request("GET", "/v1/bridges/connectors"));
  }

  /**
   * Which networks are offered, and how many bridges the owner may add
   * (`GET /v1/bridges/networks`). With `hubId` the allowance is the hub
   * owner's (bridges count against the owner, whoever adds them); without it,
   * the caller's. Read `allowance.can_create` before `createBridge()`: a Free
   * plan allows none.
   */
  async getBridgeNetworks(options: BridgeNetworksOptions = {}): Promise<BridgeNetworks> {
    const params = new URLSearchParams();
    setStringParam(params, "hub_id", options.hubId);
    const query = params.toString();
    return bridgeNetworksFromRecord(
      await this.request("GET", query ? `/v1/bridges/networks?${query}` : "/v1/bridges/networks"),
    );
  }

  /**
   * One hub's bridges with `hubId`, or the bridges the caller may see
   * (`GET /v1/bridges`); `ownerId` narrows that to one owner's.
   *
   * One request, one answer: at most `limit` bridges (1 to 500; the API's
   * default is 200), oldest first. The route has no cursor, so a caller who
   * may see more than that gets the first `limit` and no sign of the rest;
   * pass `hubId` or `ownerId` to narrow the list.
   */
  async listBridges(options: BridgeListOptions = {}): Promise<Bridge[]> {
    const params = new URLSearchParams();
    setStringParam(params, "hub_id", options.hubId);
    setStringParam(params, "owner_id", options.ownerId);
    if (options.limit !== undefined) {
      if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 500) {
        throw new RangeError("limit must be an integer from 1 to 500");
      }
      params.set("limit", String(options.limit));
    }
    const query = params.toString();
    return bridgesFromRecord(await this.request("GET", query ? `/v1/bridges?${query}` : "/v1/bridges"));
  }

  /**
   * Connect a hub to a chat network (`POST /v1/bridges`) and return the new
   * bridge, in `setup`: nothing runs until `updateBridge()` chooses its chats.
   *
   * Pass exactly one of `token` (the connector's single secret: Telegram,
   * Discord, Mattermost) and `secrets` (every secret the connector names:
   * Matrix `access_token`; Twitch `refresh_token` and `client_secret`), as a
   * {@link SecretValue} or a plain string. `settings` are the connector's
   * non-secret settings (Matrix `homeserver`, Twitch `bot_login` and
   * `client_id`), checked against its `config_schema`.
   *
   * The API checks the token with the network where the connector can: 422
   * `bridge_token_invalid`, `bridge_token_malformed` or
   * `bridge_token_not_a_bot`; 409 `bridge_bot_in_use` when the bot already
   * serves a bridge; 422 `bridge_settings_invalid` or `bridge_secrets_invalid`
   * with `fields`; 402 on a Free plan and 403 `plan_limit` past the
   * allowance (both {@link ThalovantPlanError}).
   */
  async createBridge(options: BridgeCreateOptions): Promise<Bridge> {
    const { body, secrets } = bridgeCreateBody(options);
    return bridgeFromRecord(await this.request("POST", "/v1/bridges", { body, redactSecrets: secrets }));
  }

  /** One bridge, with its status (`GET /v1/bridges/{id}`). */
  async getBridge(bridgeId: string): Promise<Bridge> {
    return bridgeFromRecord(await this.request("GET", bridgePath(bridgeId)));
  }

  /**
   * Change a bridge (`PATCH /v1/bridges/{id}`): its chats, the mention rule,
   * the session scope, its settings, or pause it (`paused: true`) and resume
   * it (`paused: false`). Only the members set in `changes` are sent.
   *
   * The first non-empty `allowed` starts the bridge. `allowed` takes ids, or
   * `bridge.allowed` entries and `listBridgeChats()` rows as they are.
   * Pausing is always allowed; anything else needs a paid plan, and resuming
   * needs room in the plan's allowance (403 `plan_limit` otherwise).
   *
   * With `options.etag` (the bridge's `etag`) the change is sent with
   * `If-Match` and refused with HTTP 412 when the bridge changed since.
   */
  async updateBridge(bridgeId: string, changes: BridgeChanges, options: BridgeWriteOptions = {}): Promise<Bridge> {
    const body = bridgeUpdateBody(changes);
    const headers: Record<string, string> = {};
    if (typeof options.etag === "string" && options.etag) headers["If-Match"] = options.etag;
    return bridgeFromRecord(await this.request("PATCH", bridgePath(bridgeId), { body, headers }));
  }

  /**
   * Replace a bridge's token (`PUT /v1/bridges/{id}/token`), for a token the
   * network rejected (`status.reason` `TokenRejected`) or one that went
   * missing. It must belong to the same bot: another bot's token is 409
   * `bridge_token_other_bot`.
   */
  async replaceBridgeToken(bridgeId: string, token: string | SecretValue): Promise<Bridge> {
    const { body, secrets } = bridgeTokenBody(token);
    return bridgeFromRecord(
      await this.request("PUT", `${bridgePath(bridgeId)}/token`, { body, redactSecrets: secrets }),
    );
  }

  /**
   * Replace some of a bridge's secrets (`PUT /v1/bridges/{id}/secrets`); the
   * keys not sent stay as stored. Refused with 422 `bridge_secrets_invalid`
   * (and `fields`) for a key the connector does not name.
   */
  async replaceBridgeSecrets(
    bridgeId: string,
    secrets: Readonly<Record<string, string | SecretValue>>,
  ): Promise<Bridge> {
    const { body, secrets: sent } = bridgeSecretsBody(secrets);
    return bridgeFromRecord(
      await this.request("PUT", `${bridgePath(bridgeId)}/secrets`, { body, redactSecrets: sent }),
    );
  }

  /**
   * The chats the bot can see (`GET /v1/bridges/{id}/chats`), to choose from
   * for `updateBridge({ allowed })`. A connector without chat discovery
   * answers `manual_entry: true` and no rows: type the ids, checked against
   * its `targets.pattern`. Telegram refuses while the bridge runs (409
   * `bridge_running`): pause it first.
   */
  async listBridgeChats(bridgeId: string): Promise<BridgeChatList> {
    return bridgeChatListFromRecord(await this.request("GET", `${bridgePath(bridgeId)}/chats`));
  }

  /**
   * Post a "Connected to <hub>." message in an allowed chat
   * (`POST /v1/bridges/{id}/test`), in the hub's language. 409
   * `bridge_helper_unavailable` for a connector without the helper; 429
   * `bridge_rate_limited` with `retryAfterSeconds` past the per-bridge limit.
   */
  async sendBridgeTestMessage(bridgeId: string, chatId: string): Promise<BridgeTestResult> {
    return bridgeTestResultFromRecord(
      await this.request("POST", `${bridgePath(bridgeId)}/test`, { body: { chat_id: chatId } }),
    );
  }

  /**
   * The bot's picture (`GET /v1/bridges/{id}/avatar`): its bytes and content
   * type. A bot without one, or a connector without the helper, is the API's
   * 404, thrown as a {@link ThalovantApiError}.
   */
  async getBridgeAvatar(bridgeId: string): Promise<BridgeAvatar> {
    const response = await this.send("GET", `${bridgePath(bridgeId)}/avatar`, { headers: { accept: "image/*" } });
    if (!response.ok) {
      throw apiError(response.status, await response.text(), undefined, response.headers);
    }
    const content = new Uint8Array(await response.arrayBuffer());
    return { content, content_type: response.headers.get("content-type") ?? "application/octet-stream" };
  }

  /** Stop and remove a bridge (`DELETE /v1/bridges/{id}`); its stored token goes with it. */
  async deleteBridge(bridgeId: string): Promise<void> {
    await this.request("DELETE", bridgePath(bridgeId));
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
    // options.spec is caller-supplied and spread wholesale, so a legacy
    // cryptoKey in it would be sent to /v1/clients and could come back inside
    // a validation error. v3 issues no crypto key, so drop normalized legacy
    // spellings while preserving reference fields and unrelated metadata.
    const callerSpec = Object.fromEntries(Object.entries(options.spec ?? {}).filter(
      ([key]) => key.toLowerCase().replace(/[_-]/g, "") !== "cryptokey",
    ));
    const connectionType = options.connectionType;
    const spec: JsonRecord = {
      ...callerSpec,
      version: String(options.spec?.version ?? "1"),
      ...(connectionType !== undefined ? { connection_type: connectionType } : {}),
      apiKey,
      password,
      siteId,
    };
    const payload: JsonRecord = {
      hub_id: hubId,
      name: options.name,
      spec,
      active: options.active ?? true,
    };
    if (options.ownerId) payload.owner_id = options.ownerId;

    // Send POST /v1/clients directly (rather than via createClient) so the
    // generated apiKey/password/cryptoKey can be scrubbed from any thrown
    // error: this route echoes the sent spec on validation failures.
    let client: JsonRecord;
    try {
      client = await this.request("POST", "/v1/clients", {
        body: payload,
        headers: { "Idempotency-Key": options.idempotencyKey ?? randomUUID() },
        redactSecrets: [apiKey, password],
      });
    } catch (error) {
      if (connectionType !== undefined && error instanceof ThalovantApiError && refusesConnectionType(error)) {
        throw new ThalovantUnsupportedConnectionTypeError(
          `The Thalovant API cannot create a ${JSON.stringify(connectionType)} connection yet.`,
          { statusCode: error.statusCode, problem: error.problem, cause: error },
        );
      }
      throw error;
    }
    if (connectionType !== undefined) await this.requireConnectionType(client, connectionType);
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
      site_id: siteId,
      default_master: defaultMaster(hubResource, endpoints, endpoint),
      default_port: 443,
      data_plane_endpoints: endpoints.asObject(),
      protocols: protocols.asObject(),
    });
    const clientSpec = isRecord(client.spec) ? client.spec : {};
    const operation = operationOrUndefined(client.operation);
    return {
      identity,
      hub: hubResource,
      client,
      endpoint,
      selectedProtocol: endpoint?.protocol,
      clientId: typeof client.id === "string" && client.id ? client.id : undefined,
      connectionType: typeof clientSpec.connection_type === "string" ? clientSpec.connection_type : undefined,
      operation,
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
          // The endpoint can carry `user:pass@` userinfo, so the safe-to-log
          // form strips it, like the identity's own endpoints.
          selectedEndpoint: endpoint === undefined || includeSecrets ? endpoint?.endpoint : redactUrlUserinfo(endpoint.endpoint),
          operation: operation ?? null,
        };
      },
    };
  }

  /** Delete and refuse a connection the API did not make of the kind asked. */
  private async requireConnectionType(client: JsonRecord, connectionType: string): Promise<void> {
    const echoed = isRecord(client.spec) ? client.spec.connection_type : undefined;
    if (echoed === connectionType) return;
    const clientId = client.id;
    let note = "";
    if (typeof clientId === "string" && clientId) {
      try {
        await this.deleteClient(clientId, { etag: typeof client.etag === "string" ? client.etag : undefined });
      } catch (error) {
        if (!(error instanceof ThalovantApiError)) throw error;
        note = ` Deleting the connection it made instead (${clientId}) failed; remove it in the dashboard.`;
      }
    }
    const answered = typeof echoed === "string" && echoed ? JSON.stringify(echoed) : "no type";
    throw new ThalovantUnsupportedConnectionTypeError(
      `The Thalovant API did not make a ${JSON.stringify(connectionType)} connection (it answered ${answered}).${note}`,
    );
  }

  /** Fetch one client (a hub connection), with the `etag` a change needs. */
  getClient(clientId: string): Promise<JsonRecord> {
    return this.request("GET", `/v1/clients/${encodeURIComponent(clientId)}`);
  }

  /** List the clients (hub connections) visible to the caller. */
  listClients(options: ClientListOptions = {}): Promise<JsonRecord> {
    const params = new URLSearchParams({ limit: String(options.limit ?? 100) });
    setStringParam(params, "hub_id", options.hubId);
    setStringParam(params, "cursor", options.cursor);
    setStringParam(params, "owner_id", options.ownerId);
    if (options.includeSpec === false) params.set("include_spec", "false");
    return this.request("GET", `/v1/clients?${params.toString()}`);
  }

  /**
   * Delete a client (a hub connection).
   *
   * The API wants the client's current `etag` as `If-Match`. Without one this
   * reads it first, and if another writer changed the client in between (HTTP
   * 412) reads it once more and retries. A client already gone (HTTP 404, on
   * either request) counts as deleted.
   */
  async deleteClient(clientId: string, options: ClientDeleteOptions = {}): Promise<void> {
    const path = `/v1/clients/${encodeURIComponent(clientId)}`;
    let etag = options.etag ?? undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (etag === undefined) {
          const current = await this.getClient(clientId);
          if (typeof current.etag !== "string" || !current.etag) {
            throw new ThalovantApiError("Thalovant API client resource is missing etag.");
          }
          etag = current.etag;
        }
        await this.request("DELETE", path, { headers: { "If-Match": etag } });
        return;
      } catch (error) {
        if (!(error instanceof ThalovantApiError)) throw error;
        if (error.statusCode === 404) return;
        if (error.statusCode !== 412 || attempt === 1) throw error;
        etag = undefined;
      }
    }
  }

  /**
   * Wait until the hub has admitted a new connection, about ninety seconds.
   *
   * `connection` is what `createClientIdentity()` returned, or its `operation`
   * (the resource, its id, or its `links.self`). Follows the operation with
   * `GET /v1/operations/{id}`: `ready` resolves; `failed` and `timed_out`
   * reject with {@link ThalovantAdmissionFailedError} carrying the operation's
   * `error_code`; `requested`, `committed` and `applied` keep polling. No
   * operation at all, or one the API no longer tracks (HTTP 404), resolves at
   * once. A 5xx is ridden out, and so is a 429, no sooner than the wait the
   * API names (the problem's `retry_after_seconds`, else `Retry-After`, else
   * `RateLimit-Reset`); one asking for longer than is left is a timeout at
   * once. A 401 or 403 rejects with the API's own error (a
   * `ThalovantAuthError` for a token to sign in again), an API out of reach
   * with {@link ThalovantApiUnreachableError}, and any other refusal of the
   * wait with {@link ThalovantAdmissionFailedError} keeping its `statusCode`,
   * `code`, `detail` and `problem`. No read runs past the deadline. When
   * `timeoutMs` passes first it rejects with
   * {@link ThalovantAdmissionTimeoutError}, which is both a connection error
   * and a timeout: the connection may still be admitted later. A link on
   * another origin (scheme, host and port) than the API's is refused and never
   * fetched, because the token goes nowhere else.
   */
  async waitForAdmission(
    connection: BootstrapIdentityResult | OperationResource | JsonRecord | string | null | undefined,
    options: AdmissionWaitOptions = {},
  ): Promise<void> {
    const signal = options.signal;
    if (signal?.aborted) throw abortError();
    const operation = isBootstrapResult(connection) ? connection.operation : connection;
    if (operation === undefined || operation === null) return;
    const link = typeof operation === "string"
      ? operation
      : isRecord(operation) && isRecord(operation.links) ? operation.links.self : undefined;
    if (typeof link === "string" && /^[a-z][a-z0-9+.-]*:/i.test(link.trim())) {
      let foreign = true;
      try {
        foreign = new URL(link.trim()).origin !== new URL(this.apiUrl).origin;
      } catch {
        foreign = true;
      }
      if (foreign) {
        // The bearer token goes to the API's own origin and nowhere else.
        throw new ThalovantApiError("The admission operation points outside the Thalovant API.");
      }
    }
    const operationId = admissionOperationId(operation);
    const timeoutMs = options.timeoutMs ?? DEFAULT_ADMISSION_TIMEOUT_MS;
    const intervalMs = options.pollIntervalMs ?? DEFAULT_OPERATION_POLL_INTERVAL_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(intervalMs) || intervalMs < 0) {
      throw new RangeError("Admission waits need finite, non-negative durations.");
    }
    const deadline = performance.now() + timeoutMs;
    const timedOut = () => new ThalovantAdmissionTimeoutError(
      `The hub did not admit the connection within ${timeoutMs}ms; it may still admit it later.`,
    );
    for (;;) {
      let current: OperationResource | undefined;
      let retryAfterMs = 0;
      let rateLimited = false;
      // Every read is bounded by what is left of the wait: a read the API is
      // slow to answer must not carry the wait past its deadline. With
      // nothing left, no read starts at all: one aborted at once may already
      // be on the wire, and its answer would come to nobody.
      const left = deadline - performance.now();
      if (left <= 0) throw timedOut();
      const read = boundedSignal(signal, left);
      try {
        current = await this.getOperation(operationId, { signal: read.signal });
      } catch (error) {
        if (signal?.aborted) throw abortError();
        if (read.expired()) throw timedOut();
        if (!(error instanceof ThalovantApiError)) throw error;
        // The API out of reach says nothing about the hub: reported as it is.
        if (error instanceof ThalovantApiUnreachableError) throw error;
        // No longer tracked: the API keeps an operation only so long, and one
        // it has forgotten carried its connection through long ago.
        if (error.statusCode === 404) return;
        // The token, not the connection: signing in again is the way out.
        if (error.statusCode === 401 || error.statusCode === 403) throw error;
        if (error.statusCode === 429) {
          // Rate limited: ridden out like a 5xx, but no sooner than the API
          // asked -- in the body, else Retry-After, else RateLimit-Reset.
          rateLimited = true;
          retryAfterMs = (error.retryAfterSeconds ?? 0) * 1000;
        } else if (error.statusCode === undefined || error.statusCode < 500) {
          // The API refused the wait itself: what it said is kept.
          throw new ThalovantAdmissionFailedError(`The hub could not admit the connection: ${error.message}`, {
            statusCode: error.statusCode,
            code: error.code,
            detail: error.detail,
            problem: error.problem,
            cause: error,
          });
        }
      } finally {
        read.dispose();
      }
      if (current?.status === "ready") return;
      if (current && (current.status === "failed" || current.status === "timed_out")) {
        const said = current.error_message || current.error_code || "no detail";
        throw new ThalovantAdmissionFailedError(
          `The hub could not admit the connection: operation ${current.id ?? operationId} ended with status ${current.status}: ${said}`,
          { errorCode: typeof current.error_code === "string" && current.error_code ? current.error_code : undefined },
        );
      }
      const wait = Math.max(intervalMs, retryAfterMs);
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw timedOut();
      // Asked to come back after the deadline: waiting it out would only end
      // in the same timeout, later, and asking sooner would be refused again.
      if (rateLimited && wait > remaining) throw timedOut();
      await sleepAtLeast(Math.min(wait, remaining), signal);
    }
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
    options: {
      body?: JsonRecord;
      headers?: Record<string, string>;
      auth?: boolean;
      /** SDK-generated secrets sent in this request, scrubbed from any error. */
      redactSecrets?: ReadonlyArray<string | undefined>;
      /** How `redactSecrets` are taken out of an error ({@link RedactOptions}). */
      scrub?: RedactOptions;
      signal?: AbortSignal;
    } = {},
  ): Promise<JsonRecord> {
    const response = await this.send(method, path, options);
    if (!response.ok) {
      throw apiError(response.status, await response.text(), options.redactSecrets, response.headers, options.scrub);
    }
    const text = await response.text();
    if (!text.trim()) {
      return {};
    }
    let body: unknown;
    try { body = JSON.parse(text); }
    catch { throw new ThalovantApiError("Thalovant API returned invalid JSON.", { statusCode: response.status }); }
    if (!isRecord(body)) {
      throw new ThalovantApiError("Thalovant API returned an unexpected response shape.", { statusCode: response.status });
    }
    return body;
  }

  private async send(
    method: string,
    path: string,
    options: { body?: JsonRecord; headers?: Record<string, string>; auth?: boolean; signal?: AbortSignal } = {},
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
    let url: URL;
    let base: URL;
    try {
      base = new URL(this.apiUrl);
      url = new URL(path.replace(/^\/+/, ""), base);
    } catch {
      throw new ThalovantApiError("The configured control-plane API URL is invalid.");
    }
    if (url.origin !== base.origin) {
      // A path is joined to the API's address with its leading slashes taken
      // off, so `/https://elsewhere/x` -- or `/elsewhere:443/x`, whose first
      // segment reads as a scheme -- would become a URL of its own. Every
      // request this client makes, and the token on it, stays on the API's
      // origin (scheme, host and port).
      throw new ThalovantApiError("Refusing a request off the Thalovant API's origin.");
    }
    if (url.username || url.password) {
      throw new ThalovantApiError("Control-plane URLs must not include embedded credentials.");
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    // Explicit loopback HTTP remains available for local development. Login
    // bodies and bearer-authenticated requests require TLS everywhere else.
    if ((options.body || headers.authorization) && url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      throw new ThalovantApiError("Credential-bearing control-plane requests require HTTPS (except explicit loopback HTTP).");
    }
    const send = this.fetchImpl ?? globalThis.fetch;
    try {
      return await send(url, {
        method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        // 307/308 preserve password-login bodies even when fetch strips bearer
        // headers on a cross-origin redirect. Never follow API redirects.
        redirect: "error",
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (options.signal?.aborted) throw abortError();
      // Network error causes can include URLs, queries or credentials, so none
      // is kept. A redirect the SDK will not follow got an answer; anything
      // else never did, and is reported as the API being out of reach.
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
      const message = "Could not reach the Thalovant API, or the endpoint redirected the request.";
      throw cause === "unexpected redirect" ? new ThalovantApiError(message) : new ThalovantApiUnreachableError(message);
    }
  }
}

function intercomPath(hubId: string, ...rest: string[]): string {
  if (typeof hubId !== "string" || !hubId.trim()) throw new TypeError("hubId must be a non-empty string.");
  return [`/v1/hubs/${encodeURIComponent(hubId)}/intercom`, ...rest].join("/");
}

function intercomSegment(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a non-empty string.`);
  return encodeURIComponent(value);
}

function bridgePath(bridgeId: string): string {
  return `/v1/bridges/${encodeURIComponent(bridgeId)}`;
}

function newSecret(): string {
  return bytesToBase64Url(randomBytes(32));
}

function normalizeControlApiUrl(apiUrl: string): string {
  let normalized = trimTrailingSlashes((apiUrl || DEFAULT_CONTROL_API_URL).trim());
  if (normalized.endsWith("/v1")) {
    normalized = normalized.slice(0, -3);
  }
  return `${trimTrailingSlashes(normalized)}/`;
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

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
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
    return trimTrailingSlashes(endpoint);
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The error for a response the API answered with a failure status.
 *
 * Any secrets the SDK itself generated and sent (`redactSecrets`) are scrubbed
 * before a message is made of the body: from every decoded string and key of a
 * JSON body, and from the text of any other, so they reach neither the message
 * nor `problem`, however the body spelt them; a secret under 8 characters is
 * replaced only where it stands alone.
 * The body is parsed once: the message is built from it, and when it is a
 * JSON object it rides on the error whole, as `problem`, with its `code` and
 * its unshortened `detail` read out of it by the error itself.
 */
function apiError(
  status: number,
  bodyText: string,
  redactSecrets?: ReadonlyArray<string | undefined>,
  headers?: Pick<Headers, "get">,
  scrub: { everywhere?: boolean } = {},
): ThalovantApiError {
  let safeBody = bodyText;
  // Parsed with the secrets taken out -- numbers before parsing rounds them,
  // every string and key once decoded -- and no deeper than
  // MAX_REDACTED_JSON_DEPTH, so that neither the scrub nor JSON.stringify can
  // overflow on a body nested thousands of levels deep.
  const body = scrubbedJsonBody(bodyText, redactSecrets ?? [], scrub);
  if (body) {
    try {
      safeBody = JSON.stringify(body.value) ?? "";
    } catch {
      safeBody = "";
    }
  }
  // A JSON body is scrubbed once decoded, every string and key in it:
  // each JSON spelling of a secret (`\u0063` for `c`, `\/` for `/`)
  // decodes back into the secret itself. Replacing spellings in the text
  // could also cut an escape in two -- `\u0032` in front of a secret that
  // starts with `2` -- and leave a body that no longer parses.
  if (!body && redactSecrets?.length) {
    // Text: every secret and every spelling JSON gives it, in one pass, so
    // that a code overlapping a verifier cannot hide the verifier's start from
    // a second replacement; a secret under 8 characters where it stands alone
    // (anywhere, with `everywhere`).
    safeBody = redactSecretsInString(bodyText, secretSpellings(redactSecrets, scrub), scrub);
  }
  const message = apiErrorMessage(status, safeBody, body);
  const options = {
    statusCode: status,
    problem: body && isRecord(body.value) ? body.value : undefined,
    retryAfterSeconds: retryAfterHeader(headers),
  };
  const error = new ThalovantApiError(message, options);
  // The class says what kind of refusal it is; every one is a ThalovantApiError.
  if (status === 401 || status === 423 || (status === 403 && error.detail === "Insufficient scopes")) {
    // A token that is unknown, expired or revoked; a locked account; or a
    // token without the scope: signing in again is the way out of each.
    return new ThalovantAuthError(message, options);
  }
  if (status === 402 || (status === 403 && error.code === "plan_limit")) {
    return new ThalovantPlanError(message, options);
  }
  if (status === 409 && error.code === "home_assistant_already_linked") {
    return new ThalovantAlreadyLinkedError(message, { ...options, clientId: linkedClientId(error.problem) });
  }
  if (error.code === "intercom_disabled") return new ThalovantIntercomDisabledError(message, options);
  if (status === 502 && error.code === "hub_unreachable") return new ThalovantHubUnreachableError(message, options);
  if (status === 429) return new ThalovantRateLimitedError(message, options);
  return error;
}

/**
 * `Retry-After` in whole seconds, else `RateLimit-Reset`, from an answer's
 * headers. The API's own rate limiter answers a 429 in plain text with only
 * `RateLimit-Reset` (seconds until its window resets) to say how long. An
 * HTTP-date `Retry-After` is not read.
 */
function retryAfterHeader(headers: Pick<Headers, "get"> | undefined): number | undefined {
  if (!headers) return undefined;
  for (const name of ["Retry-After", "RateLimit-Reset"]) {
    let value: string | null;
    try {
      value = headers.get(name);
    } catch {
      return undefined;
    }
    const text = value?.trim() ?? "";
    if (/^\d{1,10}$/.test(text)) return Number.parseInt(text, 10);
  }
  return undefined;
}

/**
 * An answer's body as text, read through a reader that `hold` receives, so
 * that the caller can cancel it: `response.text()` locks the body where no
 * cancel can reach it. Decoded as `text()` decodes (UTF-8, a leading BOM
 * dropped). A response without a stream body -- a test double, say -- is read
 * with its own `text()`.
 */
async function readAnswer(
  response: Response,
  hold: (reader: ReadableStreamDefaultReader<Uint8Array>) => void,
): Promise<string> {
  const body = response.body as ReadableStream<Uint8Array> | null | undefined;
  if (!body || typeof body.getReader !== "function") return response.text();
  const reader = body.getReader();
  hold(reader);
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** A sign-in's wait: the caller's, or `fallback`; a number of milliseconds, never negative or `NaN`. */
function waitTimeout(timeoutMs: number | undefined, fallback: number): number {
  if (timeoutMs === undefined) return fallback;
  if (typeof timeoutMs !== "number" || Number.isNaN(timeoutMs) || timeoutMs < 0) {
    throw new RangeError(`timeoutMs must be a number of milliseconds, not ${String(timeoutMs)}.`);
  }
  return timeoutMs;
}

/**
 * How long one browser sign-in request may take, in milliseconds: 10 seconds,
 * the reference's default request timeout. The accepted tab waits for the
 * exchange, so this is also what bounds its wait.
 */
const BROWSER_SIGN_IN_REQUEST_TIMEOUT_MS = 10_000;

function signInRequestTimeout(options: { requestTimeoutMs?: number }): number {
  return waitTimeout(options.requestTimeoutMs, BROWSER_SIGN_IN_REQUEST_TIMEOUT_MS);
}

/** `prompt` and `openUrl` are functions or absent: a string in their place would be ignored without a word. */
function assertCallbacks(options: { prompt?: unknown; openUrl?: unknown }): void {
  for (const name of ["prompt", "openUrl"] as const) {
    const value = options[name];
    if (value !== undefined && value !== null && typeof value !== "function") {
      throw new TypeError(`${name} must be a function that receives the URL, not a ${typeof value}.`);
    }
  }
}

/** `value`, awaited, or an `AbortError` the moment `signal` aborts, whichever is first. */
function untilAborted<T>(value: T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
  const settled = Promise.resolve(value);
  // Observed whatever happens: an opener that rejects after the abort -- or
  // that aborted the sign-in itself -- must not leave a rejection unhandled.
  settled.catch(() => undefined);
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(abortError());
    signal.addEventListener("abort", aborted, { once: true });
    settled.then(
      (result) => {
        signal.removeEventListener("abort", aborted);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

/**
 * Show the sign-in URL -- opening a browser can fail without a word -- and
 * open it.
 *
 * The browser is opened without being waited for: a console browser can hold
 * its caller until it exits, and the listener has to be answering by then. A
 * failure to open changes nothing, because the URL was already shown.
 */
function presentBrowserLogin(
  url: string,
  options: Pick<BrowserLoginOptions, "prompt" | "openBrowser" | "openUrl" | "signal">,
): void {
  const open = options.openBrowser ?? true;
  if (options.prompt) {
    options.prompt(url);
  } else if (open) {
    console.log(`Opening your browser to sign in to Thalovant. If it does not open, visit:\n${url}`);
  } else {
    console.log(`To sign in to Thalovant, visit:\n${url}`);
  }
  if (open) {
    const opener = options.openUrl ?? openExternalUrl;
    void Promise.resolve()
      // A prompt (or anything before this turn) that cancelled the sign-in
      // opens nothing: its listener is closing.
      .then(() => (options.signal?.aborted ? undefined : opener(url)))
      .catch(() => undefined);
  }
}

/** The id a token answer names, or undefined: never an earlier token's. */
function tokenIdOf(token: JsonRecord): string | undefined {
  return typeof token.token_id === "string" && token.token_id ? token.token_id : undefined;
}

/** The connection that holds a link, as a 409 names it. */
function linkedClientId(problem: JsonRecord | undefined): string | undefined {
  if (!problem) return undefined;
  const nested = isRecord(problem.detail) ? problem.detail : {};
  for (const source of [problem, nested]) {
    for (const key of ["client_id", "existing_client_id", "connection_id"]) {
      const value = source[key];
      if (typeof value === "string" && value) return value;
    }
  }
  return undefined;
}

/**
 * A 422 whose problem is about `connection_type`.
 *
 * Read from the problem's `detail` and `code`, and from each validation
 * error's `loc` and `msg` (in its `errors` list, or FastAPI's `detail` list) --
 * never from the rest of the body. `/v1/clients` echoes what it was sent as a
 * validation error's `input`, and the request always carries
 * `spec.connection_type`, so a 422 about any other field would otherwise read
 * as the API not knowing the kind.
 */
function refusesConnectionType(error: ThalovantApiError): boolean {
  if (error.statusCode !== 422) return false;
  const said: string[] = [error.detail, error.code].filter((text): text is string => typeof text === "string");
  for (const key of ["errors", "detail"]) {
    const entries = error.problem?.[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      if (Array.isArray(entry.loc)) said.push(entry.loc.map(String).join("."));
      else if (typeof entry.loc === "string") said.push(entry.loc);
      if (typeof entry.msg === "string") said.push(entry.msg);
    }
  }
  return said.some((text) => text.includes("connection_type") || text.includes("connectionType"));
}

/** The operation a create answered with, when it is one. */
function operationOrUndefined(value: unknown): OperationResource | undefined {
  return isRecord(value) && typeof value.id === "string" && value.id ? (value as unknown as OperationResource) : undefined;
}

function isBootstrapResult(value: unknown): value is BootstrapIdentityResult {
  return isRecord(value) && value.identity instanceof ThalovantIdentity && isRecord(value.client);
}

/** The id of the operation to wait on: its `id`, or the last segment of its `links.self`. */
function admissionOperationId(operation: OperationResource | JsonRecord | string): string {
  let text: string;
  if (typeof operation === "string") {
    text = operation;
  } else {
    if (typeof operation.id === "string" && operation.id) return operation.id;
    const link = isRecord(operation.links) ? operation.links.self : undefined;
    text = typeof link === "string" ? link : "";
  }
  text = text.trim();
  const marker = "/v1/operations/";
  const at = text.lastIndexOf(marker);
  if (at >= 0) text = trimSlashes(text.slice(at + marker.length).split(/[?#]/, 1)[0]);
  if (!text) throw new ThalovantApiError("An operation needs an id to wait on.");
  // Decoded because getOperation() encodes it again; a segment that is not
  // valid percent-encoding is taken as it is.
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Throw unless `value` is safe to open in a browser: http(s), a host, and no
 * credentials or control characters anywhere in it.
 */
function assertSafeBrowserUrl(value: unknown): void {
  try {
    const authority = typeof value === "string" ? value.match(/^https?:\/\/([^/?#]*)/i)?.[1] : undefined;
    if (!authority || authority.includes("@") || /[\s\u0000-\u0020\u007f-\u009f]/u.test(String(value))) throw new Error("unsafe URL");
    const parsed = typeof value === "string" ? new URL(value) : undefined;
    if (!parsed || !["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
      throw new Error("unsafe URL");
    }
  } catch {
    throw new ThalovantApiError("Device verification URLs must use HTTP or HTTPS without embedded credentials.");
  }
}

function abortError(): Error {
  return new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Wait the whole of `ms` on the monotonic clock, never less, or reject with an
 * `AbortError` the moment `signal` aborts. A timer may fire a millisecond
 * early; it is re-armed for what is left.
 */
async function sleepAtLeast(ms: number, signal?: AbortSignal): Promise<void> {
  const end = performance.now() + ms;
  for (let left = ms; left > 0; left = end - performance.now()) {
    await abortableSleep(Math.ceil(left), signal);
  }
}

/**
 * A signal that aborts when `parent` does or when `ms` pass, whichever is
 * first; `expired()` says whether the time ran out. `dispose()` clears the
 * timer and the listener.
 */
function boundedSignal(parent: AbortSignal | undefined, ms: number): {
  signal: AbortSignal;
  expired(): boolean;
  dispose(): void;
} {
  const controller = new AbortController();
  let ranOut = false;
  const onAbort = (): void => controller.abort();
  const timer = setTimeout(() => {
    ranOut = true;
    controller.abort();
  }, Math.min(Math.max(0, Math.ceil(ms)), 2_147_483_647));
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    expired: () => ranOut,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

/** Wait `ms`, or reject with an `AbortError` the moment `signal` aborts. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * A JSON body, parsed, with each secret taken out: a number that spells one
 * before parsing can round it ({@link redactSecretsInJsonNumbers}), then every
 * decoded string and key, and anything nested deeper than
 * `MAX_REDACTED_JSON_DEPTH` dropped ({@link redactSecretsInJson}). Undefined
 * when the body is not JSON.
 */
function scrubbedJsonBody(
  text: string,
  secrets: ReadonlyArray<string | undefined>,
  scrub: RedactOptions = {},
): { value: unknown } | undefined {
  const raw = parseJsonBody(text);
  if (!raw) return undefined;
  const prepared = secrets.length ? redactSecretsInJsonNumbers(text, secrets, scrub) : text;
  const parsed = prepared === text ? raw : (parseJsonBody(prepared) ?? raw);
  return { value: redactSecretsInJson(parsed.value, secrets, scrub) };
}

/** The body parsed as JSON, boxed so a body that is `null` is still JSON; undefined when it is not JSON. */
function parseJsonBody(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

/**
 * Build a thrown-error message from an HTTP status and response body without
 * ever embedding the raw body: bodies can echo request secrets (for example
 * `POST /v1/clients` validation errors repeating the sent spec). The body text
 * is already redacted (see {@link apiError}) — before bounding, so a truncated
 * secret cannot survive. Then structured JSON keeps only a short string detail
 * field, and non-JSON bodies keep a newline-stripped snippet bounded to
 * {@link MAX_ERROR_DETAIL_LENGTH}. What the API said in full is on the error
 * itself, as `code`, `detail` and `problem`.
 */
function apiErrorMessage(status: number, bodyText: string, body: { value: unknown } | undefined): string {
  const detail = apiErrorDetail(bodyText, body);
  return detail
    ? `Thalovant API request failed with HTTP ${status}: ${detail}`
    : `Thalovant API request failed with HTTP ${status}.`;
}

function apiErrorDetail(bodyText: string, body: { value: unknown } | undefined): string {
  let detail: string | undefined;
  let code: string | undefined;
  const parsed = body?.value;
  if (isRecord(parsed)) {
    for (const key of ["detail", "error_description", "message", "error", "title", "code"]) {
      detail = detailString(parsed[key]);
      if (detail) break;
    }
    if (typeof parsed.code === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(parsed.code)) {
      code = parsed.code;
    }
  }
  // A JSON body without a recognized string detail is dropped entirely rather
  // than quoted: unknown JSON shapes are exactly where echoed secrets hide.
  // Anything that is not JSON falls through to the bounded plain-text snippet.
  const source = detail ?? (body ? "" : bodyText);
  const compact = source.replace(/\s+/g, " ").trim();
  const bounded = compact.length > MAX_ERROR_DETAIL_LENGTH
    ? `${compact.slice(0, MAX_ERROR_DETAIL_LENGTH)}…`
    : compact;
  // RFC 7807 problem bodies carry a machine-readable `code` at the root
  // (for example `skill_version_already_installed`); keep it, once, so a
  // caller can branch on it without parsing the prose.
  return code && code !== bounded ? (bounded ? `${bounded} (${code})` : `(${code})`) : bounded;
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
    for (const candidate of [value.msg, value.message, value.detail]) {
      const nested = detailString(candidate);
      if (nested) return nested;
    }
  }
  return undefined;
}

/** Objects merge recursively; arrays and scalars replace. Own keys only, including __proto__. */
function mergeConfig(base: JsonRecord, delta: JsonRecord): JsonRecord {
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(delta)])].map(key => {
    if (!Object.hasOwn(delta, key)) return [key, base[key]];
    const value = delta[key];
    return [key, Object.hasOwn(base, key) && isRecord(base[key]) && isRecord(value)
      ? mergeConfig(base[key], value) : value];
  }));
}

/** Refuse a read/merge/write that could silently round an untouched integer. */
function assertSafeConfigNumbers(value: unknown): void {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new ThalovantApiError("Configuration numbers must be finite.");
  }
  if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new ThalovantApiError("Safe configuration merge cannot preserve integers outside JavaScript's safe range; use string identifiers or a client with lossless integer support.");
  }
  if (Array.isArray(value)) value.forEach(assertSafeConfigNumbers);
  else if (isRecord(value)) Object.values(value).forEach(assertSafeConfigNumbers);
}
