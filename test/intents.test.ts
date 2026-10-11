/**
 * The intent inventory, against a hub that behaves like the one observed.
 *
 * Shapes copied from a live runtime on 2026-09-05: `ovos.intent.list.response`
 * rows, `ovos.intent.describe.response` definitions carrying `samples` as the
 * skill's locale files wrote them, `hive.policy.denied` for a type the
 * connection may not publish, and every reply delivered twice.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ThalovantClient } from "../src/client.js";
import {
  EVENT_ADAPT_MANIFEST_GET,
  EVENT_INTENT_DESCRIBE,
  EVENT_INTENT_LIST,
  EVENT_FALLBACK_LIST,
  EVENT_PADATIOUS_MANIFEST_GET,
  EVENT_POLICY_DENIED,
  EVENT_SKILLS_LIST,
} from "../src/constants.js";
import { ThalovantPolicyDeniedError, ThalovantRuntimeError, ThalovantTimeoutError } from "../src/errors.js";
import { EventContext, ThalovantEvent } from "../src/events.js";
import { ThalovantIdentity } from "../src/identity.js";
import { DESCRIBE_BATCH, describeMany, HubFallback, HubIntent, HubSkillIntents, HubIntentInventory, listFallbacks, nearestHubLanguage, sameLanguage, SOURCE_ENGINES, SOURCE_MANIFEST, type IntentRegistration } from "../src/intents.js";

const WEATHER = "thalovant-skill-weather.thalovant";
const SHADOW = "thalovant-skill-custos-shadow.thalovant";

// What the hub registered: per language, per intent, the sentences. Weather
// speaks both languages; the shadow skill only English.
type Registrations = Record<string, Array<[skillId: string, intentName: string, samples: string[]]>>;

const REGISTRATIONS: Registrations = {
  "en-us": [
    [WEATHER, "current.weather", ["what is the weather", "what is the weather in {location}", "how is it outside"]],
    [SHADOW, "custos.incidents", ["are there incidents", "any incidents"]],
  ],
  "fr-fr": [
    [WEATHER, "current.weather", ["quel temps fait-il", "quelle est la météo à {location}", "quelle est la météo"]],
  ],
};
const ALLOWED = ["recognizer_loop:utterance", "speak"];

interface Emitted {
  eventType: string;
  data: Record<string, unknown>;
  context: EventContext;
}

interface FakeHubOptions {
  registrations?: Registrations;
  /**
   * The short way to say what `ovos.skills.list` answers: each skill id (or
   * `{skill_id}` row, its priority ignored -- no runtime serves one) becomes a
   * loaded skill declaring the fallback capability. `null` means the hub never
   * answers. `ovos.skills.fallback.list` is never answered: ovos-core added it
   * in #951 and took it out again in #988.
   */
  fallbacks?: unknown;
  /** `ovos.skills.list` rows exactly as the hub sends them; overrides `fallbacks`. */
  skills?: unknown;
  /** The hub's default language, stamped on the session of a reply to a listing that named none. */
  hubLang?: string;
  refuse?: string[];
  silent?: string[];
  definitionsInList?: boolean;
  echoRequestId?: boolean;
  repeats?: number;
  /** Deliver replies inside `emitBus` itself instead of on a later tick. */
  sync?: boolean;
  /** Keyword (adapt) rows per folded language: listed, never described with sentences. */
  keywords?: Record<string, Array<[skillId: string, intentName: string]>>;
  /** Folded languages whose `ovos.intent.list` gets no answer, or `ok: false`. */
  listSilentIn?: string[];
  listFailsIn?: string[];
}

/** A hub session: answers the manifest, or refuses it, twice over. */
class FakeHubTransport extends EventTarget {
  readonly emitted: Emitted[] = [];
  readonly registrations: Registrations;
  readonly fallbacks: unknown;
  readonly skills: unknown;
  readonly hubLang?: string;
  readonly refuse: string[];
  readonly silent: string[];
  readonly definitionsInList: boolean;
  readonly echoRequestId: boolean;
  readonly repeats: number;
  readonly sync: boolean;
  readonly keywords: Record<string, Array<[skillId: string, intentName: string]>>;
  readonly listSilentIn: string[];
  readonly listFailsIn: string[];
  connected = false;
  /** Describes emitted but not yet answered, and the high-water mark. */
  inFlightDescribes = 0;
  maxInFlightDescribes = 0;
  /** A window opens when a describe goes out with none outstanding. */
  describeWindows = 0;

  constructor(options: FakeHubOptions = {}) {
    super();
    this.registrations = options.registrations ?? REGISTRATIONS;
    this.fallbacks = options.fallbacks === undefined ? [] : options.fallbacks;
    this.skills = options.skills !== undefined ? options.skills : Array.isArray(this.fallbacks)
      ? this.fallbacks.map(row => ({
        skill_id: typeof row === "object" && row !== null ? (row as Record<string, unknown>).skill_id : row,
        session_id: "default",
        capabilities: ["fallback", "converse"],
        intents: 0,
      }))
      : this.fallbacks;
    this.hubLang = options.hubLang;
    this.refuse = options.refuse ?? [];
    this.silent = options.silent ?? [];
    this.definitionsInList = options.definitionsInList ?? false;
    this.echoRequestId = options.echoRequestId ?? true;
    this.repeats = options.repeats ?? 2;
    this.sync = options.sync ?? false;
    this.keywords = options.keywords ?? {};
    this.listSilentIn = options.listSilentIn ?? [];
    this.listFailsIn = options.listFailsIn ?? [];
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  healthcheck() {
    return { connected: this.connected, handshakeComplete: this.connected, transportAlive: this.connected };
  }

  protected deliver(type: string, data: Record<string, unknown>, context: EventContext, onSend?: () => void): void {
    const replyContext: EventContext = { ...context };
    if (!this.echoRequestId) delete replyContext.request_id;
    const send = (): void => {
      onSend?.();
      for (let copy = 0; copy < this.repeats; copy += 1) {
        this.dispatchEvent(new CustomEvent("bus", { detail: { type, data, context: replyContext } }));
      }
    };
    if (this.sync) send();
    else setTimeout(send, 0);
  }

  async emitBus(eventType: string, data: Record<string, unknown>, context: EventContext): Promise<void> {
    this.emitted.push({ eventType, data: { ...data }, context: { ...context } });
    if (this.refuse.includes(eventType)) {
      this.deliver(EVENT_POLICY_DENIED, {
        denied_type: eventType,
        code: "acl_disallowed_type",
        reason: `${eventType} not in allowed_types`,
        data: { msg_type: eventType, allowed: ALLOWED },
      }, context);
      return;
    }
    if (this.silent.includes(eventType)) return;
    // The runtime folds the tag it is asked for; the fake keys registrations
    // by the folded form and answers with the standardised one.
    const lang = String(data.lang ?? "").toLowerCase().replaceAll("_", "-");
    if (eventType === EVENT_SKILLS_LIST) {
      // A runtime without the handler simply never answers.
      if (this.skills !== null) this.deliver("ovos.skills.list.response", { ok: true, skills: this.skills }, context);
    } else if (eventType === EVENT_INTENT_LIST && !("lang" in data)) {
      // Every language the hub loaded, in the hub's spelling. "" in
      // listSilentIn / listFailsIn is this listing.
      if (this.listSilentIn.includes("")) return;
      if (this.listFailsIn.includes("")) {
        this.deliver("ovos.intent.list.response", { ok: false, error: "listing failed" }, context);
        return;
      }
      const rows: Array<Record<string, unknown>> = [];
      for (const [tag, registered] of Object.entries(this.registrations)) {
        const [base, region] = tag.split("-");
        const spelled = region ? `${base}-${region.toUpperCase()}` : base;
        for (const [skillId, intentName, samples] of registered) {
          const row: Record<string, unknown> = {
            skill_id: skillId, intent_name: intentName, lang: spelled, method: "template", enabled: true, session_id: "default",
          };
          if (this.definitionsInList && data.include_definitions) {
            row.definition = { skill_id: skillId, intent_name: intentName, lang: spelled, samples };
          }
          rows.push(row);
        }
      }
      const replyContext: EventContext = { ...context };
      if (this.hubLang) replyContext.session = { session_id: "s", lang: this.hubLang };
      this.deliver("ovos.intent.list.response", { ok: true, intents: rows }, replyContext);
    } else if (eventType === EVENT_FALLBACK_LIST) {
      return;
    } else if (eventType === EVENT_INTENT_LIST && this.listSilentIn.includes(lang)) {
      return;
    } else if (eventType === EVENT_INTENT_LIST && this.listFailsIn.includes(lang)) {
      this.deliver("ovos.intent.list.response", { ok: false, error: "listing failed" }, context);
    } else if (eventType === EVENT_INTENT_LIST) {
      const rows: Array<Record<string, unknown>> = (this.registrations[lang] ?? []).map(([skillId, intentName, samples]) => {
        const row: Record<string, unknown> = {
          skill_id: skillId,
          intent_name: intentName,
          // The runtime standardises what it stores: fr-fr is answered as fr-FR.
          lang: lang === "fr-fr" ? "fr-FR" : lang,
          method: "template",
          enabled: true,
          session_id: "default",
        };
        if (this.definitionsInList && data.include_definitions) {
          row.definition = { skill_id: skillId, intent_name: intentName, lang, samples };
        }
        return row;
      });
      for (const [skillId, intentName] of this.keywords[lang] ?? []) {
        rows.push({ skill_id: skillId, intent_name: intentName, lang, method: "keyword", enabled: true, session_id: "default" });
      }
      this.deliver("ovos.intent.list.response", { ok: true, intents: rows }, context);
    } else if (eventType === EVENT_INTENT_DESCRIBE) {
      if (this.inFlightDescribes === 0) this.describeWindows += 1;
      this.inFlightDescribes += 1;
      this.maxInFlightDescribes = Math.max(this.maxInFlightDescribes, this.inFlightDescribes);
      const match = (this.registrations[lang] ?? []).find(
        ([skillId, intentName]) => skillId === data.skill_id && intentName === data.intent_name,
      );
      const payload = match
        ? {
            ok: true,
            definitions: [{
              method: "template",
              definition: { skill_id: match[0], intent_name: match[1], lang, samples: match[2], blacklist: [], slot_blacklist: {} },
            }],
          }
        : { ok: false, error: "unknown intent" };
      this.deliver("ovos.intent.describe.response", payload, context, () => {
        this.inFlightDescribes -= 1;
      });
    } else if (eventType === EVENT_ADAPT_MANIFEST_GET) {
      this.deliver("intent.service.adapt.manifest", { intents: [] }, context);
    } else if (eventType === EVENT_PADATIOUS_MANIFEST_GET) {
      const names = new Set<string>();
      for (const rows of Object.values(this.registrations)) {
        for (const [skillId, intentName] of rows) names.add(`${skillId}:${intentName}`);
      }
      this.deliver("intent.service.padatious.manifest", { intents: [...names].sort() }, context);
    }
  }
}

function identity(): ThalovantIdentity {
  return new ThalovantIdentity({ key: "access", password: "secret", site: "site", host: "https://hub.example.com" });
}

function client(transport: FakeHubTransport): ThalovantClient {
  return new ThalovantClient(identity(), { transport, replySettleMs: 0 });
}

function emittedOf(hub: FakeHubTransport, eventType: string): Emitted[] {
  return hub.emitted.filter(entry => entry.eventType === eventType);
}

test("intents carry the sentences per language", async () => {
  const hub = new FakeHubTransport();
  const inventory = await client(hub).intents(["en-us", "fr-fr"]);

  assert.ok(inventory instanceof HubIntentInventory);
  assert.equal(inventory.source, SOURCE_MANIFEST);
  assert.deepEqual(inventory.denied, []);
  assert.deepEqual(inventory.languages, ["en-us", "fr-fr"]);
  assert.deepEqual(inventory.skills.map(skill => skill.skillId), [SHADOW, WEATHER]);
  const weather = inventory.skills[1].intents[0];
  assert.equal(weather.id, `${WEATHER}:current.weather`);
  assert.equal(weather.engine, "padatious");
  assert.equal(weather.enabled, true);
  assert.deepEqual(weather.phrasesFor("fr-FR"), ["quel temps fait-il", "quelle est la météo à {location}", "quelle est la météo"]);
  assert.deepEqual(inventory.skills[1].languages, ["en-us", "fr-fr"]);
  const shadow = inventory.skills[0];
  assert.deepEqual(shadow.languages, ["en-us"], "the hub said the skill has no French");
  assert.deepEqual(shadow.intents[0].phrasesFor("fr-fr"), []);
  assert.equal(inventory.hasPhrases, true);
});

test("intent examples prefer whole sentences and respect the limit", async () => {
  const inventory = await client(new FakeHubTransport()).intents(["en-us"]);
  const weather = inventory.skills[1].intents[0];

  assert.deepEqual(weather.examples("en-us", 2), ["how is it outside", "what is the weather"]);
  assert.deepEqual(weather.examples("en-us", 0), weather.phrasesFor("en-us"));
  assert.deepEqual(weather.examples(undefined, 1), ["how is it outside"]);
  assert.deepEqual(weather.examples(), ["how is it outside", "what is the weather"]);
});

test("every registration is described at once and repeats are dropped", async () => {
  const hub = new FakeHubTransport({ repeats: 3 });
  const inventory = await client(hub).intents(["en-us", "fr-fr"]);

  const describes = emittedOf(hub, EVENT_INTENT_DESCRIBE).map(entry => [entry.data.skill_id, entry.data.intent_name, entry.data.lang].join("/"));
  assert.equal(describes.length, 3);
  assert.equal(new Set(describes).size, 3);
  assert.equal(inventory.intents.length, 2);
  // Three copies of each reply must not count as three answers: the batch is
  // complete only once every registration has been described.
  const weather = inventory.intents.find(intent => intent.skillId === WEATHER);
  const shadow = inventory.intents.find(intent => intent.skillId === SHADOW);
  assert.deepEqual(weather?.phrasesFor("en-us"), REGISTRATIONS["en-us"][0][2]);
  assert.deepEqual(weather?.phrasesFor("fr-fr"), REGISTRATIONS["fr-fr"][0][2]);
  assert.deepEqual(shadow?.phrasesFor("en-us"), REGISTRATIONS["en-us"][1][2]);
  for (const entry of hub.emitted) {
    if (entry.eventType === EVENT_INTENT_LIST || entry.eventType === EVENT_INTENT_DESCRIBE) {
      assert.ok(typeof entry.context.request_id === "string", "every query is correlated by request id");
      assert.equal(entry.context.lang, entry.data.lang, "the language travels in the context too");
    }
  }
});

test("definitions attached to the listing skip the describes", async () => {
  const hub = new FakeHubTransport({ definitionsInList: true });
  const inventory = await client(hub).intents(["fr-fr"]);

  assert.equal(emittedOf(hub, EVENT_INTENT_DESCRIBE).length, 0);
  assert.equal(inventory.intents[0].phrasesFor("fr-fr")[0], "quel temps fait-il");
  assert.deepEqual(hub.emitted[0].data, { lang: "fr-fr", include_definitions: true });
});

test("a refusal is an error naming the type, not a timeout", async () => {
  const hub = new FakeHubTransport({ refuse: [EVENT_INTENT_LIST] });
  const started = Date.now();
  const error = await client(hub).intents(["en-us"], { fallback: false, timeoutMs: 5000 }).then(
    () => assert.fail("the refusal was not raised"),
    (caught: unknown) => caught,
  );

  assert.ok(error instanceof ThalovantPolicyDeniedError);
  assert.ok(error instanceof ThalovantRuntimeError, "a policy refusal is a runtime error");
  assert.equal(error.deniedType, EVENT_INTENT_LIST);
  assert.equal(error.code, "acl_disallowed_type");
  assert.equal(error.reason, `${EVENT_INTENT_LIST} not in allowed_types`);
  assert.deepEqual(error.allowed, ALLOWED);
  assert.match(error.message, /ovos\.intent\.list/);
  assert.match(error.message, /connection/);
  assert.ok(Date.now() - started < 1000, "the refusal did not wait for the timeout");
});

test("the fallback lists names and says what was refused", async () => {
  const hub = new FakeHubTransport({ refuse: [EVENT_INTENT_LIST] });
  const inventory = await client(hub).intents(["en-us", "fr-fr"]);

  assert.equal(inventory.source, SOURCE_ENGINES);
  assert.deepEqual(inventory.denied, [EVENT_INTENT_LIST]);
  assert.equal(inventory.hasPhrases, false);
  assert.deepEqual(inventory.intents.map(intent => intent.id), [`${SHADOW}:custos.incidents`, `${WEATHER}:current.weather`]);
  assert.deepEqual(inventory.intents.map(intent => intent.engine), ["padatious", "padatious"]);
  assert.deepEqual(inventory.languages, ["en-us", "fr-fr"]);
  // Names carry no language, so the engines are asked once, not per language.
  assert.equal(emittedOf(hub, EVENT_PADATIOUS_MANIFEST_GET).length, 1);
  assert.equal(emittedOf(hub, EVENT_ADAPT_MANIFEST_GET).length, 1);
});

test("a hub refusing everything rejects even with the fallback", async () => {
  const hub = new FakeHubTransport({ refuse: [EVENT_INTENT_LIST, EVENT_ADAPT_MANIFEST_GET] });
  await assert.rejects(
    client(hub).intents(["en-us"]),
    (error: unknown) => error instanceof ThalovantPolicyDeniedError && error.deniedType === EVENT_ADAPT_MANIFEST_GET,
  );
});

test("a refused describe rejects at once", async () => {
  const hub = new FakeHubTransport({ refuse: [EVENT_INTENT_DESCRIBE] });
  await assert.rejects(
    client(hub).intents(["en-us"], { timeoutMs: 5000 }),
    (error: unknown) => error instanceof ThalovantPolicyDeniedError && error.deniedType === EVENT_INTENT_DESCRIBE,
  );
});

test("a silent listing rejects when engine fallback is disabled", async () => {
  const hub = new FakeHubTransport({ silent: [EVENT_INTENT_LIST] });
  await assert.rejects(
    client(hub).intents(["en-us"], { timeoutMs: 200, fallback: false }),
    (error: unknown) => error instanceof ThalovantTimeoutError && /ovos\.intent\.list/.test(error.message),
  );
});

test("a describe that never comes leaves that intent without sentences", async () => {
  class HalfDeaf extends FakeHubTransport {
    override async emitBus(eventType: string, data: Record<string, unknown>, context: EventContext): Promise<void> {
      if (eventType === EVENT_INTENT_DESCRIBE && data.skill_id === SHADOW) {
        this.emitted.push({ eventType, data: { ...data }, context: { ...context } });
        return;
      }
      await super.emitBus(eventType, data, context);
    }
  }

  const inventory = await client(new HalfDeaf()).intents(["en-us"], { timeoutMs: 300 });
  const byId = new Map(inventory.intents.map(intent => [intent.id, intent]));
  assert.ok(byId.get(`${WEATHER}:current.weather`)?.phrasesFor("en-us").length);
  assert.deepEqual(byId.get(`${SHADOW}:custos.incidents`)?.phrasesFor("en-us"), []);
  assert.deepEqual(byId.get(`${SHADOW}:custos.incidents`)?.languages, ["en-us"]);
});

test("a reply without a request id is still taken", async () => {
  // A hub that does not echo the request id is not evidence of anything.
  const hub = new FakeHubTransport({ echoRequestId: false, repeats: 1 });
  const inventory = await client(hub).intents(["en-us", "fr-fr"]);
  assert.equal(inventory.hasPhrases, true);
  assert.deepEqual(inventory.skills[1].intents[0].phrasesFor("fr-fr"), REGISTRATIONS["fr-fr"][0][2]);
  assert.deepEqual(inventory.skills[0].intents[0].phrasesFor("en-us"), REGISTRATIONS["en-us"][1][2]);
});

test("a reply delivered inside the emit itself is still taken", async () => {
  const hub = new FakeHubTransport({ sync: true });
  const inventory = await client(hub).intents(["en-us"]);
  assert.equal(inventory.intents.length, 2);
  assert.equal(inventory.hasPhrases, true);
});

test("low-level calls expose the manifest rows and definitions", async () => {
  const hub = new FakeHubTransport();
  const rows = await client(hub).listIntents("fr-fr");
  assert.deepEqual(rows.map(row => [row.skillId, row.intentName, row.engine, row.method, row.enabled, row.sessionId]), [
    [WEATHER, "current.weather", "padatious", "template", true, "default"],
  ]);
  assert.equal(rows[0].lang, "fr-FR");
  assert.ok(sameLanguage(rows[0].lang, "fr-fr"));
  assert.equal(rows[0].definition, undefined);

  const definitions = await client(hub).describeIntent(WEATHER, "current.weather", "fr-fr");
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0].samples[0], "quel temps fait-il");
  assert.equal(definitions[0].engine, "padatious");
  assert.deepEqual(definitions[0].raw.blacklist, []);
  assert.deepEqual(await client(hub).describeIntent(SHADOW, "custos.incidents", "fr-fr"), []);

  const withDefinitions = await client(new FakeHubTransport({ definitionsInList: true })).listIntents("en-us", { includeDefinitions: true });
  assert.deepEqual(withDefinitions[0].definition?.samples, REGISTRATIONS["en-us"][0][2]);
});

test("asObject is JSON-ready and complete", async () => {
  const inventory = await client(new FakeHubTransport()).intents(["en-us", "fr-fr"]);
  const payload = JSON.parse(JSON.stringify(inventory.asObject())) as {
    source: string;
    denied: string[];
    languages: string[];
    skills: Array<{ skill_id: string; languages: string[]; intents: Array<Record<string, unknown>> }>;
  };

  assert.equal(payload.source, SOURCE_MANIFEST);
  assert.deepEqual(payload.denied, []);
  assert.deepEqual(payload.languages, ["en-us", "fr-fr"]);
  const weather = payload.skills.find(skill => skill.skill_id === WEATHER);
  assert.deepEqual(weather?.languages, ["en-us", "fr-fr"]);
  assert.deepEqual(weather?.intents[0], {
    id: `${WEATHER}:current.weather`,
    skill_id: WEATHER,
    name: "current.weather",
    engine: "padatious",
    enabled: true,
    phrases: { "en-us": REGISTRATIONS["en-us"][0][2], "fr-fr": REGISTRATIONS["fr-fr"][0][2] },
  });
});

test("languages default to English", async () => {
  const hub = new FakeHubTransport();
  await client(hub).intents();
  assert.equal(hub.emitted[0].data.lang, "en-us");
  hub.emitted.length = 0;
  await client(hub).intents([]);
  assert.equal(hub.emitted[0].data.lang, "en-us");
  hub.emitted.length = 0;
  await client(hub).listIntents();
  assert.equal(hub.emitted[0].data.lang, "en-us");
});

test("each language is asked once, trimmed, in its first spelling", async () => {
  const hub = new FakeHubTransport();
  const inventory = await client(hub).intents([" en-us ", "en-US", "en_us", "fr_FR", "fr-fr", ""]);

  assert.deepEqual(emittedOf(hub, EVENT_INTENT_LIST).map(entry => entry.data.lang), ["en-us", "fr_FR"]);
  assert.deepEqual(inventory.languages, ["en-us", "fr_FR"]);
  const weather = inventory.intents.find(intent => intent.skillId === WEATHER);
  assert.deepEqual(weather?.languages, ["en-us", "fr_FR"]);
  assert.deepEqual(weather?.phrasesFor("fr-fr"), REGISTRATIONS["fr-fr"][0][2]);
  await assert.rejects(client(hub).intents([" ", ""]), /at least one language/);
});

test("hasPhrases means at least one sentence", async () => {
  const hub = new FakeHubTransport({ registrations: { "en-us": [[SHADOW, "custos.incidents", []]] } });
  const inventory = await client(hub).intents(["en-us"]);
  assert.equal(inventory.intents.length, 1);
  assert.deepEqual(inventory.intents[0].languages, ["en-us"]);
  assert.equal(inventory.hasPhrases, false);
});

// One intent, two registrations in one language: the keyword row has no
// samples and must not erase the template row's, whichever comes first.
class Dual extends FakeHubTransport {
  constructor(private readonly order: "template-first" | "keyword-first") {
    super();
  }

  override async emitBus(eventType: string, data: Record<string, unknown>, context: EventContext): Promise<void> {
    if (eventType !== EVENT_INTENT_LIST) return super.emitBus(eventType, data, context);
    const lang = String(data.lang);
    const template = {
      skill_id: WEATHER, intent_name: "current.weather", lang, method: "template", enabled: true, session_id: "default",
      definition: { skill_id: WEATHER, intent_name: "current.weather", lang, samples: ["what is the weather"] },
    };
    const keyword = {
      skill_id: WEATHER, intent_name: "current.weather", lang, method: "keyword", enabled: true, session_id: "default",
      definition: { skill_id: WEATHER, intent_name: "current.weather", lang, required: [["WeatherKeyword"]] },
    };
    const rows = this.order === "template-first" ? [template, keyword] : [keyword, template];
    this.emitted.push({ eventType, data: { ...data }, context: { ...context } });
    this.deliver("ovos.intent.list.response", { ok: true, intents: rows }, context);
  }
}

test("a keyword row does not erase the template row's sentences", async () => {
  const inventory = await client(new Dual("template-first")).intents(["en-us"]);
  assert.equal(inventory.intents.length, 1);
  assert.deepEqual(inventory.intents[0].phrasesFor("en-us"), ["what is the weather"]);
  assert.equal(inventory.intents[0].engine, "padatious", "the first row names the engine");
});

test("a template row after the keyword row still carries the sentences", async () => {
  const inventory = await client(new Dual("keyword-first")).intents(["en-us"]);
  assert.equal(inventory.intents.length, 1);
  assert.deepEqual(inventory.intents[0].phrasesFor("en-us"), ["what is the weather"]);
  assert.equal(inventory.intents[0].engine, "adapt", "the first row names the engine");
});

test("the fallback keeps the first engine that names an intent", async () => {
  class BothEngines extends FakeHubTransport {
    override async emitBus(eventType: string, data: Record<string, unknown>, context: EventContext): Promise<void> {
      if (eventType !== EVENT_ADAPT_MANIFEST_GET) return super.emitBus(eventType, data, context);
      this.emitted.push({ eventType, data: { ...data }, context: { ...context } });
      this.deliver("intent.service.adapt.manifest", { intents: [`${WEATHER}:current.weather`] }, context);
    }
  }

  const hub = new BothEngines({ refuse: [EVENT_INTENT_LIST] });
  const inventory = await client(hub).intents(["en-us"]);
  assert.deepEqual(hub.emitted.map(entry => entry.eventType).slice(1), [EVENT_ADAPT_MANIFEST_GET, EVENT_PADATIOUS_MANIFEST_GET, EVENT_SKILLS_LIST]);
  const weather = inventory.intents.find(intent => intent.name === "current.weather");
  assert.equal(weather?.engine, "adapt");
  assert.equal(inventory.intents.find(intent => intent.name === "custos.incidents")?.engine, "padatious");
  assert.equal(inventory.intents.length, 2, "the same name from both engines is one intent");
});

test("describes go out in bounded batches", async () => {
  // A hub with many intents must not put more requests in flight than a
  // bounded reply queue can hold: 69 intents is 69 describes, and every reply
  // arrives twice. They go out 32 at a time, each batch its own window.
  const many = manyIntents();
  const hub = new FakeHubTransport({ registrations: many });
  const inventory = await client(hub).intents(["en-us"]);

  assert.equal(DESCRIBE_BATCH, 32);
  assert.equal(emittedOf(hub, EVENT_INTENT_DESCRIBE).length, 69);
  assert.equal(hub.describeWindows, 3, "69 describes go out in three batches of at most 32");
  assert.equal(hub.maxInFlightDescribes, DESCRIBE_BATCH, "never more than a batch in flight");
  assert.equal(inventory.intents.length, 69);
  assert.deepEqual(
    inventory.intents.filter(intent => intent.phrasesFor("en-us").length === 0).map(intent => intent.id),
    [],
    "every intent came back with its sentence",
  );
  assert.deepEqual(inventory.intents[0].phrasesFor("en-us"), ["sentence 0"]);
  assert.deepEqual(inventory.intents[68].phrasesFor("en-us"), ["sentence 68"]);

  // The same through the low-level call, and unbatched on request.
  const direct = new FakeHubTransport({ registrations: many });
  const wanted = many["en-us"].map(([skillId, intentName]) => ({ skillId, intentName, lang: "en-us" }));
  assert.equal((await describeMany(client(direct), wanted, { timeoutMs: 5000 })).size, 69);
  assert.equal(direct.describeWindows, 3);

  const atOnce = new FakeHubTransport({ registrations: many });
  assert.equal((await describeMany(client(atOnce), wanted, { timeoutMs: 5000, batch: 0 })).size, 69);
  assert.equal(atOnce.describeWindows, 1, "batch 0 sends them all at once");
  assert.equal(atOnce.maxInFlightDescribes, 69);
});

// 69 intents, one language: windows are 0-31, 32-63, 64-68.
function manyIntents(): Registrations {
  return {
    "en-us": Array.from({ length: 69 }, (_, n): [string, string, string[]] => [
      WEATHER,
      `intent.${String(n).padStart(3, "0")}`,
      [`sentence ${n}`],
    ]),
  };
}

test("a silent window keeps what the earlier windows found", async () => {
  // Windows are contiguous slices, so a skill that stops answering can own a
  // whole window. Losing its sentences is right; losing the inventory is not.
  const quietFrom = 40;

  class GoesQuiet extends FakeHubTransport {
    override async emitBus(eventType: string, data: Record<string, unknown>, context: EventContext): Promise<void> {
      if (eventType === EVENT_INTENT_DESCRIBE && Number(String(data.intent_name).split(".").at(-1)) >= quietFrom) {
        this.emitted.push({ eventType, data: { ...data }, context: { ...context } });
        return;
      }
      await super.emitBus(eventType, data, context);
    }
  }

  const hub = new GoesQuiet({ registrations: manyIntents() });
  const inventory = await client(hub).intents(["en-us"], { timeoutMs: 300 });

  assert.equal(inventory.intents.length, 69, "every intent is still listed");
  // The first window answers in full, the second in part, the third not at
  // all -- and the third does not discard the rest.
  assert.equal(inventory.intents.filter(intent => intent.phrasesFor("en-us").length > 0).length, quietFrom);
  assert.deepEqual(inventory.intents[0].phrasesFor("en-us"), ["sentence 0"]);
  assert.deepEqual(inventory.intents[39].phrasesFor("en-us"), ["sentence 39"]);
  assert.deepEqual(inventory.intents[40].phrasesFor("en-us"), []);
  assert.deepEqual(inventory.intents[68].phrasesFor("en-us"), []);
  assert.equal(inventory.hasPhrases, true);
});

test("a hub silent from the first window still fails fast", async () => {
  const hub = new FakeHubTransport({ registrations: manyIntents(), silent: [EVENT_INTENT_DESCRIBE] });
  const wanted = manyIntents()["en-us"].map(([skillId, intentName]) => ({ skillId, intentName, lang: "en-us" }));

  await assert.rejects(
    describeMany(client(hub), wanted, { timeoutMs: 200 }),
    (error: unknown) => error instanceof ThalovantTimeoutError && /ovos\.intent\.describe/.test(error.message),
  );
  assert.equal(emittedOf(hub, EVENT_INTENT_DESCRIBE).length, DESCRIBE_BATCH, "it gives up after one window, not after all 69");
});

test("language tags compare case-insensitively with separators folded", () => {
  assert.ok(sameLanguage("fr-fr", "fr_FR"));
  assert.ok(sameLanguage(" en-US ", "en-us"));
  assert.ok(!sameLanguage("en-us", "en-gb"));
});

test("a policy refusal parses the hub's event as sent", () => {
  const event = new ThalovantEvent(EVENT_POLICY_DENIED, {
    denied_type: EVENT_INTENT_LIST,
    code: "acl_disallowed_type",
    reason: "ovos.intent.list not in allowed_types",
    data: { msg_type: EVENT_INTENT_LIST, allowed: ALLOWED },
  });
  const error = ThalovantPolicyDeniedError.fromEvent(event);
  assert.equal(error.deniedType, EVENT_INTENT_LIST);
  assert.equal(error.code, "acl_disallowed_type");
  assert.deepEqual(error.allowed, ALLOWED);
  assert.equal(
    error.message,
    'The hub refused "ovos.intent.list": ovos.intent.list not in allowed_types. ' +
      'Allow this connection to publish "ovos.intent.list" in the dashboard\'s connection settings.',
  );

  const bare = ThalovantPolicyDeniedError.fromEvent(new ThalovantEvent(EVENT_POLICY_DENIED, { denied_type: "speak" }));
  assert.deepEqual(bare.allowed, []);
  assert.match(bare.message, /refused by the hub's policy/);
});

test("a refused listing is an error, not an empty hub", async () => {
  // `ok: false` on a listing means the query failed. Reading the missing
  // `intents` key as an empty list would show a person an empty hub.
  class Refuses extends FakeHubTransport {
    override async emitBus(eventType: string, data: Record<string, unknown>, context: EventContext): Promise<void> {
      if (eventType === EVENT_INTENT_LIST) {
        this.emitted.push({ eventType, data: { ...data }, context: { ...context } });
        this.deliver("ovos.intent.list.response", { ok: false, error: "manifest unavailable" }, context);
        return;
      }
      await super.emitBus(eventType, data, context);
    }
  }

  const hub = new Refuses();
  await assert.rejects(
    client(hub).intents(["en-us"], { timeoutMs: 5000 }),
    (error: unknown) =>
      error instanceof ThalovantRuntimeError &&
      !(error instanceof ThalovantPolicyDeniedError) &&
      /ovos\.intent\.list failed: manifest unavailable/.test(error.message),
  );
  // The engines' manifests are the fallback for a refusal, not for a failure:
  // the hub answered, and what it said was that it could not answer.
  assert.equal(emittedOf(hub, EVENT_PADATIOUS_MANIFEST_GET).length, 0);
});

test("a listing that fails without saying why still names the query", async () => {
  class Mute extends FakeHubTransport {
    override async emitBus(eventType: string, data: Record<string, unknown>, context: EventContext): Promise<void> {
      if (eventType === EVENT_INTENT_LIST) {
        this.emitted.push({ eventType, data: { ...data }, context: { ...context } });
        this.deliver("ovos.intent.list.response", { ok: false }, context);
        return;
      }
      await super.emitBus(eventType, data, context);
    }
  }

  await assert.rejects(
    client(new Mute()).intents(["en-us"], { timeoutMs: 5000 }),
    (error: unknown) =>
      error instanceof ThalovantRuntimeError && /ovos\.intent\.list failed: the hub refused the listing/.test(error.message),
  );
});

test("a describe that does not know the intent is not an error", async () => {
  // The other half of the rule: `ok: false` from describe is a real answer --
  // the hub does not know that registration -- and leaves it without sentences.
  class KnowsNothing extends FakeHubTransport {
    override async emitBus(eventType: string, data: Record<string, unknown>, context: EventContext): Promise<void> {
      if (eventType === EVENT_INTENT_DESCRIBE) {
        this.emitted.push({ eventType, data: { ...data }, context: { ...context } });
        this.deliver("ovos.intent.describe.response", { ok: false, error: "unknown intent" }, context);
        return;
      }
      await super.emitBus(eventType, data, context);
    }
  }

  const inventory = await client(new KnowsNothing()).intents(["en-us"], { timeoutMs: 5000 });
  assert.equal(inventory.source, SOURCE_MANIFEST);
  assert.deepEqual(inventory.intents.map(intent => intent.id), [`${SHADOW}:custos.incidents`, `${WEATHER}:current.weather`]);
  assert.equal(inventory.hasPhrases, false, "every intent is listed, none carries sentences");
});

test("only string entries survive in the allowed list", () => {
  // A number or a null in `allowed` is not a message type; stringifying one
  // would put "3" in front of an operator reading which types to allow.
  const error = ThalovantPolicyDeniedError.fromEvent(new ThalovantEvent(EVENT_POLICY_DENIED, {
    denied_type: EVENT_INTENT_LIST,
    code: "acl_disallowed_type",
    data: { allowed: ["speak", 3, null, { msg_type: "speak" }, "recognizer_loop:utterance"] },
  }));

  assert.deepEqual(error.allowed, ["speak", "recognizer_loop:utterance"]);
});


test("a silent listing uses engine manifests and records the unanswered query", async () => {
  const hub = new FakeHubTransport({ silent: [EVENT_INTENT_LIST], fallbacks: [{ skill_id: "fallback.llm", priority: 50 }] });
  const inventory = await client(hub).intents("en-us", { timeoutMs: 20 });
  assert.equal(inventory.source, SOURCE_ENGINES);
  assert.deepEqual(inventory.denied, [EVENT_INTENT_LIST]);
  assert.equal(inventory.intents.length, 2);
  assert.equal(inventory.fallbacksKnown, true);
  assert.equal(inventory.mayAnswer("fr-fr"), true);
  assert.equal(emittedOf(hub, EVENT_ADAPT_MANIFEST_GET).length, 1);
  assert.equal(emittedOf(hub, EVENT_PADATIOUS_MANIFEST_GET).length, 1);
});

test("silence from the engine fallback still rejects", async () => {
  const hub = new FakeHubTransport({ silent: [EVENT_INTENT_LIST, EVENT_ADAPT_MANIFEST_GET] });
  await assert.rejects(client(hub).intents(["en-us"], { timeoutMs: 20 }), error =>
    error instanceof ThalovantTimeoutError && /adapt/.test(error.message));
});

test("bare language strings form one language and an empty string defaults to English", async () => {
  for (const lang of ["fr_FR", ""]) {
    const hub = new FakeHubTransport();
    const inventory = await client(hub).intents(lang);
    assert.deepEqual(inventory.languages, [lang || "en-us"]);
    assert.equal(emittedOf(hub, EVENT_INTENT_LIST).length, 1);
  }
});

test("fallbacks are in skill id order with no priority, and allow languages without intent phrases", async () => {
  const hub = new FakeHubTransport({ fallbacks: [
    { skill_id: "fallback.z", priority: 50 }, { skill_id: "fallback.a", priority: 50 },
    { skill_id: "fallback.first", priority: 1 }, "fallback.a",
  ] });
  const inventory = await client(hub).intents(["en-us"]);
  assert.deepEqual(inventory.fallbacks.map(row => [row.skillId, row.priority]), [
    ["fallback.a", null], ["fallback.first", null], ["fallback.z", null],
  ], "skill id order, de-duplicated, and no priority: the hub does not serve one");
  assert.ok(inventory.fallbacks[0] instanceof HubFallback);
  assert.deepEqual(inventory.fallbacks[0].asObject(), { skill_id: "fallback.a", priority: null });
  assert.equal(emittedOf(hub, EVENT_FALLBACK_LIST).length, 0, "no runtime answers it, and asking cost every listing 1.5 s");
  assert.equal(inventory.fallbacksKnown, true);
  assert.equal(inventory.mayAnswer("ja-jp"), true);
  assert.deepEqual(inventory.asObject().fallbacks, inventory.fallbacks.map(row => row.asObject()));
  assert.equal(inventory.asObject().fallbacks_known, true);
});

test("known empty and unknown fallback sets keep distinct answerability semantics", async () => {
  const empty = await client(new FakeHubTransport()).intents(["en-us"]);
  assert.equal(empty.fallbacksKnown, true);
  assert.equal(empty.mayAnswer("en_US"), true);
  assert.equal(empty.mayAnswer("ja-jp"), false);
  for (const options of [
    { refuse: [EVENT_SKILLS_LIST] }, { silent: [EVENT_SKILLS_LIST] }, { fallbacks: null }, { skills: "not a list" },
  ]) {
    const inventory = await client(new FakeHubTransport(options)).intents(["en-us"], { timeoutMs: 25 });
    assert.equal(inventory.fallbacksKnown, false);
    assert.deepEqual(inventory.fallbacks, []);
    assert.equal(inventory.mayAnswer("ja-jp"), true);
    assert.equal(inventory.asObject().fallbacks_known, false);
  }
});

test("disabled intent phrases do not imply answerability", () => {
  const inventory = new HubIntentInventory({ languages: ["en-us"], fallbacksKnown: true,
    skills: [new HubSkillIntents("disabled", [new HubIntent({ skillId: "disabled", name: "test", engine: "padatious", enabled: false, phrases: { "en-us": ["hello"] } })])],
  });
  assert.equal(inventory.mayAnswer("en-us"), false);
});

test("only the hub's own fallback skills are listed and malformed rows are skipped", async () => {
  const hub = new FakeHubTransport({ skills: [
    { skill_id: "thalovant-skill-memory.thalovant", session_id: "default", capabilities: ["fallback", "converse"], intents: 0 },
    { skill_id: "thalovant-skill-weather.thalovant", session_id: "default", capabilities: [], intents: 16 },
    { skill_id: "someone-elses.fallback", session_id: "another-session", capabilities: ["fallback"], intents: 0 },
    { skill_id: "custos-fallback.thalovant", capabilities: ["fallback"] },
    { skill_id: "empty-session.thalovant", session_id: "", capabilities: ["fallback"] },
    { skill_id: "", session_id: "default", capabilities: ["fallback"] },
    { skill_id: 42, session_id: "default", capabilities: ["fallback"] },
    { skill_id: "no-capabilities.thalovant", session_id: "default", capabilities: null },
    { skill_id: "string-capabilities.thalovant", session_id: "default", capabilities: "fallback" },
    null, "not a row",
  ] });
  assert.deepEqual((await listFallbacks(client(hub)))?.map(row => row.asObject()), [
    { skill_id: "custos-fallback.thalovant", priority: null },
    { skill_id: "empty-session.thalovant", priority: null },
    { skill_id: "thalovant-skill-memory.thalovant", priority: null },
  ]);
  assert.equal(emittedOf(hub, EVENT_FALLBACK_LIST).length, 0);
});

test("a fallback built by hand keeps the priority it was given", () => {
  assert.equal(new HubFallback("x", 5).priority, 5);
  assert.equal(new HubFallback("x").priority, null);
});

test("the unsupported optional probe uses its own small ceiling", async () => {
  const hub = new FakeHubTransport({ silent: [EVENT_SKILLS_LIST] });
  const started = performance.now();
  const inventory = await client(hub).intents(["en-us"], { timeoutMs: 10000 });
  assert.equal(inventory.fallbacksKnown, false);
  assert.ok(performance.now() - started < 4000, "optional probe must not wait the full 10 second query timeout");
});


test("another request's correlated policy denial does not fail inventory queries", async () => {
  class Noisy extends FakeHubTransport {
    override async emitBus(type: string, data: Record<string, unknown>, context: EventContext) {
      this.deliver(EVENT_POLICY_DENIED, { denied_type: type }, { request_id: "another-request" });
      return super.emitBus(type, data, context);
    }
  }
  const inventory = await client(new Noisy({ sync: true })).intents(["en-us"], { timeoutMs: 100 });
  assert.equal(inventory.source, SOURCE_MANIFEST);
  assert.equal(inventory.hasPhrases, true);
  assert.equal(inventory.fallbacksKnown, true);
});

test("describe never accepts a foreign request ID by matching its definition", async () => {
  class Noisy extends FakeHubTransport {
    override async emitBus(type: string, data: Record<string, unknown>, context: EventContext) {
      if (type === EVENT_INTENT_DESCRIBE) this.deliver("ovos.intent.describe.response", {
        ok: true, definitions: [{ method: "template", definition: { ...data, samples: ["foreign answer"] } }],
      }, { request_id: "another-request" });
      return super.emitBus(type, data, context);
    }
  }
  const inventory = await client(new Noisy({ sync: true })).intents(["en-us"], { timeoutMs: 100 });
  assert.equal(inventory.hasPhrases, true);
  assert.ok(inventory.intents.every(intent => !intent.phrasesFor("en-us").includes("foreign answer")));
});


test("explicitly failed fallback discovery is unknown even with an empty list", async () => {
  class Failed extends FakeHubTransport {
    override async emitBus(type: string, data: Record<string, unknown>, context: EventContext) {
      if (type === EVENT_SKILLS_LIST) {
        this.deliver("ovos.skills.list.response", { ok: false, skills: [] }, context);
        return;
      }
      return super.emitBus(type, data, context);
    }
  }
  const inventory = await client(new Failed()).intents(["en-us"]);
  assert.equal(inventory.fallbacksKnown, false);
  assert.equal(inventory.mayAnswer("ja-jp"), true);
});

test("optional probe deadline includes reconnect and retains retired connect ownership", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  class Reconnecting extends FakeHubTransport {
    connects = 0;
    override async connect() {
      this.connects += 1;
      if (this.connects === 2) await gate;
      return super.connect();
    }
  }
  const hub = new Reconnecting();
  const sdk = client(hub);
  await sdk.connect(200);
  hub.connected = false;
  try {
    const started = performance.now();
    assert.equal(await listFallbacks(sdk, { timeoutMs: 30 }), null);
    assert.ok(performance.now() - started < 250);
    await assert.rejects(sdk.connect(20));
    assert.equal(hub.connects, 2, "retry must wait for the retired attempt");
    assert.equal(emittedOf(hub, EVENT_SKILLS_LIST).length, 0);
    release();
    await sdk.connect(200);
    assert.equal(hub.connects, 3);
  } finally {
    release();
    await sdk.close();
  }
});

test("optional probe deadline includes a held send and removes its listeners", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  class HeldSend extends FakeHubTransport {
    override async emitBus(type: string, data: Record<string, unknown>, context: EventContext) {
      if (type === EVENT_SKILLS_LIST) await gate;
      return super.emitBus(type, data, context);
    }
  }
  const hub = new HeldSend();
  const sdk = client(hub);
  try {
    const started = performance.now();
    assert.equal(await listFallbacks(sdk, { timeoutMs: 30 }), null);
    assert.ok(performance.now() - started < 250);
    release();
    await new Promise(resolve => setTimeout(resolve, 5));
    const inventory = await sdk.intents(["en-us"]);
    assert.equal(inventory.fallbacksKnown, true);
  } finally {
    release();
    await sdk.close();
  }
});

for (const firstReply of [{ ok: false, error: "unknown intent" }, { ok: true, definitions: [] }]) {
  for (const batch of [0, 1]) {
    for (const silentSecond of [true, false]) {
      test(`describe empty/error replies ${silentSecond ? "cannot hide silence" : "remain valid when fully answered"}, batch=${batch}, ok=${firstReply.ok}`, async () => {
        class EmptyReplies extends FakeHubTransport {
          override async emitBus(eventType: string, data: Record<string, unknown>, context: EventContext): Promise<void> {
            this.emitted.push({ eventType, data: { ...data }, context: { ...context } });
            if (!silentSecond || data.intent_name === "first") this.deliver("ovos.intent.describe.response", firstReply, context);
          }
        }
        const hub = new EmptyReplies({ sync: true });
        const sdk = client(hub);
        const wanted = ["first", "second"].map(intentName => ({ skillId: WEATHER, intentName, lang: "en-us" }));
        try {
          const result = describeMany(sdk, wanted, { timeoutMs: 30, batch });
          if (silentSecond) await assert.rejects(result, ThalovantTimeoutError);
          else {
            const found = await result;
            assert.equal(found.size, 2);
            assert.ok([...found.values()].every(definitions => definitions.length === 0));
          }
          assert.equal(hub.emitted.length, 2);
        } finally { await sdk.close(); }
      });
    }
  }
}

// The Pop Culture hub on 2026-10-11: one skill registers keyword vocabulary in
// 63 regional tags, every other skill only in en-US. Its en-CA listing was
// five keyword rows -- not empty, and nothing a person can say.
const SCOUT = "thalovant-skill-source-scout.thalovant";
const SCOUT_KEYWORDS: Array<[string, string]> = [[SCOUT, "SourceScoutTopicIntent"], [SCOUT, "SourceScoutRealPromptIntent"]];

function listedLanguages(hub: FakeHubTransport): unknown[] {
  return emittedOf(hub, EVENT_INTENT_LIST).map(entry => entry.data.lang);
}

test("a tag with only keyword rows is listed under its usual form", async () => {
  const hub = new FakeHubTransport({ keywords: { "en-ca": SCOUT_KEYWORDS, "en-us": SCOUT_KEYWORDS } });
  const inventory = await client(hub).intents(["en-CA"]);

  assert.deepEqual(inventory.listedIn, ["en-us"], "the usual form has sentences, en-CA has none");
  assert.equal(inventory.hasPhrases, true);
  assert.deepEqual(inventory.skills.map(skill => skill.skillId), [SHADOW, SCOUT, WEATHER]);
  assert.deepEqual(listedLanguages(hub), ["en-CA", "en-us"]);
});

test("keyword rows are kept when the usual form has no sentences either", async () => {
  const hub = new FakeHubTransport({ registrations: {}, keywords: { "en-ca": SCOUT_KEYWORDS, "en-us": SCOUT_KEYWORDS.slice(0, 1) } });
  const inventory = await client(hub).intents(["en-CA"]);

  assert.deepEqual(inventory.listedIn, ["en-CA"], "nothing better to take");
  assert.deepEqual(inventory.intents.map(intent => intent.name), ["SourceScoutRealPromptIntent", "SourceScoutTopicIntent"]);
});

test("a listing with sentences is not retried for its keyword rows", async () => {
  const hub = new FakeHubTransport({
    registrations: { "en-ca": REGISTRATIONS["en-us"], "en-us": REGISTRATIONS["en-us"] },
    keywords: { "en-ca": SCOUT_KEYWORDS },
  });
  const inventory = await client(hub).intents(["en-CA"]);

  assert.deepEqual(listedLanguages(hub), ["en-CA"]);
  assert.deepEqual(inventory.listedIn, ["en-CA"]);
});

for (const failure of ["silent", "refused"] as const) {
  test(`a ${failure} retry keeps the names the first listing gave`, async () => {
    const hub = new FakeHubTransport({
      keywords: { "en-ca": SCOUT_KEYWORDS },
      listSilentIn: failure === "silent" ? ["en-us", ""] : [],
      listFailsIn: failure === "refused" ? ["en-us", ""] : [],
    });
    const inventory = await client(hub).intents(["en-CA"], { timeoutMs: 200 });

    assert.equal(inventory.source, SOURCE_MANIFEST);
    assert.deepEqual(inventory.listedIn, ["en-CA"]);
    assert.deepEqual(inventory.intents.map(intent => intent.name), ["SourceScoutRealPromptIntent", "SourceScoutTopicIntent"]);
  });
}

for (const failure of ["silent", "refused"] as const) {
  test(`the hub's own listing answers when a ${failure} usual form leaves keyword rows`, async () => {
    const hub = new FakeHubTransport({
      keywords: { "en-ca": SCOUT_KEYWORDS },
      listSilentIn: failure === "silent" ? ["en-us"] : [],
      listFailsIn: failure === "refused" ? ["en-us"] : [],
    });
    const inventory = await client(hub).intents(["en-CA"], { timeoutMs: 200 });

    assert.deepEqual(inventory.listedIn, ["en-US"]);
    assert.equal(inventory.hasPhrases, true);
  });
}

test("a failed retry after an empty listing still fails as before", async () => {
  const hub = new FakeHubTransport({ registrations: {}, listFailsIn: ["en-us"] });
  await assert.rejects(client(hub).intents(["en-CA"], { timeoutMs: 200 }), ThalovantRuntimeError);
});

// A language the hub never loaded ---------------------------------------------
//
// Measured on all 13 public hubs on 2026-10-11: a hub loads its `lang` and
// `secondary_langs` (en-US and fr-FR on most) and lists nothing under any other
// tag. A phone set to Spanish, Japanese or German asked in its own language,
// then its usual form, got nothing twice and showed an empty list -- while the
// hub answered those people in its own language.

const BOTH: Registrations = { "en-us": REGISTRATIONS["en-us"], "fr-fr": REGISTRATIONS["fr-fr"] };
// The hub's own listing order on Daily Desk and Rewrite Forge: French first.
const FRENCH_FIRST: Registrations = { "fr-fr": REGISTRATIONS["fr-fr"], "en-us": REGISTRATIONS["en-us"] };

for (const phone of ["es-ES", "ja-JP", "de-DE"]) {
  test(`a ${phone} phone is listed in the language the hub answers it in`, async () => {
    const hub = new FakeHubTransport({ registrations: FRENCH_FIRST, hubLang: "en-US" });
    const inventory = await client(hub).intents([phone]);

    assert.deepEqual(inventory.languages, [phone]);
    assert.deepEqual(inventory.listedIn, ["en-US"], "the language the hub answers that person in");
    assert.equal(inventory.hasPhrases, true);
    assert.deepEqual(inventory.skills.map(skill => skill.skillId), [SHADOW, WEATHER]);
    const weather = inventory.skills[1].intents[0];
    assert.equal(weather.phrasesFor(inventory.listedIn[0])[0], "what is the weather");
    const asked = emittedOf(hub, EVENT_INTENT_LIST).map(entry => entry.data);
    assert.equal(asked.filter(data => !("lang" in data)).length, 1, "the hub's own listing is asked once");
    const whole = emittedOf(hub, EVENT_INTENT_LIST).find(entry => !("lang" in entry.data));
    assert.equal(whole?.context.lang, undefined, "no language in the context either");
    assert.deepEqual(whole?.data, { include_definitions: true });
  });
}

test("the same language in another region comes before the hub's own", async () => {
  // en-CA's usual form is en-US; a hub that loaded en-GB has neither.
  const hub = new FakeHubTransport({ registrations: { "fr-fr": REGISTRATIONS["fr-fr"], "en-gb": REGISTRATIONS["en-us"] }, hubLang: "fr-FR" });
  const inventory = await client(hub).intents(["en-CA"]);
  assert.deepEqual(inventory.listedIn, ["en-GB"], "English before the hub's own French");
});

test("without a session hint the language with the most sentences wins", async () => {
  const inventory = await client(new FakeHubTransport({ registrations: FRENCH_FIRST })).intents(["ja-JP"]);
  assert.deepEqual(inventory.listedIn, ["en-US"], "two intents in English, one in French");
});

test("nearestHubLanguage: a tie goes to the first listed and a hint must be listed", () => {
  const rows = (lang: string, method = "template"): IntentRegistration[] => [
    { skillId: "s", intentName: "i", lang, method, engine: "padatious", enabled: true, sessionId: "default" },
  ];
  const listed = new Map([["fr-FR", rows("fr-FR")], ["en-US", rows("en-US")]]);
  assert.equal(nearestHubLanguage("ja-JP", listed), "fr-FR");
  assert.equal(nearestHubLanguage("ja-JP", listed, "en-US"), "en-US");
  assert.equal(nearestHubLanguage("ja-JP", listed, "ko-KR"), "fr-FR", "a hint the hub never listed is no hint");
  assert.equal(nearestHubLanguage("fr-CA", listed, "en-US"), "fr-FR");
  assert.equal(nearestHubLanguage("ja-JP", { "en-US": rows("en-US", "keyword") }), undefined);
  const disabled = rows("en-US").map(row => ({ ...row, enabled: false }));
  assert.equal(nearestHubLanguage("ja-JP", { "en-US": disabled, "fr-FR": rows("fr-FR") }), "fr-FR", "a disabled row carries no sentence");
});

test("a language the hub loaded never asks the whole manifest", async () => {
  const hub = new FakeHubTransport({ registrations: BOTH, hubLang: "en-US" });
  const inventory = await client(hub).intents(["fr-fr", "en-us"]);
  assert.deepEqual(inventory.listedIn, ["fr-fr", "en-us"]);
  assert.ok(emittedOf(hub, EVENT_INTENT_LIST).every(entry => "lang" in entry.data));
});

test("two languages that land on the same hub language share one listing", async () => {
  const hub = new FakeHubTransport({ registrations: BOTH, hubLang: "en-US" });
  const inventory = await client(hub).intents(["en-us", "ja-JP"]);
  assert.deepEqual(inventory.listedIn, ["en-us", "en-us"], "one key per language, not en-us and en-US");
  const weather = inventory.intents.find(intent => intent.skillId === WEATHER);
  assert.deepEqual(Object.keys(weather?.phrases ?? {}), ["en-us"]);
});

test("two languages without sentences ask the hub's own listing once", async () => {
  const hub = new FakeHubTransport({ registrations: BOTH, hubLang: "en-US" });
  const inventory = await client(hub).intents(["ja-JP", "es-ES"]);
  assert.deepEqual(inventory.listedIn, ["en-US", "en-US"]);
  assert.equal(emittedOf(hub, EVENT_INTENT_LIST).filter(entry => !("lang" in entry.data)).length, 1);
});

for (const failure of ["silent", "refused", "denied"] as const) {
  test(`a hub that cannot list its languages (${failure}) leaves the answer as it was`, async () => {
    class Hub extends FakeHubTransport {
      override async emitBus(eventType: string, data: Record<string, unknown>, context: EventContext): Promise<void> {
        if (eventType === EVENT_INTENT_LIST && !("lang" in data) && failure === "denied") {
          this.emitted.push({ eventType, data: { ...data }, context: { ...context } });
          this.deliver(EVENT_POLICY_DENIED, { denied_type: eventType }, context);
          return;
        }
        return super.emitBus(eventType, data, context);
      }
    }
    const hub = new Hub({
      registrations: BOTH,
      keywords: { "ja-jp": SCOUT_KEYWORDS },
      listSilentIn: failure === "silent" ? [""] : [],
      listFailsIn: failure === "refused" ? [""] : [],
    });
    const inventory = await client(hub).intents(["ja-JP"], { timeoutMs: 200 });

    assert.equal(inventory.source, SOURCE_MANIFEST);
    assert.deepEqual(inventory.listedIn, ["ja-JP"]);
    assert.deepEqual(inventory.intents.map(intent => intent.name), ["SourceScoutRealPromptIntent", "SourceScoutTopicIntent"]);
  });
}

test("an empty hub stays empty rather than failing", async () => {
  const inventory = await client(new FakeHubTransport({ registrations: {} })).intents(["ja-JP"]);
  assert.deepEqual(inventory.skills, []);
  assert.deepEqual(inventory.listedIn, ["ja-JP"]);
});

test("the hub's own listing is not asked when nearest is off", async () => {
  const hub = new FakeHubTransport({ registrations: BOTH });
  const inventory = await client(hub).intents(["ja-JP"], { nearest: false });
  assert.deepEqual(inventory.skills, []);
  assert.deepEqual(emittedOf(hub, EVENT_INTENT_LIST).map(entry => entry.data), [{ lang: "ja-JP", include_definitions: true }]);
});

test("the hub's own listing sends no include_definitions when not describing", async () => {
  const hub = new FakeHubTransport({ registrations: BOTH, hubLang: "en-US" });
  const inventory = await client(hub).intents(["es-ES"], { describe: false });
  assert.deepEqual(inventory.listedIn, ["en-US"]);
  assert.deepEqual(emittedOf(hub, EVENT_INTENT_LIST).find(entry => !("lang" in entry.data))?.data, {});
});

test("definitions from the hub's own listing need no describe", async () => {
  const hub = new FakeHubTransport({ registrations: BOTH, definitionsInList: true, hubLang: "en-US" });
  const inventory = await client(hub).intents(["es-ES"]);
  assert.equal(inventory.hasPhrases, true);
  assert.equal(emittedOf(hub, EVENT_INTENT_DESCRIBE).length, 0);
});

test("rows without a definition are described under the chosen tag", async () => {
  const hub = new FakeHubTransport({ registrations: BOTH, hubLang: "en-US" });
  const inventory = await client(hub).intents(["es-ES"]);
  assert.ok(emittedOf(hub, EVENT_INTENT_DESCRIBE).every(entry => entry.data.lang === "en-US"));
  assert.equal(inventory.hasPhrases, true);
});

test("the serialised inventory says which language it listed in", async () => {
  const hub = new FakeHubTransport({ registrations: BOTH, hubLang: "en-US" });
  const payload = (await client(hub).intents(["es-ES"])).asObject();
  assert.deepEqual(payload.languages, ["es-ES"]);
  assert.deepEqual(payload.listed_in, ["en-US"]);
});
