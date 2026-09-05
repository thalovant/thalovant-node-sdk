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
} from "./constants.js";
import { ThalovantPolicyDeniedError, ThalovantTimeoutError } from "./errors.js";
import { EventContext, newRequestId, ThalovantEvent } from "./events.js";

/** The inventory was read from the runtime's intent manifest: sentences per language. */
export const SOURCE_MANIFEST = "intent-manifest";
/** The inventory was read from the engines' own manifests: names only. */
export const SOURCE_ENGINES = "engine-manifests";
export type HubIntentSource = typeof SOURCE_MANIFEST | typeof SOURCE_ENGINES;

const DEFAULT_TIMEOUT_MS = 5000;
const ENGINE_BY_METHOD: Record<string, string> = { template: "padatious", keyword: "adapt" };

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
    for (const [candidate, sentences] of Object.entries(this.phrases)) {
      if (sameLanguage(candidate, lang)) return sentences;
    }
    return [];
  }

  /** A few sentences worth showing: whole ones before ones with a slot, shorter first. */
  examples(lang?: string, limit = 2): readonly string[] {
    const pool = lang ? this.phrasesFor(lang) : Object.values(this.phrases)[0] ?? [];
    if (limit <= 0) return pool;
    return [...pool]
      .sort((a, b) => Number(a.includes("{")) - Number(b.includes("{")) || a.length - b.length)
      .slice(0, limit);
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
 * Everything a hub can be asked, grouped by skill.
 *
 * `source` says how it was read: `intent-manifest` carries sentences per
 * language; `engine-manifests` is the names-only fallback, and `denied` then
 * names the query the hub refused.
 */
export class HubIntentInventory {
  /** The languages asked for. */
  readonly languages: readonly string[];
  readonly skills: readonly HubSkillIntents[];
  readonly source: HubIntentSource;
  readonly denied: readonly string[];

  constructor(options: {
    languages: readonly string[];
    skills: readonly HubSkillIntents[];
    source?: HubIntentSource;
    denied?: readonly string[];
  }) {
    this.languages = [...options.languages];
    this.skills = [...options.skills];
    this.source = options.source ?? SOURCE_MANIFEST;
    this.denied = [...(options.denied ?? [])];
  }

  /** Every intent across skills. */
  get intents(): HubIntent[] {
    return this.skills.flatMap(skill => [...skill.intents]);
  }

  /** Whether at least one intent carries a sentence in some language. */
  get hasPhrases(): boolean {
    return this.intents.some(intent => Object.values(intent.phrases).some(sentences => sentences.length > 0));
  }

  asObject(): Record<string, unknown> {
    return {
      languages: [...this.languages],
      source: this.source,
      denied: [...this.denied],
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
  const requestId = newRequestId();
  const context: EventContext = { request_id: requestId };
  if (options.lang) context.lang = options.lang;
  await client.connect();
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
    fail(new ThalovantTimeoutError(`Hub did not answer ${queryType} within ${timeoutMs}ms.`));
  }, timeoutMs);
  const subscriptions = [
    client.on(EVENT_POLICY_DENIED, event => {
      if (deniedTypeOf(event) === queryType) fail(ThalovantPolicyDeniedError.fromEvent(event));
    }),
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
 * One subscription, one request id per registration, replies matched by that
 * id -- or, for a hub that does not echo the id, by the definition's own
 * `skill_id`/`intent_name`/`lang`. Repeats are dropped and the deadline
 * covers the whole batch: a registration the hub did not describe in time is
 * simply absent from the result (keyed by `describeKey`), and only a batch
 * nothing answered rejects with the timeout.
 *
 * @internal Reached through `ThalovantClient.intents()`.
 */
export async function describeMany(
  client: ThalovantClient,
  targets: Iterable<DescribeTarget>,
  options: { timeoutMs?: number } = {},
): Promise<Map<string, IntentDefinition[]>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const wanted = new Map<string, DescribeTarget>();
  for (const target of targets) wanted.set(describeKey(target), target);
  const found = new Map<string, IntentDefinition[]>();
  if (wanted.size === 0) return found;

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
    if (key === undefined && definitions.length > 0) {
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
      if (deniedTypeOf(event) === EVENT_INTENT_DESCRIBE) fail(ThalovantPolicyDeniedError.fromEvent(event));
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
      if (!(error instanceof ThalovantTimeoutError) || found.size === 0) throw error;
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
  // Names are `<skill_id>:<intent_name>`; a name registered by both engines
  // keeps the later one, as the reference implementation does.
  const intents = new Map<string, HubIntent>();
  for (const [engine, entries] of Object.entries(names)) {
    for (const raw of entries) {
      const separator = raw.indexOf(":");
      let skillId = separator >= 0 ? raw.slice(0, separator) : "";
      let name = separator >= 0 ? raw.slice(separator + 1) : "";
      if (!name) [skillId, name] = ["", raw];
      intents.set(JSON.stringify([skillId, name]), new HubIntent({ skillId, name, engine }));
    }
  }
  const bySkill = new Map<string, HubIntent[]>();
  for (const intent of intents.values()) {
    bySkill.set(intent.skillId, [...(bySkill.get(intent.skillId) ?? []), intent]);
  }
  return new HubIntentInventory({ languages, skills: skillsFrom(bySkill), source: SOURCE_ENGINES, denied: [denied] });
}

/**
 * Everything the hub can be asked, in each language, grouped by skill.
 *
 * Asks the intent manifest per language and, unless the runtime attached
 * definitions to the listing, describes every registration at once. When the
 * hub refuses `ovos.intent.list` and `fallback` is on, the engines' manifests
 * give the names and the result says so.
 *
 * @internal Use `ThalovantClient.intents()`.
 */
export async function intentInventory(
  client: ThalovantClient,
  languages: Iterable<string>,
  options: { timeoutMs?: number; describe?: boolean; fallback?: boolean } = {},
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
  try {
    for (const lang of asked) {
      listed.set(lang, await listIntents(client, lang, { timeoutMs: options.timeoutMs, includeDefinitions: describe }));
    }
  } catch (error) {
    if (!fallback || !(error instanceof ThalovantPolicyDeniedError) || error.deniedType !== EVENT_INTENT_LIST) throw error;
    const names = await intentNames(client, asked[0], { timeoutMs: options.timeoutMs });
    return inventoryFromNames(names, asked, error.deniedType);
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
      if (entry.definition !== undefined) {
        intent.phrases[lang] = samplesOf(entry.definition);
      } else {
        const definitions = described.get(describeKey({ skillId: entry.skillId, intentName: entry.intentName, lang })) ?? [];
        intent.phrases[lang] = definitions.find(definition => definition.samples.length > 0)?.samples ?? [];
      }
      gathered.set(key, intent);
    }
  }

  const bySkill = new Map<string, HubIntent[]>();
  for (const intent of gathered.values()) {
    const intents = bySkill.get(intent.skillId) ?? [];
    intents.push(new HubIntent(intent));
    bySkill.set(intent.skillId, intents);
  }
  return new HubIntentInventory({ languages: asked, skills: skillsFrom(bySkill), source: SOURCE_MANIFEST });
}
