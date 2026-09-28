/**
 * The Home Assistant link: a hub asks a home, and the home always answers.
 *
 * A home skill on the hub sends `thalovant.home.request` to the account's Home
 * Assistant connection; the integration hands the utterance to Home
 * Assistant's conversation agent and answers with `thalovant.home.response`.
 * The rules every SDK keeps (`home-link-vectors.json`):
 *
 * - every request gets at most one answer, and never after the hub's 10
 *   seconds, counted from its arrival: the handler's time (9 s by default)
 *   and the reply's own sending both come out of that bound, and a reply that
 *   could only arrive late is not sent at all;
 * - the answer is a reply (OVOS-MSG-1 §5.2), so it goes back the way the
 *   request came;
 * - `speech` is plain text, never markup: tags, comments and processing
 *   instructions removed; numeric character references, the five XML
 *   entities and `&nbsp;` decoded and nothing else; runs of Unicode
 *   White_Space collapsed to one space;
 * - `response_type` is `action_done`, `query_answer` or `error`, and an `error`
 *   names one `error_code`. When the SDK has to answer for a handler -- it
 *   threw, it was too slow, it answered outside the contract -- the speech is
 *   empty: the hub speaks its own sentence for the code, in the device's
 *   language, which the SDK does not know.
 */
import type { EventHandler, ThalovantSubscription } from "./client.js";
import type { BusPayload, EventContext } from "./events.js";
import type { SendOptions } from "./transport.js";
import { ThalovantEvent } from "./events.js";
import { stripSsml } from "./rich.js";

export const HOME_REQUEST = "thalovant.home.request";
export const HOME_RESPONSE = "thalovant.home.response";
/** The hub treats silence after this many milliseconds as `timeout`. */
export const HOME_REQUEST_TIMEOUT_MS = 10_000;
/**
 * How long a handler has by default, in milliseconds: a second inside the
 * hub's bound, so the SDK's own `timeout` answer still lands before the hub
 * gives up.
 */
export const DEFAULT_HOME_HANDLER_TIMEOUT_MS = HOME_REQUEST_TIMEOUT_MS - 1_000;

/** Every `response_type` the contract has. */
export const HOME_RESPONSE_TYPES = Object.freeze(["action_done", "query_answer", "error"] as const);
/** Every `error_code` the contract has; one goes with each `error`. */
export const HOME_ERROR_CODES = Object.freeze([
  "no_intent_match",
  "no_valid_targets",
  "failed_to_handle",
  "unknown",
  "timeout",
  "agent_unavailable",
] as const);

export type HomeResponseType = (typeof HOME_RESPONSE_TYPES)[number];
export type HomeErrorCode = (typeof HOME_ERROR_CODES)[number];

/** One `thalovant.home.request`: what was said, in which language. */
export interface HomeRequest {
  /** `""` when the hub sent none; the answer echoes it either way. */
  readonly requestId: string;
  readonly utterance: string;
  readonly lang: string | null;
  readonly conversationId: string | null;
  /** The event it arrived as; the answer is a reply to it. */
  readonly event: ThalovantEvent;
}

/**
 * What a handler says back. `speech` may carry markup; it is sent as plain
 * text. The wire's own snake_case names (`response_type`, `error_code`, ...)
 * are read too, so a handler can pass an answer it already holds in that form.
 */
export interface HomeAnswer {
  speech?: string;
  /** Default `action_done`. */
  responseType?: HomeResponseType | (string & {});
  /** Only with `error`: one of {@link HOME_ERROR_CODES}. */
  errorCode?: HomeErrorCode | (string & {}) | null;
  continueConversation?: boolean;
  /** Echoed from the request when omitted. */
  conversationId?: string | null;
}

/** The `thalovant.home.response` payload, as it goes on the wire. */
export interface HomeResponsePayload {
  request_id: string;
  speech: string;
  response_type: HomeResponseType;
  error_code?: HomeErrorCode;
  continue_conversation: boolean;
  conversation_id?: string;
  [key: string]: unknown;
}

/** What a handler may return: an answer, a plain string (a spoken `action_done`), or nothing. */
export type HomeHandlerResult = HomeAnswer | Record<string, unknown> | string | null | undefined;

/**
 * Answers one request. `signal` aborts when the SDK stops waiting -- the
 * handler ran out of time, or the caller unsubscribed -- so work it started can
 * stop too.
 */
export type HomeHandler = (
  request: HomeRequest,
  signal: AbortSignal,
) => HomeHandlerResult | Promise<HomeHandlerResult>;

/** Anything that can answer a message along its route: a `ThalovantClient` or a `HubSession`. */
export interface HomeReplier {
  /**
   * `options.signal` aborts when the hub has given up on the request: a reply
   * still queued then is withdrawn rather than sent late.
   */
  reply(
    event: ThalovantEvent,
    msgType: string,
    data: Record<string, unknown>,
    context?: EventContext,
    options?: SendOptions,
  ): Promise<unknown>;
}

/** A replier that can also subscribe, for {@link answerHomeRequests}. */
export interface HomeLink extends HomeReplier {
  on(name: string, handler: EventHandler): ThalovantSubscription | (() => void);
}

export interface HomeAnswerOptions {
  /**
   * How long the handler has, in milliseconds, before the SDK answers
   * `timeout` for it. Default 9000, a second inside the hub's 10 s.
   */
  timeoutMs?: number;
  /**
   * The hub's own bound, in milliseconds from the request's arrival: the
   * handler and the reply's sending both fit inside it. Default 10000.
   */
  hubTimeoutMs?: number;
}

/** Read a request from a delivered event, or from a bus payload `{ type, data, context }`. */
export function homeRequestFromEvent(event: ThalovantEvent | BusPayload): HomeRequest {
  const delivered = event instanceof ThalovantEvent
    ? event
    : new ThalovantEvent(event.type ?? HOME_REQUEST, event.data ?? {}, event.context ?? {}, event);
  const data = isRecord(delivered.data) ? delivered.data : {};
  const text = (key: string): string | null => {
    const value = data[key];
    return typeof value === "string" && value ? value : null;
  };
  return {
    requestId: text("request_id") ?? "",
    utterance: text("utterance") ?? "",
    lang: text("lang"),
    conversationId: text("conversation_id"),
    event: delivered,
  };
}

/**
 * The `thalovant.home.response` payload for `answer`, held to the contract.
 *
 * A plain string is a spoken `action_done`, and nothing at all is `error` /
 * `unknown`. An answer outside the contract -- an unknown `responseType`, or
 * an `error` without a known `errorCode` -- becomes `error` / `unknown`,
 * keeping its speech.
 */
export function homeResponse(request: HomeRequest, answer: HomeHandlerResult): HomeResponsePayload {
  const given = readAnswer(answer);
  let responseType = given.responseType;
  let errorCode = responseType === "error" ? given.errorCode : null;
  if (
    !(HOME_RESPONSE_TYPES as readonly string[]).includes(responseType) ||
    (responseType === "error" && !(HOME_ERROR_CODES as readonly string[]).includes(errorCode ?? ""))
  ) {
    responseType = "error";
    errorCode = "unknown";
  }
  const payload: HomeResponsePayload = {
    request_id: request.requestId,
    speech: plainSpeech(given.speech),
    response_type: responseType as HomeResponseType,
    continue_conversation: given.continueConversation,
  };
  if (errorCode) payload.error_code = errorCode as HomeErrorCode;
  const conversationId = given.conversationId || request.conversationId;
  if (conversationId) payload.conversation_id = conversationId;
  return payload;
}

/**
 * Answer one request: run `handler`, then reply whatever happened.
 *
 * Everything happens inside the hub's bound (`hubTimeoutMs`, 10 s), counted
 * from the call: the hub gives up on a request after that, and an answer it
 * has given up on only confuses the next one. The handler gets `timeoutMs` or
 * what is left of the bound, whichever is less. One that throws is answered
 * `failed_to_handle`, one that does not answer in time `timeout`, each with
 * empty speech -- at the deadline, whether or not the handler returns. The
 * reply gets whatever the handler left: it is never started after the bound,
 * and one still queued when the bound passes is withdrawn.
 *
 * Resolves with the payload sent, or undefined when there was no time left to
 * send it; rejects only when the reply itself could not be sent.
 */
export async function answerHomeRequest(
  link: HomeReplier,
  event: ThalovantEvent | BusPayload,
  handler: HomeHandler,
  options: HomeAnswerOptions = {},
): Promise<HomeResponsePayload | undefined> {
  const arrived = performance.now();
  return answerWithin(link, homeRequestFromEvent(event), handler, handlerTimeout(options.timeoutMs), {
    arrived,
    hubTimeoutMs: hubTimeout(options.hubTimeoutMs),
    controller: new AbortController(),
  });
}

/** Run the handler and send its answer, both inside the hub's bound from `arrived`. */
async function answerWithin(
  link: HomeReplier,
  request: HomeRequest,
  handler: HomeHandler,
  timeoutMs: number,
  bound: { arrived: number; hubTimeoutMs: number; controller: AbortController; stopped?: () => boolean },
): Promise<HomeResponsePayload | undefined> {
  const remaining = (): number => bound.hubTimeoutMs - (performance.now() - bound.arrived);
  const payload = await answerFor(request, handler, Math.max(0, Math.min(timeoutMs, remaining())), bound.controller);
  const left = remaining();
  if (left <= 0 || bound.stopped?.()) return undefined;
  // Withdraws the reply at the bound: one still queued is never sent late.
  const withdraw = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => {
      withdraw.abort();
      resolve("expired");
    }, Math.ceil(left));
  });
  try {
    const outcome = await Promise.race([
      Promise.resolve().then(() => link.reply(request.event, HOME_RESPONSE, payload, undefined, { signal: withdraw.signal })),
      expired,
    ]);
    return outcome === "expired" ? undefined : payload;
  } catch (error) {
    if (withdraw.signal.aborted) return undefined;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Answer every `thalovant.home.request` `link` receives. Returns a function
 * that unsubscribes.
 *
 * `link` is a `ThalovantClient` or a `HubSession`; on a session the
 * subscription outlives every reconnect. Each request is answered on its own,
 * so a slow one does not hold up the next. Unsubscribing aborts the answers
 * still running, and those are not sent. A reply that cannot be sent -- the
 * link is down -- is dropped, since the hub has its own timeout for it.
 */
export function answerHomeRequests(
  link: HomeLink,
  handler: HomeHandler,
  options: HomeAnswerOptions = {},
): () => void {
  const timeoutMs = handlerTimeout(options.timeoutMs);
  const hubTimeoutMs = hubTimeout(options.hubTimeoutMs);
  const running = new Set<AbortController>();
  let stopped = false;
  const subscription = link.on(HOME_REQUEST, (event) => {
    if (stopped) return;
    const arrived = performance.now();
    const controller = new AbortController();
    running.add(controller);
    void answerWithin(link, homeRequestFromEvent(event), handler, timeoutMs, {
      arrived,
      hubTimeoutMs,
      controller,
      stopped: () => stopped,
    })
      .catch(() => undefined)
      .finally(() => running.delete(controller));
  });
  return () => {
    if (stopped) return;
    stopped = true;
    if (typeof subscription === "function") subscription();
    else subscription.close();
    for (const controller of running) controller.abort();
    running.clear();
  };
}

/**
 * Speech a device can say as it is, made in this order: markup removed (see
 * `stripSsml`), character references decoded once (see {@link decodeReferences}),
 * then every run of Unicode White_Space collapsed to one space and the ends
 * trimmed. In that order, so `&lt;b&gt;` stays the text "<b>".
 */
export function plainSpeech(text: string | null | undefined): string {
  if (!text) return "";
  const collapsed = decodeReferences(stripSsml(String(text))).replace(WHITE_SPACE, " ");
  // Runs are single spaces now, so trimming is one character at each end.
  const start = collapsed.startsWith(" ") ? 1 : 0;
  const end = collapsed.length > start && collapsed.endsWith(" ") ? collapsed.length - 1 : collapsed.length;
  return collapsed.slice(start, end);
}

/**
 * The Unicode White_Space property, spelled out: a regular expression's `\s`
 * differs between languages (JavaScript's has U+FEFF and lacks U+0085).
 */
const WHITE_SPACE = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g;

/** The portable set: numeric references, the five XML entities and `&nbsp;`, each with its `;`. */
const REFERENCE = /&(?:#([0-9]{1,7})|#[xX]([0-9A-Fa-f]{1,6})|(amp|lt|gt|quot|apos|nbsp));/g;
const NAMED: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

/**
 * Decode character references once, left to right: numeric ones (`&#72;`,
 * `&#x48;`, `&#X48;`) except 0, surrogates and anything past U+10FFFF, which
 * stay as written; the five XML entities; and `&nbsp;`. Nothing else --
 * `&eacute;` and `&copy;` stay as written, since HTML's list of named
 * references differs between the libraries SDKs use -- and a reference needs
 * its `;`.
 */
export function decodeReferences(text: string): string {
  return text.replace(REFERENCE, (whole: string, decimal?: string, hex?: string, name?: string) => {
    if (name !== undefined) return NAMED[name];
    const codePoint = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex ?? "", 16);
    if (codePoint === 0 || (codePoint >= 0xd800 && codePoint <= 0xdfff) || codePoint > 0x10ffff) return whole;
    return String.fromCodePoint(codePoint);
  });
}

async function answerFor(
  request: HomeRequest,
  handler: HomeHandler,
  timeoutMs: number,
  controller: AbortController,
): Promise<HomeResponsePayload> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = Symbol("expired");
  let answer: HomeHandlerResult;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => handler(request, controller.signal)),
      new Promise<typeof expired>((resolve) => {
        timer = setTimeout(() => resolve(expired), timeoutMs);
      }),
    ]);
    if (result === expired) {
      controller.abort();
      answer = { responseType: "error", errorCode: "timeout" };
    } else {
      answer = result;
    }
  } catch {
    answer = { responseType: "error", errorCode: "failed_to_handle" };
  } finally {
    clearTimeout(timer);
  }
  return homeResponse(request, answer);
}

function readAnswer(answer: HomeHandlerResult): {
  speech: string;
  responseType: string;
  errorCode: string | null;
  continueConversation: boolean;
  conversationId: string | null;
} {
  if (answer === null || answer === undefined) {
    return { speech: "", responseType: "error", errorCode: "unknown", continueConversation: false, conversationId: null };
  }
  if (typeof answer === "string") {
    return { speech: answer, responseType: "action_done", errorCode: null, continueConversation: false, conversationId: null };
  }
  const given = answer as Record<string, unknown>;
  const pick = (camel: string, snake: string): unknown => (given[camel] !== undefined ? given[camel] : given[snake]);
  const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
  const speech = pick("speech", "speech");
  return {
    speech: typeof speech === "string" ? speech : speech === undefined || speech === null ? "" : String(speech),
    responseType: text(pick("responseType", "response_type")) ?? "action_done",
    errorCode: text(pick("errorCode", "error_code")),
    continueConversation: pick("continueConversation", "continue_conversation") === true,
    conversationId: text(pick("conversationId", "conversation_id")),
  };
}

function hubTimeout(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? HOME_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(value) || value < 0 || value > 2_147_483_647) {
    throw new RangeError("The hub's bound must be a finite, non-negative number of milliseconds.");
  }
  return value;
}

function handlerTimeout(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? DEFAULT_HOME_HANDLER_TIMEOUT_MS;
  if (!Number.isFinite(value) || value < 0 || value > 2_147_483_647) {
    throw new RangeError("A home handler timeout must be a finite, non-negative number of milliseconds.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
