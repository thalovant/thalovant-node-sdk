/** Locale-aware illustrative listings, using versioned canonical language data. */
import { listingData } from './listing-data.js';

export interface ListingLanguage {
  trailing_words?: readonly string[];
  question_openers?: readonly string[];
  question_words_anywhere?: readonly string[];
  question_patterns?: readonly string[];
  written_forms?: Readonly<Record<string, string>>;
  slot_examples?: Readonly<Record<string, string>>;
}
export interface ListingData {
  sentence_ends: string;
  languages: Readonly<Record<string, ListingLanguage>>;
}

function fold(tag: string): string {
  const value = tag.trim().replaceAll('_', '-');
  try { return new Intl.Locale(value).toString().toLowerCase(); }
  catch { return value.toLowerCase(); } // Private/application tags are valid data keys.
}

/** Exact tags first, then the same language/script and nearest available region.
 * Ties preserve registration order. Unrelated languages never supply phrases.
 */
export function closestLanguage(target: string, available: readonly string[]): string | undefined {
  const wanted = fold(target);
  const exact = available.find(tag => fold(tag) === wanted);
  if (exact !== undefined) return exact;
  function parts(tag: string): { language: string; script?: string; region?: string } {
    try { const locale = new Intl.Locale(tag).maximize(); return locale; }
    catch { return { language: tag.split('-')[0] }; }
  }
  const requested = parts(wanted);
  let best: string | undefined, distance = Infinity;
  for (const tag of available) {
    const candidate = parts(fold(tag));
    if (candidate.language !== requested.language || candidate.script !== requested.script) continue;
    const score = candidate.region === requested.region ? 0 : 1;
    if (score < distance) { best = tag; distance = score; }
  }
  return best;
}

function pattern(expression: string): RegExp {
  // Python data permits leading global flags. Compile each rule independently.
  const flags = new Set(['i', 'u']);
  expression = expression.replace(/^\(\?([ims]+)\)/, (_, inline: string) => {
    for (const flag of inline) flags.add(flag);
    return '';
  });
  // Python's Unicode word boundary includes letters/numbers/underscore. JS \b
  // remains ASCII even in Unicode mode. Preserve the data's boundary semantics.
  expression = expression.replace(/\\b/g, '(?:(?<![\\p{L}\\p{N}_])(?=[\\p{L}\\p{N}_])|(?<=[\\p{L}\\p{N}_])(?![\\p{L}\\p{N}_]))');
  return new RegExp(expression, [...flags].join(''));
}
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const words = (text: string): string[] => text.trim() ? text.trim().split(/\s+/u) : [];

/** An immutable snapshot; pass null to render without language data, or supply
 * a complete custom data tree. No filesystem, network or global configuration.
 */
export class ListingRules {
  readonly available: boolean;
  readonly sentenceEnds: string;
  private readonly languages: ReadonlyMap<string, ListingLanguage>;
  private readonly patterns: ReadonlyMap<string, readonly RegExp[]>;

  constructor(data: ListingData | null = listingData) {
    this.available = data !== null;
    this.sentenceEnds = data?.sentence_ends ?? '';
    // Copy all nested input so later caller mutations cannot alter a listing.
    const copied = JSON.parse(JSON.stringify(data?.languages ?? {})) as Record<string, ListingLanguage>;
    this.languages = new Map(Object.entries(copied));
    this.patterns = new Map([...this.languages].map(([tag, rules]) =>
      [tag, (rules.question_patterns ?? []).map(pattern)]));
  }

  private tag(lang?: string): string | undefined {
    return lang ? closestLanguage(lang, [...this.languages.keys()]) : undefined;
  }
  languageData(lang?: string): ListingLanguage {
    const tag = this.tag(lang);
    return JSON.parse(JSON.stringify(tag === undefined ? {} : this.languages.get(tag)!));
  }
  private wordSet(lang: string | undefined, key: 'trailing_words' | 'question_openers' | 'question_words_anywhere'): Set<string> {
    const tag = this.tag(lang);
    const entries = lang ? (tag === undefined ? [] : [this.languages.get(tag)!]) : [...this.languages.values()];
    return new Set(entries.flatMap(data => (data[key] ?? []).map(word => word.toLowerCase())));
  }
  slotExamples(lang?: string): Readonly<Record<string, string>> {
    return this.languageData(lang).slot_examples ?? {};
  }
  dangling(text: string, lang?: string): boolean {
    const chars = [...text];
    while (chars.length && (this.sentenceEnds + ' ').includes(chars.at(-1)!)) chars.pop();
    const last = words(chars.join('')).at(-1);
    return last !== undefined && this.wordSet(lang, 'trailing_words').has(last.toLowerCase());
  }
  asks(text: string, lang?: string): boolean {
    const tag = this.tag(lang);
    if (tag !== undefined && this.patterns.get(tag)!.some(rule => rule.test(text))) return true;
    const tokens = words(text).map(word => word.replace(/^[,;:!?.’'"()]+|[,;:!?.’'"()]+$/gu, '').toLowerCase()).filter(Boolean);
    return tokens.length > 0 && (this.wordSet(lang, 'question_openers').has(tokens[0]) ||
      tokens.some(word => this.wordSet(lang, 'question_words_anywhere').has(word)));
  }
  asSentence(text: string, lang?: string): string {
    text = text.trim();
    if (!text) return text;
    const first = [...text][0];
    text = first.toUpperCase() + text.slice(first.length);
    if ([...this.sentenceEnds].some(mark => text.endsWith(mark)) || this.dangling(text, lang)) return text;
    const data = this.languageData(lang);
    if (!lang || ![data.question_openers, data.question_words_anywhere, data.question_patterns].some(value => value?.length)) return text;
    for (const [word, written] of Object.entries(data.written_forms ?? {})) {
      text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escape(word)}(?![\\p{L}\\p{N}_])`, 'gu'), () => written);
    }
    return text + (this.asks(text, lang) ? '?' : '.');
  }
  rank(phrases: readonly string[], lang?: string): string[] {
    const key = (text: string): number[] => [Number(this.dangling(text, lang)), Number(text.includes('{')), -Math.min(words(text).length, 8), [...text].length];
    return [...phrases].map(text => ({text, key:key(text)})).sort((a,b) => {
      for (let i=0;i<a.key.length;i++) { const delta=a.key[i]-b.key[i]; if(delta) return delta; }
      return 0;
    }).map(row => row.text);
  }
}

export const defaultListing = new ListingRules();
export function asSentence(text: string, lang?: string, listing: ListingRules = defaultListing): string {
  return listing.asSentence(text, lang);
}
