import { readFile } from "node:fs/promises";
import { ThalovantIdentityError } from "./errors.js";

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
  publicKey?: string;
  public_key?: string;
}

export class ThalovantIdentity {
  readonly accessKey: string;
  readonly password: string;
  readonly defaultMaster: string;
  readonly defaultPort: number;
  readonly defaultPath: string;
  readonly siteId: string;
  readonly cryptoKey?: string;
  readonly publicKey?: string;

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
    this.publicKey = optional(input.publicKey ?? input.public_key);
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
    });
  }

  endpointBase(): string {
    const master = this.defaultMaster.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
    try {
      const url = new URL(master);
      if (!url.port) {
        url.port = String(this.defaultPort);
      }
      const path = [url.pathname, this.defaultPath]
        .map(part => part.replace(/^\/+|\/+$/g, ""))
        .filter(Boolean)
        .join("/");
      url.pathname = path ? `/${path}` : "";
      url.search = "";
      url.hash = "";
      return url.toString().replace(/\/$/, "");
    } catch {
      return `${master.replace(/\/+$/, "")}:${this.defaultPort}${this.defaultPath}`;
    }
  }

  asObject(includeSecrets = false): Record<string, unknown> {
    const data: Record<string, unknown> = {
      site_id: this.siteId,
      default_master: this.defaultMaster,
      default_port: this.defaultPort,
      default_path: this.defaultPath,
    };
    if (includeSecrets) {
      data.access_key = this.accessKey;
      data.password = this.password;
      data.crypto_key = this.cryptoKey;
    }
    return data;
  }
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

function normalizePath(value: unknown): string {
  const normalized = optional(value)?.replace(/^\/+|\/+$/g, "");
  return normalized ? `/${normalized}` : "";
}
