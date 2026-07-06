import {
  EVENT_INTENT_FAILURE,
  EVENT_OVOS_UTTERANCE_SPEAK,
  EVENT_POLICY_DENIED,
  EVENT_QUERY_TIMEOUT,
  EVENT_RECOGNIZER_LOOP_UTTERANCE,
  EVENT_SPEAK,
  EVENT_UTTERANCE_HANDLED,
} from "./constants.js";
import { ThalovantRuntimeError, ThalovantTimeoutError, ThalovantUnsupportedProtocolError } from "./errors.js";
import {
  contextWithCorrelation,
  eventFromBusPayload,
  eventMatchesContext,
  EventContext,
  mergeContext,
  newRequestId,
  newSessionId,
  ThalovantEvent,
  ThalovantReply,
  utterancePayload,
} from "./events.js";
import { ThalovantIdentity } from "./identity.js";
import { DEFAULT_PROTOCOL_PREFERENCE, HubProtocol } from "./protocols.js";
import { stripSsml, ThalovantDisplayItem } from "./rich.js";
import {
  HiveMindHttpTransport,
  HiveMindMqttTransport,
  HiveMindRuntimeTransport,
  HiveMindWSSTransport,
  TransportHealth,
} from "./transport.js";

export type EventHandler = (event: ThalovantEvent) => void | Promise<void>;
export type EventPredicate = (event: ThalovantEvent) => boolean;

export class ThalovantSubscription {
  constructor(private readonly closeFn: () => void) {}
  close(): void {
    this.closeFn();
  }
  unsubscribe(): void {
    this.close();
  }
}

export class ThalovantClient {
  readonly identity: ThalovantIdentity;
  private readonly transport: HiveMindRuntimeTransport;
  private readonly replySettleMs: number;
  private readonly emptyReplyWaitMs: number;
  private connected = false;

  constructor(
    identity: ThalovantIdentity,
    options: { transport?: HiveMindRuntimeTransport; protocol?: HubProtocol; replySettleMs?: number; emptyReplyWaitMs?: number } = {},
  ) {
    this.identity = identity;
    this.transport = options.transport ?? transportForProtocol(identity, options.protocol ?? defaultRuntimeProtocol(identity));
    this.replySettleMs = options.replySettleMs ?? 250;
    this.emptyReplyWaitMs = options.emptyReplyWaitMs ?? 5000;
  }

  static async fromIdentityFile(path: string, options: { protocol?: HubProtocol } = {}): Promise<ThalovantClient> {
    return new ThalovantClient(await ThalovantIdentity.fromFile(path), options);
  }

  static async fromConfig(options: { path?: string; profile?: string; protocol?: HubProtocol } = {}): Promise<ThalovantClient> {
    return new ThalovantClient(await ThalovantIdentity.fromConfig(options), { protocol: options.protocol });
  }

  static fromEnv(options: { protocol?: HubProtocol } = {}): ThalovantClient {
    return new ThalovantClient(ThalovantIdentity.fromEnv(), options);
  }

  async connect(timeoutMs?: number): Promise<void> {
    if (this.connected) return;
    await this.transport.connect(timeoutMs);
    this.connected = true;
  }

  async close(): Promise<void> {
    await this.transport.disconnect();
    this.connected = false;
  }

  healthcheck(): TransportHealth {
    return this.transport.healthcheck();
  }

  conversation(options: { sessionId?: string; lang?: string; context?: EventContext } = {}): ThalovantConversation {
    return new ThalovantConversation(this, options);
  }

  on(
    eventName: string,
    handler: EventHandler,
    options: { context?: EventContext; sessionId?: string; requestId?: string; predicate?: EventPredicate } = {},
  ): ThalovantSubscription {
    const expected = contextWithCorrelation(options.context ?? {}, {
      sessionId: options.sessionId,
      requestId: options.requestId,
    });
    const listener = (raw: Event): void => {
      const detail = (raw as CustomEvent).detail;
      if (detail.type !== eventName) return;
      const event = eventFromBusPayload(detail, detail);
      if (!eventMatchesContext(event, expected)) return;
      if (options.predicate && !options.predicate(event)) return;
      void handler(event);
    };
    this.transport.addEventListener("bus", listener);
    return new ThalovantSubscription(() => this.transport.removeEventListener("bus", listener));
  }

  async waitForEvent(
    eventName: string,
    options: { timeoutMs?: number; context?: EventContext; sessionId?: string; requestId?: string; predicate?: EventPredicate } = {},
  ): Promise<ThalovantEvent> {
    await this.connect();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        sub.close();
        reject(new ThalovantTimeoutError(`Hub did not emit ${eventName} within ${options.timeoutMs ?? 12000}ms.`));
      }, options.timeoutMs ?? 12000);
      const sub = this.on(eventName, event => {
        clearTimeout(timer);
        sub.close();
        resolve(event);
      }, options);
    });
  }

  async emit(eventType: string, data: Record<string, unknown> = {}, context: EventContext = {}): Promise<void> {
    await this.connect();
    await this.transport.emitBus(eventType, data, this.contextWithIdentityMetadata(context));
  }

  async sendUtterance(
    text: string,
    options: { lang?: string; context?: EventContext; sessionId?: string; requestId?: string } = {},
  ): Promise<void> {
    const prompt = text.trim();
    if (!prompt) throw new Error("sendUtterance() requires a non-empty text prompt.");
    const lang = options.lang ?? "en-us";
    const requestId = options.requestId ?? newRequestId();
    const sessionId = options.sessionId ?? newSessionId();
    await this.emit(
      EVENT_RECOGNIZER_LOOP_UTTERANCE,
      utterancePayload(prompt, lang),
      contextWithCorrelation(options.context ?? {}, {
        sessionId,
        siteId: this.identity.siteId,
        lang,
        requestId,
      }),
    );
  }

  async sendAction(
    payload: string,
    options: { title?: string; lang?: string; context?: EventContext; sessionId?: string; requestId?: string } = {},
  ): Promise<void> {
    const prompt = payload.trim();
    if (!prompt) throw new Error("sendAction() requires a non-empty payload.");
    await this.sendUtterance(prompt, {
      ...options,
      context: mergeContext(options.context, {
        input: { kind: "action", title: options.title, payload: prompt },
      }),
    });
  }

  async sendCode(
    value: string,
    options: { kind?: string; label?: string; lang?: string; context?: EventContext; sessionId?: string; requestId?: string } = {},
  ): Promise<void> {
    const code = value.trim();
    if (!code) throw new Error("sendCode() requires a non-empty value.");
    const lang = options.lang ?? "en-us";
    const requestId = options.requestId ?? newRequestId();
    const sessionId = options.sessionId ?? newSessionId();
    const input = { kind: options.kind ?? "code", label: options.label, value: code, exact: true };
    await this.emit(
      EVENT_RECOGNIZER_LOOP_UTTERANCE,
      { ...utterancePayload(code, lang), input },
      contextWithCorrelation(mergeContext(options.context, { input }), {
        sessionId,
        siteId: this.identity.siteId,
        lang,
        requestId,
      }),
    );
  }

  async ask(
    text: string,
    options: {
      timeoutMs?: number;
      lang?: string;
      context?: EventContext;
      sessionId?: string;
      requestId?: string;
      replySettleMs?: number;
      emptyReplyWaitMs?: number;
    } = {},
  ): Promise<ThalovantReply> {
    const prompt = text.trim();
    if (!prompt) throw new Error("ask() requires a non-empty text prompt.");
    const lang = options.lang ?? "en-us";
    const requestId = options.requestId ?? newRequestId();
    const sessionId = options.sessionId ?? newSessionId();
    const context = contextWithCorrelation(this.contextWithIdentityMetadata(options.context ?? {}), {
      sessionId,
      siteId: this.identity.siteId,
      lang,
      requestId,
    });
    const fragments: string[] = [];
    const events: ThalovantEvent[] = [];
    let failureEvent: ThalovantEvent | undefined;
    await this.connect();
    let finishHandled!: () => void;
    let failHandled!: (error: Error) => void;
    let finishReply!: () => void;
    const handled = new Promise<void>((resolve, reject) => {
      finishHandled = resolve;
      failHandled = reject;
    });
    const firstReply = new Promise<void>((resolve) => {
      finishReply = resolve;
    });
    const handleReply = (event: ThalovantEvent): void => {
      const normalized = event.text.trim().replace(/\s+/g, " ");
      if (normalized && fragments.at(-1) !== normalized) {
        fragments.push(normalized);
        finishReply();
      }
      events.push(event);
    };
    const timer = setTimeout(() => {
      failHandled(new ThalovantTimeoutError(`Hub did not finish handling the utterance within ${options.timeoutMs ?? 12000}ms.`));
    }, options.timeoutMs ?? 12000);
    const listenerContext = requestOnlyCorrelationContext(context, requestId);
    const optionsWithCorrelation = {
      context: listenerContext,
      predicate: (event: ThalovantEvent) => eventMatchesRequiredCorrelation(event, listenerContext),
    };
    const handlers = [
      this.on(EVENT_SPEAK, handleReply, optionsWithCorrelation),
      this.on(EVENT_OVOS_UTTERANCE_SPEAK, handleReply, optionsWithCorrelation),
      this.on(EVENT_UTTERANCE_HANDLED, event => {
        events.push(event);
        finishHandled();
      }, optionsWithCorrelation),
      this.on(EVENT_INTENT_FAILURE, event => {
        events.push(event);
      }, optionsWithCorrelation),
      this.on(EVENT_POLICY_DENIED, event => {
        failureEvent = event;
        events.push(event);
        finishHandled();
      }, optionsWithCorrelation),
      this.on(EVENT_QUERY_TIMEOUT, event => {
        failureEvent = event;
        events.push(event);
        finishHandled();
      }, optionsWithCorrelation),
    ];
    try {
      await Promise.race([
        this.transport.emitBus(EVENT_RECOGNIZER_LOOP_UTTERANCE, utterancePayload(prompt, lang), context),
        handled,
      ]);
      await Promise.race([handled, firstReply]);
      clearTimeout(timer);
      if (!failureEvent && fragments.length === 0) {
        const emptyReplyWaitMs = options.emptyReplyWaitMs ?? this.emptyReplyWaitMs;
        if (emptyReplyWaitMs > 0) {
          await Promise.race([firstReply, sleep(emptyReplyWaitMs)]);
        }
      }
      const replySettleMs = options.replySettleMs ?? this.replySettleMs;
      if (replySettleMs > 0) {
        await sleep(replySettleMs);
      }
      if (!failureEvent && fragments.length === 0) {
        throw new ThalovantTimeoutError(`Hub handled the utterance but did not emit a speak reply within ${options.emptyReplyWaitMs ?? this.emptyReplyWaitMs}ms.`);
      }
      if (failureEvent && fragments.length === 0) {
        throw new ThalovantRuntimeError(failureEvent.text || `Hub reported ${failureEvent.name}.`);
      }
      const text = fragments.join(" ");
      return {
        text,
        displayText: stripSsml(text),
        utterances: fragments,
        handled: !failureEvent,
        ok: !failureEvent,
        sessionId: context.session?.session_id,
        requestId,
        events,
        failureEvent,
        displayItems(options: { maxTextChars?: number } = {}): ThalovantDisplayItem[] {
          const items = events.flatMap(event => event.displayItems(options));
          return items.length ? items : [{ kind: "text", text: stripSsml(text) }];
        },
      };
    } finally {
      clearTimeout(timer);
      handlers.forEach(handler => handler.close());
    }
  }

  private contextWithIdentityMetadata(context: EventContext): EventContext {
    if (Object.keys(this.identity.metadata).length === 0) {
      return context;
    }
    const existing = isRecord(context.metadata) ? context.metadata : {};
    return {
      ...context,
      metadata: {
        ...this.identity.metadata,
        ...existing,
      },
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function requestOnlyCorrelationContext(context: EventContext, requestId: string): EventContext {
  const { session: _session, session_id: _sessionId, ...rest } = context as EventContext & { session_id?: unknown };
  return contextWithCorrelation(rest, { requestId });
}

function eventMatchesRequiredCorrelation(event: ThalovantEvent, expected: EventContext): boolean {
  const expectedSession = correlationSessionId(expected);
  const expectedRequest = correlationRequestId(expected);
  if (expectedSession && event.sessionId && expectedSession !== event.sessionId) {
    return false;
  }
  if (expectedRequest && event.requestId && expectedRequest !== event.requestId) {
    return false;
  }
  if (!expectedSession && !expectedRequest) {
    return true;
  }
  return Boolean((expectedSession && event.sessionId) || (expectedRequest && event.requestId));
}

function correlationSessionId(context?: EventContext): string | undefined {
  const value = context?.session?.session_id ?? context?.session_id;
  return value === undefined || value === null ? undefined : String(value);
}

function correlationRequestId(context?: EventContext): string | undefined {
  return requestIdFromMapping(context) ?? requestIdFromMapping(context?.session as Record<string, unknown> | undefined);
}

function requestIdFromMapping(mapping?: Record<string, unknown>): string | undefined {
  const value = mapping?.request_id ?? mapping?.thalovant_request_id ?? mapping?.correlation_id;
  return value === undefined || value === null ? undefined : String(value);
}

function defaultRuntimeProtocol(identity: ThalovantIdentity): HubProtocol {
  for (const protocol of DEFAULT_PROTOCOL_PREFERENCE) {
    if (protocol === "wss") {
      if (identity.supportsProtocol("wss") && identity.endpointFor("wss")) return "wss";
      continue;
    }
    if (protocol === "https") {
      if (identity.supportsProtocol("https") || identity.endpointFor("https")) return "https";
      continue;
    }
    if (protocol === "mqtt" && identity.supportsProtocol("mqtt") && identity.mqtt) {
      return "mqtt";
    }
  }
  throw new ThalovantUnsupportedProtocolError("The identity does not include a usable WSS, HTTPS, or MQTT endpoint.");
}

function transportForProtocol(identity: ThalovantIdentity, protocol: HubProtocol): HiveMindRuntimeTransport {
  if (protocol === "https") {
    return new HiveMindHttpTransport(identity);
  }
  if (protocol === "wss") {
    if (!identity.endpointFor("wss")) {
      throw new ThalovantUnsupportedProtocolError("WSS is enabled, but the identity does not include a WSS endpoint.");
    }
    return new HiveMindWSSTransport(identity);
  }
  if (protocol === "mqtt") {
    if (!identity.mqtt) {
      throw new ThalovantUnsupportedProtocolError("MQTT is enabled, but the identity does not include MQTT broker credentials.");
    }
    return new HiveMindMqttTransport(identity);
  }
  throw new ThalovantUnsupportedProtocolError(`Unsupported protocol: ${protocol}`);
}

export class ThalovantConversation {
  readonly sessionId: string;
  readonly lang: string;
  readonly context: EventContext;

  constructor(private readonly client: ThalovantClient, options: { sessionId?: string; lang?: string; context?: EventContext } = {}) {
    this.sessionId = options.sessionId ?? newSessionId();
    this.lang = options.lang ?? "en-us";
    this.context = options.context ?? {};
  }

  ask(text: string, options: { timeoutMs?: number; lang?: string; context?: EventContext; requestId?: string } = {}): Promise<ThalovantReply> {
    return this.client.ask(text, {
      ...options,
      lang: options.lang ?? this.lang,
      context: mergeContext(this.context, options.context),
      sessionId: this.sessionId,
    });
  }

  sendUtterance(text: string, options: { lang?: string; context?: EventContext; requestId?: string } = {}): Promise<void> {
    return this.client.sendUtterance(text, {
      ...options,
      lang: options.lang ?? this.lang,
      context: mergeContext(this.context, options.context),
      sessionId: this.sessionId,
    });
  }

  sendAction(payload: string, options: { title?: string; lang?: string; context?: EventContext; requestId?: string } = {}): Promise<void> {
    return this.client.sendAction(payload, {
      ...options,
      lang: options.lang ?? this.lang,
      context: mergeContext(this.context, options.context),
      sessionId: this.sessionId,
    });
  }

  sendCode(value: string, options: { kind?: string; label?: string; lang?: string; context?: EventContext; requestId?: string } = {}): Promise<void> {
    return this.client.sendCode(value, {
      ...options,
      lang: options.lang ?? this.lang,
      context: mergeContext(this.context, options.context),
      sessionId: this.sessionId,
    });
  }
}
