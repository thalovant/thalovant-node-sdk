import { closestLanguage, defaultListing } from "./listing.js";
import {
  defaultInventoryCacheDirectory,
  readInventoryCache,
  writeInventoryCache,
  readSecretFile,
} from "./platform/node.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export const CACHE_VERSION = 1;
export const CACHE_TTL_SECONDS = 3600;
export const HUB_SOURCE = "hub";
export const LIVE_SOURCES = Object.freeze(["hub", "ovos-runtime"]);
export interface InventoryIntentData {
  id: string;
  name: string;
  skill_id: string;
  engine: string;
  phrases: Record<string, string[]>;
  languages?: string[];
}
export interface InventorySkillData {
  id: string;
  title: string;
  locales: string[];
  intents: InventoryIntentData[];
}
export interface InventoryData {
  cache_version: number;
  hub_id: string;
  hub_name: string;
  source: string;
  generated_at: string;
  notes: string[];
  skills: InventorySkillData[];
}
export class Intent {
  readonly languages: readonly string[];
  readonly phrases: Readonly<Record<string, readonly string[]>>;
  constructor(
    readonly id: string,
    readonly name: string,
    readonly skillId: string,
    readonly engine: string,
    phrases: Readonly<Record<string, readonly string[]>> = {},
    languages: readonly string[] = [],
  ) {
    this.languages = Object.freeze(
      [...new Set([...languages, ...Object.keys(phrases)])].filter((tag) =>
        Object.hasOwn(phrases, tag),
      ),
    );
    this.phrases = Object.freeze(
      Object.fromEntries(
        Object.entries(phrases).map(([lang, texts]) => [
          lang,
          Object.freeze([...texts]),
        ]),
      ),
    );
  }
  examples(language?: string, limit = 3): readonly string[] {
    const tag = language
      ? closestLanguage(language, this.languages)
      : this.languages[0];
    const pool = tag ? this.phrases[tag] : [];
    return limit <= 0
      ? [...pool]
      : defaultListing.rank(pool, language).slice(0, limit);
  }
}
export class Skill {
  readonly locales: readonly string[];
  readonly intents: readonly Intent[];
  constructor(
    readonly id: string,
    readonly title: string,
    locales: readonly string[] = [],
    intents: readonly Intent[] = [],
  ) {
    this.locales = Object.freeze([...locales]);
    this.intents = Object.freeze([...intents]);
  }
  get declaresLocales(): boolean {
    return this.locales.length > 0;
  }
  speaks(language: string): boolean | undefined {
    return this.locales.length
      ? closestLanguage(language, this.locales) !== undefined
      : undefined;
  }
}
export class Inventory {
  readonly skills: readonly Skill[];
  readonly notes: readonly string[];
  constructor(
    readonly hubId: string,
    readonly hubName: string,
    readonly source: string,
    readonly generatedAt: string,
    skills: readonly Skill[] = [],
    notes: readonly string[] = [],
  ) {
    this.skills = Object.freeze([...skills]);
    this.notes = Object.freeze([...notes]);
  }
  get intents(): readonly Intent[] {
    return this.skills.flatMap((skill) => skill.intents);
  }
  get live(): boolean {
    return LIVE_SOURCES.includes(this.source);
  }
  get hasPhrases(): boolean {
    return this.intents.some(
      (intent) => Object.keys(intent.phrases).length > 0,
    );
  }
  asObject(): InventoryData {
    return {
      cache_version: CACHE_VERSION,
      hub_id: this.hubId,
      hub_name: this.hubName,
      source: this.source,
      generated_at: this.generatedAt,
      notes: [...this.notes],
      skills: this.skills.map((skill) => ({
        id: skill.id,
        title: skill.title,
        locales: [...skill.locales],
        intents: skill.intents.map((intent) => ({
          id: intent.id,
          name: intent.name,
          skill_id: intent.skillId,
          engine: intent.engine,
          languages: [...intent.languages],
          phrases: Object.fromEntries(
            Object.entries(intent.phrases).map(([lang, texts]) => [
              lang,
              [...texts],
            ]),
          ),
        })),
      })),
    };
  }
  static fromObject(raw: unknown): Inventory {
    const data = object(raw);
    if (data.cache_version !== CACHE_VERSION)
      throw new TypeError("Not a current inventory cache");
    return new Inventory(
      string(data.hub_id),
      string(data.hub_name),
      string(data.source),
      string(data.generated_at),
      array(data.skills).map((raw) => {
        const skill = object(raw);
        return new Skill(
          string(skill.id),
          string(skill.title),
          strings(skill.locales),
          array(skill.intents).map((raw) => {
            const intent = object(raw);
            const phrases = object(intent.phrases);
            return new Intent(
              string(intent.id),
              string(intent.name),
              string(intent.skill_id),
              string(intent.engine),
              Object.fromEntries(
                Object.entries(phrases).map(([lang, texts]) => [
                  lang,
                  strings(texts),
                ]),
              ),
              intent.languages === undefined ? [] : strings(intent.languages),
            );
          }),
        );
      }),
      strings(data.notes),
    );
  }
}
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new TypeError("Expected inventory object");
  return raw as Record<string, unknown>;
}
function string(raw: unknown): string {
  if (typeof raw !== "string") throw new TypeError("Expected inventory string");
  return raw;
}
function array(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) throw new TypeError("Expected inventory list");
  return raw;
}
function strings(raw: unknown): string[] {
  return array(raw).map(string);
}
export function languagesPresent(inventory: Inventory): string[] {
  return [
    ...new Set(
      inventory.skills.flatMap((skill) => [
        ...skill.locales,
        ...skill.intents.flatMap((intent) => Object.keys(intent.phrases)),
      ]),
    ),
  ].sort();
}
export function friendlyTitle(skillId: string): string {
  let name = skillId.replace(/^(?:thalovant-skill-|ovos-skill-|skill-)/, "");
  if (name.includes(".")) name = name.slice(0, name.lastIndexOf("."));
  name = name.replace(/[-_]/g, " ").trim();
  return (
    name.replace(/\p{L}+/gu, (word) => {
      const chars = [...word];
      return chars[0].toUpperCase() + chars.slice(1).join("").toLowerCase();
    }) || skillId
  );
}
const tokens = (name: string): string[] => name.split(/[._]+/).filter(Boolean);
export function humanize(name: string): string {
  return tokens(name).join(" ");
}
export function commonAffix(
  names: readonly string[],
): [kind: "prefix" | "suffix" | undefined, token: string] {
  const split = names.map(tokens);
  if (names.length < 2 || split.some((parts) => parts.length < 2))
    return [undefined, ""];
  if (split.every((parts) => parts.at(-1) === split[0].at(-1)))
    return ["suffix", split[0].at(-1)!];
  if (split.every((parts) => parts[0] === split[0][0]))
    return ["prefix", split[0][0]];
  return [undefined, ""];
}
export function stripAffix(
  name: string,
  kind: "prefix" | "suffix" | undefined,
  token: string,
): string {
  if (!kind) return name;
  const parts = tokens(name);
  if (kind === "suffix" && parts.at(-1) === token) parts.pop();
  else if (kind === "prefix" && parts[0] === token) parts.shift();
  return parts.join(" ") || name;
}
/** Natural-order chunks; compareNames provides a total order for mixed names. */
export function sortKey(name: string): (string | bigint)[] {
  return (name.match(/[0-9]+|[^0-9]+/g) ?? []).map((chunk) =>
    /^[0-9]+$/.test(chunk) ? BigInt(chunk) : chunk.toLowerCase(),
  );
}
export function compareNames(a: string, b: string): number {
  const left = sortKey(a),
    right = sortKey(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const l = left[i],
      r = right[i];
    if (l === r) continue;
    if (typeof l !== typeof r) return typeof l === "bigint" ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return left.length - right.length;
}
/** Optional host storage. Browser storage is per origin; never a credential store. */
export class InventoryCache {
  constructor(
    readonly directory = defaultInventoryCacheDirectory(),
    readonly ttl = CACHE_TTL_SECONDS,
  ) {
    if (!Number.isFinite(ttl) || ttl < 0)
      throw new RangeError("Cache TTL must be finite and nonnegative");
  }
  static key(mode: string, identityPath = "", host?: string): string {
    const readable = (host || "local")
      .replace(/[^A-Za-z0-9._-]/g, "-")
      .slice(0, 40);
    return `${mode}-${readable}-${bytesToHex(sha256(new TextEncoder().encode(`${mode}|${identityPath}|${host || "local"}`))).slice(0, 8)}`;
  }
  static async keyForIdentity(
    mode: string,
    identityPath?: string,
  ): Promise<string> {
    return InventoryCache.key(
      mode,
      identityPath,
      await identityHost(identityPath),
    );
  }
  filename(key: string): string {
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(key))
      throw new TypeError("Invalid inventory cache key");
    return `intents-${key}.json`;
  }
  async load(key: string): Promise<Inventory | undefined> {
    try {
      const saved = await readInventoryCache(
        this.directory,
        this.filename(key),
      );
      if (!saved || Date.now() / 1000 - saved.modifiedAt > this.ttl)
        return undefined;
      return Inventory.fromObject(JSON.parse(saved.contents));
    } catch {
      return undefined;
    }
  }
  async store(key: string, inventory: Inventory): Promise<void> {
    try {
      await writeInventoryCache(
        this.directory,
        this.filename(key),
        JSON.stringify(inventory.asObject()),
      );
    } catch {
      /* Optional cache never breaks a call. */
    }
  }
}

/** Best-effort host lookup; only the public hostname is returned. */
export async function identityHost(
  identityPath?: string,
): Promise<string | undefined> {
  if (!identityPath) return undefined;
  try {
    const raw = JSON.parse(await readSecretFile(identityPath, "identity file"));
    return typeof raw?.default_master === "string"
      ? new URL(
          raw.default_master.includes("://")
            ? raw.default_master
            : `wss://${raw.default_master}`,
        ).hostname || undefined
      : undefined;
  } catch {
    return undefined;
  }
}
