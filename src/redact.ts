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

/**
 * `text` with each secret replaced by {@link REDACTED}: one of 8 characters or
 * more wherever it occurs, a shorter one only where it stands alone -- no
 * letter or digit directly before or after it -- so that a short value cannot
 * take pieces out of unrelated words. One pass, the longest secret tried first
 * at each place, and never inside a {@link REDACTED} already there. The text is
 * a decoded string, never JSON source, so nothing here can break a document's
 * structure.
 */
export function redactSecretsInString(text: string, secrets: ReadonlyArray<string | undefined>): string {
  const ordered = [...new Set(secrets.filter((secret): secret is string => typeof secret === "string" && secret !== ""))]
    .sort((a, b) => b.length - a.length);
  if (!ordered.length) return text;
  let out = "";
  let index = 0;
  scan: while (index < text.length) {
    if (text.startsWith(REDACTED, index)) {
      out += REDACTED;
      index += REDACTED.length;
      continue;
    }
    for (const secret of ordered) {
      if (!text.startsWith(secret, index)) continue;
      const end = index + secret.length;
      const after = end < text.length ? String.fromCodePoint(text.codePointAt(end)!) : undefined;
      if (secret.length < 8 && (isWordCharacter(characterBefore(text, index)) || isWordCharacter(after))) continue;
      out += REDACTED;
      index = end;
      continue scan;
    }
    out += text[index];
    index += 1;
  }
  return out;
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
 * A parsed JSON value with each secret taken out of every string in it, keys
 * included ({@link redactSecretsInString}).
 *
 * {@link redactSecretsInText} replaces the spellings of a secret it knows in
 * the body before it is parsed. JSON has others -- `c` for `c`, `\/` for
 * `/`, non-ASCII escaped in some places and not others -- which decode back
 * into the secret. Walking the parsed value catches every one of them, and a
 * short secret, which the text pass leaves alone, too. A number that spells a
 * secret becomes the string {@link REDACTED}.
 */
export function redactSecretsInJson(value: unknown, secrets: ReadonlyArray<string | undefined>): unknown {
  if (typeof value === "string") return redactSecretsInString(value, secrets);
  if (typeof value === "number") {
    // A secret of digits may come back as a number.
    const text = String(value);
    const scrubbed = redactSecretsInString(text, secrets);
    return scrubbed === text ? value : scrubbed;
  }
  if (Array.isArray(value)) return value.map((entry) => redactSecretsInJson(entry, secrets));
  if (isRecord(value)) {
    const result: UnknownRecord = {};
    for (const [key, entry] of Object.entries(value)) {
      // defineProperty, so that a key such as `__proto__` stays a key.
      Object.defineProperty(result, redactSecretsInString(key, secrets), {
        value: redactSecretsInJson(entry, secrets),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  }
  return value;
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
