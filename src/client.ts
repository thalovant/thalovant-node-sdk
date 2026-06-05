import {
  EVENT_INTENT_FAILURE,
  EVENT_POLICY_DENIED,
  EVENT_RECOGNIZER_LOOP_UTTERANCE,
  EVENT_SPEAK,
  EVENT_UTTERANCE_HANDLED,
} from "./constants.js";
import { ThalovantRuntimeError, ThalovantTimeoutError } from "./errors.js";
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
import { stripSsml, ThalovantDisplayItem } from "./rich.js";
import { HiveMindHttpTransport, TransportHealth } from "./transport.js";

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
  private readonly transport: HiveMindHttpTransport;
  private connected = false;

  constructor(identity: ThalovantIdentity, options: { transport?: HiveMindHttpTransport } = {}) {
    this.identity = identity;
    this.transport = options.transport ?? new HiveMindHttpTransport(identity);
  }

  static async fromIdentityFile(path: string): Promise<ThalovantClient> {
    return new ThalovantClient(await ThalovantIdentity.fromFile(path));
  }

  static fromEnv(): ThalovantClient {
    return new ThalovantClient(ThalovantIdentity.fromEnv());
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.transport.connect();
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
    await this.transport.emitBus(eventType, data, context);
  }

  async sendUtterance(
    text: string,
    options: { lang?: string; context?: EventContext; sessionId?: string; requestId?: string } = {},
  ): Promise<void> {
    const prompt = text.trim();
    if (!prompt) throw new Error("sendUtterance() requires a non-empty text prompt.");
    const lang = options.lang ?? "en-us";
    const requestId = options.requestId ?? newRequestId();
    await this.emit(
      EVENT_RECOGNIZER_LOOP_UTTERANCE,
      utterancePayload(prompt, lang),
      contextWithCorrelation(options.context ?? {}, {
        sessionId: options.sessionId,
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
    const input = { kind: options.kind ?? "code", label: options.label, value: code, exact: true };
    await this.emit(
      EVENT_RECOGNIZER_LOOP_UTTERANCE,
      { ...utterancePayload(code, lang), input },
      contextWithCorrelation(mergeContext(options.context, { input }), {
        sessionId: options.sessionId,
        siteId: this.identity.siteId,
        lang,
        requestId,
      }),
    );
  }

  async ask(
    text: string,
    options: { timeoutMs?: number; lang?: string; context?: EventContext; sessionId?: string; requestId?: string } = {},
  ): Promise<ThalovantReply> {
    const prompt = text.trim();
    if (!prompt) throw new Error("ask() requires a non-empty text prompt.");
    const lang = options.lang ?? "en-us";
    const requestId = options.requestId ?? newRequestId();
    const context = contextWithCorrelation(options.context ?? {}, {
      sessionId: options.sessionId,
      siteId: this.identity.siteId,
      lang,
      requestId,
    });
    const fragments: string[] = [];
    const events: ThalovantEvent[] = [];
    let failureEvent: ThalovantEvent | undefined;
    const handlers = [
      this.on(EVENT_SPEAK, event => {
        fragments.push(event.text);
        events.push(event);
      }, { context }),
      this.on(EVENT_INTENT_FAILURE, event => {
        failureEvent = event;
        events.push(event);
      }, { context }),
      this.on(EVENT_POLICY_DENIED, event => {
        failureEvent = event;
        events.push(event);
      }, { context }),
    ];
    try {
      const handled = this.waitForEvent(EVENT_UTTERANCE_HANDLED, { timeoutMs: options.timeoutMs ?? 12000, context });
      await this.emit(EVENT_RECOGNIZER_LOOP_UTTERANCE, utterancePayload(prompt, lang), context);
      await handled;
      if (failureEvent && fragments.length === 0) {
        throw new ThalovantRuntimeError(failureEvent.text || `Hub reported ${failureEvent.name}.`);
      }
      return {
        text: fragments.join(" "),
        displayText: stripSsml(fragments.join(" ")),
        utterances: fragments,
        handled: !failureEvent,
        ok: !failureEvent,
        sessionId: context.session?.session_id,
        requestId,
        events,
        failureEvent,
        displayItems(options: { maxTextChars?: number } = {}): ThalovantDisplayItem[] {
          const items = events.flatMap(event => event.displayItems(options));
          return items.length ? items : [{ kind: "text", text: stripSsml(fragments.join(" ")) }];
        },
      };
    } finally {
      handlers.forEach(handler => handler.close());
    }
  }
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
