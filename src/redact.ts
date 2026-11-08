/**
 * Internal redaction helpers shared by `identity.ts` and `control.ts`. This
 * module is deliberately NOT re-exported from `index.ts`, so none of it is
 * public API.
 *
 * Everything here feeds ONLY human-facing debug/log/display output — the
 * default `asObject()` view, the `util.inspect` custom hook, `toString()`, and
 * thrown error messages. It must never touch the wire protocol, identity-file
 * persistence, or the `includeSecrets: true` path. Browser-safe: no `node:`
 * imports, only `URL` and plain string/object work.
 */

type UnknownRecord = Record<string, unknown>;

/** Placeholder shown instead of secret values in debug/log output. */
export const REDACTED = "[redacted]";

/**
 * Key names that hold secrets in control-plane records and identity metadata,
 * compared after lowercasing and stripping `_`/`-` so both spellings match
 * (`apiKey`/`api_key`, `cryptoKey`/`crypto_key`, ...). `initial_identify` is
 * the whole credential bundle `POST /v1/clients` returns.
 */
const SECRET_KEY_NAMES = new Set([
  "initialidentify",
  "initialidentifytoken",
  "accesskey",
  "apikey",
  "clientsecret",
  "cryptokey",
  "password",
  "privatekey",
  "secret",
  "token",
  "accesstoken",
  "refreshtoken",
  "authorization",
  "apisecret",
  "secretkey",
  "credentials",
]);

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_NAMES.has(key.toLowerCase().replace(/[_-]/g, ""));
}

/**
 * Deep copy with secret-named keys omitted at every level, the same way
 * `ThalovantIdentity.asObject()` omits its own secret fields by default. Used
 * only for the human-facing default view; the wire payloads and the
 * `includeSecrets: true` path never go through it.
 */
export function withoutSecretKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(entry => withoutSecretKeys(entry)) as unknown as T;
  }
  if (isRecord(value)) {
    const result: UnknownRecord = {};
    for (const [key, entry] of Object.entries(value)) {
      if (isSecretKey(key)) continue;
      result[key] = withoutSecretKeys(entry);
    }
    return result as unknown as T;
  }
  return value;
}

/**
 * Strip any `user:pass@` userinfo from a URL for display. Returns the input
 * unchanged when it carries no userinfo (or does not parse), so URLs without
 * credentials keep their exact original spelling — no trailing-slash churn.
 */
export function redactUrlUserinfo(value: string): string {
  try {
    const url = new URL(value);
    if (!url.username && !url.password) {
      return value;
    }
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return value;
  }
}

/**
 * Replace every occurrence of each known secret value with {@link REDACTED}.
 * Used to scrub secrets the SDK itself generated (and sent) out of a server
 * error string before it is surfaced. Values shorter than 8 characters are
 * ignored to avoid clobbering unrelated text.
 *
 * The text is usually a JSON body not yet parsed, where a secret holding `"`,
 * `\`, a control character or non-ASCII is spelt escaped: each of those
 * spellings is replaced too (see {@link jsonSpellings}).
 */
export function redactSecretsInText(text: string, secrets: ReadonlyArray<string | undefined>): string {
  const spellings = new Set<string>();
  for (const secret of secrets) {
    if (secret && secret.length >= 8) {
      for (const spelling of jsonSpellings(secret)) spellings.add(spelling);
    }
  }
  // Longest first, so a spelling that contains another is replaced whole.
  let result = text;
  for (const spelling of [...spellings].sort((a, b) => b.length - a.length)) {
    result = result.split(spelling).join(REDACTED);
  }
  return result;
}

/** A letter or a digit, which a short secret must not be glued to for it to be replaced. */
function isWordCharacter(char: string | undefined): boolean {
  return char !== undefined && /^[\p{L}\p{N}]$/u.test(char);
}

/** How {@link redactSecretsInString} replaces a secret shorter than 8 characters. */
export interface RedactOptions {
  /**
   * Replace every secret wherever it occurs, however short, as a browser
   * sign-in's exchange does with its code, verifier and state. By default a
   * secret under 8 characters is replaced only where it stands alone.
   */
  everywhere?: boolean;
}

/**
 * `text` with each secret replaced by {@link REDACTED}: one of 8 characters or
 * more wherever it occurs, a shorter one only where it stands alone -- no
 * letter or digit directly before or after it -- so that a short value cannot
 * take pieces out of unrelated words (`everywhere` replaces it anywhere).
 *
 * Every occurrence of every secret is found in the text as given, and
 * occurrences that overlap are replaced together, by one marker: a short code
 * that overlaps the start of a verifier takes the whole verifier with it. An
 * occurrence that lies wholly inside a {@link REDACTED} already there is left
 * alone, so scrubbing twice changes nothing; one that only starts or ends
 * inside a marker is replaced, and takes that marker with it. Markers are
 * looked up by binary search, so a text full of them costs O(n log n), not
 * O(n^2). The text is a decoded string, never JSON source, so nothing here can
 * break a document's structure.
 */
export function redactSecretsInString(
  text: string,
  secrets: ReadonlyArray<string | undefined>,
  options: RedactOptions = {},
): string {
  const wanted = [...new Set(secrets.filter((secret): secret is string => typeof secret === "string" && secret !== ""))];
  if (!wanted.length) return text;
  // Marker starts, in order; markers never overlap, so the one that could
  // hold a position is the last that starts at or before it.
  const markers: number[] = [];
  for (let at = text.indexOf(REDACTED); at !== -1; at = text.indexOf(REDACTED, at + REDACTED.length)) markers.push(at);
  const markerAt = (position: number): number | undefined => {
    let low = 0;
    let high = markers.length - 1;
    let found: number | undefined;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (markers[middle] <= position) {
        found = markers[middle];
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return found !== undefined && position < found + REDACTED.length ? found : undefined;
  };
  const spans: Array<[number, number]> = [];
  for (const secret of wanted) {
    for (let at = text.indexOf(secret); at !== -1; at = text.indexOf(secret, at + 1)) {
      let start = at;
      let end = at + secret.length;
      const opening = markerAt(start);
      const closing = markerAt(end - 1);
      // Wholly inside one marker: already redacted.
      if (opening !== undefined && opening === closing) continue;
      if (!options.everywhere && secret.length < 8) {
        const after = end < text.length ? String.fromCodePoint(text.codePointAt(end)!) : undefined;
        if (isWordCharacter(characterBefore(text, start)) || isWordCharacter(after)) continue;
      }
      // Reaching into a marker takes the whole marker, so none is left cut.
      if (opening !== undefined) start = opening;
      if (closing !== undefined) end = closing + REDACTED.length;
      spans.push([start, end]);
    }
  }
  if (!spans.length) return text;
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = "";
  let from = 0;
  let index = 0;
  while (index < spans.length) {
    let [start, stop] = spans[index];
    // Every span that overlaps this one goes with it.
    for (index += 1; index < spans.length && spans[index][0] < stop; index += 1) {
      stop = Math.max(stop, spans[index][1]);
    }
    out += text.slice(from, start) + REDACTED;
    from = stop;
  }
  return out + text.slice(from);
}

/** The whole character that ends just before `index`, a surrogate pair included. */
function characterBefore(text: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const low = text.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.slice(index - 2, index);
  }
  return text[index - 1];
}

/**
 * How deep {@link redactSecretsInJson} follows a parsed value. Anything deeper
 * becomes {@link REDACTED}: an error body nested thousands of levels deep would
 * otherwise overflow the stack -- here, or in `JSON.stringify` -- before the
 * error carrying its status could be made, and dropping it keeps nothing
 * unsanitized.
 */
export const MAX_REDACTED_JSON_DEPTH = 64;

/**
 * A parsed JSON value with each secret taken out of every string in it, keys
 * included ({@link redactSecretsInString}).
 *
 * {@link redactSecretsInText} replaces the spellings of a secret it knows in
 * the body before it is parsed. JSON has others -- `\u0063` for `c`, `\/` for
 * `/`, non-ASCII escaped in some places and not others -- which decode back
 * into the secret. Walking the parsed value catches every one of them, and a
 * short secret, which the text pass leaves alone, too. A number that spells a
 * secret becomes the string {@link REDACTED}; run
 * {@link redactSecretsInJsonNumbers} on the text first, so that one too long
 * for a double is caught before parsing rounds it. A value nested deeper than
 * {@link MAX_REDACTED_JSON_DEPTH} becomes {@link REDACTED}.
 */
export function redactSecretsInJson(
  value: unknown,
  secrets: ReadonlyArray<string | undefined>,
  options: RedactOptions = {},
  depth = 0,
): unknown {
  if (typeof value === "string") return redactSecretsInString(value, secrets, options);
  if (typeof value === "number") {
    const text = String(value);
    const scrubbed = redactSecretsInString(text, secrets, options);
    return scrubbed === text ? value : REDACTED;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_REDACTED_JSON_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((entry) => redactSecretsInJson(entry, secrets, options, depth + 1));
  const result: UnknownRecord = {};
  for (const [key, entry] of Object.entries(value)) {
    // defineProperty, so that a key such as `__proto__` stays a key.
    Object.defineProperty(result, redactSecretsInString(key, secrets, options), {
      value: redactSecretsInJson(entry, secrets, options, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

/** One JSON number, as it is written. */
const JSON_NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

/**
 * JSON source with every number that spells a secret replaced by the string
 * `"[redacted]"`, before it is parsed.
 *
 * Parsing rounds a number past what a double holds -- `12345678901234567890`
 * comes back as `12345678901234567000` -- so a code of digits echoed as a
 * number would keep 17 of its digits once parsed. Strings are copied as they
 * are, escapes and all; only number tokens outside them are read. The result
 * parses whenever the input did.
 */
export function redactSecretsInJsonNumbers(
  text: string,
  secrets: ReadonlyArray<string | undefined>,
  options: RedactOptions = {},
): string {
  if (!secrets.some((secret) => typeof secret === "string" && /[0-9]/.test(secret))) return text;
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      out += text.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (char === "-" || (char >= "0" && char <= "9")) {
      JSON_NUMBER.lastIndex = index;
      const match = JSON_NUMBER.exec(text);
      if (match) {
        const token = match[0];
        out += redactSecretsInString(token, secrets, options) === token ? token : JSON.stringify(REDACTED);
        index += token.length;
        continue;
      }
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * Each secret and the spellings JSON gives it ({@link jsonSpellings}): of
 * those of 8 characters or more, or of every one with `everywhere`. Passed to
 * {@link redactSecretsInString} together, so that overlapping occurrences of
 * any of them in a text are found before any is replaced.
 */
export function secretSpellings(secrets: ReadonlyArray<string | undefined>, options: RedactOptions = {}): string[] {
  const out = new Set<string>();
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret === "") continue;
    out.add(secret);
    if (options.everywhere || secret.length >= 8) for (const spelling of jsonSpellings(secret)) out.add(spelling);
  }
  return [...out];
}

/**
 * How a secret may be spelt inside a JSON string: as it is; as
 * `JSON.stringify` escapes it (`"`, `\` and control characters); and with
 * every non-ASCII character `\u`-escaped as well, in lower- and upper-case hex,
 * as Python's `json.dumps` and many other encoders write it.
 */
function jsonSpellings(secret: string): string[] {
  const escaped = JSON.stringify(secret).slice(1, -1);
  const ascii = (upper: boolean) => escaped.replace(/[^\x00-\x7f]/g, (char) => {
    const hex = char.charCodeAt(0).toString(16).padStart(4, "0");
    return `\\u${upper ? hex.toUpperCase() : hex}`;
  });
  return [...new Set([secret, escaped, ascii(false), ascii(true)])];
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
