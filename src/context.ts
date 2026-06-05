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
