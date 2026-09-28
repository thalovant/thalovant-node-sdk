/**
 * The Home Assistant link: a hub asks a home, and the home always answers.
 *
 * A home skill on the hub sends `thalovant.home.request` to the account's Home
 * Assistant connection; the integration hands the utterance to Home
 * Assistant's conversation agent and answers with `thalovant.home.response`.
 * The rules every SDK keeps (`home-link-vectors.json`):
 *
 * - every request gets exactly one answer, within the hub's 10 seconds;
 * - the answer is a reply (OVOS-MSG-1 §5.2), so it goes back the way the
 *   request came;
 * - `speech` is plain text, never markup;
 * - `response_type` is `action_done`, `query_answer` or `error`, and an `error`
 *   names one `error_code`. When the SDK has to answer for a handler -- it
 *   threw, it was too slow, it answered outside the contract -- the speech is
 *   empty: the hub speaks its own sentence for the code, in the device's
 *   language, which the SDK does not know.
 */
import type { EventHandler, ThalovantSubscription } from "./client.js";
import type { BusPayload, EventContext } from "./events.js";
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
  reply(
    event: ThalovantEvent,
    msgType: string,
    data: Record<string, unknown>,
    context?: EventContext,
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
 * The handler is bounded by `timeoutMs`. One that throws is answered
 * `failed_to_handle`, one that does not answer in time `timeout`, each with
 * empty speech. Resolves with the payload sent; rejects only when the reply
 * itself could not be sent.
 */
export async function answerHomeRequest(
  link: HomeReplier,
  event: ThalovantEvent | BusPayload,
  handler: HomeHandler,
  options: HomeAnswerOptions = {},
): Promise<HomeResponsePayload> {
  const request = homeRequestFromEvent(event);
  const payload = await answerFor(request, handler, handlerTimeout(options.timeoutMs), new AbortController());
  await link.reply(request.event, HOME_RESPONSE, payload);
  return payload;
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
  const running = new Set<AbortController>();
  let stopped = false;
  const subscription = link.on(HOME_REQUEST, (event) => {
    if (stopped) return;
    const controller = new AbortController();
    running.add(controller);
    const request = homeRequestFromEvent(event);
    void answerFor(request, handler, timeoutMs, controller)
      .then(async (payload) => {
        if (stopped) return;
        await link.reply(request.event, HOME_RESPONSE, payload);
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

/** Speech a device can say as it is: markup removed, entities decoded, whitespace collapsed. */
export function plainSpeech(text: string | null | undefined): string {
  if (!text) return "";
  return decodeEntities(stripSsml(String(text))).replace(/\s+/g, " ").trim();
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

/**
 * Named character references a device's speech may carry: the XML five, the
 * Latin-1 block (U+00A0 onwards, in order) and the common typographic ones.
 */
const LATIN1_ENTITIES =
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 " +
  "acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde " +
  "Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc " +
  "Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml " +
  "aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc " +
  "otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml";
const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map<string, string>([
  ["quot", '"'], ["amp", "&"], ["apos", "'"], ["lt", "<"], ["gt", ">"],
  ...LATIN1_ENTITIES.split(" ").map((name, index): [string, string] => [name, String.fromCodePoint(0xa0 + index)]),
  ...([
    ["OElig", 0x152], ["oelig", 0x153], ["Scaron", 0x160], ["scaron", 0x161], ["Yuml", 0x178], ["fnof", 0x192],
    ["circ", 0x2c6], ["tilde", 0x2dc], ["ensp", 0x2002], ["emsp", 0x2003], ["thinsp", 0x2009], ["zwnj", 0x200c],
    ["zwj", 0x200d], ["lrm", 0x200e], ["rlm", 0x200f], ["ndash", 0x2013], ["mdash", 0x2014], ["lsquo", 0x2018],
    ["rsquo", 0x2019], ["sbquo", 0x201a], ["ldquo", 0x201c], ["rdquo", 0x201d], ["bdquo", 0x201e],
    ["dagger", 0x2020], ["Dagger", 0x2021], ["bull", 0x2022], ["hellip", 0x2026], ["permil", 0x2030],
    ["prime", 0x2032], ["Prime", 0x2033], ["lsaquo", 0x2039], ["rsaquo", 0x203a], ["oline", 0x203e],
    ["frasl", 0x2044], ["euro", 0x20ac], ["trade", 0x2122], ["larr", 0x2190], ["uarr", 0x2191],
    ["rarr", 0x2192], ["darr", 0x2193], ["harr", 0x2194], ["minus", 0x2212],
  ] as const).map(([name, codePoint]): [string, string] => [name, String.fromCodePoint(codePoint)]),
]);

/**
 * Decode character references: numeric ones (`&#39;`, `&#x27;`, the `;`
 * optional) and the named ones above (`;` required). A reference that names no
 * character is left as it is; one that names something no voice can say -- a
 * control character, a surrogate, past U+10FFFF -- is dropped or replaced.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+);?|#[xX]([0-9a-fA-F]+);?|([A-Za-z][A-Za-z0-9]{1,31});)/g, (whole, decimal, hex, name) => {
    if (name !== undefined) return NAMED_ENTITIES.get(name) ?? whole;
    const codePoint = Number.parseInt(decimal ?? hex, decimal !== undefined ? 10 : 16);
    if (!Number.isFinite(codePoint) || codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      return "�";
    }
    if ((codePoint < 0x20 && ![0x09, 0x0a, 0x0d].includes(codePoint)) || (codePoint >= 0x7f && codePoint <= 0x9f)) return "";
    return String.fromCodePoint(codePoint);
  });
}
