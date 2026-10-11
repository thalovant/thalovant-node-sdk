/**
 * What a hub can be asked: the intent inventory, over the client's own session.
 *
 * The hub runtime keeps an intent manifest (OVOS-INTENT-4 section 10): every
 * intent a skill registered, per language, and on request the registration
 * itself, which for a template intent carries the sentences from the skill's
 * locale files, slots and all -- `what is the weather in {location}`. This
 * module asks that manifest and shapes the answer, so a satellite, an
 * installer or an agent shows a person what they can say without a
 * control-plane token.
 *
 * Two queries, correlated by `context.request_id` like every other request:
 *
 * - `ovos.intent.list` `{"lang": <tag>}` -> `ovos.intent.list.response`
 *   `{"ok", "intents": [{skill_id, intent_name, lang, method, enabled,
 *   session_id}]}`. `method` is `template` (sample sentences) or `keyword`
 *   (keyword sets). A runtime may attach each entry's `definition` when asked
 *   with `include_definitions`; when it does not, the client describes each
 *   intent individually.
 * - `ovos.intent.describe` `{"skill_id", "intent_name", "lang"}` ->
 *   `ovos.intent.describe.response` `{"ok", "definitions": [{method,
 *   definition}]}` or `{"ok": false, "error"}`.
 *
 * A hub whose connection may not publish a type answers `hive.policy.denied`
 * naming it; that becomes a `ThalovantPolicyDeniedError` at once rather than
 * a timeout. The engines' own manifests (`intent.service.adapt.manifest.get`
 * and `intent.service.padatious.manifest.get`, names only, no language) are
 * the fallback for a hub allowed for those alone.
 */
import { closestLanguage, defaultListing, type ListingRules } from "./listing.js";
import { closestLanguage as closestLang, usualForm } from "./language-matching.js";
import type { ThalovantClient } from "./client.js";
import {
  EVENT_ADAPT_MANIFEST,
  EVENT_ADAPT_MANIFEST_GET,
  EVENT_INTENT_DESCRIBE,
  EVENT_INTENT_DESCRIBE_RESPONSE,
  EVENT_INTENT_LIST,
  EVENT_INTENT_LIST_RESPONSE,
  EVENT_PADATIOUS_MANIFEST,
  EVENT_PADATIOUS_MANIFEST_GET,
  EVENT_POLICY_DENIED,
  EVENT_SKILLS_LIST,
  EVENT_SKILLS_LIST_RESPONSE,
} from "./constants.js";
import { ThalovantConnectionError, ThalovantPolicyDeniedError, ThalovantRuntimeError, ThalovantTimeoutError } from "./errors.js";
import { EventContext, newRequestId, ThalovantEvent } from "./events.js";

/** The inventory was read from the runtime's intent manifest: sentences per language. */
export const SOURCE_MANIFEST = "intent-manifest";
/** The inventory was read from the engines' own manifests: names only. */
export const SOURCE_ENGINES = "engine-manifests";
export type HubIntentSource = typeof SOURCE_MANIFEST | typeof SOURCE_ENGINES;

const DEFAULT_TIMEOUT_MS = 5000;
/** Unsupported optional fallback discovery must not consume a full query timeout. */
export const FALLBACK_PROBE_TIMEOUT_MS = 1500;
/** The capability a skill announces in `ovos.skills.list` when it takes what nothing else matched. */
export const FALLBACK_CAPABILITY = "fallback";
const ENGINE_BY_METHOD: Record<string, string> = { template: "padatious", keyword: "adapt" };

/**
 * How many describes may be in flight at once.
 *
 * A hub with 69 intents in two languages is 138 requests and, with every
 * reply delivered twice, 276 inbound events; an SDK whose reply queue is
 * bounded (the Rust port's bus channel holds 64) drops replies past its
 * capacity and the inventory comes back missing sentences. Batching also
 * spares the hub a burst it never asked for.
 *
 * @internal
 */
export const DESCRIBE_BATCH = 32;

/** `fr-fr` and `fr_FR` are the same language tag. */
export function sameLanguage(a: string, b: string): boolean {
  return foldLanguage(a) === foldLanguage(b);
}

function foldLanguage(tag: string): string {
  return tag.trim().toLowerCase().replaceAll("_", "-");
}

function engineFor(method: string): string {
  return ENGINE_BY_METHOD[method] ?? (method || "unknown");
}

/** One row of the hub's intent manifest, from `ovos.intent.list`. */
export interface IntentRegistration {
  skillId: string;
  intentName: string;
  lang: string;
  /** `template` (sample sentences) or `keyword` (keyword sets), as the hub says it. */
  method: string;
  /** `padatious` for a template intent, `adapt` for a keyword one. */
  engine: string;
  enabled: boolean;
  sessionId: string;
  /** Attached by a runtime that honours `include_definitions`; absent otherwise. */
  definition?: Record<string, unknown>;
}

/** A registration as the skill made it, from `ovos.intent.describe`. */
export interface IntentDefinition {
  skillId: string;
  intentName: string;
  lang: string;
  method: string;
  engine: string;
  /** The sentences as the skill's locale files wrote them, `{slot}` placeholders included. */
  samples: string[];
  /** The definition as the hub sent it. */
  raw: Record<string, unknown>;
}

/** One thing a hub can be asked, with the sentences that ask it, per language. */
export class HubIntent {
  readonly skillId: string;
  readonly name: string;
  /** `padatious` or `adapt`. */
  readonly engine: string;
  /** Sentences keyed by the language tag they were asked for. */
  readonly phrases: Readonly<Record<string, readonly string[]>>;
  readonly enabled: boolean;

  constructor(options: {
    skillId: string;
    name: string;
    engine: string;
    phrases?: Record<string, readonly string[]>;
    enabled?: boolean;
  }) {
    this.skillId = options.skillId;
    this.name = options.name;
    this.engine = options.engine;
    this.phrases = Object.fromEntries(
      Object.entries(options.phrases ?? {}).map(([lang, sentences]) => [lang, [...sentences]]),
    );
    this.enabled = options.enabled ?? true;
  }

  /** `skill_id:name`, the same name the engines' manifests use. */
  get id(): string {
    return `${this.skillId}:${this.name}`;
  }

  get languages(): string[] {
    return Object.keys(this.phrases);
  }

  phrasesFor(lang: string): readonly string[] {
    const match = closestLanguage(lang, Object.keys(this.phrases));
    return match === undefined ? [] : this.phrases[match];
  }

  /** Complete phrases before prefixes and slots; fuller wording up to eight words. */
  examples(lang?: string, limit = 2, options: { speakable?: boolean; sentence?: boolean; slots?: Readonly<Record<string, string>>; listing?: ListingRules } = {}): readonly string[] {
    const renderLang = lang || Object.keys(this.phrases)[0];
    const pool = renderLang ? this.phrasesFor(renderLang) : [];
    const listing = options.listing ?? defaultListing;
    // Python preserves registration order for unlimited raw patterns.
    if (!options.speakable && !options.sentence) return limit <= 0 ? pool : listing.rank(pool, renderLang).slice(0, limit);
    const rendered: string[] = [], seen = new Set<string>();
    for (const original of listing.rank(pool, renderLang)) {
      let value = speakable(original, options.slots, renderLang, listing);
      if (options.sentence) value = listing.asSentence(value, renderLang);
      if (!value || seen.has(value)) continue;
      seen.add(value);
      rendered.push(value);
      if (limit > 0 && rendered.length >= limit) break;
    }
    return rendered;
  }

  asObject(): Record<string, unknown> {
    return {
      id: this.id,
      skill_id: this.skillId,
      name: this.name,
      engine: this.engine,
      enabled: this.enabled,
      phrases: Object.fromEntries(Object.entries(this.phrases).map(([lang, sentences]) => [lang, [...sentences]])),
    };
  }
}

export class HubSkillIntents {
  readonly skillId: string;
  readonly intents: readonly HubIntent[];

  constructor(skillId: string, intents: readonly HubIntent[]) {
    this.skillId = skillId;
    this.intents = [...intents];
  }

  /** Every language any of the skill's intents carries sentences for, in first-seen order. */
  get languages(): string[] {
    const seen = new Set<string>();
    for (const intent of this.intents) {
      for (const lang of intent.languages) seen.add(lang);
    }
    return [...seen];
  }

  asObject(): Record<string, unknown> {
    return {
      skill_id: this.skillId,
      languages: this.languages,
      intents: this.intents.map(intent => intent.asObject()),
    };
  }
}

/**
 * A skill that answers whatever nothing else matched.
 *
 * It has no sentences to publish for that, so a caller can learn that it
 * exists and nothing more. That is still the difference between "no skill
 * handles this" and "something will try".
 *
 * `priority` is `null` whenever the SDK read the hub: no runtime serves it.
 * `ovos.skills.list` says which skills declared the fallback capability and
 * not in what order they are tried, and the query that would have carried the
 * order (`ovos.skills.fallback.list`, ovos-core #951) was reverted the same
 * day it landed. A number here would be invented, so there is none; the list
 * is in skill id order and says nothing about who goes first.
 */
export class HubFallback {
  readonly priority: number | null;

  constructor(readonly skillId: string, priority?: number | null) {
    this.priority = priority ?? null;
  }

  asObject(): Record<string, unknown> {
    return { skill_id: this.skillId, priority: this.priority };
  }
}

/**
 * Everything a hub can be asked, grouped by skill.
 *
 * `source` says how it was read: `intent-manifest` carries sentences per
 * language; `engine-manifests` is the names-only fallback, and `denied` then
 * names the query the hub refused or did not answer.
 */
export class HubIntentInventory {
  /** The languages asked for. */
  readonly languages: readonly string[];
  readonly skills: readonly HubSkillIntents[];
  readonly source: HubIntentSource;
  readonly denied: readonly string[];
  readonly fallbacks: readonly HubFallback[];
  /** False means the optional probe was unsupported, denied or unanswered. */
  readonly fallbacksKnown: boolean;
  /** The tag the hub actually listed each language under, in `languages` order.
   * Equal to `languages` unless the listing in that language had no sentences
   * and another answered instead: the language's usual form (`en-CA` ->
   * `en-US`), or else one of the languages the hub loaded -- the same language
   * in another region first, then the hub's own -- because a hub lists nothing
   * under a language it did not load and still answers a person speaking it.
   * A caller showing these sentences should say which language they are in
   * when this differs from what was asked in a way the person would notice.
   * Callers rendering sentences must read them from the tag that answered. */
  readonly listedIn: readonly string[];

  constructor(options: {
    languages: readonly string[];
    skills: readonly HubSkillIntents[];
    source?: HubIntentSource;
    denied?: readonly string[];
    fallbacks?: readonly HubFallback[];
    fallbacksKnown?: boolean;
    listedIn?: readonly string[];
  }) {
    this.languages = [...options.languages];
    this.skills = [...options.skills];
    this.source = options.source ?? SOURCE_MANIFEST;
    this.denied = [...(options.denied ?? [])];
    this.fallbacks = [...(options.fallbacks ?? [])];
    this.fallbacksKnown = options.fallbacksKnown ?? false;
    this.listedIn = [...(options.listedIn ?? options.languages)];
  }

  /** Every intent across skills. */
  get intents(): HubIntent[] {
    return this.skills.flatMap(skill => [...skill.intents]);
  }

  /** Whether at least one intent carries a sentence in some language. */
  get hasPhrases(): boolean {
    return this.intents.some(intent => Object.values(intent.phrases).some(sentences => sentences.length > 0));
  }

  /** Conservative answerability hint, never a guarantee that a request will succeed. */
  mayAnswer(lang: string): boolean {
    return this.intents.some(intent => intent.enabled && intent.phrasesFor(lang).length > 0)
      || this.fallbacks.length > 0 || !this.fallbacksKnown;
  }

  asObject(): Record<string, unknown> {
    return {
      languages: [...this.languages],
      listed_in: [...this.listedIn],
      source: this.source,
      denied: [...this.denied],
      fallbacks: this.fallbacks.map(fallback => fallback.asObject()),
      fallbacks_known: this.fallbacksKnown,
      skills: this.skills.map(skill => skill.asObject()),
    };
  }
}

// ----------------------------------------------------------------------------
// the wire
// ----------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function samplesOf(definition: Record<string, unknown>): string[] {
  const raw = definition.samples;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string").map(item => item.trim()).filter(Boolean);
}

function registrationFromRow(row: unknown): IntentRegistration | undefined {
  if (!isRecord(row)) return undefined;
  const skillId = text(row.skill_id).trim();
  const intentName = text(row.intent_name).trim();
  if (!skillId || !intentName) return undefined;
  const method = text(row.method);
  const registration: IntentRegistration = {
    skillId,
    intentName,
    lang: text(row.lang),
    method,
    engine: engineFor(method),
    enabled: row.enabled !== false,
    sessionId: text(row.session_id) || "default",
  };
  if (isRecord(row.definition)) registration.definition = { ...row.definition };
  return registration;
}

function definitionFromItem(item: unknown): IntentDefinition | undefined {
  if (!isRecord(item) || !isRecord(item.definition)) return undefined;
  const definition = item.definition;
  const skillId = text(definition.skill_id).trim();
  const intentName = text(definition.intent_name).trim();
  if (!skillId || !intentName) return undefined;
  const method = text(item.method) || text(definition.method);
  return {
    skillId,
    intentName,
    lang: text(definition.lang),
    method,
    engine: engineFor(method),
    samples: samplesOf(definition),
    raw: { ...definition },
  };
}

function definitionsFromReply(event: ThalovantEvent): IntentDefinition[] {
  const items = event.data.definitions;
  if (!Array.isArray(items)) return [];
  return items.map(definitionFromItem).filter((definition): definition is IntentDefinition => definition !== undefined);
}

function deniedTypeOf(event: ThalovantEvent): string {
  return text(event.data.denied_type);
}

/**
 * Send one bus query and return its reply, matched by request id.
 *
 * A reply may arrive more than once; the first one wins and repeats are
 * dropped. A `hive.policy.denied` naming the query rejects at once.
 *
 * @internal Reached through `ThalovantClient`; not part of the package surface.
 */
export async function requestReply(
  client: ThalovantClient,
  queryType: string,
  replyType: string,
  data: Record<string, unknown>,
  options: { lang?: string; timeoutMs?: number } = {},
): Promise<ThalovantEvent> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = performance.now() + timeoutMs;
  const timeoutError = () => new ThalovantTimeoutError(`Hub did not answer ${queryType} within ${timeoutMs}ms.`);
  const requestId = newRequestId();
  const context: EventContext = { request_id: requestId };
  if (options.lang) context.lang = options.lang;
  try {
    await client.connect(timeoutMs);
  } catch (error) {
    if ((error instanceof ThalovantConnectionError && error.cause instanceof ThalovantTimeoutError) || performance.now() >= deadline) throw timeoutError();
    throw error;
  }
  if (performance.now() >= deadline) throw timeoutError();
  let keep!: (event: ThalovantEvent) => void;
  let fail!: (error: Error) => void;
  const answer = new Promise<ThalovantEvent>((resolve, reject) => {
    keep = resolve;
    fail = reject;
  });
  // The race below observes every settlement; this keeps a rejection that
  // lands after the race has already lost from surfacing as unhandled.
  answer.catch(() => undefined);
  const timer = setTimeout(() => {
    fail(timeoutError());
  }, Math.max(1, deadline - performance.now()));
  const subscriptions = [
    client.on(EVENT_POLICY_DENIED, event => {
      if (deniedTypeOf(event) === queryType) fail(ThalovantPolicyDeniedError.fromEvent(event));
    }, { requestId }),
    // A settled promise ignores later resolutions: the first reply wins.
    client.on(replyType, event => keep(event), { requestId }),
  ];
  try {
    await Promise.race([client.emit(queryType, data, context), answer]);
    return await answer;
  } finally {
    clearTimeout(timer);
    subscriptions.forEach(subscription => subscription.close());
  }
}

/**
 * The hub's intent manifest for one language.
 *
 * @internal Use `ThalovantClient.listIntents()`.
 */
export async function listIntents(
  client: ThalovantClient,
  lang: string,
  options: { timeoutMs?: number; includeDefinitions?: boolean } = {},
): Promise<IntentRegistration[]> {
  const data: Record<string, unknown> = { lang };
  if (options.includeDefinitions) data.include_definitions = true;
  const event = await requestReply(client, EVENT_INTENT_LIST, EVENT_INTENT_LIST_RESPONSE, data, {
    lang,
    timeoutMs: options.timeoutMs,
  });
  if (event.data.ok === false) {
    // A refused listing is not an empty hub. Describe answers `ok: false` for
    // an intent it does not know, which is a real answer; a listing that fails
    // has told us nothing, and reading the missing `intents` key as an empty
    // list would show a person a device that can do nothing.
    const detail = String(event.data.error ?? "").trim() || "the hub refused the listing";
    throw new ThalovantRuntimeError(`${EVENT_INTENT_LIST} failed: ${detail}`);
  }
  const rows = event.data.intents;
  if (!Array.isArray(rows)) return [];
  return rows.map(registrationFromRow).filter((row): row is IntentRegistration => row !== undefined);
}

/**
 * Every registration behind one intent in one language, keyword ones first.
 *
 * @internal Use `ThalovantClient.describeIntent()`.
 */
export async function describeIntent(
  client: ThalovantClient,
  skillId: string,
  intentName: string,
  lang: string,
  options: { timeoutMs?: number } = {},
): Promise<IntentDefinition[]> {
  const event = await requestReply(
    client,
    EVENT_INTENT_DESCRIBE,
    EVENT_INTENT_DESCRIBE_RESPONSE,
    { skill_id: skillId, intent_name: intentName, lang },
    { lang, timeoutMs: options.timeoutMs },
  );
  if (event.data.ok === false) return [];
  return definitionsFromReply(event);
}

/**
 * One registration to describe: a skill's intent in one language.
 *
 * @internal
 */
export interface DescribeTarget {
  skillId: string;
  intentName: string;
  lang: string;
}

/**
 * The key `describeMany` files a target's definitions under.
 *
 * @internal
 */
export function describeKey(target: DescribeTarget): string {
  return JSON.stringify([target.skillId, target.intentName, target.lang]);
}

/**
 * Describe many registrations with the requests in flight together.
 *
 * At most `batch` of them are in flight at a time (`DESCRIBE_BATCH` by
 * default, `0` sends them all at once). One subscription per batch, one
 * request id per registration, replies matched by that id -- or, for a hub
 * that does not echo the id, by the definition's own
 * `skill_id`/`intent_name`/`lang`. Repeats are dropped and the deadline
 * covers each batch, so a registration the hub did not describe in time is
 * simply absent from the result (keyed by `describeKey`). A window that
 * received nothing contributes nothing, and the call rejects with the timeout
 * only when no window produced a definition -- so a hub silent from the start
 * fails at the first window rather than holding every request open.
 *
 * @internal Reached through `ThalovantClient.intents()`.
 */
export async function describeMany(
  client: ThalovantClient,
  targets: Iterable<DescribeTarget>,
  options: { timeoutMs?: number; batch?: number } = {},
): Promise<Map<string, IntentDefinition[]>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const batch = options.batch ?? DESCRIBE_BATCH;
  const wanted = new Map<string, DescribeTarget>();
  for (const target of targets) wanted.set(describeKey(target), target);
  const found = new Map<string, IntentDefinition[]>();
  if (wanted.size === 0) return found;
  if (batch > 0 && wanted.size > batch) {
    const all = [...wanted.values()];
    for (let start = 0; start < all.length; start += batch) {
      try {
        const window = await describeMany(client, all.slice(start, start + batch), { timeoutMs, batch: 0 });
        for (const [key, definitions] of window) found.set(key, definitions);
      } catch (error) {
        // A partial answer is an answer, across windows as within one: windows
        // are contiguous slices, so an unresponsive skill with more than one
        // window's worth of intents would otherwise turn the whole inventory
        // into a timeout while the same skill with fewer intents only loses
        // its sentences. A hub silent from the start still fails at the first
        // window, since nothing is found.
        if (!(error instanceof ThalovantTimeoutError) || ![...found.values()].some(definitions => definitions.length > 0)) throw error;
      }
    }
    return found;
  }

  const byRequest = new Map<string, string>();
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  done.catch(() => undefined);
  const keep = (event: ThalovantEvent): void => {
    const definitions = definitionsFromReply(event);
    let key = byRequest.get(event.requestId ?? "");
    if (key === undefined && !event.requestId && definitions.length > 0) {
      // No request id came back: the definition names what it describes.
      const first = definitions[0];
      for (const [candidate, target] of wanted) {
        if (target.skillId === first.skillId && target.intentName === first.intentName && sameLanguage(target.lang, first.lang)) {
          key = candidate;
          break;
        }
      }
    }
    if (key === undefined || found.has(key)) return;
    found.set(key, event.data.ok === false ? [] : definitions);
    if (found.size === wanted.size) finish();
  };

  await client.connect();
  const timer = setTimeout(() => {
    fail(new ThalovantTimeoutError(`Hub did not answer ${EVENT_INTENT_DESCRIBE} within ${timeoutMs}ms.`));
  }, timeoutMs);
  const subscriptions = [
    client.on(EVENT_POLICY_DENIED, event => {
      if ((!event.requestId || byRequest.has(event.requestId)) && deniedTypeOf(event) === EVENT_INTENT_DESCRIBE) fail(ThalovantPolicyDeniedError.fromEvent(event));
    }),
    client.on(EVENT_INTENT_DESCRIBE_RESPONSE, keep),
  ];
  try {
    for (const [key, target] of wanted) {
      const requestId = newRequestId();
      byRequest.set(requestId, key);
      await Promise.race([
        client.emit(
          EVENT_INTENT_DESCRIBE,
          { skill_id: target.skillId, intent_name: target.intentName, lang: target.lang },
          { request_id: requestId, lang: target.lang },
        ),
        done,
      ]);
    }
    try {
      await done;
    } catch (error) {
      // A partial answer is still an answer: the intents the hub did not
      // describe in time simply carry no sentences.
      if (!(error instanceof ThalovantTimeoutError) || ![...found.values()].some(definitions => definitions.length > 0)) throw error;
    }
  } finally {
    clearTimeout(timer);
    subscriptions.forEach(subscription => subscription.close());
  }
  return found;
}

/**
 * The engines' own manifests: `{ adapt: [names], padatious: [names] }`.
 *
 * Names only, and the same names whatever the language asked, because an
 * intent's name is the same in every language. The fallback for a hub
 * allowed for these queries but not the intent manifest.
 *
 * @internal Reached through `ThalovantClient.intents()`.
 */
export async function intentNames(
  client: ThalovantClient,
  lang: string,
  options: { timeoutMs?: number } = {},
): Promise<Record<string, string[]>> {
  const names: Record<string, string[]> = {};
  for (const [engine, queryType, replyType] of [
    ["adapt", EVENT_ADAPT_MANIFEST_GET, EVENT_ADAPT_MANIFEST],
    ["padatious", EVENT_PADATIOUS_MANIFEST_GET, EVENT_PADATIOUS_MANIFEST],
  ] as const) {
    const event = await requestReply(client, queryType, replyType, { lang }, { lang, timeoutMs: options.timeoutMs });
    const raw = event.data.intents;
    names[engine] = (Array.isArray(raw) ? raw : []).filter((item): item is string => typeof item === "string" && item !== "");
  }
  return names;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function skillsFrom(bySkill: Map<string, HubIntent[]>): HubSkillIntents[] {
  return [...bySkill.entries()]
    .sort(([a], [b]) => compare(a, b))
    .map(([skillId, intents]) => new HubSkillIntents(skillId, [...intents].sort((a, b) => compare(a.name, b.name))));
}

function inventoryFromNames(names: Record<string, string[]>, languages: readonly string[], denied: string): HubIntentInventory {
  // Names are `<skill_id>:<intent_name>`. The first engine to name an intent
  // decides its engine, as on the manifest path; adapt is asked first.
  const intents = new Map<string, HubIntent>();
  for (const [engine, entries] of Object.entries(names)) {
    for (const raw of entries) {
      const separator = raw.indexOf(":");
      let skillId = separator >= 0 ? raw.slice(0, separator) : "";
      let name = separator >= 0 ? raw.slice(separator + 1) : "";
      if (!name) [skillId, name] = ["", raw];
      const key = JSON.stringify([skillId, name]);
      if (!intents.has(key)) intents.set(key, new HubIntent({ skillId, name, engine }));
    }
  }
  const bySkill = new Map<string, HubIntent[]>();
  for (const intent of intents.values()) {
    bySkill.set(intent.skillId, [...(bySkill.get(intent.skillId) ?? []), intent]);
  }
  return new HubIntentInventory({ languages, skills: skillsFrom(bySkill), source: SOURCE_ENGINES, denied: [denied] });
}

/** Whether a listing has an enabled template row: the only kind with sentences. */
function canCarrySentences(rows: readonly IntentRegistration[]): boolean {
  return rows.some(row => row.enabled && row.method === "template");
}

function sentenceRows(rows: Iterable<IntentRegistration>): number {
  let count = 0;
  for (const row of rows) if (row.enabled && row.method === "template") count += 1;
  return count;
}

/**
 * The hub's whole manifest, by the language each row was registered in.
 *
 * `byLang` keeps the hub's own spelling and the order it listed them in.
 * `sessionLang` is the language the hub stamped on its reply's session: a
 * request that names no language is answered in a session the hub opened in
 * its default language, the nearest thing to "the hub's own language" the bus
 * offers. It is a hint, not a promise, so it only ever breaks a choice between
 * languages the hub actually listed.
 */
interface HubLanguages {
  byLang: Map<string, IntentRegistration[]>;
  sessionLang?: string;
}

/**
 * `ovos.intent.list` with no `lang`: every language the hub loaded.
 *
 * `null` when the hub refused, failed or did not answer: this is only ever
 * asked to improve an answer, and an answer it cannot improve stands.
 */
async function listHubLanguages(
  client: ThalovantClient,
  options: { timeoutMs?: number; includeDefinitions?: boolean },
): Promise<HubLanguages | null> {
  const data: Record<string, unknown> = {};
  if (options.includeDefinitions) data.include_definitions = true;
  let event: ThalovantEvent;
  try {
    event = await requestReply(client, EVENT_INTENT_LIST, EVENT_INTENT_LIST_RESPONSE, data, { timeoutMs: options.timeoutMs });
  } catch (error) {
    if (error instanceof ThalovantTimeoutError || error instanceof ThalovantPolicyDeniedError || error instanceof ThalovantRuntimeError) return null;
    throw error;
  }
  if (event.data.ok === false) return null;
  const raw = event.data.intents;
  const byLang = new Map<string, IntentRegistration[]>();
  for (const row of Array.isArray(raw) ? raw : []) {
    const entry = registrationFromRow(row);
    if (entry === undefined || !entry.lang.trim()) continue;
    const key = [...byLang.keys()].find(seen => sameLanguage(seen, entry.lang)) ?? entry.lang;
    const rows = byLang.get(key) ?? [];
    rows.push(entry);
    byLang.set(key, rows);
  }
  const session = event.context.session;
  const sessionLang = isRecord(session) && typeof session.lang === "string" && session.lang.trim() ? session.lang : undefined;
  return { byLang, sessionLang };
}

/**
 * Which of the hub's languages to list in, for a person who asked in `asked`.
 *
 * Only a language with a sentence to show is a candidate. The same language
 * first, by the matcher the rest of OVOS uses (`de-AT` takes `de-DE`); then
 * the hub's own language, `hubLang`, when the hub listed it; then the language
 * with the most sentences, the first listed on a tie. `undefined` when no
 * language the hub listed carries a sentence.
 *
 * The hub does not say which language is its own. A person asking in a
 * language the hub never loaded is answered all the same -- in the hub's
 * language, by its fallback or persona -- so the sentences worth showing them
 * are the ones in that language, and the order above is the closest this can
 * get to it without inventing a fact.
 */
export function nearestHubLanguage(
  asked: string,
  listed: ReadonlyMap<string, Iterable<IntentRegistration>> | Readonly<Record<string, Iterable<IntentRegistration>>>,
  hubLang?: string | null,
): string | undefined {
  const entries = listed instanceof Map ? [...listed.entries()] : Object.entries(listed);
  const counts = new Map<string, number>();
  for (const [tag, rows] of entries) counts.set(tag, sentenceRows(rows));
  const candidates = [...counts.keys()].filter(tag => (counts.get(tag) ?? 0) > 0);
  if (candidates.length === 0) return undefined;
  const match = closestLang(asked, candidates);
  if (match !== undefined) return match;
  if (hubLang) {
    const own = closestLang(hubLang, candidates);
    if (own !== undefined) return own;
  }
  // Strictly greater: a tie keeps the first listed.
  let best = candidates[0];
  for (const tag of candidates) if ((counts.get(tag) ?? 0) > (counts.get(best) ?? 0)) best = tag;
  return best;
}

/**
 * Everything the hub can be asked, in each language, grouped by skill.
 *
 * Asks the intent manifest per language and, unless the runtime attached
 * definitions to the listing, describes every registration at once. When the
 * hub refuses or does not answer `ovos.intent.list` and `fallback` is on, the engines' manifests
 * give the names and the result says so.
 *
 * @internal Use `ThalovantClient.intents()`.
 */
export async function intentInventory(
  client: ThalovantClient,
  languages: Iterable<string>,
  options: { timeoutMs?: number; describe?: boolean; fallback?: boolean; nearest?: boolean } = {},
): Promise<HubIntentInventory> {
  const describe = options.describe ?? true;
  const fallback = options.fallback ?? true;
  // Each language once, in its first spelling: `en-us` and `en-US` are one
  // listing and one `phrases` key, and a padded tag is sent as the hub stores it.
  const asked: string[] = [];
  for (const value of languages) {
    const lang = String(value).trim();
    if (lang !== "" && !asked.some(seen => sameLanguage(seen, lang))) asked.push(lang);
  }
  if (asked.length === 0) throw new Error("intentInventory() requires at least one language.");

  const listed = new Map<string, IntentRegistration[]>();
  const answered = new Map<string, string>();
  const nearest = options.nearest ?? true;
  // The hub's whole manifest: asked at most once, and only when needed.
  let hubLanguages: HubLanguages | null | undefined;
  try {
    for (const lang of asked) {
      const listingOptions = { timeoutMs: options.timeoutMs, includeDefinitions: describe };
      let rows = await listIntents(client, lang, listingOptions);
      let tag = lang;
      if (nearest && !canCarrySentences(rows)) {
        // Listing and asking do not agree about languages. The hub matches an
        // utterance to the closest language it knows, so a phone set to en-CA
        // is understood by skills registered under en-US; the manifest is
        // keyed by exact tag, so the same hub lists nothing for en-CA -- and a
        // person is shown an empty hub by the hub that is answering them.
        //
        // Not only on an empty listing: on a listing with no template row,
        // which can never carry a sentence. The Pop Culture hub (2026-10-11)
        // listed five keyword intents of one skill under en-CA -- that skill
        // registers keyword vocabulary in 63 regional tags -- and 141 intents
        // with sentences under en-US; five names is not an answer a person
        // can use.
        //
        // Once only: a listing with a template row is never asked twice, a
        // language whose usual form is itself has nothing to retry with, and
        // the usual form's listing is taken only when it can carry sentences
        // (or the first was empty), so keyword names are never traded for
        // other names. A retry that times out or is refused never makes the
        // answer worse: the first listing's names stand, and only an empty
        // first listing lets the failure through, as before.
        const usual = usualForm(lang);
        if (usual !== undefined) {
          let retried: IntentRegistration[];
          try {
            retried = await listIntents(client, usual, listingOptions);
          } catch (error) {
            if (rows.length === 0 || !(error instanceof ThalovantTimeoutError || error instanceof ThalovantRuntimeError)) throw error;
            retried = [];
          }
          if (canCarrySentences(retried) || (retried.length > 0 && rows.length === 0)) { rows = retried; tag = usual; }
        }
      }
      if (nearest && !canCarrySentences(rows)) {
        // Still nothing a person can say: the hub did not load this language.
        // A hub loads its `lang` and `secondary_langs` (en-US and fr-FR on
        // most public hubs) and lists nothing under any other tag, so a phone
        // set to Spanish, Japanese or German was shown an empty list -- by a
        // hub that answered every one of those people, in its own language.
        // Measured on all 13 public hubs on 2026-10-11.
        //
        // The listing without a language names every language the hub loaded;
        // list in the closest of them and say so in `listedIn`. Asked once per
        // inventory, only here, and taken only when it has sentences, so it
        // never replaces names with fewer names. A hub that cannot answer it
        // leaves the result exactly as it was.
        if (hubLanguages === undefined) hubLanguages = await listHubLanguages(client, listingOptions);
        if (hubLanguages !== null) {
          const chosen = nearestHubLanguage(lang, hubLanguages.byLang, hubLanguages.sessionLang);
          if (chosen !== undefined) {
            rows = hubLanguages.byLang.get(chosen) ?? rows;
            tag = chosen;
          }
        }
      }
      // One key per language: en-us asked and en-US chosen for another tag are
      // the same listing, and two keys would split its phrases.
      tag = [...listed.keys()].find(seen => sameLanguage(seen, tag)) ?? tag;
      listed.set(tag, rows);
      answered.set(lang, tag);
    }
  } catch (error) {
    const refused = error instanceof ThalovantPolicyDeniedError && error.deniedType === EVENT_INTENT_LIST;
    if (!fallback || (!refused && !(error instanceof ThalovantTimeoutError))) throw error;
    const names = await intentNames(client, asked[0], { timeoutMs: options.timeoutMs });
    return withFallbacks(client, inventoryFromNames(names, asked, EVENT_INTENT_LIST), options.timeoutMs);
  }

  const wanted: DescribeTarget[] = [];
  for (const [lang, entries] of listed) {
    for (const entry of entries) {
      if (entry.enabled && entry.definition === undefined && entry.method === "template") {
        wanted.push({ skillId: entry.skillId, intentName: entry.intentName, lang });
      }
    }
  }
  const described = describe && wanted.length > 0 ? await describeMany(client, wanted, { timeoutMs: options.timeoutMs }) : new Map<string, IntentDefinition[]>();

  // One intent per skill and name across languages: the engine of its first
  // registration, enabled if any language's is, and the sentences per language.
  const gathered = new Map<string, { skillId: string; name: string; engine: string; enabled: boolean; phrases: Record<string, readonly string[]> }>();
  for (const [lang, entries] of listed) {
    for (const entry of entries) {
      const key = JSON.stringify([entry.skillId, entry.intentName]);
      const intent = gathered.get(key) ?? { skillId: entry.skillId, name: entry.intentName, engine: entry.engine, enabled: false, phrases: {} };
      intent.enabled ||= entry.enabled;
      let sentences: readonly string[];
      if (entry.definition !== undefined) {
        sentences = samplesOf(entry.definition);
      } else {
        const definitions = described.get(describeKey({ skillId: entry.skillId, intentName: entry.intentName, lang })) ?? [];
        sentences = definitions.find(definition => definition.samples.length > 0)?.samples ?? [];
      }
      // An intent registered under both engines has two rows for the language;
      // the keyword row carries no sentences and must not erase the template
      // row's, whichever order the rows arrive in.
      if (sentences.length > 0 || !(lang in intent.phrases)) intent.phrases[lang] = sentences;
      gathered.set(key, intent);
    }
  }

  const bySkill = new Map<string, HubIntent[]>();
  for (const intent of gathered.values()) {
    const intents = bySkill.get(intent.skillId) ?? [];
    intents.push(new HubIntent(intent));
    bySkill.set(intent.skillId, intents);
  }
  return withFallbacks(client, new HubIntentInventory({
    languages: asked,
    skills: skillsFrom(bySkill),
    source: SOURCE_MANIFEST,
    listedIn: asked.map(lang => answered.get(lang) ?? lang),
  }), options.timeoutMs);
}

/**
 * The fallback skills in an `ovos.skills.list` answer, in skill id order.
 *
 * Only the hub's own skills: a row in another session ("default" is where the
 * runtime loads every installed skill) is somebody else's, and a row with no
 * session is taken as the hub's, which is what the runtime means by leaving
 * it out. A malformed row is skipped and the rest kept.
 */
function fallbacksFromSkills(rows: unknown): HubFallback[] {
  const found = new Set<string>();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isRecord(row)) continue;
    const skillId = row.skill_id;
    if (typeof skillId !== "string" || !skillId.trim()) continue;
    const session = row.session_id;
    if (!(session === undefined || session === null || session === "" || session === "default")) continue;
    if (!Array.isArray(row.capabilities)) continue;
    if (row.capabilities.includes(FALLBACK_CAPABILITY)) found.add(skillId.trim());
  }
  return [...found].sort(compare).map(skillId => new HubFallback(skillId));
}

/**
 * Which skills answer whatever nothing else matched, or `null` if unknowable.
 *
 * Read from `ovos.skills.list`: every skill the hub loaded, with the
 * capabilities it declared; a fallback is one declaring `fallback`. It used to
 * ask `ovos.skills.fallback.list`, which ovos-core added in #951 and removed in
 * #988 the same day, so no hub ever answered it.
 *
 * `null` and `[]` are deliberately different answers: `[]` means the hub said
 * it has no fallbacks; `null` means it could not say -- a runtime without
 * `ovos.skills.list`, a connection not allowed to publish it, or a hub that did
 * not reply. No priority comes back: see `HubFallback`.
 *
 * @internal
 */
export async function listFallbacks(client: ThalovantClient, options: { timeoutMs?: number } = {}): Promise<HubFallback[] | null> {
  let event: ThalovantEvent;
  try {
    event = await requestReply(client, EVENT_SKILLS_LIST, EVENT_SKILLS_LIST_RESPONSE, {}, options);
  } catch (error) {
    if (error instanceof ThalovantPolicyDeniedError || error instanceof ThalovantTimeoutError) return null;
    throw error;
  }
  if (event.data.ok === false || !Array.isArray(event.data.skills)) return null;
  return fallbacksFromSkills(event.data.skills);
}

async function withFallbacks(client: ThalovantClient, inventory: HubIntentInventory, timeoutMs?: number): Promise<HubIntentInventory> {
  const fallbacks = await listFallbacks(client, { timeoutMs: Math.min(timeoutMs ?? DEFAULT_TIMEOUT_MS, FALLBACK_PROBE_TIMEOUT_MS) });
  return new HubIntentInventory({ ...inventory, fallbacks: fallbacks ?? [], fallbacksKnown: fallbacks !== null });
}

/** Render an illustrative phrase using locale examples, then explicit slot overrides. */
export function speakable(pattern: string, slots: Readonly<Record<string, string>> = {}, lang?: string, listing: ListingRules = defaultListing): string {
  slots = { ...listing.slotExamples(lang), ...slots };
  let text = pattern;
  while (/\[[^\[\]]*\]/.test(text)) text = text.replace(/\[[^\[\]]*\]/g, "");
  while (/\([^()]*\)/.test(text)) text = text.replace(/\(([^()]*)\)/g, (_, group: string) => {
    const options = group.split("|").map(value => value.trim());
    const real = options.filter(Boolean);
    return real.length < options.length && real.length <= 1 ? "" : real[0] ?? "";
  });
  return text.replace(/\{([a-z_][a-z0-9_]*)\}/g, (_, slot: string) =>
    Object.hasOwn(slots, slot) ? slots[slot] : slot.replaceAll("_", " "))
    .replace(/\s{2,}/g, " ").replace(/^[ ,]+|[ ,]+$/g, "");
}
