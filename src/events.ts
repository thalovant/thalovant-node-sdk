import { FAILURE_EVENTS } from "./constants.js";
import { displayItemsFromEventData, richMediaFromData, stripSsml, ThalovantDisplayItem } from "./rich.js";

export interface SessionContext {
  session_id?: string;
  site_id?: string;
  lang?: string;
  request_id?: string;
  [key: string]: unknown;
}

export interface EventContext {
  session?: SessionContext;
  request_id?: string;
  thalovant_request_id?: string;
  [key: string]: unknown;
}

export interface BusPayload {
  type: string;
  data?: Record<string, unknown>;
  context?: EventContext;
}

export class ThalovantEvent {
  readonly name: string;
  readonly data: Record<string, unknown>;
  readonly context: EventContext;
  readonly raw: unknown;

  constructor(name: string, data: Record<string, unknown> = {}, context: EventContext = {}, raw?: unknown) {
    this.name = name;
    this.data = data;
    this.context = context;
    this.raw = raw;
  }

  get text(): string {
    const direct = this.data.utterance ?? this.data.text;
    if (typeof direct === "string") {
      return direct;
    }
    return this.utterances[0] ?? "";
  }

  get utterances(): string[] {
    const raw = this.data.utterances;
    if (typeof raw === "string") {
      return [raw];
    }
    if (Array.isArray(raw)) {
      return raw.filter((item): item is string => typeof item === "string");
    }
    const utterance = this.data.utterance;
    return typeof utterance === "string" ? [utterance] : [];
  }

  get displayText(): string {
    return stripSsml(this.text);
  }

  get sessionId(): string | undefined {
    return sessionIdFromContext(this.context);
  }

  get requestId(): string | undefined {
    return requestIdFromContext(this.context) ?? requestIdFromMapping(this.data);
  }

  get isFailure(): boolean {
    return FAILURE_EVENTS.has(this.name);
  }

  get richMedia(): Record<string, unknown> {
    return richMediaFromData(this.data);
  }

  displayItems(options: { maxTextChars?: number } = {}): ThalovantDisplayItem[] {
    return displayItemsFromEventData(this.data, { eventName: this.name, ...options });
  }

  matchesContext(expected?: EventContext): boolean {
    return eventMatchesContext(this, expected);
  }

  asObject(): Record<string, unknown> {
    return {
      name: this.name,
      data: this.data,
      context: this.context,
      text: this.text,
      display_text: this.displayText,
      session_id: this.sessionId,
      request_id: this.requestId,
      display_items: this.displayItems(),
    };
  }
}

export interface ThalovantReply {
  text: string;
  displayText: string;
  utterances: string[];
  handled: boolean;
  ok: boolean;
  sessionId?: string;
  requestId?: string;
  events: ThalovantEvent[];
  failureEvent?: ThalovantEvent;
  displayItems(options?: { maxTextChars?: number }): ThalovantDisplayItem[];
}

export function newSessionId(): string {
  return `thalovant-session-${crypto.randomUUID().replaceAll("-", "")}`;
}

export function newRequestId(): string {
  return `thalovant-request-${crypto.randomUUID().replaceAll("-", "")}`;
}

export function utterancePayload(text: string, lang: string): Record<string, unknown> {
  return { utterances: [text], lang };
}

export function mergeContext(base?: EventContext, extra?: EventContext): EventContext {
  const merged: EventContext = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (key === "session" && typeof value === "object" && value && !Array.isArray(value)) {
      merged.session = { ...(merged.session ?? {}), ...(value as SessionContext) };
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

export function contextWithCorrelation(
  context: EventContext = {},
  options: { sessionId?: string; siteId?: string; lang?: string; requestId?: string } = {},
): EventContext {
  const next: EventContext = { ...context };
  const session: SessionContext = { ...(next.session ?? {}) };
  if (options.sessionId) session.session_id = options.sessionId;
  if (options.siteId && !session.site_id) session.site_id = options.siteId;
  if (options.lang && !session.lang) session.lang = options.lang;
  if (options.requestId) {
    next.request_id = options.requestId;
    next.thalovant_request_id = options.requestId;
    session.request_id = options.requestId;
  }
  if (Object.keys(session).length > 0) {
    next.session = session;
  }
  return next;
}

export function eventMatchesContext(event: ThalovantEvent, expected?: EventContext): boolean {
  // The request id decides, when both sides carry one. A hub does not echo a
  // client-declared session id: it substitutes its own. Observed against a live
  // hub on 2026-09-03 - sent "observe-me", every reply came back as
  // "71048b7f-e7b0-4360-8fb5-a03816f78617" - so comparing session ids rejected
  // replies the request id had already identified as ours, and ask() timed out
  // while the hub had answered and emitted ovos.utterance.handled.
  const expectedRequest = requestIdFromContext(expected);
  if (expectedRequest && event.requestId) {
    return expectedRequest === event.requestId;
  }
  // No request id on one side or the other: fall back to the session, which is
  // all a caller had before request ids existed. Deliberately lenient - a reply
  // carrying no request id is not evidence either way.
  const expectedSession = sessionIdFromContext(expected);
  if (expectedSession && event.sessionId && expectedSession !== event.sessionId) {
    return false;
  }
  return true;
}

export function eventFromBusPayload(payload: BusPayload, raw?: unknown): ThalovantEvent {
  return new ThalovantEvent(payload.type, payload.data ?? {}, payload.context ?? {}, raw ?? payload);
}

function sessionIdFromContext(context?: EventContext): string | undefined {
  const value = context?.session?.session_id ?? context?.session_id;
  return value === undefined || value === null ? undefined : String(value);
}

function requestIdFromContext(context?: EventContext): string | undefined {
  return requestIdFromMapping(context) ?? requestIdFromMapping(context?.session as Record<string, unknown> | undefined);
}

function requestIdFromMapping(mapping?: Record<string, unknown>): string | undefined {
  const value = mapping?.request_id ?? mapping?.thalovant_request_id ?? mapping?.correlation_id;
  return value === undefined || value === null ? undefined : String(value);
}
