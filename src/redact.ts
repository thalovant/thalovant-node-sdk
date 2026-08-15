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
 */
export function redactSecretsInText(text: string, secrets: ReadonlyArray<string | undefined>): string {
  let result = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 8) {
      result = result.split(secret).join(REDACTED);
    }
  }
  return result;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
