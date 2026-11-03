/**
 * Chat apps: the networks a hub can answer on, and the bridges that connect it.
 *
 * A hub owner connects a chat network (Telegram, Discord; Matrix, Mattermost
 * and Twitch in beta) to a hub, and the hub answers there. The control plane
 * keeps one bridge per bot under `/v1/bridges`; the methods that call those
 * routes live on {@link ThalovantControlPlane} (`listChatAppConnectors()`,
 * `createBridge()`, `updateBridge()` ...). This module holds what they return,
 * the {@link SecretValue} a token or secret travels in, and the readers that
 * turn the API's JSON into those models.
 *
 * Every model keeps the API's own snake_case field names, as `HubSkill` does.
 * Every enumeration is open: a phase, reason or status the API adds later is
 * kept as the string it sent, never refused. Timestamps stay the strings the
 * API wrote (ISO 8601). An answer without what the SDK needs to act on -- an
 * id, an `etag`, a state, phase or reason -- is refused as an unexpected
 * answer; a member the API leaves out that only describes (a title, a time,
 * an optional link) reads as `null`, empty or its documented default.
 *
 * Browser-safe: no `node:` imports.
 */

import { ThalovantApiError } from "./errors.js";
import { REDACTED } from "./redact.js";
import type { OperationResource } from "./control.js";

type JsonRecord = Record<string, unknown>;

/** Node's `util.inspect` extension point, registered so the module stays browser-safe. */
const customInspect: unique symbol = Symbol.for("nodejs.util.inspect.custom");

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/**
 * A bot token or connector secret, kept out of every printed form.
 *
 * `String(secret)`, a template string, `JSON.stringify`, `console.log` and
 * `util.inspect` all show `[redacted]`, never the value. The value is read
 * only by {@link SecretValue.reveal}, which the SDK calls when it builds a
 * request body and nowhere else.
 *
 * `createBridge()`, `replaceBridgeToken()` and `replaceBridgeSecrets()` take a
 * `SecretValue` or a plain string; a plain string is wrapped at once.
 *
 * ```ts
 * const token = new SecretValue(process.env.TELEGRAM_BOT_TOKEN ?? "");
 * console.log(`token: ${token}`); // token: [redacted]
 * ```
 */
export class SecretValue {
  readonly #value: string;

  constructor(value: string) {
    if (typeof value !== "string") {
      // Never the value itself: it may be a secret of the wrong type.
      throw new TypeError("SecretValue wraps a string.");
    }
    this.#value = value;
    Object.freeze(this);
  }

  /** `value` itself when it already is a `SecretValue`, else a new one wrapping it. */
  static from(value: string | SecretValue): SecretValue {
    return value instanceof SecretValue ? value : new SecretValue(value);
  }

  /** The wrapped value. Use it only where the secret has to be sent. */
  reveal(): string {
    return this.#value;
  }

  /** Always `[redacted]`. */
  toString(): string {
    return REDACTED;
  }

  /** Always `[redacted]`: `JSON.stringify` never writes the value. */
  toJSON(): string {
    return REDACTED;
  }

  /** Template strings and `+` see `[redacted]`. */
  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  /** `console.log` and `util.inspect` print `[redacted]`. */
  [customInspect](): string {
    return REDACTED;
  }
}

// ---------------------------------------------------------------------------
// Enumerations: the values known today, open to the ones the API adds later.
// ---------------------------------------------------------------------------

/** Whether a connector is offered, in beta, or hidden from owners. */
export type ChatAppStatus = "offered" | "beta" | "hidden" | (string & {});
/** The built-in helpers a connector has: token check, chat discovery, test message, picture. */
export type ChatAppHelper = "validate" | "discover" | "test_message" | "avatar" | (string & {});
/** `setup` until chats are chosen, then `active`. */
export type BridgeState = "setup" | "active" | (string & {});
/** One conversation per `person`, or one shared by the whole `chat`. */
export type BridgeSessionScope = "person" | "chat" | (string & {});
/** `Setup`, then the platform's own phase. */
export type BridgePhase = "Setup" | "Pending" | "Ready" | "Degraded" | "Paused" | "Error" | (string & {});
/**
 * Why a bridge is where it is, stable and safe to show an owner:
 *
 * - `Setup`: no chats chosen yet.
 * - `Starting`: rolling out, or not reported yet.
 * - `Connected`: running.
 * - `Paused`: paused by the owner or held by the platform (see `hold`).
 * - `Unavailable`: rolled out but not running, or a platform-side error.
 * - `TokenMissing`: the stored token has not reached the bridge yet.
 * - `TokenRejected`: the network refused the bridge's credentials; replace them.
 */
export type BridgeStatusReason =
  | "Setup"
  | "Starting"
  | "Connected"
  | "Paused"
  | "Unavailable"
  | "TokenMissing"
  | "TokenRejected"
  | (string & {});
/** Where the status came from. */
export type BridgeStatusSource = "lifecycle" | "operator" | "watcher" | "unavailable" | (string & {});
/** Why the platform paused a bridge: the plan's allowance, or a suspended account. */
export type BridgeHoldReason = "plan_limit" | "account_suspended" | (string & {});

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** Text in English, and in French when the API has it. */
export interface LocalizedText {
  en: string;
  fr: string | null;
}

/** One secret a connector needs (`token`, `access_token`, `refresh_token` ...). */
export interface ChatAppSecretField {
  key: string;
  label: LocalizedText;
  description: LocalizedText | null;
  required: boolean;
}

/** What a chat id looks like on this network, and how many a bridge may answer in. */
export interface ChatAppTargets {
  label: LocalizedText;
  /** Anchored regular expression an id must match (after `strip_prefix` and `lowercase`). */
  pattern: string;
  max: number;
  /** Ids are stored lower-case (Twitch logins): fold before matching. */
  lowercase: boolean;
  /** A prefix owners type that the id does not carry (Twitch's `#`): drop it. */
  strip_prefix: string | null;
}

/** The options a connector supports. */
export interface ChatAppOptions {
  /** True when the network only answers what mentions the bot (Discord). */
  require_mention_fixed: boolean;
  session_scopes: BridgeSessionScope[];
}

/** The release new bridges of a connector run. */
export interface ChatAppRelease {
  version: string;
  released_at: string | null;
}

/** One row of `GET /v1/bridges/connectors`: a chat app a bridge can connect to. */
export interface ChatAppConnector {
  id: string;
  name: string;
  /** The console's brand-mark id. */
  mark: string;
  status: ChatAppStatus;
  description: LocalizedText;
  /** Markdown, shown as plain text. */
  setup_steps: LocalizedText;
  /** JSON Schema of the settings (`title` English, `x-title-fr` French). */
  config_schema: JsonRecord;
  secrets: ChatAppSecretField[];
  targets: ChatAppTargets;
  options: ChatAppOptions;
  helpers: ChatAppHelper[];
  /** Whether a bridge can be created for it now. */
  offered: boolean;
  version: ChatAppRelease | null;
}

/** One network of `GET /v1/bridges/networks`. */
export interface BridgeNetworkOffer {
  network: string;
  /** Whether a bridge can be created for it now. */
  offered: boolean;
  name: string | null;
  mark: string | null;
  status: ChatAppStatus | null;
}

/** How many bridges the owner may have, and whether one more can be created now. */
export interface BridgeAllowance {
  /** The hub's owner when `hubId` was given, else the caller. */
  owner_id: string;
  plan: string;
  /** False on Free: creating answers 402 whatever `limit` says. */
  paid_plan: boolean;
  limit: number;
  used: number;
  remaining: number;
  /** Whether `createBridge()` would pass the plan checks now (not the token or network checks). */
  can_create: boolean;
}

/** `GET /v1/bridges/networks`: the networks offered and the owner's allowance. */
export interface BridgeNetworks {
  networks: BridgeNetworkOffer[];
  allowance: BridgeAllowance;
}

/** The connector a bridge belongs to, and the release it was last rendered with. */
export interface BridgeConnectorRef {
  id: string;
  name: string;
  version: string | null;
}

/** The bot a bridge speaks as. */
export interface BridgeBot {
  user_id: string;
  username: string | null;
  display_name: string | null;
  /** Discord only: the application the invite link authorises. */
  application_id: string | null;
  /** The API's own address for the bot's picture; read it with `getBridgeAvatar()`. */
  avatar_url: string;
}

/** Links that add the bot to a group or open a chat with it (Telegram and Discord). */
export interface BridgeInviteLinks {
  add_to_group: string | null;
  direct_chat: string | null;
}

/** A chat the bridge answers in. */
export interface BridgeAllowedChat {
  id: string;
  title: string | null;
  kind: string | null;
  /** Discord: the server the channel belongs to. */
  guild_id: string | null;
  guild_name: string | null;
}

/** Set when the platform paused a bridge; `null` for the owner's own pause. */
export interface BridgeHold {
  reason: BridgeHoldReason;
  since: string;
}

/** Where a bridge is, in words safe to show its owner. */
export interface BridgeStatus {
  phase: BridgePhase;
  ready: boolean;
  reason: BridgeStatusReason;
  /** Platform administrators only; `null` for everybody else. */
  message: string | null;
  /** Platform administrators only; `null` for everybody else. */
  operator_reason: string | null;
  generation: number | null;
  observed_generation: number | null;
  /** True once the running bridge carries the last change; `null` in setup. */
  applied: boolean | null;
  source: BridgeStatusSource;
}

/** A bridge between a hub and a chat network. Never carries a token or secret value. */
export interface Bridge {
  id: string;
  hub_id: string;
  owner_id: string;
  network: string;
  /** `null` when the API did not say. */
  connector: BridgeConnectorRef | null;
  /** The non-secret settings (a homeserver, a bot login ...). */
  settings: JsonRecord;
  /** Which secrets are stored, by key; never their values. */
  secrets_set: string[];
  state: BridgeState;
  resource_name: string;
  bot: BridgeBot;
  /** `null` for a connector the owner adds by inviting the bot (its setup steps say how). */
  invite_links: BridgeInviteLinks | null;
  allowed: BridgeAllowedChat[];
  require_mention: boolean;
  session_scope: BridgeSessionScope;
  paused: boolean;
  hold: BridgeHold | null;
  status: BridgeStatus;
  /** Pass it as `etag` to `updateBridge()` to refuse a change on a bridge changed since. */
  etag: string;
  token_updated_at: string;
  activated_at: string | null;
  created_at: string;
  updated_at: string;
  /** The operation this write queued, when it queued one. */
  operation: OperationResource | null;
}

/** A chat the bot can see, from `listBridgeChats()`. */
export interface BridgeChat {
  id: string;
  title: string;
  kind: string;
  guild_id: string | null;
  guild_name: string | null;
  guild_icon_url: string | null;
  /** Whether the bridge already answers in it. */
  allowed: boolean;
  /** An end-to-end encrypted room the bridge cannot read. */
  encrypted: boolean;
  /** Whether it can be chosen. */
  selectable: boolean;
}

/** `GET /v1/bridges/{id}/chats`. */
export interface BridgeChatList {
  network: string;
  data: BridgeChat[];
  /** A sentence to show beside the list, when there is one. */
  note: string | null;
  /**
   * True for a connector without chat discovery (Matrix, Mattermost, Twitch):
   * `data` is empty and the owner types the ids, checked against the
   * connector's `targets.pattern`.
   */
  manual_entry: boolean;
}

/** `POST /v1/bridges/{id}/test`. */
export interface BridgeTestResult {
  sent: boolean;
  chat_id: string;
  /** The language the message was posted in: the hub's, else English. */
  language: string;
}

/** The bot's picture, as the API serves it. */
export interface BridgeAvatar {
  content: Uint8Array;
  content_type: string;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * A chat to answer in. `bridge.allowed` entries and `listBridgeChats()` rows
 * both fit; only `id`, `title`, `kind`, `guild_id` and `guild_name` are sent.
 */
export interface BridgeAllowedChatInput {
  id: string;
  title?: string | null;
  kind?: string | null;
  guild_id?: string | null;
  guild_name?: string | null;
}

/** Options for `createBridge()`. Exactly one of `token` and `secrets`. */
export interface BridgeCreateOptions {
  /** Sent as `hub_id`. */
  hubId: string;
  /** The connector id from `listChatAppConnectors()`: `telegram`, `discord`, `matrix` ... */
  connector: string;
  /** The connector's single `token` secret (Telegram, Discord, Mattermost). */
  token?: string | SecretValue;
  /** Every secret the connector names (Matrix `access_token`; Twitch `refresh_token`, `client_secret`). */
  secrets?: Readonly<Record<string, string | SecretValue>>;
  /** Non-secret settings, checked against the connector's `config_schema`. */
  settings?: JsonRecord;
}

/** Options for `listBridges()`. */
export interface BridgeListOptions {
  /** Sent as `hub_id`: one hub's bridges. */
  hubId?: string;
  /** Sent as `owner_id`: narrows the bridges the caller may see to one owner's. */
  ownerId?: string;
  /** 1 to 500; the API's default is 200. */
  limit?: number;
}

/** Options for `getBridgeNetworks()`. */
export interface BridgeNetworksOptions {
  /** Sent as `hub_id`: the allowance is then the hub owner's, not the caller's. */
  hubId?: string;
}

/** What `updateBridge()` changes. Only the members set are sent. */
export interface BridgeChanges {
  /** The chats to answer in; never empty. The first non-empty list starts the bridge. */
  allowed?: ReadonlyArray<string | BridgeAllowedChatInput>;
  /** Sent as `require_mention`. */
  requireMention?: boolean;
  /** Sent as `session_scope`. */
  sessionScope?: BridgeSessionScope;
  /** `true` pauses, `false` resumes. */
  paused?: boolean;
  /** Settings to change, merged into the stored ones. */
  settings?: JsonRecord;
}

/** Options for `updateBridge()`. */
export interface BridgeWriteOptions {
  /** The bridge's `etag`, sent as `If-Match`: a bridge changed since fails with HTTP 412. */
  etag?: string;
}

// ---------------------------------------------------------------------------
// Request bodies (package-internal)
// ---------------------------------------------------------------------------

/** @internal A request body and the secret values in it, for scrubbing from any error. */
export interface SecretBody {
  body: JsonRecord;
  secrets: string[];
}

/** @internal The body of `POST /v1/bridges`. */
export function bridgeCreateBody(options: BridgeCreateOptions): SecretBody {
  if (!isRecord(options)) throw new ThalovantApiError("createBridge needs hubId and connector.");
  if (typeof options.hubId !== "string" || !options.hubId.trim()) {
    throw new ThalovantApiError("createBridge needs a hubId.");
  }
  if (typeof options.connector !== "string" || !options.connector.trim()) {
    throw new ThalovantApiError("createBridge needs a connector.");
  }
  const hasToken = options.token !== undefined && options.token !== null;
  const hasSecrets = options.secrets !== undefined && options.secrets !== null && Object.keys(options.secrets).length > 0;
  if (hasToken && hasSecrets) {
    throw new ThalovantApiError("createBridge takes token or secrets, not both.");
  }
  if (!hasToken && !hasSecrets) {
    throw new ThalovantApiError("createBridge needs the connector's token or secrets.");
  }
  const body: JsonRecord = { hub_id: options.hubId, connector: options.connector };
  const sent: string[] = [];
  if (hasToken) {
    const token = secretOf(options.token, "token").reveal();
    body.token = token;
    sent.push(token);
  } else {
    const secrets = secretValues(options.secrets, "createBridge");
    body.secrets = secrets;
    sent.push(...Object.values(secrets));
  }
  if (options.settings !== undefined) body.settings = settingsOf(options.settings);
  return { body, secrets: sent };
}

/** @internal The body of `PUT /v1/bridges/{id}/token`. */
export function bridgeTokenBody(token: string | SecretValue): SecretBody {
  if (token === undefined || token === null) throw new ThalovantApiError("replaceBridgeToken needs a token.");
  const value = secretOf(token, "token").reveal();
  return { body: { token: value }, secrets: [value] };
}

/** @internal The body of `PUT /v1/bridges/{id}/secrets`. */
export function bridgeSecretsBody(secrets: Readonly<Record<string, string | SecretValue>>): SecretBody {
  const values = secretValues(secrets, "replaceBridgeSecrets");
  return { body: { secrets: values }, secrets: Object.values(values) };
}

/** @internal The body of `PATCH /v1/bridges/{id}`: only the members the caller set. */
export function bridgeUpdateBody(changes: BridgeChanges): JsonRecord {
  if (!isRecord(changes)) throw new ThalovantApiError("updateBridge needs the changes to make.");
  const body: JsonRecord = {};
  if (changes.allowed !== undefined) {
    if (!Array.isArray(changes.allowed)) throw new ThalovantApiError("allowed is a list of chats.");
    body.allowed = changes.allowed.map(allowedChatBody);
  }
  if (changes.requireMention !== undefined) body.require_mention = changes.requireMention;
  if (changes.sessionScope !== undefined) body.session_scope = changes.sessionScope;
  if (changes.paused !== undefined) body.paused = changes.paused;
  if (changes.settings !== undefined) body.settings = settingsOf(changes.settings);
  return body;
}

function allowedChatBody(chat: string | BridgeAllowedChatInput): JsonRecord {
  if (typeof chat === "string") return { id: chat };
  if (!isRecord(chat) || typeof chat.id !== "string") {
    throw new ThalovantApiError("Each allowed chat is an id or an object with an id.");
  }
  const entry: JsonRecord = { id: chat.id };
  for (const key of ["title", "kind", "guild_id", "guild_name"] as const) {
    const value = chat[key];
    if (value !== undefined && value !== null) entry[key] = value;
  }
  return entry;
}

function settingsOf(settings: unknown): JsonRecord {
  if (!isRecord(settings)) throw new ThalovantApiError("settings is an object of setting names to values.");
  return { ...settings };
}

/** A string or `SecretValue`, wrapped; anything else refused without printing it. */
function secretOf(value: unknown, name: string): SecretValue {
  if (value instanceof SecretValue) return value;
  if (typeof value === "string") return new SecretValue(value);
  throw new ThalovantApiError(`${name} must be a string or a SecretValue.`);
}

function secretValues(secrets: unknown, method: string): Record<string, string> {
  if (!isRecord(secrets) || Object.keys(secrets).length === 0) {
    throw new ThalovantApiError(`${method} needs at least one secret.`);
  }
  // Own data properties whatever the key, `__proto__` included. The key is a
  // name the connector publishes, never a value: safe to say in a refusal.
  return Object.fromEntries(
    Object.entries(secrets).map(([key, value]) => [key, secretOf(value, `secret ${JSON.stringify(key)}`).reveal()]),
  );
}

// ---------------------------------------------------------------------------
// Readers (package-internal)
// ---------------------------------------------------------------------------

/** @internal `{data: [...]}` of `GET /v1/bridges/connectors`. */
export function chatAppConnectorsFromRecord(payload: JsonRecord): ChatAppConnector[] {
  return envelopeRows(payload, "chat app connector").map(chatAppConnectorFromRecord);
}

/** @internal One connector. */
export function chatAppConnectorFromRecord(value: JsonRecord): ChatAppConnector {
  const what = "chat app connector";
  const version = isRecord(value.version) ? value.version : null;
  return {
    id: text(value, "id", what),
    name: text(value, "name", what),
    mark: optionalText(value.mark) ?? "",
    status: text(value, "status", what),
    description: localized(value.description, "description", what),
    setup_steps: localized(value.setup_steps, "setup_steps", what),
    config_schema: isRecord(value.config_schema) ? { ...value.config_schema } : {},
    secrets: records(value.secrets).map(secretFieldFromRecord),
    targets: targetsFromRecord(record(value.targets, "targets", what)),
    options: optionsFromRecord(isRecord(value.options) ? value.options : {}),
    helpers: strings(value.helpers),
    offered: value.offered === true,
    version: version ? { version: text(version, "version", "chat app release"), released_at: optionalText(version.released_at) } : null,
  };
}

function secretFieldFromRecord(value: JsonRecord): ChatAppSecretField {
  const what = "chat app secret";
  return {
    key: text(value, "key", what),
    label: localized(value.label, "label", what),
    description: isRecord(value.description) ? localized(value.description, "description", what) : null,
    required: value.required !== false,
  };
}

function targetsFromRecord(value: JsonRecord): ChatAppTargets {
  const what = "chat app targets";
  return {
    label: localized(value.label, "label", what),
    pattern: text(value, "pattern", what),
    max: wholeNumber(value.max) ?? 0,
    lowercase: value.lowercase === true,
    strip_prefix: optionalText(value.strip_prefix),
  };
}

function optionsFromRecord(value: JsonRecord): ChatAppOptions {
  return {
    require_mention_fixed: value.require_mention_fixed === true,
    session_scopes: Array.isArray(value.session_scopes) ? strings(value.session_scopes) : ["person", "chat"],
  };
}

/** @internal `GET /v1/bridges/networks`. */
export function bridgeNetworksFromRecord(payload: JsonRecord): BridgeNetworks {
  const what = "bridge networks answer";
  if (!Array.isArray(payload.networks)) {
    throw new ThalovantApiError(`Thalovant API returned a ${what} without networks.`);
  }
  const allowance = record(payload.allowance, "allowance", what);
  return {
    networks: records(payload.networks).map((offer) => ({
      network: text(offer, "network", "bridge network"),
      offered: offer.offered === true,
      name: optionalText(offer.name),
      mark: optionalText(offer.mark),
      status: optionalText(offer.status),
    })),
    allowance: {
      owner_id: text(allowance, "owner_id", "bridge allowance"),
      plan: optionalText(allowance.plan) ?? "",
      paid_plan: allowance.paid_plan === true,
      limit: wholeNumber(allowance.limit) ?? 0,
      used: wholeNumber(allowance.used) ?? 0,
      remaining: wholeNumber(allowance.remaining) ?? 0,
      can_create: allowance.can_create === true,
    },
  };
}

/** @internal `{data: [...]}` of `GET /v1/bridges`. */
export function bridgesFromRecord(payload: JsonRecord): Bridge[] {
  return envelopeRows(payload, "bridge").map(bridgeFromRecord);
}

/** @internal One bridge. */
export function bridgeFromRecord(value: JsonRecord): Bridge {
  const what = "bridge";
  const connector = isRecord(value.connector) ? value.connector : null;
  const invite = isRecord(value.invite_links) ? value.invite_links : null;
  const hold = isRecord(value.hold) ? value.hold : null;
  const bot = record(value.bot, "bot", what);
  const status = record(value.status, "status", what);
  return {
    id: text(value, "id", what),
    hub_id: text(value, "hub_id", what),
    owner_id: text(value, "owner_id", what),
    network: text(value, "network", what),
    connector: connector
      ? {
          id: text(connector, "id", "bridge connector"),
          name: text(connector, "name", "bridge connector"),
          version: optionalText(connector.version),
        }
      : null,
    settings: isRecord(value.settings) ? { ...value.settings } : {},
    secrets_set: strings(value.secrets_set),
    state: text(value, "state", what),
    resource_name: optionalText(value.resource_name) ?? "",
    bot: {
      user_id: text(bot, "user_id", "bridge bot"),
      username: optionalText(bot.username),
      display_name: optionalText(bot.display_name),
      application_id: optionalText(bot.application_id),
      avatar_url: optionalText(bot.avatar_url) ?? "",
    },
    invite_links: invite
      ? { add_to_group: optionalText(invite.add_to_group), direct_chat: optionalText(invite.direct_chat) }
      : null,
    allowed: records(value.allowed).map(allowedChatFromRecord),
    require_mention: value.require_mention === true,
    session_scope: text(value, "session_scope", what),
    paused: value.paused === true,
    hold: hold ? { reason: text(hold, "reason", "bridge hold"), since: optionalText(hold.since) ?? "" } : null,
    status: {
      phase: text(status, "phase", "bridge status"),
      ready: status.ready === true,
      reason: text(status, "reason", "bridge status"),
      message: optionalText(status.message),
      operator_reason: optionalText(status.operator_reason),
      generation: wholeNumber(status.generation),
      observed_generation: wholeNumber(status.observed_generation),
      applied: typeof status.applied === "boolean" ? status.applied : null,
      source: text(status, "source", "bridge status"),
    },
    etag: text(value, "etag", what),
    token_updated_at: optionalText(value.token_updated_at) ?? "",
    activated_at: optionalText(value.activated_at),
    created_at: optionalText(value.created_at) ?? "",
    updated_at: optionalText(value.updated_at) ?? "",
    operation: isRecord(value.operation) && typeof value.operation.id === "string" && value.operation.id
      ? (value.operation as unknown as OperationResource)
      : null,
  };
}

function allowedChatFromRecord(value: JsonRecord): BridgeAllowedChat {
  return {
    id: text(value, "id", "allowed chat"),
    title: optionalText(value.title),
    kind: optionalText(value.kind),
    guild_id: optionalText(value.guild_id),
    guild_name: optionalText(value.guild_name),
  };
}

/** @internal `GET /v1/bridges/{id}/chats`. */
export function bridgeChatListFromRecord(payload: JsonRecord): BridgeChatList {
  return {
    network: text(payload, "network", "bridge chat list"),
    data: envelopeRows(payload, "bridge chat").map((chat) => ({
      id: text(chat, "id", "bridge chat"),
      title: optionalText(chat.title) ?? "",
      kind: optionalText(chat.kind) ?? "",
      guild_id: optionalText(chat.guild_id),
      guild_name: optionalText(chat.guild_name),
      guild_icon_url: optionalText(chat.guild_icon_url),
      allowed: chat.allowed === true,
      encrypted: chat.encrypted === true,
      selectable: chat.selectable !== false,
    })),
    note: optionalText(payload.note),
    manual_entry: payload.manual_entry === true,
  };
}

/** @internal `POST /v1/bridges/{id}/test`. */
export function bridgeTestResultFromRecord(payload: JsonRecord): BridgeTestResult {
  return {
    sent: payload.sent === true,
    chat_id: text(payload, "chat_id", "bridge test result"),
    language: optionalText(payload.language) || "en",
  };
}

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

function envelopeRows(payload: JsonRecord, what: string): JsonRecord[] {
  if (!Array.isArray(payload.data)) {
    throw new ThalovantApiError(`Thalovant API returned an unexpected ${what} listing shape.`);
  }
  return records(payload.data);
}

/** A string the API must send, non-empty; anything else is an unexpected answer. */
function text(values: JsonRecord, key: string, what: string): string {
  const value = values[key];
  if (typeof value !== "string" || !value) {
    throw new ThalovantApiError(`Thalovant API returned a ${what} without ${key}.`);
  }
  return value;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function record(value: unknown, key: string, what: string): JsonRecord {
  if (!isRecord(value)) throw new ThalovantApiError(`Thalovant API returned a ${what} without ${key}.`);
  return value;
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function localized(value: unknown, key: string, what: string): LocalizedText {
  const entry = record(value, key, what);
  if (typeof entry.en !== "string") throw new ThalovantApiError(`Thalovant API returned a ${what} without ${key}.en.`);
  return { en: entry.en, fr: optionalText(entry.fr) };
}

/** A whole number within 2**53, or null. */
function wholeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
