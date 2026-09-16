import { FAILURE_EVENTS, EVENT_AUDIO_QUEUE, MAX_AUDIO_CLIP_BYTES, MAX_REPLY_MEDIA_BYTES } from "./constants.js";
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

  get lang(): string | undefined {
    const value = this.data.lang || this.context.lang || this.context.session?.lang;
    return value == null ? undefined : String(value);
  }

  get isAudio(): boolean { return this.name === EVENT_AUDIO_QUEUE; }
  get hasAudio(): boolean { return this.isAudio && typeof this.data.binary_data === "string" && this.data.binary_data.length > 0; }

  /** Decode embedded hex only; never fetch a path or URL supplied by a skill. */
  audioBytes(maxBytes = MAX_AUDIO_CLIP_BYTES): Uint8Array {
    const encoded = this.isAudio ? this.data.binary_data : undefined;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("Invalid audio byte limit.");
    if (typeof encoded !== "string" || !encoded.length) throw new Error("No embedded audio data.");
    if (encoded.length > maxBytes * 2) throw new Error("Embedded audio exceeds the byte limit.");
    // Python bytes.fromhex permits whitespace between bytes, never between nibbles.
    // Scan iteratively: a repeated regex group can exhaust the stack on a valid clip.
    const bytes = new Uint8Array(Math.floor(encoded.length / 2));
    let high = -1, written = 0;
    for (let i = 0; i < encoded.length; i++) {
      const c = encoded.charCodeAt(i);
      if (c === 32 || (c >= 9 && c <= 13)) {
        if (high >= 0) throw new Error("Invalid embedded audio hex.");
        continue;
      }
      const value = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
      if (value < 0) throw new Error("Invalid embedded audio hex.");
      if (high < 0) high = value;
      else { bytes[written++] = high * 16 + value; high = -1; }
    }
    if (high >= 0) throw new Error("Invalid embedded audio hex.");
    return bytes.subarray(0, written);
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
  /** SDK-produced replies always include these; optional for custom reply objects. */
  readonly pipelineIds?: string[];
  readonly skillIds?: string[];
  readonly claimed?: boolean;
  text: string;
  /** Language selected by the runtime, from the first event carrying a hint. */
  readonly lang?: string;
  readonly mediaEvents?: ThalovantEvent[];
  readonly hasAudio?: boolean;
  readonly droppedMedia?: number;
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

/** Ordered string stamps and advisory claim status; never proof of peer identity. */
export function replyClaimMetadata(reply: Pick<ThalovantReply, "events" | "handled" | "ok" | "failureEvent">): {
  pipelineIds: string[]; skillIds: string[]; claimed: boolean;
} {
  const ids = (key: string): string[] => [...new Set(reply.events.map(event => event.context[key])
    .filter((value): value is string => typeof value === "string" && value.length > 0))];
  const pipelineIds = ids("pipeline_id");
  return { pipelineIds, skillIds: ids("skill_id"), claimed: reply.handled && reply.ok && !reply.failureEvent
    && (pipelineIds.length === 0 || pipelineIds.some(stage => !stage.includes("fallback"))) };
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

/**
 * The hive's own frame kinds, which a client may subscribe to.
 *
 * `query` and `cascade` are deliberately absent: they are this client's own
 * request/response traffic and `ask()` already owns them, so subscribing to
 * one would quietly compete for the same replies.
 */
export const HIVE_KINDS = ["broadcast", "propagate", "escalate", "intercom", "rendezvous"] as const;

/**
 * Payload types a BINARY frame can carry, by their wire number.
 *
 * A hub answers `speak:synth` by rendering the utterance and sending one of
 * these back, so a client with no synthesiser of its own can still speak; a
 * file arrives the same way. The wire numbers the type, this names it.
 */
export const BINARY_PAYLOAD_KINDS: Record<number, string> = {
  1: "raw_audio",
  2: "numpy_image",
  3: "file",
  4: "stt_transcribe",
  5: "stt_handle",
  6: "tts_audio",
};

/** A payload type nobody has named still arrives, under its number. */
export function binaryKindName(wireNumber: number): string {
  return BINARY_PAYLOAD_KINDS[wireNumber] ?? `binary:${wireNumber}`;
}

/** A binary frame: the bytes a hub sent, and what it said about them. */
export interface ThalovantBinary {
  /** `tts_audio`, `file`, ... or `binary:<wire number>` for an unnamed type. */
  readonly kind: string;
  /** The payload itself. Never parsed, never decompressed. */
  readonly data: Uint8Array;
  /** Metadata as the hub sent it. */
  readonly metadata: Record<string, unknown>;
  /** What was said, when this is rendered speech. Absent reads as null. */
  readonly utterance: string | null;
  /** The language it was said in. */
  readonly lang: string | null;
  /** The name a file arrived under. An empty name is no name. */
  readonly fileName: string | null;
}

/** Read a hub's metadata into the shape above; absent and empty both read null. */
export function binaryFrame(kind: string, data: Uint8Array, metadata: Record<string, unknown>): ThalovantBinary {
  const text = (key: string): string | null => {
    const value = metadata[key];
    return typeof value === "string" && value !== "" ? value : null;
  };
  return {
    kind,
    data,
    metadata,
    utterance: text("utterance"),
    lang: text("lang"),
    fileName: text("file_name"),
  };
}

export type HiveKind = (typeof HIVE_KINDS)[number];

/**
 * Session fields a client carries from one turn of a conversation to the next.
 *
 * A hub keeps nothing for a *named* session: OVOS-SESSION-2 §2.2 makes the
 * orchestrator stateless for those, so the carrier a client sends is the whole
 * snapshot and whatever the last turn activated is discarded the moment it
 * ends. Without `converse_handlers` the converse pipeline has no skill to poll
 * and every follow-up falls past it to the fallback.
 *
 * An allow-list, not a deny-list. Deliberately absent: the caller's own
 * per-turn settings (`lang`, `pipeline`, `site_id`), because a satellite
 * decides the language per utterance and a remembered one would silently
 * outrank it; and the live device flags, which describe a moment that has
 * passed by the time the next turn is sent.
 */
export const CONVERSATION_SESSION_FIELDS = [
  "converse_handlers",
  "active_handlers",
  "active_skills",
  "context",
  "utterance_states",
  "response_mode",
] as const;

function carried(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

/**
 * Fill the conversation fields of `session` from the hub's last reply.
 *
 * This turn's own values win: a field the caller set is never overwritten, only
 * one it left out is taken from the turn before.
 */
export function carryConversation(
  previous: Record<string, unknown> | undefined,
  session: Record<string, unknown>,
): Record<string, unknown> {
  if (!previous) return session;
  const next: Record<string, unknown> = { ...session };
  for (const field of CONVERSATION_SESSION_FIELDS) {
    if (field in next) continue;
    if (carried(previous[field])) next[field] = previous[field];
  }
  return next;
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

/** @internal Bound skill audio before retaining it in a reply. */
export class ReplyMediaBudget {
  dropped = 0;
  private chars = 0;
  private readonly seen = new WeakSet<object>();
  accept(event: ThalovantEvent): boolean {
    if (!event.isAudio) return true;
    if (typeof event.raw === "object" && event.raw !== null) {
      if (this.seen.has(event.raw)) return false;
    }
    const encoded = event.data.binary_data;
    if (typeof encoded !== "string" || encoded.length > MAX_AUDIO_CLIP_BYTES * 2
        || this.chars + encoded.length > MAX_REPLY_MEDIA_BYTES * 2) {
      this.dropped++;
      return false;
    }
    if (typeof event.raw === "object" && event.raw !== null) this.seen.add(event.raw);
    this.chars += encoded.length;
    return true;
  }
}
