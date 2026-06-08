import { readFile } from "node:fs/promises";
import { ThalovantIdentityError } from "./errors.js";
import { HubDataPlaneEndpoints, HubProtocol, HubProtocolSettings } from "./protocols.js";

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
  tls?: boolean | string | number;
}

export class MqttBrokerCredentials {
  readonly endpoint: string;
  readonly username: string;
  readonly password: string;
  readonly topicPrefix?: string;
  readonly tls: boolean;

  constructor(input: MqttBrokerCredentialsInput) {
    this.endpoint = required(input.endpoint ?? input.broker_url ?? input.brokerUrl, "mqtt.endpoint");
    this.username = required(input.username ?? input.broker_username ?? input.brokerUsername, "mqtt.username");
    this.password = required(input.password ?? input.broker_password ?? input.brokerPassword, "mqtt.password");
    this.topicPrefix = optional(input.topic_prefix ?? input.topicPrefix);
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
    this.mqtt = MqttBrokerCredentials.from(input.mqtt);
  }

  static async fromFile(path: string): Promise<ThalovantIdentity> {
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

function numberValue(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
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
