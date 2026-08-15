import { ThalovantIdentityError } from "./errors.js";
import {
  defaultConfigPath as platformDefaultConfigPath,
  envVar,
  parseYamlText,
  readSecretFile,
} from "./platform/node.js";
import { HubDataPlaneEndpoints, HubProtocol, HubProtocolSettings } from "./protocols.js";
import { REDACTED, redactUrlUserinfo, withoutSecretKeys } from "./redact.js";

const DEFAULT_CONFIG_FILENAME = "config.yaml";

/**
 * Node's `util.inspect` extension point (used by `console.log`). Registered
 * through `Symbol.for`, which exists on every platform, so this file stays
 * browser-safe; browsers simply never call the method.
 */
const customInspect: unique symbol = Symbol.for("nodejs.util.inspect.custom");

export interface IdentityInput {
  accessKey?: string;
  access_key?: string;
  api_key?: string;
  key?: string;
  password?: string;
  cryptoKey?: string;
  crypto_key?: string;
  siteId?: string;
  site_id?: string;
  site?: string;
  defaultMaster?: string;
  default_master?: string;
  hub_http_host?: string;
  host?: string;
  master?: string;
  defaultPort?: number | string;
  default_port?: number | string;
  hub_http_port?: number | string;
  port?: number | string;
  defaultPath?: string;
  default_path?: string;
  hub_http_path?: string;
  path?: string;
  uri_path?: string;
  dataPlaneEndpoints?: unknown;
  data_plane_endpoints?: unknown;
  endpoints?: unknown;
  protocols?: unknown;
  spec?: unknown;
  publicKey?: string;
  public_key?: string;
  metadata?: Record<string, unknown>;
  mqtt?: unknown;
}

export interface MqttBrokerCredentialsInput {
  endpoint?: string;
  broker_url?: string;
  brokerUrl?: string;
  username?: string;
  broker_username?: string;
  brokerUsername?: string;
  password?: string;
  broker_password?: string;
  brokerPassword?: string;
  topic_prefix?: string;
  topicPrefix?: string;
  hub_id?: string;
  hubId?: string;
  c2s_topic?: string;
  c2sTopic?: string;
  s2c_topic?: string;
  s2cTopic?: string;
  status_topic?: string;
  statusTopic?: string;
  hash_topics?: boolean | string | number;
  hashTopics?: boolean | string | number;
  qos?: number | string;
  tls?: boolean | string | number;
}

/** Node-only: throws a ThalovantIdentityError in browsers. */
export function defaultConfigPath(): string {
  return platformDefaultConfigPath(DEFAULT_CONFIG_FILENAME);
}

export class MqttBrokerCredentials {
  readonly endpoint: string;
  readonly username: string;
  readonly password: string;
  readonly topicPrefix?: string;
  readonly hubId?: string;
  readonly c2sTopic?: string;
  readonly s2cTopic?: string;
  readonly statusTopic?: string;
  readonly hashTopics: boolean;
  readonly qos: number;
  readonly tls: boolean;

  constructor(input: MqttBrokerCredentialsInput) {
    this.endpoint = required(input.endpoint ?? input.broker_url ?? input.brokerUrl, "mqtt.endpoint");
    this.username = required(input.username ?? input.broker_username ?? input.brokerUsername, "mqtt.username");
    this.password = required(input.password ?? input.broker_password ?? input.brokerPassword, "mqtt.password");
    this.topicPrefix = optional(input.topic_prefix ?? input.topicPrefix);
    this.hubId = optional(input.hub_id ?? input.hubId);
    this.c2sTopic = optional(input.c2s_topic ?? input.c2sTopic);
    this.s2cTopic = optional(input.s2c_topic ?? input.s2cTopic);
    this.statusTopic = optional(input.status_topic ?? input.statusTopic);
    this.hashTopics = boolValue(input.hash_topics ?? input.hashTopics, false);
    this.qos = numberValue(input.qos, 1);
    this.tls = boolValue(input.tls, this.endpoint.startsWith("mqtts://"));
  }

  static from(input: unknown): MqttBrokerCredentials | undefined {
    if (!isRecord(input)) {
      return undefined;
    }
    try {
      return new MqttBrokerCredentials(input);
    } catch {
      return undefined;
    }
  }

  asObject(includeSecrets = false): Record<string, unknown> {
    const data: Record<string, unknown> = {
      // The broker URL can carry `user:pass@` userinfo; strip it in the
      // default view but keep the raw endpoint under includeSecrets.
      endpoint: includeSecrets ? this.endpoint : redactUrlUserinfo(this.endpoint),
      tls: this.tls,
    };
    if (includeSecrets) {
      data.username = this.username;
      data.password = this.password;
      if (this.topicPrefix) {
        data.topic_prefix = this.topicPrefix;
      }
      if (this.hubId) {
        data.hub_id = this.hubId;
      }
      if (this.c2sTopic) {
        data.c2s_topic = this.c2sTopic;
      }
      if (this.s2cTopic) {
        data.s2c_topic = this.s2cTopic;
      }
      if (this.statusTopic) {
        data.status_topic = this.statusTopic;
      }
      if (this.hashTopics) {
        data.hash_topics = true;
      }
      if (this.qos !== 1) {
        data.qos = this.qos;
      }
    }
    return data;
  }

  /**
   * Human-readable form with the broker credentials redacted. Debug/display
   * only — the transports read `username`/`password` directly, and
   * `asObject(true)` still returns the real values.
   */
  toString(): string {
    return `MqttBrokerCredentials ${JSON.stringify({
      ...this.asObject(false),
      username: REDACTED,
      password: REDACTED,
    })}`;
  }

  /** Node `console.log`/`util.inspect` print the redacted form, never secrets. */
  [customInspect](): string {
    return this.toString();
  }
}

export class ThalovantIdentity {
  readonly accessKey: string;
  readonly password: string;
  readonly defaultMaster: string;
  readonly defaultPort: number;
  readonly defaultPath: string;
  readonly siteId: string;
  readonly cryptoKey?: string;
  readonly dataPlaneEndpoints: HubDataPlaneEndpoints;
  readonly protocols: HubProtocolSettings;
  readonly publicKey?: string;
  readonly metadata: Record<string, unknown>;
  readonly mqtt?: MqttBrokerCredentials;

  constructor(input: IdentityInput) {
    this.accessKey = required(input.accessKey ?? input.access_key ?? input.api_key ?? input.key, "access_key");
    this.password = required(input.password, "password");
    this.defaultMaster = required(
      input.defaultMaster ?? input.default_master ?? input.hub_http_host ?? input.host ?? input.master,
      "default_master",
    ).replace(/\/+$/, "");
    this.siteId = required(input.siteId ?? input.site_id ?? input.site, "site_id");
    this.defaultPort = numberValue(input.defaultPort ?? input.default_port ?? input.hub_http_port ?? input.port ?? 5679);
    this.defaultPath = normalizePath(input.defaultPath ?? input.default_path ?? input.hub_http_path ?? input.path ?? input.uri_path);
    this.cryptoKey = optional(input.cryptoKey ?? input.crypto_key);
    this.dataPlaneEndpoints = HubDataPlaneEndpoints.from(input);
    this.protocols = HubProtocolSettings.from(input);
    this.publicKey = optional(input.publicKey ?? input.public_key);
    this.metadata = isRecord(input.metadata) ? { ...input.metadata } : {};
    this.mqtt = MqttBrokerCredentials.from(input.mqtt);
  }

  /** Node-only: reading identity files throws a ThalovantIdentityError in browsers. */
  static async fromFile(path: string): Promise<ThalovantIdentity> {
    const text = await readSecretFile(path, "identity file");
    try {
      return new ThalovantIdentity(JSON.parse(text) as IdentityInput);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new ThalovantIdentityError(`Identity file is not valid JSON: ${path}`);
      }
      if (error instanceof ThalovantIdentityError) {
        throw error;
      }
      throw new ThalovantIdentityError(`Unable to read identity file: ${path}`);
    }
  }

  /** Node-only: reading YAML config files throws a ThalovantIdentityError in browsers. */
  static async fromConfig(options: { path?: string; profile?: string } = {}): Promise<ThalovantIdentity> {
    const path = options.path ?? defaultConfigPath();
    const text = await readSecretFile(path, "Thalovant config file");
    let raw: unknown;
    try {
      raw = parseYamlText(text);
    } catch (error) {
      if (error instanceof ThalovantIdentityError) {
        throw error;
      }
      throw new ThalovantIdentityError(`Unable to read Thalovant config file: ${path}`);
    }
    if (!isRecord(raw)) {
      throw new ThalovantIdentityError("Thalovant config file must contain a YAML object.");
    }
    return new ThalovantIdentity(identityConfigInput(raw, options.profile));
  }

  static fromEnv(prefix = "THALOVANT_"): ThalovantIdentity {
    return new ThalovantIdentity({
      access_key: envVar(`${prefix}ACCESS_KEY`),
      password: envVar(`${prefix}PASSWORD`),
      crypto_key: envVar(`${prefix}CRYPTO_KEY`),
      site_id: envVar(`${prefix}SITE_ID`),
      default_master: envVar(`${prefix}HUB_HTTP_HOST`) ?? envVar(`${prefix}DEFAULT_MASTER`),
      default_port: envVar(`${prefix}HUB_HTTP_PORT`) ?? envVar(`${prefix}DEFAULT_PORT`),
      default_path: envVar(`${prefix}HUB_HTTP_PATH`) ?? envVar(`${prefix}DEFAULT_PATH`),
      data_plane_endpoints: {
        https: envVar(`${prefix}HUB_HTTPS_HOST`) ?? envVar(`${prefix}HUB_HTTP_HOST`),
        wss: envVar(`${prefix}HUB_WSS_HOST`) ?? envVar(`${prefix}HUB_WEBSOCKET_HOST`),
        mqtt: envVar(`${prefix}HUB_MQTT_HOST`),
      },
      mqtt: {
        endpoint: envVar(`${prefix}MQTT_ENDPOINT`) ?? envVar(`${prefix}HUB_MQTT_HOST`),
        username: envVar(`${prefix}MQTT_USERNAME`),
        password: envVar(`${prefix}MQTT_PASSWORD`),
        topic_prefix: envVar(`${prefix}MQTT_TOPIC_PREFIX`),
        hub_id: envVar(`${prefix}MQTT_HUB_ID`),
        c2s_topic: envVar(`${prefix}MQTT_C2S_TOPIC`),
        s2c_topic: envVar(`${prefix}MQTT_S2C_TOPIC`),
        status_topic: envVar(`${prefix}MQTT_STATUS_TOPIC`),
        hash_topics: envVar(`${prefix}MQTT_HASH_TOPICS`),
        qos: envVar(`${prefix}MQTT_QOS`),
      },
    });
  }

  endpointBase(): string {
    return this.dataPlaneEndpoints.httpBase(this.defaultMaster, this.defaultPort, this.defaultPath);
  }

  endpointFor(protocol: HubProtocol): string | undefined {
    if (protocol === "https") {
      return this.endpointBase();
    }
    const endpoint = this.dataPlaneEndpoints.endpointFor(protocol);
    if (endpoint) {
      return endpoint;
    }
    if (protocol === "wss" && /^wss?:\/\//i.test(this.defaultMaster)) {
      return this.defaultMaster;
    }
    return undefined;
  }

  enabledProtocols(): HubProtocol[] {
    return this.protocols.enabledProtocols();
  }

  supportsProtocol(protocol: HubProtocol): boolean {
    return this.protocols.isEnabled(protocol);
  }

  asObject(includeSecrets = false): Record<string, unknown> {
    const data: Record<string, unknown> = {
      site_id: this.siteId,
      // default_master may carry `user:pass@` userinfo; strip it in the
      // default view, keep it raw under includeSecrets.
      default_master: includeSecrets ? this.defaultMaster : redactUrlUserinfo(this.defaultMaster),
      default_port: this.defaultPort,
      default_path: this.defaultPath,
    };
    const endpoints = this.dataPlaneEndpoints.asObject({ redactCredentials: !includeSecrets });
    if (Object.keys(endpoints).length > 0) {
      data.data_plane_endpoints = endpoints;
    }
    if (Object.keys(this.metadata).length > 0) {
      // metadata is free-form; secret-named entries (nested included) are
      // dropped from the default view, but kept verbatim under includeSecrets.
      data.metadata = includeSecrets ? { ...this.metadata } : withoutSecretKeys(this.metadata);
    }
    if (includeSecrets) {
      data.access_key = this.accessKey;
      data.password = this.password;
      data.crypto_key = this.cryptoKey;
    }
    if (this.mqtt) {
      data.mqtt = this.mqtt.asObject(includeSecrets);
    }
    return data;
  }

  /**
   * Human-readable form with `access_key`, `password`, and `crypto_key`
   * redacted. Debug/display only — it never feeds the wire protocol or
   * identity-file persistence, and `asObject(true)` still returns the real
   * values. `JSON.stringify(identity)` is intentionally left untouched.
   */
  toString(): string {
    return `ThalovantIdentity ${JSON.stringify({
      ...this.asObject(false),
      access_key: REDACTED,
      password: REDACTED,
      ...(this.cryptoKey ? { crypto_key: REDACTED } : {}),
    })}`;
  }

  /** Node `console.log`/`util.inspect` print the redacted form, never secrets. */
  [customInspect](): string {
    return this.toString();
  }
}

function identityConfigInput(config: Record<string, unknown>, profile?: string): IdentityInput {
  if (isRecord(config.profiles)) {
    const profileName = profile ?? optional(config.profile ?? config.default_profile ?? config.defaultProfile) ?? "default";
    const selected = config.profiles[profileName];
    if (!isRecord(selected)) {
      throw new ThalovantIdentityError(`Missing Thalovant config profile: ${profileName}`);
    }
    return profileIdentityInput(selected);
  }
  return profileIdentityInput(config);
}

function profileIdentityInput(profile: Record<string, unknown>): IdentityInput {
  if (isRecord(profile.identity)) {
    return profile.identity as IdentityInput;
  }
  return profile as IdentityInput;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function required(value: unknown, field: string): string {
  const normalized = optional(value);
  if (!normalized) {
    throw new ThalovantIdentityError(`Missing required identity field: ${field}`);
  }
  return normalized;
}

function optional(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized || undefined;
}

function numberValue(value: unknown, fallback?: number): number {
  if ((value === null || value === undefined || value === "") && fallback !== undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    if (fallback !== undefined) {
      return fallback;
    }
    throw new ThalovantIdentityError("Identity field must be a positive integer: default_port");
  }
  return parsed;
}

function boolValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

function normalizePath(value: unknown): string {
  const normalized = optional(value)?.replace(/^\/+|\/+$/g, "");
  return normalized ? `/${normalized}` : "";
}
