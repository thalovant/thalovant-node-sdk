import { replyClaimMetadata } from "./events.js";
import {
  EVENT_AUDIO_QUEUE,
  MEDIA_EVENTS,
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
  carryConversation,
  CONVERSATION_SESSION_FIELDS,
  HIVE_KINDS,
  BusPayload,
  eventFromBusPayload,
  eventMatchesContext,
  EventContext,
  mergeContext,
  newRequestId,
  newSessionId,
  type ThalovantBinary,
  ThalovantEvent,
  ThalovantReply,
  ReplyMediaBudget,
  utterancePayload,
} from "./events.js";
import { requestContext, type RequestContextOptions } from "./context.js";
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
  /**
   * The conversation each session id is in the middle of.
   *
   * A hub is stateless for a named session, so what the last turn
   * activated comes back on ovos.utterance.handled and has to be sent
   * again with the next utterance or it is gone. Bounded, because a
   * long-lived client handed a fresh session id per turn must not
   * accumulate one entry per turn for ever.
   */
  private readonly conversations = new Map<string, Record<string, unknown>>();
  private static readonly MAX_REMEMBERED_CONVERSATIONS = 32;

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
  /**
   * Listen to one of the hive's own frame kinds.
   *
   * A hub relays more than this client's conversation: `broadcast` is aimed
   * down at every child, `propagate` walks the whole hive, `escalate` goes up
   * to the parent, `intercom` is addressed node to node, and `rendezvous` is
   * the mailbox peers use to find each other through NAT.
   *
   * Returns a function that unsubscribes.
   */
  onHive(kind: string, handler: (frame: unknown) => void): () => void {
    if (!(HIVE_KINDS as readonly string[]).includes(kind)) {
      // Named rather than silently never firing: subscribing to "bus" or to a
      // typo is the kind of mistake that looks like a quiet hub.
      throw new TypeError(`${kind} is not a hive frame kind; expected one of ${HIVE_KINDS.join(", ")}`);
    }
    const listener = (event: Event) => handler((event as CustomEvent).detail);
    this.transport.addEventListener?.(kind, listener);
    return () => this.transport.removeEventListener?.(kind, listener);
  }

  /**
   * Listen for binary frames: rendered speech, and files.
   *
   * This is what a hub sends back for `speak:synth` -- the audio itself, so a
   * client with no synthesiser can still speak -- and how it hands over a
   * file. Delivered by subscription and not on a reply, because a binary frame
   * carries no request id: it cannot be attributed to one `ask()`. Its
   * `utterance` is the only thread back to a turn.
   *
   * `handler` runs on the transport's receive path, in subscription order,
   * like every other subscription here. A handler that blocks holds up the
   * next frame, so hand slow work -- decoding, playback, writing to disk -- to
   * something of your own.
   *
   * Returns a function that unsubscribes.
   */
  onBinary(handler: (frame: ThalovantBinary) => void): () => void {
    const listener = (event: Event) => handler((event as CustomEvent<ThalovantBinary>).detail);
    this.transport.addEventListener?.("binary", listener);
    return () => this.transport.removeEventListener?.("binary", listener);
  }

  /** Send an event across the hive; every node sees it once. */
  async propagate(eventType: string, data: Record<string, unknown> = {}, context: EventContext = {}): Promise<void> {
    return this.sendHive("propagate", eventType, data, context);
  }

  /** Send an event up to the parent node. */
  async escalate(eventType: string, data: Record<string, unknown> = {}, context: EventContext = {}): Promise<void> {
    return this.sendHive("escalate", eventType, data, context);
  }

  /**
   * Send an event down to every child of this hub. **Admin only.**
   *
   * A hub requires admin standing and the `can_broadcast` grant, and a client
   * that sends one without them is not answered with an error -- it is
   * disconnected for misbehaviour. Nothing here can check first: a hub's HELLO
   * carries its public key, peer name and node id, and nothing about what this
   * client may do, so a refusal arrives as a closed socket on the next read.
   */
  async broadcast(eventType: string, data: Record<string, unknown> = {}, context: EventContext = {}): Promise<void> {
    return this.sendHive("broadcast", eventType, data, context);
  }

  /**
   * Wrap a bus event in a hive frame and send it.
   *
   * Nested on purpose: a hub reads `message.payload` of a mesh frame as a
   * HiveMessage of its own and re-stamps its route on it before forwarding, so
   * a flat frame would lose the route.
   */
  private async sendHive(kind: string, eventType: string, data: Record<string, unknown>, context: EventContext): Promise<void> {
    const type = eventType.trim();
    if (!type) throw new TypeError("A hive frame needs a non-empty event type.");
    if (!this.transport.sendHiveMessage) {
      throw new ThalovantUnsupportedProtocolError("This transport does not support HiveMind frames.");
    }
    await this.connect();
    await this.transport.sendHiveMessage({
      msg_type: kind,
      payload: {
        msg_type: "bus",
        payload: { type, data, context: this.contextWithIdentityMetadata(context) },
        metadata: {},
        route: [],
      },
      metadata: {},
      route: [],
    } as never);
  }

  /** Keep the session a hub returned, to send with the next utterance. */
  private rememberConversation(sessionId: string, context: EventContext | undefined): void {
    const session = (context?.session ?? undefined) as Record<string, unknown> | undefined;
    const kept: Record<string, unknown> = {};
    for (const field of CONVERSATION_SESSION_FIELDS) {
      const value = session?.[field];
      if (value === undefined || value === null) continue;
      if (Array.isArray(value) ? value.length === 0 : typeof value === "object" && Object.keys(value as object).length === 0) continue;
      kept[field] = value;
    }
    // Forgetting is the state, not the absence of one: a turn that ended with
    // nothing active must not leave the old entry behind to resurrect it.
    this.conversations.delete(sessionId);
    if (!Object.keys(kept).length) return;
    this.conversations.set(sessionId, kept);
    while (this.conversations.size > ThalovantClient.MAX_REMEMBERED_CONVERSATIONS) {
      const oldest = this.conversations.keys().next();
      if (oldest.done) break;
      this.conversations.delete(oldest.value);
    }
  }

  /** Put the last turn's conversation state back into this turn. */
  private continueConversation(context: EventContext, sessionId: string): EventContext {
    const previous = this.conversations.get(sessionId);
    if (!previous) return context;
    const session = (context.session ?? {}) as Record<string, unknown>;
    const carried = carryConversation(previous, session);
    if (carried === session) return context;
    return { ...context, session: carried } as EventContext;
  }

  async ask(
    text: string,
    options: RequestContextOptions & {
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
    const context = contextWithCorrelation(
      this.continueConversation(this.contextWithIdentityMetadata(requestContext(options.context, options) ?? {}), sessionId),
      { sessionId, siteId: this.identity.siteId, lang, requestId },
    );
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
    const mediaBudget = new ReplyMediaBudget();
    let failureEvent: ThalovantEvent | undefined;
    let softFailureEvent: ThalovantEvent | undefined;
    let terminal = false;
    let handled = false;
    // Whether the hub has said what the conversation now is, and what it said.
    let sawHandled = false;
    let handledContext: EventContext | undefined;
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
      const detail = (raw as CustomEvent).detail;
      const event = eventFromBusPayload(detail, detail);
      if (!eventMatchesRequiredCorrelation(event, listenerContext)) return;
      // Ahead of every gate below. The end of the turn is the one place a hub
      // states what the conversation now is, and whether this reply is still
      // collecting, already settled or already failed says nothing about what
      // the next one will need. A short settle window -- zero most of all --
      // completes the reply before this frame arrives.
      if (event.name === EVENT_UTTERANCE_HANDLED) {
        sawHandled = true;
        this.rememberConversation(sessionId, event.context);
        // And under the id the hub answered with, when it differs: a satellite
        // reuses its own id, an ordinary caller is handed the reply's.
        if (event.sessionId && event.sessionId !== sessionId) {
          this.rememberConversation(event.sessionId, event.context);
        }
        handledContext = event.context;
      }
      if (terminal) return;
      if (performance.now() >= deadline) { complete(); return; }
      if (!mediaBudget.accept(event)) return;
      switch (event.name) {
        case EVENT_AUDIO_QUEUE:
          events.push(event);
          break;
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
          // The end of the turn is the one place a hub states what the
          // conversation now is, and it keeps none of it for a named session.
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
      const claimMetadata = () => replyClaimMetadata({ events, handled: !effectiveFailure, ok: !effectiveFailure, failureEvent: effectiveFailure });
      return {
        get pipelineIds(): string[] { return claimMetadata().pipelineIds; },
        get skillIds(): string[] { return claimMetadata().skillIds; },
        get claimed(): boolean { return claimMetadata().claimed; },
        text: replyText,
        displayText: stripSsml(replyText),
        utterances: fragments,
        lang: events.map(event => event.lang).find(Boolean),
        mediaEvents: events.filter(event => MEDIA_EVENTS.has(event.name)),
        hasAudio: events.some(event => event.isAudio),
        droppedMedia: mediaBudget.dropped,
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
      // Removed unconditionally: this SDK guarantees no listener outlives an
      // ask, and its suite checks that immediately on return. Holding one for
      // a moment to catch a late `ovos.utterance.handled` would break that
      // guarantee, so the remaining half of this -- a reply that settles
      // before the hub says what the conversation now is -- needs a decision
      // about latency, not a longer listener.
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
    const mediaBudget = new ReplyMediaBudget();
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
      if (!mediaBudget.accept(event)) return;
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
      const claimMetadata = () => replyClaimMetadata({ events, handled: !failureEvent, ok: !failureEvent, failureEvent });
      return {
        get pipelineIds(): string[] { return claimMetadata().pipelineIds; },
        get skillIds(): string[] { return claimMetadata().skillIds; },
        get claimed(): boolean { return claimMetadata().claimed; },
        text: replyText,
        displayText: stripSsml(replyText),
        utterances: fragments,
        lang: events.map(event => event.lang).find(Boolean),
        mediaEvents: events.filter(event => MEDIA_EVENTS.has(event.name)),
        hasAudio: events.some(event => event.isAudio),
        droppedMedia: mediaBudget.dropped,
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

  ask(text: string, options: RequestContextOptions & { timeoutMs?: number; lang?: string; context?: EventContext; requestId?: string; signal?: AbortSignal; replySettleMs?: number; emptyReplyWaitMs?: number } = {}): Promise<ThalovantReply> {
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
