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
 */
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
  const state = base64Url(randomBytes(24));
  const scopes = options.scopes ?? DEFAULT_NATIVE_SCOPES;
  // Not `replace(/\/+$/, "")`: CodeQL is right that a trailing-run regex on a
  // caller-supplied string backtracks polynomially, and this one is handed a
  // URL from outside. Trimming in a loop is linear and does the same thing.
  let dashboard = options.dashboardUrl ?? DEFAULT_DASHBOARD_URL;
  while (dashboard.endsWith("/")) dashboard = dashboard.slice(0, -1);
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
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`.toLowerCase();
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
