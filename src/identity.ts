import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ThalovantIdentityError } from "./errors.js";
import { HubDataPlaneEndpoints, HubProtocol, HubProtocolSettings } from "./protocols.js";

const DEFAULT_CONFIG_FILENAME = "config.yaml";

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

export function defaultConfigPath(): string {
  if (process.env.XDG_CONFIG_HOME) {
    return join(process.env.XDG_CONFIG_HOME, "thalovant", DEFAULT_CONFIG_FILENAME);
  }
  if (process.platform === "win32" && process.env.APPDATA) {
    return join(process.env.APPDATA, "Thalovant", DEFAULT_CONFIG_FILENAME);
  }
  return join(homedir(), ".config", "thalovant", DEFAULT_CONFIG_FILENAME);
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
      endpoint: this.endpoint,
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

  static async fromFile(path: string): Promise<ThalovantIdentity> {
    await assertSecureIdentityFile(path);
    try {
      return new ThalovantIdentity(JSON.parse(await readFile(path, "utf8")) as IdentityInput);
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

  static async fromConfig(options: { path?: string; profile?: string } = {}): Promise<ThalovantIdentity> {
    const path = options.path ?? defaultConfigPath();
    await assertSecureConfigFile(path);
    let raw: unknown;
    try {
      raw = parseYaml(await readFile(path, "utf8"));
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
      access_key: process.env[`${prefix}ACCESS_KEY`],
      password: process.env[`${prefix}PASSWORD`],
      crypto_key: process.env[`${prefix}CRYPTO_KEY`],
      site_id: process.env[`${prefix}SITE_ID`],
      default_master: process.env[`${prefix}HUB_HTTP_HOST`] ?? process.env[`${prefix}DEFAULT_MASTER`],
      default_port: process.env[`${prefix}HUB_HTTP_PORT`] ?? process.env[`${prefix}DEFAULT_PORT`],
      default_path: process.env[`${prefix}HUB_HTTP_PATH`] ?? process.env[`${prefix}DEFAULT_PATH`],
      data_plane_endpoints: {
        https: process.env[`${prefix}HUB_HTTPS_HOST`] ?? process.env[`${prefix}HUB_HTTP_HOST`],
        wss: process.env[`${prefix}HUB_WSS_HOST`] ?? process.env[`${prefix}HUB_WEBSOCKET_HOST`],
        mqtt: process.env[`${prefix}HUB_MQTT_HOST`],
      },
      mqtt: {
        endpoint: process.env[`${prefix}MQTT_ENDPOINT`] ?? process.env[`${prefix}HUB_MQTT_HOST`],
        username: process.env[`${prefix}MQTT_USERNAME`],
        password: process.env[`${prefix}MQTT_PASSWORD`],
        topic_prefix: process.env[`${prefix}MQTT_TOPIC_PREFIX`],
        hub_id: process.env[`${prefix}MQTT_HUB_ID`],
        c2s_topic: process.env[`${prefix}MQTT_C2S_TOPIC`],
        s2c_topic: process.env[`${prefix}MQTT_S2C_TOPIC`],
        status_topic: process.env[`${prefix}MQTT_STATUS_TOPIC`],
        hash_topics: process.env[`${prefix}MQTT_HASH_TOPICS`],
        qos: process.env[`${prefix}MQTT_QOS`],
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
    return this.dataPlaneEndpoints.endpointFor(protocol);
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
      default_master: this.defaultMaster,
      default_port: this.defaultPort,
      default_path: this.defaultPath,
    };
    const endpoints = this.dataPlaneEndpoints.asObject({ redactCredentials: !includeSecrets });
    if (Object.keys(endpoints).length > 0) {
      data.data_plane_endpoints = endpoints;
    }
    if (Object.keys(this.metadata).length > 0) {
      data.metadata = { ...this.metadata };
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

async function assertSecureConfigFile(path: string): Promise<void> {
  await assertSecureSecretFile(path, "Thalovant config file");
}

async function assertSecureIdentityFile(path: string): Promise<void> {
  await assertSecureSecretFile(path, "identity file");
}

async function assertSecureSecretFile(path: string, description: string): Promise<void> {
  let mode: number;
  try {
    mode = (await stat(path)).mode & 0o777;
  } catch (error) {
    throw new ThalovantIdentityError(`Unable to read ${description}: ${path}`);
  }
  if (process.platform !== "win32" && (mode & 0o077) !== 0) {
    throw new ThalovantIdentityError(`${capitalize(description)} is too permissive: ${path}. Run \`chmod 600 ${path}\`.`);
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
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
