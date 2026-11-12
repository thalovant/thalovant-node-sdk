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
 * `cancelAnnouncement()`, and `hubs:write` (owner or admin of the hub) for
 * settings and speakers.
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

/** `plan`, `kid_hub` or `public_hub` when intercom cannot be enabled; open. */
export type IntercomUnavailableReason = "plan" | "kid_hub" | "public_hub" | (string & {});
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

/** A hub's intercom switch (`GET /v1/hubs/{id}/intercom/settings`). */
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

/** A client of the hub that may be spoken to, with presence and policy. */
export interface IntercomSpeaker {
  client_id: string;
  slug: string | null;
  name: string | null;
  online: boolean;
  last_seen_at: string | null;
  intercom: IntercomPolicy;
}

/** What happened for one speaker. */
export interface IntercomDelivery {
  client_id: string | null;
  slug: string | null;
  name: string | null;
  status: DeliveryStatus;
  at: string | null;
}

/** An announcement and its deliveries. The text is never part of it: the platform keeps none. */
export interface Announcement {
  id: string;
  status: AnnouncementStatus;
  priority: IntercomPriority | (string & {});
  created_at: string | null;
  deliveries: IntercomDelivery[];
  acked_by: string | null;
  /**
   * Only on the answer to `cancelAnnouncement()`: `false` means the hub could
   * not confirm the cancel (the record is `cancelled` anyway), so speech
   * already queued on the hub may still play. Absent on every other answer.
   */
  hub_confirmed?: boolean;
}

/** A page of announcements, newest first; `next_cursor` is null on the last page. */
export interface AnnouncementList {
  items: Announcement[];
  next_cursor: string | null;
}

/** Every client of the hub, as speakers. */
export interface IntercomSpeakerList {
  items: IntercomSpeaker[];
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
  /** 1-280 characters, trimmed, no control characters. It is spoken aloud in a home. */
  text: string;
  targets: IntercomTargets;
  /** `normal` (default) or `urgent`. */
  priority?: IntercomPriority;
  /** Urgent only. */
  repeat?: IntercomRepeat;
  lang?: string;
  /**
   * Sent as `Idempotency-Key` when given; never generated. Use a fresh unique
   * key (a `crypto.randomUUID()`) per announcement you mean to send: the same
   * key replays the stored result for 24 hours and never sends again, a
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

/** What {@link ThalovantControlPlane.updateIntercomSpeaker} takes: only what is present is sent; `room: null` clears it. */
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

const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]", "u");
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

/** The text as it is sent: trimmed, 1-280 characters, no control characters. */
export function announcementText(text: string): string {
  if (typeof text !== "string") throw new TypeError("An announcement's text must be a string.");
  const trimmed = text.trim();
  if (!trimmed) throw new RangeError("An announcement's text must not be empty.");
  if (Array.from(trimmed).length > MAX_ANNOUNCEMENT_TEXT) {
    throw new RangeError(`An announcement's text is at most ${MAX_ANNOUNCEMENT_TEXT} characters.`);
  }
  if (CONTROL.test(trimmed)) throw new RangeError("An announcement's text must not contain control characters.");
  return trimmed;
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
    requireText(options.lang, "lang");
    body.lang = options.lang;
  }
  return body;
}

/** @internal The `PATCH .../intercom/speakers/{id}` body: only what is present. */
export function speakerUpdateBody(changes: IntercomSpeakerChanges): JsonRecord {
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
  if (changes.dnd !== undefined) {
    if (typeof changes.dnd !== "object" || changes.dnd === null) throw new TypeError("dnd must be an object.");
    // The API replaces the whole do-not-disturb object and stores a missing
    // `enabled` as false, so a value that is not a real boolean (or is missing)
    // is refused, never read as false: that would switch DND off unasked.
    if (typeof changes.dnd.enabled !== "boolean") throw new TypeError("dnd.enabled must be true or false.");
    const dnd: JsonRecord = { enabled: changes.dnd.enabled };
    const hours = changes.dnd.quiet_hours;
    if (hours !== undefined && hours !== null) {
      if (!CLOCK.test(hours.start) || !CLOCK.test(hours.end)) throw new RangeError("quiet_hours start and end must be HH:MM.");
      if (hours.timezone !== null && hours.timezone !== undefined && typeof hours.timezone !== "string") {
        throw new TypeError("quiet_hours.timezone must be an IANA name or null.");
      }
      dnd.quiet_hours = { start: hours.start, end: hours.end, timezone: hours.timezone ?? null };
    }
    body.dnd = dnd;
  }
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
  for (const item of items) requireText(item, `a ${kind.slice(0, -1)} target`);
  if (kind === "speakers" && items.length > MAX_ANNOUNCEMENT_SPEAKERS) {
    throw new RangeError(`An announcement names at most ${MAX_ANNOUNCEMENT_SPEAKERS} speakers.`);
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
    online: row.online === true,
    last_seen_at: optionalText(row.last_seen_at),
    intercom: policyFromRecord(row.intercom),
  };
}

/** @internal */
export function intercomSpeakersFromRecord(payload: JsonRecord): IntercomSpeakerList {
  if (!Array.isArray(payload.items)) {
    throw new ThalovantApiError("Thalovant API returned an unexpected intercom speaker listing shape.");
  }
  return { items: payload.items.map(intercomSpeakerFromRecord) };
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
      };
    }),
    acked_by: optionalText(row.acked_by),
    ...(typeof row.hub_confirmed === "boolean" ? { hub_confirmed: row.hub_confirmed } : {}),
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
