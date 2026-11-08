/**
 * The authorization-code grant with PKCE (RFC 7636), for a client that can
 * open a browser.
 *
 * `loginWithBrowser()` is the device grant, and it exists for something that
 * *cannot* open one: somebody reads a code off one screen and types it into
 * another. A desktop tool, or an app, can open the browser itself and be
 * handed the answer back, and asking its user to copy a code between two
 * windows on the same machine is a worse experience than the one every other
 * tool on that machine offers.
 *
 * ```ts
 * const begun = await beginNativeSignIn({ clientId: "my-app", redirectUri: "myapp://auth" });
 * open(begun.authorizationUrl);
 * const code = codeFrom(begun, redirect);        // verifies state; null when not ours
 * await plane.completeNativeSignIn(code, begun.verifier, "my-app", "myapp://auth");
 * ```
 *
 * `begun.verifier` never leaves the process and never enters the browser. That
 * is what PKCE is for: a code intercepted by whatever else claimed the
 * redirect is useless without it.
 *
 * The same grant signs a *program* in -- a script, a command line, the MCP
 * server -- through `ThalovantControlPlane.browserLogin()`, which listens on a
 * loopback port for the answer (RFC 8252 section 7.3). The pieces it is made
 * of live here, so that each can be checked against the shared vectors on its
 * own: `browserAuthorizationUrl()` builds the address the browser opens,
 * `loopbackRedirectUri()` the redirect it comes back to, `newState()` the
 * value that ties the two together, `NativeSignInConfig` reads where the API
 * says to send the browser, and `canOpenBrowser()` says whether this machine
 * has a browser to send. The browser that approves hands the code to its own
 * computer's `127.0.0.1`, so a sign-in link sent to somebody on another
 * computer delivers nothing to the sender. That is all it promises: a
 * forwarded callback port (`ssh -L`, a port-forwarding tool) or another user of
 * the same computer can still complete a sign-in.
 */
import { ThalovantApiError } from "./errors.js";
import { hostName } from "./loopback.js";

// `node:crypto` is not importable here: this package ships a browser bundle
// and a test asserts the bundle pulls in no Node builtins. `globalThis.crypto`
// is Web Crypto, present in Node >= 20 (which package.json requires) and in
// every browser, so one implementation serves both.
//
// Its digest is async, which is why `beginNativeSignIn` is. A sync version
// would mean either a Node-only import or carrying a SHA-256 of our own, and
// an awaited call is a smaller price than either.
function webCrypto(): Crypto {
  const crypto = (globalThis as { crypto?: Crypto }).crypto;
  if (!crypto?.subtle) {
    throw new TypeError("Web Crypto is unavailable; Node 20+ or a secure browser context is required.");
  }
  return crypto;
}

function randomBytes(size: number): Uint8Array {
  const out = new Uint8Array(size);
  webCrypto().getRandomValues(out);
  return out;
}

/** Where a person approves the request. */
export const DEFAULT_DASHBOARD_URL = "https://dash.thalovant.com";

/** The three a phone needs; also the three a free plan may mint. */
export const DEFAULT_NATIVE_SCOPES = ["hubs:read", "clients:read", "clients:write"] as const;

/**
 * One sign-in attempt in progress. Keep it until the browser comes back; it
 * holds the two secrets that make the round trip safe.
 */
export interface NativeSignIn {
  /** Open this in a browser. */
  readonly authorizationUrl: string;
  /** Proves the redirect answers *this* attempt and not a replayed one. */
  readonly state: string;
  /** Never send this to the browser. Exchanged with the code, once. */
  readonly verifier: string;
  /**
   * The redirect this attempt asked for. A callback arriving at some other
   * address is not this attempt's, however good its state looks.
   */
  readonly redirectUri: string;
}

export interface BeginNativeSignInOptions {
  clientId: string;
  redirectUri: string;
  scopes?: readonly string[];
  dashboardUrl?: string;
}

function base64Url(raw: Uint8Array): string {
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  // Same reason for the padding: a trailing-run regex is the polynomial shape,
  // even on our own output. The character swaps are single-character classes
  // and cannot backtrack.
  let encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_");
  while (encoded.endsWith("=")) encoded = encoded.slice(0, -1);
  return encoded;
}

/** A PKCE verifier: 64 random bytes, base64url, no padding. */
export function newVerifier(): string {
  return base64Url(randomBytes(64));
}

/**
 * An OAuth `state`: 24 random bytes (192 bits), base64url, no padding.
 *
 * It ties the answer the browser brings back to the request that sent it.
 * Compare it in constant time.
 */
export function newState(): string {
  return base64Url(randomBytes(24));
}

/** The S256 challenge for a verifier. */
export async function challengeFor(verifier: string): Promise<string> {
  const digest = await webCrypto().subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/**
 * Whether a URL belongs to Thalovant, for a caller that wants to show where it
 * is about to send somebody. Scheme and host only: a display check, not an
 * authorization one.
 */
export function isThalovantUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  // Reject embedded credentials: `https://evil.test@dash.thalovant.com/` has a
  // host that passes, and a URL somebody is about to be sent to should not read
  // as one host and resolve to another.
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  return host === "thalovant.com" || host.endsWith(".thalovant.com");
}

/**
 * Start a sign-in. Returns the URL to open and the secrets to keep.
 *
 * `redirectUri` must be one the API has registered for `clientId`; the
 * authorization endpoint matches it exactly and refuses anything else, so it
 * cannot be turned into an open redirect.
 */
export async function beginNativeSignIn(options: BeginNativeSignInOptions): Promise<NativeSignIn> {
  const clientId = options.clientId?.trim() ?? "";
  const redirectUri = options.redirectUri?.trim() ?? "";
  if (!clientId) throw new TypeError("clientId is required to start a sign-in.");
  if (!redirectUri) throw new TypeError("redirectUri is required to start a sign-in.");
  assertSafeDashboard(options.dashboardUrl ?? DEFAULT_DASHBOARD_URL);
  const verifier = newVerifier();
  const state = newState();
  const scopes = options.scopes ?? DEFAULT_NATIVE_SCOPES;
  // Not `replace(/\/+$/, "")`: CodeQL is right that a trailing-run regex on a
  // caller-supplied string backtracks polynomially, and this one is handed a
  // URL from outside. Trimming in a loop is linear and does the same thing.
  const given = options.dashboardUrl ?? DEFAULT_DASHBOARD_URL;
  let end = given.length;
  while (end > 0 && given.charCodeAt(end - 1) === 0x2f) end -= 1;
  const dashboard = given.slice(0, end);
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge: await challengeFor(verifier),
    // S256 only. `plain` is refused by the API, and offering it here would
    // only give a caller a way to ask for the weaker one.
    code_challenge_method: "S256",
    scope: scopes.join(" "),
    state,
  });
  return {
    authorizationUrl: `${dashboard}/authorize?${query.toString()}`,
    state,
    verifier,
    redirectUri,
  };
}

/**
 * The authorization code out of the redirect the browser came back with, or
 * null when it is not an answer to this attempt.
 *
 * null rather than a throw on a state mismatch, a missing code, or an `error=`
 * response -- including one that also carries a code: all of those mean "do not
 * continue", and a caller that handles them
 * alike cannot accidentally treat one of them as success.
 */
export function codeFrom(signIn: NativeSignIn, redirect: string): string | null {
  const query = redirect.includes("?") ? redirect.slice(redirect.indexOf("?") + 1) : "";
  if (!query) return null;
  // The callback has to arrive where this attempt asked it to. State proves
  // the answer belongs to this request; the address proves it came back to the
  // app that made it, and not to some other page handed the same query string.
  if (!sameTarget(redirect, signIn.redirectUri)) return null;
  const found = new URLSearchParams(query);
  if (found.get("state") !== signIn.state) return null;
  // A refusal that also carries a code is still a refusal. Checking only for a
  // missing code accepted that pair and would have started an exchange on a
  // code the server had just declined to issue.
  if (found.has("error")) return null;
  const code = found.get("code");
  return code ? code : null;
}

/**
 * Refuse to put an authorization code and its PKCE verifier on the wire in
 * cleartext.
 *
 * The control-plane URL accepts an `http` scheme -- a self-hosted or local
 * deployment may legitimately be served that way -- and the request path hands
 * whatever it is given to fetch without looking. Every other call that would
 * leak over http leaks a bearer token the caller already holds; this one leaks
 * the two secrets that are about to become one, and a code is exchangeable by
 * whoever sees it first.
 *
 * Loopback is allowed: a request that never leaves the machine has no
 * cleartext to observe, and that is how the control plane is run while
 * somebody is working on it.
 */
export function assertSecureTokenExchange(apiUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new TypeError(`Thalovant API URL could not be read: ${apiUrl}`);
  }
  if (parsed.protocol === "https:") return;
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return;
  throw new TypeError(
    `Refusing to send an authorization code and PKCE verifier in cleartext to ${host}. ` +
      "Use https, or a loopback address while developing.",
  );
}

function origin(url: string): string | null {
  try {
    const parsed = new URL(url);
    // One backward scan and one slice: the trailing-run regex backtracks on a
    // path of slashes, and slicing per slash copies the path each time.
    const path = parsed.pathname;
    let end = path.length;
    while (end > 0 && path.charCodeAt(end - 1) === 0x2f) end -= 1;
    return `${parsed.protocol}//${parsed.host}${path.slice(0, end)}`.toLowerCase();
  } catch {
    return null;
  }
}

function sameTarget(redirect: string, expected: string): boolean {
  const a = origin(redirect);
  const b = origin(expected);
  return a !== null && a === b;
}

/**
 * Refuse to hand the authorization request to a dashboard that cannot be
 * trusted with it.
 *
 * The request carries the challenge, the scopes and the state. A caller may
 * point this at their own dashboard -- a self-hosted control plane is a real
 * thing -- but not at a cleartext one, and not at one whose address reads as a
 * different host than it resolves to. Loopback is allowed: it never leaves the
 * machine.
 */
export function assertSafeDashboard(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError(`dashboardUrl is not a URL: ${url}`);
  }
  if (parsed.username || parsed.password) {
    throw new TypeError("dashboardUrl must not carry credentials.");
  }
  // A query or a fragment breaks the address this builds. `<dash>#x` becomes
  // `<dash>#x/authorize?client_id=...` -- every parameter lands in the
  // fragment, which a browser never sends, so the authorize endpoint receives
  // nothing and says nothing. A query mangles the path the same way.
  if (parsed.search || parsed.hash) {
    throw new TypeError("dashboardUrl must not carry a query or a fragment.");
  }
  if (parsed.protocol === "https:") return;
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol === "http:" && (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]")) {
    return;
  }
  throw new TypeError(
    `dashboardUrl must be https (or a loopback address while developing), not ${url}`,
  );
}

// -- Browser sign-in: PKCE on a loopback redirect (RFC 8252 section 7.3) ------

/**
 * The SDKs' own registered app, which a program signs in as through the
 * browser. `GET /v1/auth/native/config` names it as `sdk_client_id`.
 */
export const SDK_CLIENT_ID = "thalovant-sdk";
/** The one path the loopback listener answers. */
export const LOOPBACK_CALLBACK_PATH = "/callback";
/** Milliseconds a browser sign-in waits for the browser to come back (5 minutes). */
export const DEFAULT_BROWSER_LOGIN_TIMEOUT_MS = 300_000;
/**
 * The longest `device_name` the consent page shows and the token is named by,
 * in Unicode code points (the API refuses a longer one).
 */
export const MAX_DEVICE_NAME_LENGTH = 120;
/** The name this SDK gives itself in {@link defaultDeviceName}. */
const SDK_DEVICE_LABEL = "thalovant-node-sdk";

/**
 * `http://127.0.0.1:<port>/callback`, the one redirect a program is answered on.
 *
 * The IP literal, never `localhost`, which a hosts file or a resolver can send
 * elsewhere; that path; no query, no trailing slash. The API matches it
 * exactly and only for an unprivileged port, which is what a port bound as
 * port 0 always is, so a port outside 1024-65535 is refused here
 * ({@link RangeError}) rather than sent.
 */
export function loopbackRedirectUri(port: number): string {
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new RangeError(`A loopback redirect needs a port from 1024 to 65535, not ${String(port)}.`);
  }
  return `http://127.0.0.1:${port}${LOOPBACK_CALLBACK_PATH}`;
}

/**
 * RFC 3986 percent-encoding: unreserved characters as they are, every other
 * byte of the UTF-8 form as `%XX` in uppercase hex, a space as `%20`.
 * `encodeURIComponent` leaves `! ' ( ) *` alone, so those are encoded here.
 */
function queryValue(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** What {@link browserAuthorizationUrl} puts after the endpoint. */
export interface BrowserAuthorizationUrlOptions {
  /** `http://127.0.0.1:<port>/callback`, from {@link loopbackRedirectUri}. */
  redirectUri: string;
  /** The S256 challenge of the verifier, from {@link challengeFor}. */
  codeChallenge: string;
  /** This sign-in's state, from {@link newState}. */
  state: string;
  /**
   * The scopes the token will carry. Empty strings are dropped; when nothing
   * is left the parameter is left out and the API grants its default
   * (`hubs:read clients:write`).
   */
  scopes?: readonly string[] | null;
  /**
   * What the consent page and the token show. Cut to
   * {@link MAX_DEVICE_NAME_LENGTH} code points, and left out when empty.
   */
  deviceName?: string | null;
  /** The registered app, the configuration's `sdk_client_id`. Default {@link SDK_CLIENT_ID}. */
  clientId?: string;
}

/**
 * The address a browser sign-in opens.
 *
 * `{authorizationEndpoint}?response_type=code&client_id=...&redirect_uri=...
 * &code_challenge=...&code_challenge_method=S256&state=...&scope=...
 * &device_name=...`, in that order, every value percent-encoded as RFC 3986
 * has it (a space is `%20`).
 */
export function browserAuthorizationUrl(authorizationEndpoint: string, options: BrowserAuthorizationUrlOptions): string {
  const parameters: Array<[string, string]> = [
    ["response_type", "code"],
    ["client_id", options.clientId ?? SDK_CLIENT_ID],
    ["redirect_uri", options.redirectUri],
    ["code_challenge", options.codeChallenge],
    // S256 only: `plain` puts the verifier in the browser.
    ["code_challenge_method", "S256"],
    ["state", options.state],
  ];
  const scope = (options.scopes ?? []).filter((value) => value).join(" ");
  if (scope) parameters.push(["scope", scope]);
  // Code points, not UTF-16 units: a cut must never split a character, and
  // the API counts code points.
  const deviceName = Array.from(options.deviceName ?? "").slice(0, MAX_DEVICE_NAME_LENGTH).join("");
  if (deviceName) parameters.push(["device_name", deviceName]);
  const query = parameters.map(([key, value]) => `${key}=${queryValue(value)}`).join("&");
  return `${authorizationEndpoint}?${query}`;
}

/**
 * `thalovant-node-sdk on <hostname>`: what the consent page and the token
 * show when the caller names nothing. Just `thalovant-node-sdk` when the host
 * has no name (or in a browser), and cut to {@link MAX_DEVICE_NAME_LENGTH}
 * code points.
 */
export function defaultDeviceName(): string {
  const host = hostName();
  const name = host ? `${SDK_DEVICE_LABEL} on ${host}` : SDK_DEVICE_LABEL;
  return Array.from(name).slice(0, MAX_DEVICE_NAME_LENGTH).join("");
}

/**
 * This machine as the browser rule names it: `linux`, `macos`, `windows`, or
 * Node's own name for anything else (`freebsd`, `openbsd`, `android` ...).
 * Read at every call, so a test that sets `process.platform` is answered.
 */
function platformName(): string {
  const platform = (globalThis as { process?: { platform?: unknown } }).process?.platform;
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return typeof platform === "string" && platform ? platform : "unknown";
}

function processEnvironment(): Readonly<Record<string, string | undefined>> {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
}

/**
 * Whether this machine can show a browser to the person signing in.
 *
 * Never in CI (`CI` set) or over SSH (`SSH_CONNECTION` or `SSH_TTY` set): the
 * browser would open on another machine, or nowhere. Otherwise yes on `macos`
 * and `windows`; anywhere else -- Linux, the BSDs -- only with a display
 * (`DISPLAY` or `WAYLAND_DISPLAY`). A variable counts as set when it has a
 * value: an empty one is not set, and `CI=false` is. `env` and `platform`
 * default to this process's (`process.env`, and `process.platform` named as
 * above); a web page has neither, so it has no browser to send by this rule.
 */
export function canOpenBrowser(env?: Readonly<Record<string, string | undefined>>, platform?: string): boolean {
  const vars = env ?? processEnvironment();
  const present = (name: string): boolean => {
    const value = vars[name];
    return typeof value === "string" && value !== "";
  };
  if (present("CI") || present("SSH_CONNECTION") || present("SSH_TTY")) return false;
  const system = platform ?? platformName();
  if (system === "macos" || system === "windows") return true;
  return present("DISPLAY") || present("WAYLAND_DISPLAY");
}

/** Whitespace, or a C0 or C1 control character, anywhere in `value`. */
function hasSpaceOrControl(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code < 32 || (code >= 127 && code <= 159) || /\s/u.test(char)) return true;
  }
  return false;
}

/** One DNS label as a URL host carries it: letters, digits and inner hyphens. */
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** A dotted-quad IPv4 address, each part 0-255 without a leading zero, as Python's `ipaddress` reads one. */
const IPV4 = /^(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(?:\.(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$/;

/**
 * Whether `host` (lowercased, brackets off) names something a browser can
 * reach: an IP address -- IPv6 only between brackets, IPv4 whenever the last
 * label is a number, as a browser reads it -- or a DNS name of ASCII labels of
 * letters, digits and inner hyphens (an international name in its `xn--`
 * form), at most 253 characters. `%`, `_`, an empty label and anything else
 * that will not parse to a hostname make the address unusable.
 */
function realHost(host: string, bracketed: boolean): boolean {
  if (bracketed) {
    if (!/^[0-9a-f:.]+$/.test(host)) return false;
    try {
      return new URL(`http://[${host}]/`).hostname !== "";
    } catch {
      return false;
    }
  }
  if (IPV4.test(host)) return true;
  const labels = host.split(".");
  // Numeric like an IPv4 address, and not one.
  if (/^[0-9]+$/.test(labels[labels.length - 1])) return false;
  return host.length <= 253 && labels.every((label) => HOST_LABEL.test(label));
}

/**
 * https, or http on a loopback host while developing; a host that parses to a
 * real hostname or IP address; a port a browser can open (not 0, not above
 * 65535); no credentials, query (not even a bare `?`), fragment, backslash,
 * whitespace or control characters.
 */
function usableAuthorizationEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || !value || hasSpaceOrControl(value)) return false;
  if (value.includes("?") || value.includes("#") || value.includes("\\")) return false;
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]*)/.exec(value);
  if (!match) return false;
  const scheme = match[1].toLowerCase();
  const authority = match[2];
  if (authority.includes("@")) return false;
  let host: string;
  let port: string;
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    if (end === -1) return false;
    host = authority.slice(1, end);
    const rest = authority.slice(end + 1);
    if (rest && !rest.startsWith(":")) return false;
    port = rest.slice(1);
  } else {
    if (authority.includes("[") || authority.includes("]")) return false;
    const colon = authority.indexOf(":");
    host = colon === -1 ? authority : authority.slice(0, colon);
    port = colon === -1 ? "" : authority.slice(colon + 1);
  }
  // Port 0 is no port a browser can open, and neither is one above 65535.
  if (port && (!/^[0-9]{1,5}$/.test(port) || Number(port) === 0 || Number(port) > 65535)) return false;
  host = host.toLowerCase();
  if (!host || !realHost(host, authority.startsWith("["))) return false;
  // What a browser would make of it, too: a malformed IPv6 literal, say.
  try {
    new URL(value);
  } catch {
    return false;
  }
  return scheme === "https" || (scheme === "http" && (host === "localhost" || host === "127.0.0.1" || host === "::1"));
}

/**
 * A path on the API: one leading slash, every `%` followed by two hex digits,
 * and no colon, query, fragment, backslash, whitespace or control character.
 *
 * No colon, because a URL joiner can read what follows the slash as a URL of
 * its own: `/https://collector.example/token` and `/collector.example:443/token`
 * both leave the API's origin once the slash is taken off, and the exchange
 * carries the code and the verifier. A broken escape (`/v1/%zz`) cannot be
 * sent as written; better found out now, while a device login can still stand
 * in, than after somebody approved.
 */
function usableTokenEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return false;
  if (/%(?![0-9A-Fa-f]{2})/.test(value)) return false;
  return !/[:?#\\]/.test(value) && !hasSpaceOrControl(value);
}

/**
 * Where a program signs in through the browser (`GET /v1/auth/native/config`).
 *
 * `authorizationEndpoint` is the dashboard page the browser opens;
 * `tokenEndpoint` the path on the API the code is exchanged at; `sdkClientId`
 * the registered app the program signs in as. The API reads it from its own
 * settings, so a staging or self-hosted API sends the browser to its own
 * dashboard.
 */
export class NativeSignInConfig {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly sdkClientId: string;
  /** Where a device login starts, when the API said; nothing here reads it. */
  readonly deviceAuthorizationEndpoint: string | null;

  private constructor(fields: {
    authorizationEndpoint: string;
    tokenEndpoint: string;
    sdkClientId: string;
    deviceAuthorizationEndpoint: string | null;
  }) {
    this.authorizationEndpoint = fields.authorizationEndpoint;
    this.tokenEndpoint = fields.tokenEndpoint;
    this.sdkClientId = fields.sdkClientId;
    this.deviceAuthorizationEndpoint = fields.deviceAuthorizationEndpoint;
  }

  /**
   * Read the answer; refuse one a browser sign-in cannot safely use.
   *
   * Unusable -- a {@link ThalovantApiError} with no `statusCode`, because the
   * API did not refuse anything -- when the answer is not a JSON object; when
   * `authorization_endpoint` is not https (or http on a loopback host), has
   * no host, carries credentials, a query or a fragment, whitespace or a
   * control character, a port no browser can open (0, or above 65535), or a
   * host that does not parse to a real hostname or IP address; when
   * `token_endpoint` is not a path on the API (a colon anywhere, or a `%` not
   * followed by two hex digits, included); when `sdk_client_id` is not 1-64 characters of
   * `A-Z a-z 0-9 . _ -`; or when `code_challenge_methods_supported` is not a
   * list holding `S256`. Other members are ignored, `loopback_redirect_uri`
   * included: the redirect is always {@link loopbackRedirectUri}'s.
   */
  static fromResponse(payload: unknown): NativeSignInConfig {
    const refuse = (why: string): never => {
      throw new ThalovantApiError(`Thalovant API answered an unusable browser sign-in configuration. ${why}`);
    };
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return refuse("The browser sign-in configuration is not an object.");
    }
    const fields = payload as Record<string, unknown>;
    const authorization = fields.authorization_endpoint;
    const token = fields.token_endpoint;
    const clientId = fields.sdk_client_id;
    const methods = fields.code_challenge_methods_supported;
    if (!usableAuthorizationEndpoint(authorization)) {
      return refuse("The browser sign-in configuration has no usable authorization_endpoint.");
    }
    if (!usableTokenEndpoint(token)) {
      return refuse("The browser sign-in configuration has no usable token_endpoint.");
    }
    if (typeof clientId !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(clientId)) {
      return refuse("The browser sign-in configuration has no usable sdk_client_id.");
    }
    if (!Array.isArray(methods) || !methods.includes("S256")) {
      return refuse("The browser sign-in configuration does not offer S256.");
    }
    const device = fields.device_authorization_endpoint;
    return new NativeSignInConfig({
      authorizationEndpoint: authorization,
      tokenEndpoint: token,
      sdkClientId: clientId,
      deviceAuthorizationEndpoint: typeof device === "string" && device ? device : null,
    });
  }

  /** The API's field names. */
  toJSON(): Record<string, unknown> {
    return {
      authorization_endpoint: this.authorizationEndpoint,
      token_endpoint: this.tokenEndpoint,
      sdk_client_id: this.sdkClientId,
      device_authorization_endpoint: this.deviceAuthorizationEndpoint,
    };
  }
}
