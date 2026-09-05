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
  EVENT_PADATIOUS_MANIFEST_GET,
  EVENT_POLICY_DENIED,
} from "../src/constants.js";
import { ThalovantPolicyDeniedError, ThalovantRuntimeError, ThalovantTimeoutError } from "../src/errors.js";
import { EventContext, ThalovantEvent } from "../src/events.js";
import { ThalovantIdentity } from "../src/identity.js";
import { DESCRIBE_BATCH, describeMany, HubIntentInventory, sameLanguage, SOURCE_ENGINES, SOURCE_MANIFEST } from "../src/intents.js";

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
  refuse?: string[];
  silent?: string[];
  definitionsInList?: boolean;
  echoRequestId?: boolean;
  repeats?: number;
  /** Deliver replies inside `emitBus` itself instead of on a later tick. */
  sync?: boolean;
}

/** A hub session: answers the manifest, or refuses it, twice over. */
class FakeHubTransport extends EventTarget {
  readonly emitted: Emitted[] = [];
  readonly registrations: Registrations;
  readonly refuse: string[];
  readonly silent: string[];
  readonly definitionsInList: boolean;
  readonly echoRequestId: boolean;
  readonly repeats: number;
  readonly sync: boolean;
  connected = false;
  /** Describes emitted but not yet answered, and the high-water mark. */
  inFlightDescribes = 0;
  maxInFlightDescribes = 0;
  /** A window opens when a describe goes out with none outstanding. */
  describeWindows = 0;

  constructor(options: FakeHubOptions = {}) {
    super();
    this.registrations = options.registrations ?? REGISTRATIONS;
    this.refuse = options.refuse ?? [];
    this.silent = options.silent ?? [];
    this.definitionsInList = options.definitionsInList ?? false;
    this.echoRequestId = options.echoRequestId ?? true;
    this.repeats = options.repeats ?? 2;
    this.sync = options.sync ?? false;
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
    if (eventType === EVENT_INTENT_LIST) {
      const rows = (this.registrations[lang] ?? []).map(([skillId, intentName, samples]) => {
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

test("a silent hub times out on the listing", async () => {
  const hub = new FakeHubTransport({ silent: [EVENT_INTENT_LIST] });
  await assert.rejects(
    client(hub).intents(["en-us"], { timeoutMs: 200 }),
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
  assert.deepEqual(hub.emitted.map(entry => entry.eventType).slice(1), [EVENT_ADAPT_MANIFEST_GET, EVENT_PADATIOUS_MANIFEST_GET]);
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
