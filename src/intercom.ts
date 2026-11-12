/**
 * Intercom: say a short text aloud on a household hub's speakers.
 *
 * An announcement is a text of at most 280 characters, spoken by each chosen
 * speaker's own text-to-speech. It is announce-only: no two-way audio.
 * Intercom does not record or store speech; while an urgent alert sounds, the
 * hub only checks whether a reply is an acknowledgement. **It is not a
 * certified safety system** and does not replace smoke or CO alarms, medical
 * alert devices or emergency services.
 *
 * The API does not store the text: it keeps a keyed hash of it (HMAC-SHA256,
 * server-side secret) and its length, the targets, each speaker's result and
 * the actor. (The hub's own message bus and each speaker's text-to-speech are
 * outside the platform's control.) This module holds the models of the
 * `/v1/hubs/{hub_id}/intercom` routes, their readers and the request
 * builders; the methods live on {@link ThalovantControlPlane} (`announce()`,
 * `cancelAnnouncement()`, `getAnnouncement()`, `listAnnouncements()`,
 * `listIntercomSpeakers()`, `updateIntercomSpeaker()`, `getIntercomSettings()`
 * and `setIntercomSettings()`). The names say *announce* and *intercom*, never
 * a bare `intercom`: the HiveMind mesh already has an `intercom` frame, which
 * is a different thing.
 *
 * Scopes: `intercom:read` for the reads, `intercom:send` for `announce()` and
 * `cancelAnnouncement()`, `intercom:urgent` **in addition to** `intercom:send`
 * for an urgent announcement (`priority: "urgent"`, and so every `repeat`), and
 * `hubs:write` (owner, manager or admin of the hub) for settings and speakers.
 * A token without `intercom:urgent` is refused before anything is spent (403
 * `urgent_scope_required`, {@link ThalovantUrgentScopeRequiredError}).
 *
 * Idempotency: pass a fresh unique `idempotencyKey` (a `crypto.randomUUID()`)
 * for each announcement you mean to send. The same key replays the stored
 * answer (`Idempotency-Replayed: true`) and **never sends again**, whatever its
 * status; a replayed `failed` announcement stays `failed`. To send the same
 * text again on purpose, use a new key.
 *
 * Models keep the API's snake_case field names, as the chat apps models do.
 * Every status is an open enumeration: a value the SDK does not know yet is
 * kept as the string the API sent. Browser-safe: no `node:` imports.
 */

import { ThalovantApiError } from "./errors.js";

type JsonRecord = Record<string, unknown>;

/**
 * Why intercom cannot run on a hub; open. `platform`: the platform's own
 * switch is off (it wins over the others); then `plan`, `kid_hub`, `public_hub`.
 */
export type IntercomUnavailableReason = "platform" | "plan" | "kid_hub" | "public_hub" | (string & {});
/** `normal` waits for the hub's answer; `urgent` may repeat until acknowledged. */
export type IntercomPriority = "normal" | "urgent";
/** `sending` while an urgent announcement is still repeating; `cancelled` after `cancelAnnouncement()`; open. */
export type AnnouncementStatus = "completed" | "partial" | "failed" | "sending" | "cancelled" | (string & {});
/** What happened for one speaker; open. */
export type DeliveryStatus =
  | "delivered" | "acked" | "offline" | "skipped_dnd" | "skipped_not_receiving" | "failed" | (string & {});

/** Longest announcement, in characters (code points). */
export const MAX_ANNOUNCEMENT_TEXT = 280;
/** Most speakers one announcement may name. */
export const MAX_ANNOUNCEMENT_SPEAKERS = 50;
/** Most repeats of an urgent announcement. */
export const MAX_REPEAT_TIMES = 10;
/** Shortest and longest repeat interval, in seconds. */
export const MIN_REPEAT_INTERVAL_SECONDS = 5;
export const MAX_REPEAT_INTERVAL_SECONDS = 120;
/** Limits of a speaker's policy. */
export const MAX_ROOM_LENGTH = 64;
export const MAX_GROUP_LENGTH = 32;
export const MAX_GROUPS = 8;
/** Longest name in a `speakers`, `rooms` or `groups` target, and most names in one list. */
export const MAX_TARGET_NAME_LENGTH = 64;
export const MAX_TARGET_NAMES = 50;
/** Longest `Idempotency-Key` the API takes. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
/** Longest IANA timezone name the API takes. */
export const MAX_TIMEZONE_LENGTH = 64;

/**
 * The scopes of the intercom routes. `intercom:urgent` is needed IN ADDITION to
 * `intercom:send` for an urgent announcement; it is not implied by anything and
 * implies nothing. Changing settings or a speaker needs `hubs:write`.
 */
export const INTERCOM_READ_SCOPE = "intercom:read";
export const INTERCOM_SEND_SCOPE = "intercom:send";
export const INTERCOM_URGENT_SCOPE = "intercom:urgent";

/**
 * What a delivery's `detail` can be: a fixed code, never free text. Treat a
 * value that is not in this set as opaque; it is kept as sent.
 */
export const DELIVERY_DETAIL_CODES: ReadonlySet<string> = new Set([
  "disabled", "sender_not_allowed", "rate_limited", "invalid_text", "text_too_long", "invalid_priority",
  "too_many_targets", "no_targets", "internal_error", "duplicate_id", "busy", "not_running", "invalid_id",
  "policy_changed", "dnd_unreadable", "cancelled", "intercom_disabled", "intercom_disabled_platform",
  "no_result", "unknown_status", "no_matching_speakers", "hub_no_response", "hub_unreachable", "hub_not_ready",
  "hub_transport_error", "skill_not_installed", "stopped",
]);

/**
 * A hub's intercom switch (`GET /v1/hubs/{id}/intercom/settings`). `enabled`
 * is true only when the hub's switch is on AND `unavailable_reason` is null.
 */
export interface IntercomSettings {
  enabled: boolean;
  plan_allowed: boolean;
  unavailable_reason: IntercomUnavailableReason | null;
}

/** Quiet hours: `HH:MM` start and end in an IANA timezone (UTC when null). */
export interface IntercomQuietHours {
  start: string;
  end: string;
  timezone: string | null;
}

/** Do not disturb: a normal announcement is skipped inside quiet hours; an urgent one is not. */
export interface IntercomDnd {
  enabled: boolean;
  quiet_hours: IntercomQuietHours | null;
}

/** A speaker's intercom policy. `receive` is false until somebody turns it on. */
export interface IntercomPolicy {
  receive: boolean;
  room: string | null;
  groups: string[];
  dnd: IntercomDnd;
}

/**
 * A connection of the hub that may be spoken to, with presence and policy.
 */
export interface IntercomSpeaker {
  client_id: string;
  slug: string | null;
  name: string | null;
  /**
   * The connection kind (`voice_satellite`, `web_chat`, `developer`,
   * `embedded`, `home_assistant`; any other reads `voice_satellite`, the API's
   * own rule).
   */
  kind: string;
  /**
   * The EFFECTIVE "can this connection play speech": true by default for a
   * `voice_satellite` and `web_chat`, false for `home_assistant`, `developer`
   * and `embedded` unless its owner declared `spec.intercom.can_play: true` on
   * the connection (`PATCH /v1/clients/{id}`, never on the speaker). One that
   * cannot is listed (grey it out) but cannot be given `receive: true` (422
   * `not_a_speaker`), is never part of `all`, a room or a group, and naming it
   * in an announcement is refused.
   */
  can_play: boolean;
  online: boolean;
  last_seen_at: string | null;
  intercom: IntercomPolicy;
  /**
   * Set on the answer to `updateIntercomSpeaker()`: `false` while the hub may
   * hold an out-of-date consent map (the push failed and is retried in the
   * background), so show "Changes may take a moment to reach the home". null
   * when the API did not say (a list item: the list carries its own).
   */
  policy_synced: boolean | null;
}

/**
 * What happened for one speaker. `delivered` means the hub handed the speech
 * to that speaker's connection; there is no playback receipt, so it does not
 * prove the sound came out or that anybody heard it. Only `acked` (an urgent
 * announcement somebody answered) is a person's answer, and `failed` is not
 * proof that nothing was spoken.
 */
export interface IntercomDelivery {
  client_id: string | null;
  slug: string | null;
  name: string | null;
  status: DeliveryStatus;
  at: string | null;
  /** One of {@link DELIVERY_DETAIL_CODES} or null: a fixed code, never free text; unknown codes are kept as sent. */
  detail: string | null;
}

/** An announcement and its deliveries. The text is never part of it: the platform keeps none. */
export interface Announcement {
  id: string;
  status: AnnouncementStatus;
  priority: IntercomPriority | (string & {});
  created_at: string | null;
  deliveries: IntercomDelivery[];
  /** The display name of a client of the hub, or the literal `"unknown"`. */
  acked_by: string | null;
  /**
   * Only on the answer to `cancelAnnouncement()`: `false` means the hub could
   * not confirm the cancel (the record is `cancelled` anyway), so speech
   * already queued on the hub may still play. Absent on every other answer.
   */
  hub_confirmed?: boolean;
  /**
   * True when this answer is the STORED announcement for an `idempotencyKey`
   * the hub had seen before (the response header `Idempotency-Replayed: true`):
   * nothing new was sent, whatever its status. False on a first answer and on
   * every read. Do not clear what a person typed, or say "sent", on a replayed
   * answer without saying that nothing new was sent.
   */
  replayed: boolean;
}

/** A page of announcements, newest first; `next_cursor` is null on the last page. */
export interface AnnouncementList {
  items: Announcement[];
  next_cursor: string | null;
}

/**
 * Every connection of the hub, as speakers (the platform's own Intercom client
 * is not listed).
 */
export interface IntercomSpeakerList {
  items: IntercomSpeaker[];
  /**
   * `false` while the hub may hold an out-of-date consent map (a push failed
   * and is retried in the background): a speaker whose `receive` was just
   * turned off can still be spoken to by a routine until it clears. `true` when
   * nothing is pending and while intercom is off; null when the API did not say.
   */
  policy_synced: boolean | null;
  /** The hub's reason (the same as `getIntercomSettings()`; `platform` when intercom is off platform-wide), or null. */
  unavailable_reason: IntercomUnavailableReason | null;
}

/** Whom to speak to: exactly one of the four. */
export type IntercomTargets =
  | { all: true }
  | { speakers: readonly string[] }
  | { rooms: readonly string[] }
  | { groups: readonly string[] };

/** How an urgent announcement repeats: `times` 1-10, `interval_seconds` 5-120. */
export interface IntercomRepeat {
  times: number;
  interval_seconds: number;
}

/** What {@link ThalovantControlPlane.announce} takes. */
export interface AnnounceOptions {
  /**
   * 1-280 characters after NFC normalisation and trimming, with no `<` or `>`,
   * no control, bidirectional or other invisible format characters (the
   * zero-width joiner and non-joiner are allowed), no lone surrogates, no
   * private-use characters and no line or paragraph separators: the API's own
   * rule, checked before anything is sent. It is spoken aloud in a home.
   */
  text: string;
  targets: IntercomTargets;
  /** `normal` (default) or `urgent`. */
  /** `normal` (default) or `urgent`: urgent (and so every `repeat`) needs the scope `intercom:urgent` as well as `intercom:send`. */
  priority?: IntercomPriority;
  /** Urgent only. */
  repeat?: IntercomRepeat;
  /** A language tag such as `en-US` or `fr`. */
  lang?: string;
  /**
   * Sent as `Idempotency-Key` when given; never generated; at most 128
   * printable ASCII characters. Use a fresh unique key (a `crypto.randomUUID()`)
   * per announcement you mean to send: the same key replays the stored result
   * for 24 hours and never sends again (the answer has `replayed: true`), a
   * replayed `failed` announcement stays `failed`, and to send again on purpose
   * you need a new key.
   */
  idempotencyKey?: string;
  /** Poll a `sending` announcement until it completes. */
  wait?: boolean;
  /** Longest wait, default `times * interval_seconds * 1000 + 15000`; the latest answer is returned on timeout. */
  waitTimeoutMs?: number;
  /** Poll interval, default 2000. */
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

/**
 * What {@link ThalovantControlPlane.updateIntercomSpeaker} takes: only what is
 * present is sent; `room: null` clears it. Only these four fields exist: any
 * other key (also inside `dnd` and `quiet_hours`) is refused. `dnd` enabled
 * needs `quiet_hours` with a valid IANA `timezone` and `start !== end`. `dnd`
 * replaces the speaker's whole do-not-disturb setting: to change `enabled` and
 * keep its quiet hours, send the hours again.
 */
export interface IntercomSpeakerChanges {
  receive?: boolean;
  room?: string | null;
  groups?: readonly string[];
  dnd?: { enabled: boolean; quiet_hours?: IntercomQuietHours | null };
}

/** What {@link ThalovantControlPlane.listAnnouncements} takes. */
export interface AnnouncementListOptions {
  limit?: number;
  cursor?: string;
}

/**
 * What an announcement may not hold: controls (Cc), format characters (Cf:
 * bidirectional overrides and isolates, zero-width spaces, tag characters),
 * lone surrogates (Cs), private use (Co), line and paragraph separators (Zl,
 * Zp). The two joiners below are the exception.
 */
const REFUSED_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u;
const LONE_SURROGATE = /\p{Cs}/u;
/** The zero-width non-joiner and joiner, which scripts and emoji sequences need. */
const JOINERS = new Set([0x200c, 0x200d]);
/** What Python's `str.isspace` calls white space: the API trims with it, so the SDK does too. */
const SPACE_CODE_POINTS = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000]);
const LANG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
/** The shape of an IANA timezone name. */
const ZONE_SHAPE = /^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)*$/;
const CLOCK = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const ID_UNSAFE = new RegExp("[/?#\\\\\\u0000-\\u001f\\u007f-\\u009f]", "u");

/**
 * @internal An id (hub, client or announcement) fit to be one path segment, or
 * an error before any request. Refused: anything but a string, an empty or
 * blank one, `.` and `..` (dot segments, which a URL resolver collapses into
 * another path), and any id holding `/`, `?`, `#`, a backslash or a control
 * character.
 */
export function intercomId(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a non-empty string.`);
  if (value === "." || value === ".." || ID_UNSAFE.test(value)) {
    throw new RangeError(
      `${name} is not a valid id: it is a dot segment or holds '/', '?', '#', a backslash or a control character.`,
    );
  }
  return value;
}

function isSpace(codePoint: number): boolean {
  return SPACE_CODE_POINTS.has(codePoint) || (codePoint >= 0x2000 && codePoint <= 0x200a);
}

function pyStrip(text: string): string {
  const chars = Array.from(text);
  let from = 0;
  let to = chars.length;
  while (from < to && isSpace(chars[from].codePointAt(0)!)) from++;
  while (to > from && isSpace(chars[to - 1].codePointAt(0)!)) to--;
  return chars.slice(from, to).join("");
}

/**
 * The text as it is sent: NFC-normalised, trimmed, 1-280 characters, or an
 * error before any request. The API's own rule, applied first (one rule
 * everywhere): no `<` or `>` (a speaker's text-to-speech may read them as
 * markup), no control characters (a newline or a tab included), no
 * bidirectional overrides or isolates or other invisible format characters
 * (the zero-width joiner and non-joiner, which scripts and emoji need, are
 * allowed), no lone surrogates, no private-use characters and no line or
 * paragraph separators. The text is refused rather than rewritten, and an
 * error never echoes it.
 */
export function announcementText(text: string): string {
  if (typeof text !== "string") throw new TypeError("An announcement's text must be a string.");
  if (LONE_SURROGATE.test(text)) throw new RangeError("An announcement's text must be valid Unicode (no lone surrogates).");
  const trimmed = pyStrip(text.normalize("NFC"));
  if (!trimmed) throw new RangeError("An announcement's text must not be empty.");
  const characters = Array.from(trimmed);
  if (characters.length > MAX_ANNOUNCEMENT_TEXT) {
    throw new RangeError(`An announcement's text is at most ${MAX_ANNOUNCEMENT_TEXT} characters.`);
  }
  for (const character of characters) {
    if (character === "<" || character === ">") {
      throw new RangeError("An announcement's text must not contain markup characters (< or >).");
    }
    if (REFUSED_CHARS.test(character) && !JOINERS.has(character.codePointAt(0)!)) {
      throw new RangeError("An announcement's text must not contain control, bidirectional, format or private-use characters.");
    }
  }
  return trimmed;
}

/**
 * @internal An `Idempotency-Key` fit to send: a string of 1-128 printable ASCII
 * characters. Use a fresh unique key (a `crypto.randomUUID()`) for each
 * announcement you mean to send: the same key replays the stored answer and
 * never sends again.
 */
export function idempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("idempotencyKey must be a non-empty string when given.");
  if (value.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new RangeError(`idempotencyKey is at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`);
  }
  if (!/^[\x20-\x7e]+$/.test(value)) throw new RangeError("idempotencyKey must be printable ASCII.");
  return value;
}

/** @internal The `POST .../intercom/announce` body. It holds the text: never log it. */
export function announceBody(options: AnnounceOptions): JsonRecord {
  const priority = options.priority ?? "normal";
  if (priority !== "normal" && priority !== "urgent") throw new RangeError('priority must be "normal" or "urgent".');
  const body: JsonRecord = {
    text: announcementText(options.text),
    targets: targetsBody(options.targets),
    priority,
  };
  if (options.repeat !== undefined) {
    if (priority !== "urgent") throw new RangeError("repeat is only for urgent announcements.");
    const { times, interval_seconds } = options.repeat;
    if (!Number.isInteger(times) || times < 1 || times > MAX_REPEAT_TIMES) {
      throw new RangeError(`repeat times must be an integer from 1 to ${MAX_REPEAT_TIMES}.`);
    }
    if (!Number.isInteger(interval_seconds) || interval_seconds < MIN_REPEAT_INTERVAL_SECONDS
      || interval_seconds > MAX_REPEAT_INTERVAL_SECONDS) {
      throw new RangeError(
        `repeat interval_seconds must be an integer from ${MIN_REPEAT_INTERVAL_SECONDS} to ${MAX_REPEAT_INTERVAL_SECONDS}.`,
      );
    }
    body.repeat = { times, interval_seconds };
  }
  if (options.lang !== undefined) {
    if (typeof options.lang !== "string" || !LANG.test(options.lang)) {
      throw new RangeError('lang must be a language tag such as "en-US" or "fr".');
    }
    body.lang = options.lang;
  }
  return body;
}

function rejectUnknown(record: object, known: readonly string[], what: string): void {
  const unknown = Object.keys(record).filter((key) => !known.includes(key));
  if (unknown.length) throw new RangeError(`Unknown ${what} field: ${unknown[0]}.`);
}

/**
 * An IANA timezone name the API will accept: at most 64 characters, not
 * padded, a name's shape, and one this runtime's timezone database knows
 * (spelt as it spells it: the API is case-sensitive). Where there is no `Intl`
 * only the shape is checked and the API decides.
 */
function timezoneName(value: unknown, name: string): void {
  if (typeof value !== "string" || !value || value.length > MAX_TIMEZONE_LENGTH || value !== value.trim()
    || !ZONE_SHAPE.test(value)) {
    throw new RangeError(`${name} must be an IANA timezone name.`);
  }
  if (typeof Intl === "undefined" || typeof Intl.DateTimeFormat !== "function") return;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone;
  } catch (error) {
    if (error instanceof RangeError) throw new RangeError(`${name} must be an IANA timezone name.`);
    return;
  }
  // `Intl` accepts any case ("europe/paris"); the API does not. The right name
  // in the wrong case is refused (an alias cannot be told apart, so it is left to the API).
  if (resolved !== value && resolved.toLowerCase() === value.toLowerCase()) {
    throw new RangeError(`${name} must be an IANA timezone name.`);
  }
}

function dndBody(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("dnd must be an object.");
  const dnd = value as Record<string, unknown>;
  rejectUnknown(dnd, ["enabled", "quiet_hours"], "dnd");
  // The API replaces the whole do-not-disturb object and stores a missing
  // `enabled` as false, so a value that is not a real boolean (or is missing)
  // is refused, never read as false: that would switch DND off unasked.
  if (typeof dnd.enabled !== "boolean") throw new TypeError("dnd.enabled must be true or false.");
  const out: JsonRecord = { enabled: dnd.enabled };
  const hours = dnd.quiet_hours;
  let zone: string | null = null;
  let start: string | undefined;
  let end: string | undefined;
  if (hours !== undefined && hours !== null) {
    if (typeof hours !== "object" || Array.isArray(hours)) throw new TypeError("quiet_hours must be an object.");
    const window = hours as Record<string, unknown>;
    rejectUnknown(window, ["start", "end", "timezone"], "quiet_hours");
    if (typeof window.start !== "string" || typeof window.end !== "string" || !CLOCK.test(window.start) || !CLOCK.test(window.end)) {
      throw new RangeError("quiet_hours start and end must be HH:MM.");
    }
    if (window.timezone !== null && window.timezone !== undefined) {
      if (typeof window.timezone !== "string") throw new TypeError("quiet_hours.timezone must be an IANA name or null.");
      timezoneName(window.timezone, "quiet_hours.timezone");
      zone = window.timezone;
    }
    start = window.start;
    end = window.end;
    out.quiet_hours = { start, end, timezone: zone };
  }
  if (dnd.enabled) {
    // The API refuses an enabled window with no zone (UTC would put a Toronto
    // bedroom's night in the afternoon) or with start == end.
    if (out.quiet_hours === undefined || zone === null) {
      throw new RangeError("dnd.quiet_hours with a timezone is required when dnd is enabled.");
    }
    if (start === end) throw new RangeError("dnd.quiet_hours start and end must differ when dnd is enabled.");
  }
  return out;
}

/** @internal The `PATCH .../intercom/speakers/{id}` body: only what is present. */
export function speakerUpdateBody(changes: IntercomSpeakerChanges): JsonRecord {
  if (typeof changes !== "object" || changes === null || Array.isArray(changes)) throw new TypeError("changes must be an object.");
  // Only the four documented fields: anything else (a spread speaker's
  // `client_id`, `name`, `kind`...) is refused, never forwarded.
  rejectUnknown(changes, ["receive", "room", "groups", "dnd"], "speaker");
  const body: JsonRecord = {};
  if (changes.receive !== undefined) {
    if (typeof changes.receive !== "boolean") throw new TypeError("receive must be true or false.");
    body.receive = changes.receive;
  }
  if (changes.room !== undefined) {
    if (changes.room !== null) {
      requireText(changes.room, "room");
      if (Array.from(changes.room).length > MAX_ROOM_LENGTH) throw new RangeError(`room is at most ${MAX_ROOM_LENGTH} characters.`);
    }
    body.room = changes.room;
  }
  if (changes.groups !== undefined) {
    if (!Array.isArray(changes.groups) || changes.groups.length > MAX_GROUPS) {
      throw new RangeError(`groups is a list of at most ${MAX_GROUPS} names.`);
    }
    for (const group of changes.groups) {
      requireText(group, "a group");
      if (Array.from(group).length > MAX_GROUP_LENGTH) throw new RangeError(`A group name is at most ${MAX_GROUP_LENGTH} characters.`);
    }
    body.groups = [...changes.groups];
  }
  if (changes.dnd !== undefined) body.dnd = dndBody(changes.dnd);
  if (Object.keys(body).length === 0) throw new RangeError("Pass at least one of receive, room, groups or dnd.");
  return body;
}

/** @internal The `PUT .../intercom/settings` body. */
export function intercomSettingsBody(enabled: boolean): JsonRecord {
  if (typeof enabled !== "boolean") throw new TypeError("enabled must be true or false.");
  return { enabled };
}

function targetsBody(targets: IntercomTargets): JsonRecord {
  if (typeof targets !== "object" || targets === null) throw new TypeError("targets must be an object.");
  const record = targets as Record<string, unknown>;
  const known = ["all", "speakers", "rooms", "groups"];
  const unknown = Object.keys(record).filter((key) => !known.includes(key));
  if (unknown.length) throw new RangeError(`Unknown target kind: ${unknown[0]}.`);
  // A target list is an array of names: a bare string is refused, never split
  // into characters (`{ speakers: "ab" }` must not become speakers "a" and "b").
  for (const key of ["speakers", "rooms", "groups"]) {
    if (record[key] !== undefined && !Array.isArray(record[key])) {
      throw new TypeError(`targets.${key} must be an array of names, not a single value.`);
    }
  }
  if (record.all !== undefined && typeof record.all !== "boolean") throw new TypeError("targets.all must be true.");
  const chosen = known.filter((key) => (key === "all" ? record.all === true : Array.isArray(record[key]) && (record[key] as unknown[]).length > 0));
  if (chosen.length !== 1 || Object.keys(record).filter((k) => record[k] !== undefined).length !== 1) {
    throw new RangeError("Choose exactly one of all, speakers, rooms or groups as targets.");
  }
  const kind = chosen[0];
  if (kind === "all") return { all: true };
  const items = record[kind] as unknown[];
  for (const item of items) {
    requireText(item, `a ${kind.slice(0, -1)} target`);
    if (Array.from(item).length > MAX_TARGET_NAME_LENGTH) {
      throw new RangeError(`A ${kind.slice(0, -1)} target is at most ${MAX_TARGET_NAME_LENGTH} characters.`);
    }
  }
  if (items.length > MAX_TARGET_NAMES) {
    // 50 names of any kind; "at most 50 speakers" is the API's rule for explicit speakers.
    throw new RangeError(`An announcement names at most ${MAX_TARGET_NAMES} ${kind}.`);
  }
  return { [kind]: [...items] };
}

function requireText(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} must be a non-empty string.`);
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/** @internal */
export function intercomSettingsFromRecord(payload: JsonRecord): IntercomSettings {
  return {
    enabled: payload.enabled === true,
    plan_allowed: payload.plan_allowed === true,
    unavailable_reason: optionalText(payload.unavailable_reason),
  };
}

function policyFromRecord(value: unknown): IntercomPolicy {
  const policy = isRecord(value) ? value : {};
  const dnd = isRecord(policy.dnd) ? policy.dnd : {};
  const hours = isRecord(dnd.quiet_hours) ? dnd.quiet_hours : null;
  return {
    receive: policy.receive === true,
    room: optionalText(policy.room),
    groups: Array.isArray(policy.groups) ? policy.groups.filter((g): g is string => typeof g === "string") : [],
    dnd: {
      enabled: dnd.enabled === true,
      quiet_hours: hours && typeof hours.start === "string" && typeof hours.end === "string"
        ? { start: hours.start, end: hours.end, timezone: optionalText(hours.timezone) }
        : null,
    },
  };
}

/** @internal */
export function intercomSpeakerFromRecord(payload: unknown): IntercomSpeaker {
  const row = shape(payload, "intercom speaker");
  return {
    client_id: text(row, "client_id", "intercom speaker"),
    slug: optionalText(row.slug),
    name: optionalText(row.name),
    kind: typeof row.kind === "string" && row.kind ? row.kind : "voice_satellite",
    // The API's own default is true; only an explicit false says "cannot play".
    can_play: row.can_play !== false,
    online: row.online === true,
    last_seen_at: optionalText(row.last_seen_at),
    intercom: policyFromRecord(row.intercom),
    policy_synced: typeof row.policy_synced === "boolean" ? row.policy_synced : null,
  };
}

/** @internal */
export function intercomSpeakersFromRecord(payload: JsonRecord): IntercomSpeakerList {
  if (!Array.isArray(payload.items)) {
    throw new ThalovantApiError("Thalovant API returned an unexpected intercom speaker listing shape.");
  }
  return {
    items: payload.items.map(intercomSpeakerFromRecord),
    policy_synced: typeof payload.policy_synced === "boolean" ? payload.policy_synced : null,
    unavailable_reason: optionalText(payload.unavailable_reason),
  };
}

/** @internal */
export function announcementFromRecord(payload: unknown): Announcement {
  const row = shape(payload, "announcement");
  if (row.deliveries !== undefined && row.deliveries !== null && !Array.isArray(row.deliveries)) {
    throw new ThalovantApiError("Thalovant API returned an announcement with unexpected deliveries.");
  }
  return {
    id: text(row, "id", "announcement"),
    status: text(row, "status", "announcement"),
    priority: optionalText(row.priority) ?? "normal",
    created_at: optionalText(row.created_at),
    deliveries: ((row.deliveries as unknown[] | undefined) ?? []).map((entry) => {
      const delivery = shape(entry, "intercom delivery");
      return {
        client_id: optionalText(delivery.client_id),
        slug: optionalText(delivery.slug),
        name: optionalText(delivery.name),
        status: text(delivery, "status", "intercom delivery"),
        at: optionalText(delivery.at),
        detail: optionalText(delivery.detail),
      };
    }),
    acked_by: optionalText(row.acked_by),
    ...(typeof row.hub_confirmed === "boolean" ? { hub_confirmed: row.hub_confirmed } : {}),
    replayed: false,
  };
}

/** @internal */
export function announcementListFromRecord(payload: JsonRecord): AnnouncementList {
  const rows = Array.isArray(payload.items) ? payload.items : payload.data;
  if (!Array.isArray(rows)) {
    throw new ThalovantApiError("Thalovant API returned an unexpected announcement listing shape.");
  }
  const cursor = payload.next_cursor ?? payload.cursor;
  return { items: rows.map(announcementFromRecord), next_cursor: typeof cursor === "string" && cursor ? cursor : null };
}

function shape(value: unknown, what: string): JsonRecord {
  if (!isRecord(value)) throw new ThalovantApiError(`Thalovant API returned an unexpected ${what} shape.`);
  return value;
}

function text(values: JsonRecord, key: string, what: string): string {
  const value = values[key];
  if (typeof value !== "string" || !value) {
    throw new ThalovantApiError(`Thalovant API returned an ${what} without ${key}.`);
  }
  return value;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
