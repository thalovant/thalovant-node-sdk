/**
 * The loopback listener a browser sign-in waits on (RFC 8252 section 7.3).
 *
 * A program that signs in through the browser binds `127.0.0.1` on a port the
 * system picks, sends the browser to the authorization page with
 * `http://127.0.0.1:<port>/callback` as its redirect, and waits here for the
 * browser to come back. Only `GET /callback` is served; anything else is a 404.
 * A callback whose `state` is not this sign-in's is a 400 and changes nothing:
 * a stray tab -- an old attempt's, another program's, a page probing local
 * ports -- must not end a real sign-in. The first callback with the right
 * `state` is accepted, the port stops listening, and its tab is answered once
 * the caller says how the sign-in ended.
 *
 * Everything that decides what a request means is in {@link classifyRequest},
 * which touches no socket, so it can be checked against the shared vectors on
 * its own. The listener is a plain `node:net` server with a small request-head
 * reader rather than `node:http`: it writes nothing to a log, so the code and
 * the state in a request line never reach one, it answers a head it cannot
 * read with its own 400 page, and stopping it leaves a tab that is already
 * connected to be answered (`http.Server.close()` drops idle connections since
 * Node 19).
 *
 * Node only. Bundlers substitute `./loopback.browser.js` through the `browser`
 * map in package.json; this module, `./platform/node.js` and
 * `./transport-mqtt.js` are the only ones that import `node:` builtins.
 */
import { timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { hostname } from "node:os";

/** The one path served. */
export const CALLBACK_PATH = "/callback";
/** What the tab shows when the sign-in worked. */
export const SIGNED_IN_TEXT = "Signed in to Thalovant. You can close this tab.";
/** What the tab shows when it did not: denied, failed, the exchange refused, or no answer in time. */
export const NOT_COMPLETED_TEXT = "Sign-in was not completed.";
/** What a tab whose answer belongs to another sign-in shows. */
export const WRONG_STATE_TEXT = "This answer does not belong to the sign-in in progress.";
/** What anything other than `GET /callback` shows. */
export const NOT_FOUND_TEXT = "Not found.";
/**
 * Sent with every answer. The pages load nothing, and nothing they show may be
 * cached or leak the callback's address (code and state) as a referrer.
 */
export const PAGE_HEADERS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["Content-Type", "text/html; charset=utf-8"],
  ["Cache-Control", "no-store"],
  ["Referrer-Policy", "no-referrer"],
  ["Content-Security-Policy", "default-src 'none'"],
  ["X-Content-Type-Options", "nosniff"],
] as const);
const REASONS: Readonly<Record<number, string>> = { 200: "OK", 400: "Bad Request", 404: "Not Found" };
/** The largest request head read; a callback's is a few hundred bytes. */
export const MAX_REQUEST_HEAD = 16 * 1024;
/** How long one connection may take to send its request head. */
export const REQUEST_READ_TIMEOUT_MS = 10_000;
/** How long an accepted tab waits for its page while the code is exchanged. */
export const ANSWER_TIMEOUT_MS = 60_000;
/** How long closing waits for an accepted tab's page to be written. */
export const CLOSE_GRACE_MS = 1_000;
/** The longest a single timer may be armed for; a longer wait re-arms. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * An accepted callback: the browser came back with this sign-in's state.
 *
 * `code` when the person approved; `denied` for `error=access_denied`;
 * `failed` for any other `error`, or for neither an error nor exactly one
 * non-empty code. `error` is the `error` the page sent, when it sent one.
 */
export interface LoopbackCallback {
  readonly outcome: "code" | "denied" | "failed";
  readonly code?: string;
  readonly error?: string | null;
}

/** Options for {@link LoopbackListener}; the defaults are the contract's. */
export interface LoopbackListenerOptions {
  /** How long an accepted tab waits for its page. Default {@link ANSWER_TIMEOUT_MS}. */
  answerTimeoutMs?: number;
  /** How long a connection may take to send its request head. Default {@link REQUEST_READ_TIMEOUT_MS}. */
  requestReadTimeoutMs?: number;
}

/**
 * Python's `unquote(errors="replace")`: runs of ASCII are percent-decoded to
 * bytes and read as UTF-8, an invalid sequence becoming U+FFFD; anything else
 * is kept as it is.
 */
function unquote(text: string): string {
  if (!text.includes("%")) return text;
  // ignoreBOM: a leading U+FEFF is part of the value, as Python's decode keeps
  // it. Dropping it would let `%EF%BB%BF` in front of the state still match.
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
  let out = "";
  for (const run of text.match(/[\x00-\x7f]+|[^\x00-\x7f]+/g) ?? []) {
    if (run.charCodeAt(0) > 0x7f) {
      out += run;
      continue;
    }
    const bytes: number[] = [];
    for (let index = 0; index < run.length; index += 1) {
      const hex = run.slice(index + 1, index + 3);
      if (run[index] === "%" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        index += 2;
      } else {
        bytes.push(run.charCodeAt(index));
      }
    }
    out += decoder.decode(new Uint8Array(bytes));
  }
  return out;
}

/**
 * A query string as a form decodes it, Python's `parse_qsl(keep_blank_values=True)`:
 * split on `&` (an empty piece is skipped), name and value at the first `=`
 * (none is an empty value), `+` read as a space, then percent-decoded once.
 */
function queryPairs(query: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const piece of query.split("&")) {
    if (!piece) continue;
    const equals = piece.indexOf("=");
    const name = equals === -1 ? piece : piece.slice(0, equals);
    const value = equals === -1 ? "" : piece.slice(equals + 1);
    pairs.push([unquote(name.replace(/\+/g, " ")), unquote(value.replace(/\+/g, " "))]);
  }
  return pairs;
}

/** The two states, compared in constant time as UTF-8 bytes: a non-ASCII value is a mismatch, not a crash. */
function sameState(given: string, state: string): boolean {
  const left = Buffer.from(given, "utf8");
  const right = Buffer.from(state, "utf8");
  // timingSafeEqual throws on unequal lengths; the length of a state is not secret.
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * What the listener answers one request with, and the callback it accepts.
 *
 * `[404, null]` for anything but `GET` on exactly `/callback`; `[400, null]`
 * when `state` is missing, given more than once, or not this sign-in's
 * (compared in constant time, as bytes); otherwise `[200, callback]`. An
 * `error` wins over a `code` sent with it: a refusal that also carries a code
 * is still a refusal. Query values are decoded once, as a form decodes them.
 */
export function classifyRequest(method: string, target: string, state: string): [number, LoopbackCallback | null] {
  const mark = target.indexOf("?");
  const path = mark === -1 ? target : target.slice(0, mark);
  const query = mark === -1 ? "" : target.slice(mark + 1);
  if (method !== "GET" || path !== CALLBACK_PATH) return [404, null];
  const values = new Map<string, string[]>();
  for (const [key, value] of queryPairs(query)) {
    const list = values.get(key);
    if (list) list.push(value);
    else values.set(key, [value]);
  }
  const given = values.get("state") ?? [];
  if (given.length !== 1 || !sameState(given[0], state)) return [400, null];
  const errors = values.get("error") ?? [];
  if (errors.length) {
    if (errors.length === 1 && errors[0] === "access_denied") {
      return [200, { outcome: "denied", error: "access_denied" }];
    }
    return [200, { outcome: "failed", error: errors[0] || null }];
  }
  const codes = values.get("code") ?? [];
  if (codes.length === 1 && codes[0]) return [200, { outcome: "code", code: codes[0] }];
  return [200, { outcome: "failed", error: null }];
}

/** A page that loads nothing: no script, no style sheet, no image, no link. */
function page(text: string): Buffer {
  return Buffer.from(
    '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      `<title>Thalovant</title></head><body><p>${text}</p></body></html>\n`,
    "utf8",
  );
}

/** A whole HTTP/1.1 answer: the status, {@link PAGE_HEADERS}, and a small page. */
export function responseBytes(status: number, text: string): Buffer {
  const body = page(text);
  const lines = [`HTTP/1.1 ${status} ${REASONS[status] ?? "Error"}`];
  for (const [name, value] of PAGE_HEADERS) lines.push(`${name}: ${value}`);
  lines.push(`Content-Length: ${body.length}`, "Connection: close", "", "");
  return Buffer.concat([Buffer.from(lines.join("\r\n"), "latin1"), body]);
}

/** The method and target of a request head, or null when it has no request line. */
function requestLine(head: Buffer): { method: string; target: string } | null {
  const text = head.toString("latin1");
  const end = text.indexOf("\r\n");
  const parts = (end === -1 ? text : text.slice(0, end)).split(" ");
  if (parts.length !== 3 || !parts[2].startsWith("HTTP/")) return null;
  return { method: parts[0], target: parts[1] };
}

function abortError(): Error {
  return new DOMException("The operation was aborted.", "AbortError");
}

/** `work`, or undefined once `ms` have passed, whichever is first; the timer never outlives it. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), Math.min(Math.max(0, ms), MAX_TIMER_MS));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Waits on `127.0.0.1` for the browser to bring this sign-in's answer back.
 *
 * {@link start} binds the port (before any URL is built), {@link wait}
 * resolves with the accepted callback or null at the deadline, {@link finish}
 * says which page its tab gets, and {@link close} stops everything. Never
 * binds anything but the loopback address.
 *
 * @internal
 */
export class LoopbackListener {
  private readonly state: string;
  private readonly answerTimeoutMs: number;
  private readonly requestReadTimeoutMs: number;
  private server?: Server;
  private serverClosed?: Promise<void>;
  private started = false;
  private accepted?: LoopbackCallback;
  private readonly acceptedWaiters = new Set<() => void>();
  private signedIn?: boolean;
  private readonly answerWaiters = new Set<(signedIn: boolean) => void>();
  private readonly sockets = new Set<Socket>();
  /** The accepted tab's page, written or given up on. */
  private acceptedAnswer?: Promise<void>;

  constructor(state: string, options: LoopbackListenerOptions = {}) {
    this.state = state;
    this.answerTimeoutMs = options.answerTimeoutMs ?? ANSWER_TIMEOUT_MS;
    this.requestReadTimeoutMs = options.requestReadTimeoutMs ?? REQUEST_READ_TIMEOUT_MS;
  }

  /** The address the listener is bound to while it listens. */
  get address(): { address: string; port: number } | undefined {
    const bound = this.server?.address();
    return bound && typeof bound !== "string" ? { address: bound.address, port: bound.port } : undefined;
  }

  /** Bind `127.0.0.1` on a port the system picks; resolve with the port. */
  async start(): Promise<number> {
    if (this.started) throw new Error("The loopback listener was already started.");
    this.started = true;
    const server = createServer({ allowHalfOpen: false }, (socket) => this.connection(socket));
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error): void => {
        server.removeListener("listening", listening);
        reject(error);
      };
      const listening = (): void => {
        server.removeListener("error", failed);
        resolve();
      };
      server.once("error", failed);
      server.once("listening", listening);
      // The IP literal, never a name: `localhost` can resolve to `::1`, or
      // anywhere a hosts file says. `exclusive` keeps a cluster worker from
      // sharing the handle.
      server.listen({ port: 0, host: "127.0.0.1", exclusive: true, backlog: 8 });
    });
    // A failure after listening belongs to one connection, never the sign-in.
    server.on("error", () => undefined);
    this.server = server;
    this.serverClosed = new Promise((resolve) => server.once("close", () => resolve()));
    const bound = server.address();
    if (!bound || typeof bound === "string" || bound.address !== "127.0.0.1") {
      server.close();
      throw new Error("The loopback listener did not bind 127.0.0.1.");
    }
    return bound.port;
  }

  /**
   * The first accepted callback, or null once `timeoutMs` have passed.
   *
   * Measured on the monotonic clock and never cut short: a timer that wakes
   * early waits again for what is left. A stray request neither ends the wait
   * nor restarts it. `signal` rejects it with an `AbortError`.
   */
  async wait(timeoutMs: number, signal?: AbortSignal): Promise<LoopbackCallback | null> {
    if (!this.started) throw new Error("The loopback listener was not started.");
    const deadline = performance.now() + timeoutMs;
    while (!this.accepted) {
      if (signal?.aborted) throw abortError();
      const remaining = deadline - performance.now();
      if (!(remaining > 0)) return null;
      await this.acceptedWithin(remaining, signal);
    }
    return this.accepted;
  }

  /** Answer the accepted tab: signed in, or not completed. The first word stands. */
  finish(signedIn: boolean): void {
    if (this.signedIn !== undefined) return;
    this.signedIn = signedIn;
    for (const waiter of [...this.answerWaiters]) waiter(signedIn);
    this.answerWaiters.clear();
  }

  /**
   * Stop listening, let an accepted tab have its page, close every connection.
   *
   * Only the accepted tab is waited for, and at most {@link CLOSE_GRACE_MS}. A
   * browser also opens connections it never sends anything on; those are just
   * closed.
   */
  async close(): Promise<void> {
    this.finish(false);
    const server = this.server;
    this.server = undefined;
    if (server?.listening) server.close();
    if (this.acceptedAnswer) await within(this.acceptedAnswer, CLOSE_GRACE_MS);
    for (const socket of [...this.sockets]) socket.destroy();
    if (this.serverClosed) await within(this.serverClosed, CLOSE_GRACE_MS);
  }

  private acceptedWithin(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = (): void => {
        clearTimeout(timer);
        this.acceptedWaiters.delete(done);
        signal?.removeEventListener("abort", aborted);
        resolve();
      };
      const aborted = (): void => {
        clearTimeout(timer);
        this.acceptedWaiters.delete(done);
        reject(abortError());
      };
      const timer = setTimeout(done, Math.min(Math.ceil(ms), MAX_TIMER_MS));
      this.acceptedWaiters.add(done);
      signal?.addEventListener("abort", aborted, { once: true });
    });
  }

  private answered(): Promise<boolean> {
    if (this.signedIn !== undefined) return Promise.resolve(this.signedIn);
    return new Promise((resolve) => this.answerWaiters.add(resolve));
  }

  /** One connection: read one request head, answer it, then close. */
  private connection(socket: Socket): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    // One connection's failure is that connection's alone.
    socket.on("error", () => undefined);
    let head: Buffer = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(), this.requestReadTimeoutMs);
    socket.once("close", () => clearTimeout(timer));
    const read = (chunk: Buffer): void => {
      head = head.length ? Buffer.concat([head, chunk]) : chunk;
      const end = head.indexOf("\r\n\r\n");
      // As asyncio's readuntil(limit=16 KiB) has it: the separator must start
      // within the limit.
      if (end === -1 && head.length - 3 <= MAX_REQUEST_HEAD) return;
      socket.removeListener("data", read);
      clearTimeout(timer);
      // Whatever else the connection sends is read and dropped, so that
      // closing it never resets it under its answer.
      socket.on("data", () => undefined);
      if (end === -1 || end > MAX_REQUEST_HEAD) {
        void this.reply(socket, 400, WRONG_STATE_TEXT);
        return;
      }
      this.serve(socket, head.subarray(0, end));
    };
    socket.on("data", read);
  }

  /** Answer one request head, and hand an accepted callback to {@link wait}. */
  private serve(socket: Socket, head: Buffer): void {
    const request = requestLine(head);
    if (!request) {
      void this.reply(socket, 400, WRONG_STATE_TEXT);
      return;
    }
    let status: number;
    let callback: LoopbackCallback | null;
    try {
      [status, callback] = classifyRequest(request.method, request.target, this.state);
    } catch {
      socket.destroy();
      return;
    }
    if (!callback || this.accepted || !this.server) {
      // A second answer with the right state, after the first was accepted
      // (or after the sign-in ended), is not this sign-in's any more either.
      if (callback) status = 400;
      void this.reply(socket, status, status === 404 ? NOT_FOUND_TEXT : WRONG_STATE_TEXT);
      return;
    }
    this.accepted = callback;
    // The first accepted callback ends the listening; a tab already connected
    // is still answered.
    if (this.server.listening) this.server.close();
    for (const waiter of [...this.acceptedWaiters]) waiter();
    this.acceptedAnswer = this.answerAccepted(socket);
  }

  /** The accepted tab's page, once the sign-in has ended or {@link answerTimeoutMs} has passed. */
  private async answerAccepted(socket: Socket): Promise<void> {
    const signedIn = (await within(this.answered(), this.answerTimeoutMs)) ?? false;
    await this.reply(socket, 200, signedIn ? SIGNED_IN_TEXT : NOT_COMPLETED_TEXT);
  }

  /** Write one whole answer and close the connection; resolves once written, or once the connection is gone. */
  private reply(socket: Socket, status: number, text: string): Promise<void> {
    return new Promise((resolve) => {
      if (socket.destroyed || !socket.writable) {
        resolve();
        return;
      }
      socket.once("close", () => resolve());
      socket.end(responseBytes(status, text), () => resolve());
    });
  }
}

/** This machine's name, trimmed; empty when it has none or it cannot be read. */
export function hostName(): string {
  try {
    return hostname().trim();
  } catch {
    return "";
  }
}
