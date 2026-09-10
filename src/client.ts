import {
  EVENT_INTENT_FAILURE,
  EVENT_INTENT_UNMATCHED,
  EVENT_OVOS_UTTERANCE_SPEAK,
  EVENT_POLICY_DENIED,
  EVENT_QUERY_TIMEOUT,
  EVENT_RECOGNIZER_LOOP_UTTERANCE,
  EVENT_SPEAK,
  EVENT_UTTERANCE_HANDLED,
} from "./constants.js";
import { ThalovantConnectionError, ThalovantRuntimeError, ThalovantTimeoutError, ThalovantUnsupportedProtocolError } from "./errors.js";
import {
  contextWithCorrelation,
  BusPayload,
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
import * as intentQueries from "./intents.js";
import { HubIntentInventory, IntentDefinition, IntentRegistration } from "./intents.js";
import { DEFAULT_PROTOCOL_PREFERENCE, HubProtocol } from "./protocols.js";
import { stripSsml, ThalovantDisplayItem } from "./rich.js";
import {
  HiveMindHttpTransport,
  HiveMindMqttTransport,
  HiveMindRuntimeTransport,
  HiveMindWSSTransport,
  HiveMessage,
  TransportConnectionInfo,
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
  private readonly activeReplyIds = new Set<string>();
  private connected = false;
  // Retain timed-out work until both its connect and cleanup settle. A later
  // call may time out waiting here, but may never race an abandoned session.
  private lifecycle: Promise<void> = Promise.resolve();
  private closing: Promise<void> = Promise.resolve();
  private lifecycleGeneration = 0;
  private cancelConnect?: () => void;

  constructor(
    identity: ThalovantIdentity,
    options: {
      transport?: HiveMindRuntimeTransport;
      protocol?: HubProtocol;
      replySettleMs?: number;
      emptyReplyWaitMs?: number;
      /**
       * Where the v3 Noise static key and pin file live. Undefined uses
       * the platform default: beside the SDK config file in Node, a
       * `localStorage` namespace in a browser.
       */
      noiseStateDir?: string;
    } = {},
  ) {
    this.identity = identity;
    this.transport =
      options.transport ??
      transportForProtocol(identity, options.protocol ?? defaultRuntimeProtocol(identity), {
        noiseStateDir: options.noiseStateDir,
      });
    this.replySettleMs = options.replySettleMs ?? 250;
    this.emptyReplyWaitMs = options.emptyReplyWaitMs ?? 5000;
  }

  static async fromIdentityFile(path: string, options: { protocol?: HubProtocol; noiseStateDir?: string } = {}): Promise<ThalovantClient> {
    return new ThalovantClient(await ThalovantIdentity.fromFile(path), options);
  }

  static async fromConfig(options: { path?: string; profile?: string; protocol?: HubProtocol; noiseStateDir?: string } = {}): Promise<ThalovantClient> {
    return new ThalovantClient(await ThalovantIdentity.fromConfig(options), { protocol: options.protocol, noiseStateDir: options.noiseStateDir });
  }

  static fromEnv(options: { protocol?: HubProtocol; noiseStateDir?: string } = {}): ThalovantClient {
    return new ThalovantClient(ThalovantIdentity.fromEnv(), options);
  }

  /** Connect and reach authenticated readiness within one caller deadline. */
  async connect(timeoutMs?: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw operationAbortedError();
    if (this.connected && this.transport.healthcheck().connected && this.transport.healthcheck().handshakeComplete) return;
    const budget = normalizeConnectTimeout(timeoutMs);
    const deadline = performance.now() + budget;
    const generation = this.lifecycleGeneration;
    let expired = false;
    let started = false;
    let transportCompleted = false;
    let cleanup: Promise<void> | undefined;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
    const stop = (error: unknown): void => {
      if (expired) return;
      expired = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (started) {
        this.connected = false;
        cleanup = Promise.resolve().then(() => this.transport.disconnect()).catch(() => undefined);
      }
      reject(error);
    };
    const onAbort = (): void => stop(operationAbortedError());
    const cancel = (): void => stop(new ThalovantConnectionError("Hub connection was closed before it became ready."));
    const timer = setTimeout(() => stop(connectionTimeoutError(budget)), budget);
    signal?.addEventListener("abort", onAbort, { once: true });
    const operation = this.lifecycle.then(async () => {
      try {
        if (expired) return;
        if (generation !== this.lifecycleGeneration) { cancel(); return; }
        if (performance.now() >= deadline) {
          stop(connectionTimeoutError(budget));
          return;
        }
        const health = this.transport.healthcheck();
        if (this.connected && health.connected && health.handshakeComplete) { resolve(); return; }
        started = true;
        this.connected = false;
        this.cancelConnect = cancel;
        await this.transport.connect(Math.max(1, deadline - performance.now()));
        transportCompleted = true;
        while (!expired) {
          if (performance.now() >= deadline) {
            stop(connectionTimeoutError(budget));
            return;
          }
          const ready = this.transport.healthcheck();
          if (ready.connected && ready.handshakeComplete) {
            this.connected = true;
            resolve();
            return;
          }
          await sleep(Math.min(20, Math.max(1, deadline - performance.now())));
        }
      } catch (error) {
        stop(error);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (this.cancelConnect === cancel) this.cancelConnect = undefined;
        await cleanup;
        if (expired && transportCompleted) {
          // Retire a custom transport that completed after its first cleanup.
          await Promise.resolve().then(() => this.transport.disconnect()).catch(() => undefined);
        }
      }
    });
    this.lifecycle = operation.catch(() => undefined);
    return result;
  }

  async connectWithInfo(timeoutMs?: number): Promise<TransportConnectionInfo> {
    await this.connect(timeoutMs);
    return this.connectionInfo();
  }

  /** Cancel pending connects and close within a caller budget (default 6000ms). */
  async close(timeoutMs?: number): Promise<void> {
    this.connected = false;
    this.lifecycleGeneration += 1;
    this.cancelConnect?.();
    const closing = this.lifecycle.then(() => this.transport.disconnect());
    this.closing = closing;
    this.lifecycle = closing.catch(() => undefined);
    const budget = normalizeConnectTimeout(timeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ThalovantConnectionError(`Hub close did not complete within ${budget}ms.`)), budget);
    });
    try {
      await Promise.race([closing, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Observe the actual most recent close, including cleanup retained after timeout. */
  waitForClosed(): Promise<void> {
    return this.closing;
  }

  healthcheck(): TransportHealth {
    return this.transport.healthcheck();
  }

  connectionInfo(): TransportConnectionInfo {
    if (this.transport.connectionInfo) {
      return this.transport.connectionInfo();
    }
    const health = this.transport.healthcheck();
    return health.connection ?? {
      phase: health.handshakeComplete ? "ready" : health.connected ? "open" : "idle",
      lastError: health.lastError,
    };
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

  /** Wait within one total budget, including authenticated connection readiness. */
  async waitForEvent(
    eventName: string,
    options: { timeoutMs?: number; context?: EventContext; sessionId?: string; requestId?: string; predicate?: EventPredicate; signal?: AbortSignal } = {},
  ): Promise<ThalovantEvent> {
    const timeoutMs = requestTimeout(options.timeoutMs);
    const deadline = performance.now() + timeoutMs;
    if (options.signal?.aborted) throw operationAbortedError();
    let terminal = false;
    let sub: ThalovantSubscription | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolve!: (event: ThalovantEvent) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<ThalovantEvent>((accept, fail) => { resolve = accept; reject = fail; });
    // A deadline can expire while the connection still owns cleanup.
    void result.catch(() => undefined);
    const cleanup = (): void => {
      clearTimeout(timer);
      sub?.close();
      options.signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown): void => {
      if (terminal) return;
      terminal = true;
      cleanup();
      reject(error);
    };
    const timeoutError = () => new ThalovantTimeoutError(`Hub did not emit ${eventName} within ${timeoutMs}ms.`);
    const onAbort = (): void => fail(operationAbortedError());
    timer = setTimeout(() => fail(timeoutError()), timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    // Subscribe first: built-in transports publish only authenticated events,
    // including an event arriving just before connect() resolves readiness.
    sub = this.on(eventName, event => {
      if (terminal) return;
      terminal = true;
      cleanup();
      resolve(event);
    }, { ...options, predicate: event => {
      if (terminal) return false;
      if (performance.now() >= deadline) { fail(timeoutError()); return false; }
      try { return options.predicate?.(event) ?? true; }
      catch (error) { fail(error); return false; }
    } });
    try {
      await this.connect(Math.max(1, deadline - performance.now()), options.signal);
      return await result;
    } catch (error) {
      if (error instanceof ThalovantConnectionError && error.cause instanceof ThalovantTimeoutError) throw timeoutError();
      throw error;
    } finally {
      terminal = true;
      cleanup();
    }
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

  /** Ask with a total connection/send/collection budget and optional cancellation. */
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
      signal?: AbortSignal;
    } = {},
  ): Promise<ThalovantReply> {
    if (options.signal?.aborted) throw operationAbortedError();
    const requestId = options.requestId ?? newRequestId();
    return this.withReplyReservation("ask", requestId, () => this.askReserved(text, { ...options, requestId }));
  }

  private async askReserved(text: string, options: NonNullable<Parameters<ThalovantClient["ask"]>[1]>): Promise<ThalovantReply> {
    const prompt = text.trim();
    if (!prompt) throw new Error("ask() requires a non-empty text prompt.");
    const timeoutMs = requestTimeout(options.timeoutMs);
    const deadline = performance.now() + timeoutMs;
    const replySettleMs = replyWindow(options.replySettleMs ?? this.replySettleMs);
    const emptyReplyWaitMs = replyWindow(options.emptyReplyWaitMs ?? this.emptyReplyWaitMs);
    if (options.signal?.aborted) throw operationAbortedError();
    const timeoutError = () => new ThalovantTimeoutError(`Hub did not finish handling the utterance within ${timeoutMs}ms.`);
    const lang = options.lang ?? "en-us";
    const requestId = options.requestId ?? newRequestId();
    const sessionId = options.sessionId ?? newSessionId();
    const context = contextWithCorrelation(this.contextWithIdentityMetadata(options.context ?? {}), {
      sessionId, siteId: this.identity.siteId, lang, requestId,
    });
    try {
      await this.connect(Math.max(1, deadline - performance.now()), options.signal);
    } catch (error) {
      if (error instanceof ThalovantConnectionError && error.cause instanceof ThalovantTimeoutError) throw timeoutError();
      throw error;
    }
    if (options.signal?.aborted) throw operationAbortedError();
    if (performance.now() >= deadline) throw timeoutError();
    const fragments: string[] = [];
    const events: ThalovantEvent[] = [];
    let failureEvent: ThalovantEvent | undefined;
    let softFailureEvent: ThalovantEvent | undefined;
    let terminal = false;
    let handled = false;
    let phaseTimer: ReturnType<typeof setTimeout> | undefined;
    let phase: "empty" | "settle" | undefined;
    let finish!: () => void;
    let reject!: (error: unknown) => void;
    const done = new Promise<void>((accept, fail) => { finish = accept; reject = fail; });
    const complete = (): void => { if (!terminal) { terminal = true; finish(); } };
    const fail = (error: unknown): void => { if (!terminal) { terminal = true; reject(error); } };
    const onAbort = (): void => fail(operationAbortedError());
    const timer = setTimeout(complete, Math.max(1, deadline - performance.now()));
    const startWindow = (kind: "empty" | "settle", duration: number): void => {
      if (phase === kind) return;
      phase = kind;
      clearTimeout(phaseTimer);
      phaseTimer = setTimeout(complete, Math.min(duration, Math.max(0, deadline - performance.now())));
    };
    const listenerContext = requestOnlyCorrelationContext(context, requestId);
    const listener = (raw: Event): void => {
      if (terminal) return;
      if (performance.now() >= deadline) { complete(); return; }
      const detail = (raw as CustomEvent).detail;
      const event = eventFromBusPayload(detail, detail);
      if (!eventMatchesRequiredCorrelation(event, listenerContext)) return;
      switch (event.name) {
        case EVENT_SPEAK:
        case EVENT_OVOS_UTTERANCE_SPEAK: {
          const normalized = event.text.trim().replace(/\s+/g, " ");
          if (normalized && fragments.at(-1) !== normalized) fragments.push(normalized);
          events.push(event);
          if (fragments.length) startWindow("settle", replySettleMs);
          break;
        }
        case EVENT_INTENT_FAILURE:
        case EVENT_INTENT_UNMATCHED:
          softFailureEvent = event;
          events.push(event);
          if (!fragments.length) startWindow("empty", emptyReplyWaitMs);
          break;
        case EVENT_UTTERANCE_HANDLED:
          handled = true;
          events.push(event);
          if (!fragments.length) startWindow("empty", emptyReplyWaitMs);
          break;
        case EVENT_POLICY_DENIED:
        case EVENT_QUERY_TIMEOUT:
          failureEvent = event;
          events.push(event);
          complete();
          break;
      }
    };
    this.transport.addEventListener("bus", listener);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      // Retain/observe the transport's write even when collection expires.
      // Cancellation cannot retract an already published application request.
      void Promise.resolve().then(() => {
        if (options.signal?.aborted) onAbort();
        if (performance.now() >= deadline) complete();
        if (terminal) return;
        return this.transport.emitBus(EVENT_RECOGNIZER_LOOP_UTTERANCE, utterancePayload(prompt, lang), context);
      }).catch(fail);
      await done;
      const effectiveFailure = failureEvent ?? (fragments.length === 0 ? softFailureEvent : undefined);
      if (effectiveFailure && fragments.length === 0) {
        throw new ThalovantRuntimeError(effectiveFailure.text || `Hub reported ${effectiveFailure.name}.`);
      }
      if (fragments.length === 0) {
        if (handled) throw new ThalovantTimeoutError(`Hub handled the utterance but did not emit a speak reply within ${timeoutMs}ms.`);
        throw timeoutError();
      }
      const replyText = fragments.join(" ");
      return {
        text: replyText,
        displayText: stripSsml(replyText),
        utterances: fragments,
        handled: !effectiveFailure,
        ok: !effectiveFailure,
        sessionId: events.map(event => event.sessionId).find(id => id !== undefined && id.trim().length > 0) ?? context.session?.session_id,
        requestId,
        events,
        failureEvent: effectiveFailure,
        displayItems(queryOptions: { maxTextChars?: number } = {}): ThalovantDisplayItem[] {
          const items = events.flatMap(event => event.displayItems(queryOptions));
          return items.length ? items : [{ kind: "text", text: stripSsml(replyText) }];
        },
      };
    } finally {
      terminal = true;
      clearTimeout(timer);
      clearTimeout(phaseTimer);
      options.signal?.removeEventListener("abort", onAbort);
      this.transport.removeEventListener("bus", listener);
    }
  }

  /** Query with one connection/send/collection budget and optional cancellation. */
  async query(
    text: string,
    options: {
      timeoutMs?: number;
      lang?: string;
      context?: EventContext;
      sessionId?: string;
      requestId?: string;
      queryId?: string;
      /** Retained for compatibility; terminal Query replies return immediately. */
      replySettleMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<ThalovantReply> {
    if (options.signal?.aborted) throw operationAbortedError();
    const requestId = options.requestId ?? newRequestId();
    const queryId = options.queryId ?? requestId;
    return this.withReplyReservation("query", queryId, () => this.queryReserved(text, { ...options, requestId, queryId }));
  }

  private async queryReserved(text: string, options: NonNullable<Parameters<ThalovantClient["query"]>[1]>): Promise<ThalovantReply> {
    const prompt = text.trim();
    if (!prompt) throw new Error("query() requires a non-empty text prompt.");
    const timeoutMs = requestTimeout(options.timeoutMs);
    const timeoutError = () => new ThalovantTimeoutError(`Hub did not finish the query within ${timeoutMs}ms.`);
    const deadline = performance.now() + timeoutMs;
    if (options.signal?.aborted) throw operationAbortedError();
    const lang = options.lang ?? "en-us";
    const requestId = options.requestId ?? newRequestId();
    const queryId = options.queryId ?? requestId;
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
    let softFailureEvent: ThalovantEvent | undefined;
    try {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw timeoutError();
      await this.connect(remaining, options.signal);
    } catch (error) {
      if (error instanceof ThalovantConnectionError && error.cause instanceof ThalovantTimeoutError) throw timeoutError();
      throw error;
    }
    if (options.signal?.aborted) throw operationAbortedError();
    if (performance.now() >= deadline) throw timeoutError();
    if (!this.transport.sendHiveMessage) {
      throw new ThalovantRuntimeError("This transport does not support HiveMind query frames.");
    }
    const sendHiveMessage = this.transport.sendHiveMessage.bind(this.transport);

    let finishQuery!: () => void;
    let failQuery!: (error: unknown) => void;
    const done = new Promise<void>((resolve, reject) => {
      finishQuery = resolve;
      failQuery = reject;
    });
    let terminal = false;
    const complete = (): void => { if (!terminal) { terminal = true; finishQuery(); } };
    const fail = (error: unknown): void => { if (!terminal) { terminal = true; failQuery(error); } };
    const onAbort = (): void => fail(operationAbortedError());
    const timer = setTimeout(() => fail(timeoutError()), Math.max(1, deadline - performance.now()));
    const listener = (raw: Event): void => {
      if (terminal) return;
      if (performance.now() >= deadline) {
        fail(timeoutError());
        return;
      }
      const message = (raw as CustomEvent<HiveMessage>).detail;
      if (String(message.metadata?.query_id ?? message.metadata?.queryId ?? "") !== queryId) return;
      const payload = busPayloadFromHivePayload(message.payload);
      if (!payload) return;
      const event = eventFromBusPayload(payload, payload);
      if (event.name === "hive.query.complete") {
        events.push(event);
        complete();
        return;
      }
      events.push(event);
      if (event.name === EVENT_SPEAK || event.name === EVENT_OVOS_UTTERANCE_SPEAK) {
        const normalized = event.text.trim().replace(/\s+/g, " ");
        if (normalized && fragments.at(-1) !== normalized) {
          fragments.push(normalized);
        }
        if (normalized) softFailureEvent = undefined;
        return;
      }
      if (event.name === EVENT_INTENT_FAILURE || event.name === EVENT_INTENT_UNMATCHED) {
        if (fragments.length === 0) softFailureEvent = event;
        return;
      }
      if (event.isFailure) {
        failureEvent = event;
        complete();
      }
    };
    this.transport.addEventListener("query", listener);
    this.transport.addEventListener("cascade", listener);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const inner: HiveMessage = {
        msg_type: "bus",
        payload: {
          type: EVENT_RECOGNIZER_LOOP_UTTERANCE,
          data: utterancePayload(prompt, lang),
          context,
        },
        metadata: {},
        route: [],
        node: null,
        target_site_id: null,
        target_pubkey: null,
        source_peer: null,
      };
      // Keep an admitted write observed after caller cancellation or expiry.
      // A terminal reply/cancellation wins over a later synchronous throw or
      // rejected write; cancellation cannot retract or replay publication.
      void Promise.resolve().then(() => {
        if (options.signal?.aborted) onAbort();
        if (performance.now() >= deadline) fail(timeoutError());
        if (terminal) return;
        return sendHiveMessage({
          msg_type: "query",
          payload: inner as unknown as Record<string, unknown>,
          metadata: { query_id: queryId },
          route: [],
          node: null,
          target_site_id: null,
          target_pubkey: null,
          source_peer: null,
        });
      }).catch(fail);
      await done;
      clearTimeout(timer);
      failureEvent ??= softFailureEvent;
      if (failureEvent && fragments.length === 0) {
        throw new ThalovantRuntimeError(failureEvent.text || `Hub reported ${failureEvent.name}.`);
      }
      if (fragments.length === 0) {
        throw new ThalovantTimeoutError(`Hub finished the query but did not emit a speak reply.`);
      }
      const replyText = fragments.join(" ");
      return {
        text: replyText,
        displayText: stripSsml(replyText),
        utterances: fragments,
        handled: !failureEvent,
        ok: !failureEvent,
        sessionId: events.map(event => event.sessionId).find(id => id !== undefined && id.trim().length > 0) ?? context.session?.session_id,
        requestId,
        events,
        failureEvent,
        displayItems(queryOptions: { maxTextChars?: number } = {}): ThalovantDisplayItem[] {
          const items = events.flatMap(event => event.displayItems(queryOptions));
          return items.length ? items : [{ kind: "text", text: stripSsml(replyText) }];
        },
      };
    } finally {
      terminal = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      this.transport.removeEventListener("query", listener);
      this.transport.removeEventListener("cascade", listener);
    }
  }

  /** Reserve only the collector's wire namespace; release after listener retirement. */
  private async withReplyReservation<T>(namespace: "ask" | "query", identifier: string, work: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([namespace, identifier]);
    if (this.activeReplyIds.has(key)) throw new ThalovantRuntimeError("A reply collector with this correlation ID is already active.");
    this.activeReplyIds.add(key);
    try {
      return await work();
    } finally {
      this.activeReplyIds.delete(key);
    }
  }

  /**
   * Everything the hub can be asked, per language, grouped by skill.
   *
   * Read from the runtime's intent manifest over this session, so no
   * control-plane credential is involved. Each intent carries the sentences a
   * person says to reach it, as the skill wrote them, `{slot}` placeholders
   * included. `languages` defaults to `en-us`.
   *
   * `ovos.intent.describe` is needed only when the sentences are wanted, which
   * is the default; `{ describe: false }` skips descriptions. The optional
   * fallback-skill probe adds at most 1500ms and preserves unknown versus empty.
   *
   * Rejects with `ThalovantPolicyDeniedError` when the hub refuses a query.
   * The engines' manifests are the fallback when the hub refuses or ignores
   * `ovos.intent.list` and `fallback` is on (the default), and yield intent
   * names with `source` set to `engine-manifests`; a refused
   * `ovos.intent.describe` rejects either way. A hub that answers the listing
   * with `ok: false` rejects with `ThalovantRuntimeError`: it failed the
   * query, which is not the same as having no intents.
   */
  async intents(
    languages?: Iterable<string>,
    options: { timeoutMs?: number; describe?: boolean; fallback?: boolean } = {},
  ): Promise<HubIntentInventory> {
    const chosen = typeof languages === "string" ? (languages.trim() ? [languages] : []) : languages ? [...languages] : [];
    return intentQueries.intentInventory(this, chosen.length > 0 ? chosen : ["en-us"], options);
  }

  /**
   * The hub's intent manifest for one language, one row per registration.
   *
   * Rejects with `ThalovantRuntimeError` when the hub answers `ok: false`.
   */
  async listIntents(
    lang?: string,
    options: { timeoutMs?: number; includeDefinitions?: boolean } = {},
  ): Promise<IntentRegistration[]> {
    return intentQueries.listIntents(this, lang ?? "en-us", options);
  }

  /** The registrations behind one intent in one language, sentences included. */
  async describeIntent(
    skillId: string,
    intentName: string,
    lang?: string,
    options: { timeoutMs?: number } = {},
  ): Promise<IntentDefinition[]> {
    return intentQueries.describeIntent(this, skillId, intentName, lang ?? "en-us", options);
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

function operationAbortedError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function requestTimeout(timeoutMs = 12000): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
    throw new ThalovantTimeoutError("Request timeout must be a positive, finite timer duration.");
  }
  return timeoutMs;
}

function replyWindow(duration: number): number {
  if (!Number.isFinite(duration) || duration < 0) throw new RangeError("Reply collection windows must be finite and nonnegative.");
  return duration;
}

function connectionTimeoutError(timeoutMs: number): ThalovantConnectionError {
  // Keep the public connection error type, with a stable cause for query
  // deadlines. JS timers can fire before a monotonic-clock comparison rounds up.
  return new ThalovantConnectionError(`Hub connection did not complete within ${timeoutMs}ms.`, {
    cause: new ThalovantTimeoutError("Hub connection deadline expired."),
  });
}

function normalizeConnectTimeout(timeoutMs?: number): number {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 6000;
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
  if (expectedRequest && event.requestId) {
    return expectedRequest === event.requestId;
  }
  if (expectedSession && event.sessionId && expectedSession !== event.sessionId) {
    return false;
  }
  if (!expectedSession && !expectedRequest) {
    return true;
  }
  return Boolean((expectedSession && event.sessionId) || (expectedRequest && event.requestId));
}

function busPayloadFromHivePayload(payload: unknown): BusPayload | undefined {
  if (!isRecord(payload)) return undefined;
  if (typeof payload.type === "string") {
    return {
      type: payload.type,
      data: isRecord(payload.data) ? payload.data : {},
      context: isRecord(payload.context) ? payload.context as EventContext : {},
    };
  }
  if ("payload" in payload) {
    return busPayloadFromHivePayload(payload.payload);
  }
  return undefined;
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

function transportForProtocol(
  identity: ThalovantIdentity,
  protocol: HubProtocol,
  options: { noiseStateDir?: string } = {},
): HiveMindRuntimeTransport {
  if (protocol === "https") {
    return new HiveMindHttpTransport(identity, { noiseStateDir: options.noiseStateDir });
  }
  if (protocol === "wss") {
    if (!identity.endpointFor("wss")) {
      throw new ThalovantUnsupportedProtocolError("WSS is enabled, but the identity does not include a WSS endpoint.");
    }
    return new HiveMindWSSTransport(identity, { noiseStateDir: options.noiseStateDir });
  }
  if (protocol === "mqtt") {
    if (!identity.mqtt) {
      throw new ThalovantUnsupportedProtocolError("MQTT is enabled, but the identity does not include MQTT broker credentials.");
    }
    return new HiveMindMqttTransport(identity, { noiseStateDir: options.noiseStateDir });
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

  ask(text: string, options: { timeoutMs?: number; lang?: string; context?: EventContext; requestId?: string; signal?: AbortSignal; replySettleMs?: number; emptyReplyWaitMs?: number } = {}): Promise<ThalovantReply> {
    return this.client.ask(text, {
      ...options,
      lang: options.lang ?? this.lang,
      context: mergeContext(this.context, options.context),
      sessionId: this.sessionId,
    });
  }

  query(text: string, options: { timeoutMs?: number; lang?: string; context?: EventContext; requestId?: string; queryId?: string; signal?: AbortSignal } = {}): Promise<ThalovantReply> {
    return this.client.query(text, {
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
