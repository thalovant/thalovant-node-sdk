import { EventContext } from "./events.js";

export interface ClientContextOptions {
  userId?: string;
  userName?: string;
  authToken?: string;
  authProvider?: string;
  authClaims?: Record<string, unknown>;
  roles?: string[];
  platform?: string;
  source?: string;
  destination?: string;
  channel?: string;
  deviceId?: string;
  locale?: string;
  metadata?: Record<string, unknown>;
  sessionId?: string;
}

export function buildClientContext(base: EventContext = {}, options: ClientContextOptions = {}): EventContext {
  const context: EventContext = { ...base };
  if (options.userId || options.userName || options.roles) {
    const user = { ...asRecord(context.user) };
    if (options.userId) {
      user.id = options.userId;
      context.user_id ??= options.userId;
    }
    if (options.userName) {
      user.name = options.userName;
      context.user_name ??= options.userName;
    }
    if (options.roles) {
      user.roles = [...options.roles];
      context.roles ??= [...options.roles];
    }
    context.user = user;
  }
  if (options.authToken || options.authProvider || options.authClaims) {
    const auth = { ...asRecord(context.auth) };
    if (options.authToken) {
      auth.token = options.authToken;
      context.auth_token ??= options.authToken;
    }
    if (options.authProvider) auth.provider = options.authProvider;
    if (options.authClaims) auth.claims = { ...options.authClaims };
    context.auth = auth;
  }
  if (options.platform) context.platform ??= options.platform;
  if (options.source) context.source ??= options.source;
  if (options.destination) context.destination ??= options.destination;
  if (options.channel) context.channel ??= options.channel;
  if (options.locale) context.locale ??= options.locale;
  if (options.deviceId) {
    context.device = { ...asRecord(context.device), id: options.deviceId, ...(options.platform ? { platform: options.platform } : {}) };
  }
  if (options.metadata) {
    context.metadata = { ...asRecord(context.metadata), ...options.metadata };
  }
  if (options.sessionId) {
    context.session_id ??= options.sessionId;
    context.session = { ...(context.session ?? {}), session_id: options.sessionId };
  }
  return context;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Hints applied only to this request; omitted hints preserve existing context. */
export interface RequestContextOptions {
  sttLang?: string;
  pipeline?: readonly string[];
  location?: Record<string, unknown>;
}

export function requestContext(base: EventContext = {}, options: RequestContextOptions = {}): EventContext | undefined {
  const result = { ...base };
  if (result.session) result.session = { ...result.session };
  const stages = options.pipeline?.map(stage => stage.trim()).filter(Boolean);
  if (stages?.length) result.session = { ...asRecord(result.session), pipeline: stages };
  if (options.sttLang?.trim()) result.stt_lang = options.sttLang.trim();
  if (options.location && Object.keys(options.location).length) result.location = { ...options.location };
  return Object.keys(result).length ? result : undefined;
}

/** Build the request-level location shape understood by OVOS skills. */
export function buildLocation(options: {
  city?: string; region?: string; country?: string;
  latitude?: number | string; longitude?: number | string; timezone?: string;
} = {}): Record<string, unknown> | undefined {
  const city = options.city?.trim();
  if (!city) return undefined;
  const result: Record<string, unknown> = { city };
  if (options.region?.trim()) result.region = options.region.trim();
  if (options.country?.trim()) result.country_code = options.country.trim().toUpperCase();
  if (options.timezone?.trim()) result.timezone = { code: options.timezone.trim() };
  const coordinate = (value: number | string | undefined): number =>
    value === undefined || (typeof value === "string" && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) ? NaN : Number(value);
  const lat = coordinate(options.latitude), lon = coordinate(options.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lon) && (lat !== 0 || lon !== 0)
      && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) result.coordinate = { latitude: lat, longitude: lon };
  return result;
}
