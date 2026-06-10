export type HubProtocol = "wss" | "https" | "mqtt";
export const DEFAULT_PROTOCOL_PREFERENCE: HubProtocol[] = ["wss", "https", "mqtt"];

type UnknownRecord = Record<string, unknown>;

export interface SelectedHubEndpoint {
  protocol: HubProtocol;
  endpoint: string;
}

export class HubProtocolSettings {
  readonly wss: boolean;
  readonly http: boolean;
  readonly mqtt: boolean;

  constructor(input: { wss?: boolean; http?: boolean; mqtt?: boolean } = {}) {
    this.wss = input.wss ?? true;
    this.http = input.http ?? false;
    this.mqtt = input.mqtt ?? false;
  }

  static from(input: unknown): HubProtocolSettings {
    if (!isRecord(input)) {
      return new HubProtocolSettings();
    }
    const spec = recordValue(input, "spec") ?? input;
    const protocols = recordValue(spec, "protocols") ?? {};
    const network = recordValue(spec, "network") ?? {};
    return new HubProtocolSettings({
      wss: enabledValue(firstValue(protocols, "wss", "websocket") ?? firstValue(network, "wss", "websocket"), true),
      http: enabledValue(firstValue(protocols, "http", "https") ?? firstValue(network, "http", "https"), false),
      mqtt: enabledValue(firstValue(protocols, "mqtt") ?? firstValue(network, "mqtt"), false),
    });
  }

  get https(): boolean {
    return this.http;
  }

  enabledProtocols(): HubProtocol[] {
    const enabled: HubProtocol[] = [];
    if (this.wss) enabled.push("wss");
    if (this.http) enabled.push("https");
    if (this.mqtt) enabled.push("mqtt");
    return enabled;
  }

  isEnabled(protocol: HubProtocol): boolean {
    if (protocol === "wss") return this.wss;
    if (protocol === "https") return this.http;
    return this.mqtt;
  }

  asObject(): Record<string, { enabled: boolean }> {
    return {
      wss: { enabled: this.wss },
      http: { enabled: this.http },
      mqtt: { enabled: this.mqtt },
    };
  }
}

export class HubDataPlaneEndpoints {
  readonly https?: string;
  readonly wss?: string;
  readonly mqtt?: string;

  constructor(input: { https?: string; wss?: string; mqtt?: string } = {}) {
    this.https = normalizeEndpoint(input.https);
    this.wss = normalizeEndpoint(input.wss);
    this.mqtt = normalizeEndpoint(input.mqtt);
  }

  static from(input: unknown): HubDataPlaneEndpoints {
    if (!isRecord(input)) {
      return new HubDataPlaneEndpoints();
    }
    const source =
      recordValue(input, "data_plane_endpoints")
      ?? recordValue(input, "dataPlaneEndpoints")
      ?? recordValue(input, "endpoints")
      ?? input;
    return new HubDataPlaneEndpoints({
      https: optional(firstValue(source, "https", "http")),
      wss: optional(firstValue(source, "wss", "ws")),
      mqtt: optional(firstValue(source, "mqtt", "mqtts")),
    });
  }

  static fromHub(hub: UnknownRecord): HubDataPlaneEndpoints {
    const endpoints = HubDataPlaneEndpoints.from(hub);
    const protocols = HubProtocolSettings.from(hub);
    const domain = optional(hub.domain);
    if (!domain) {
      return endpoints;
    }
    return new HubDataPlaneEndpoints({
      https: endpoints.https ?? (protocols.http ? endpointFromDomain(domain, "https") : undefined),
      wss: endpoints.wss ?? (protocols.wss ? endpointFromDomain(domain, "wss") : undefined),
      mqtt: endpoints.mqtt,
    });
  }

  endpointFor(protocol: HubProtocol): string | undefined {
    if (protocol === "https") return this.https;
    if (protocol === "wss") return this.wss;
    return this.mqtt;
  }

  httpBase(fallbackMaster: string, fallbackPort: number, fallbackPath: string): string {
    if (this.https) {
      return endpointBase(this.https, fallbackPort, "");
    }
    const master = coerceScheme(fallbackMaster, { "wss://": "https://", "ws://": "http://" });
    return endpointBase(master, fallbackPort, fallbackPath);
  }

  asObject(options: { redactCredentials?: boolean } = {}): Record<string, string> {
    const data: Record<string, string> = {};
    for (const [key, value] of Object.entries({ https: this.https, wss: this.wss, mqtt: this.mqtt })) {
      if (value) {
        data[key] = options.redactCredentials ? redactCredentials(value) : value;
      }
    }
    return data;
  }
}

export function selectDataPlaneEndpoint(
  endpoints: HubDataPlaneEndpoints,
  protocols: HubProtocolSettings,
  preferredProtocols: readonly HubProtocol[] = DEFAULT_PROTOCOL_PREFERENCE,
): SelectedHubEndpoint | undefined {
  for (const protocol of preferredProtocols) {
    if (!protocols.isEnabled(protocol)) continue;
    const endpoint = endpoints.endpointFor(protocol);
    if (endpoint) return { protocol, endpoint };
  }
  return undefined;
}

export function endpointFromDomain(domain: string, protocol: HubProtocol): string {
  const normalized = domain.trim().replace(/\/+$/, "");
  if (protocol === "wss") {
    if (/^wss?:\/\//i.test(normalized)) return normalizeEndpoint(normalized) ?? "";
    if (/^https?:\/\//i.test(normalized)) {
      return normalizeEndpoint(normalized.replace(/^https?:\/\//i, "wss://")) ?? "";
    }
    return normalizeEndpoint(`wss://${normalized}`) ?? "";
  }
  if (protocol === "https") {
    if (/^https?:\/\//i.test(normalized)) {
      return normalizeEndpoint(normalized.replace(/^http:\/\//i, "https://")) ?? "";
    }
    if (/^wss?:\/\//i.test(normalized)) {
      return normalizeEndpoint(normalized.replace(/^wss?:\/\//i, "https://")) ?? "";
    }
    return normalizeEndpoint(`https://${normalized}`) ?? "";
  }
  return "";
}

export function endpointBase(master: string, defaultPort: number, defaultPath: string): string {
  try {
    const url = new URL(master);
    if (!url.port) {
      url.port = String(defaultPort);
    }
    const path = [url.pathname, defaultPath]
      .map(part => part.replace(/^\/+|\/+$/g, ""))
      .filter(Boolean)
      .join("/");
    url.pathname = path ? `/${path}` : "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return `${master.replace(/\/+$/, "")}:${defaultPort}${defaultPath}`;
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(values: UnknownRecord, key: string): UnknownRecord | undefined {
  const value = values[key];
  return isRecord(value) ? value : undefined;
}

function firstValue(values: UnknownRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in values) {
      return values[key];
    }
  }
  return undefined;
}

function enabledValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  if (isRecord(value)) {
    return enabledValue(value.enabled, fallback);
  }
  return fallback;
}

function optional(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized || undefined;
}

function normalizeEndpoint(value: unknown): string | undefined {
  const raw = optional(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (!["http:", "https:", "ws:", "wss:", "mqtt:", "mqtts:"].includes(url.protocol)) {
      return undefined;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function coerceScheme(value: string, replacements: Record<string, string>): string {
  for (const [prefix, replacement] of Object.entries(replacements)) {
    if (value.startsWith(prefix)) {
      return `${replacement}${value.slice(prefix.length)}`;
    }
  }
  return value;
}

function redactCredentials(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value;
  }
}
