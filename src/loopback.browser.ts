/**
 * Browser stand-in for `./loopback.js`. Bundlers substitute this module
 * through the `browser` map in package.json, so the browser bundle carries no
 * `node:net`, `node:crypto` or `node:os`.
 *
 * A web page cannot listen on a port, so a browser sign-in cannot wait for its
 * redirect here: {@link LoopbackListener.start} refuses, before anything is
 * opened. `canOpenBrowser()` already answers false in a page (it has no
 * `process`), so `interactiveLogin()` signs a page in with a device login.
 */
import { ThalovantError } from "./errors.js";

/** @see `./loopback.js` */
export interface LoopbackCallback {
  readonly outcome: "code" | "denied" | "failed";
  readonly code?: string;
  readonly error?: string | null;
}

/** @see `./loopback.js` */
export interface LoopbackListenerOptions {
  answerTimeoutMs?: number;
  requestReadTimeoutMs?: number;
}

/**
 * Refuses to start: a browser sign-in needs a program that can listen on
 * `127.0.0.1`.
 *
 * @internal
 */
export class LoopbackListener {
  constructor(_state: string, _options: LoopbackListenerOptions = {}) {}

  get address(): { address: string; port: number } | undefined {
    return undefined;
  }

  async start(): Promise<number> {
    throw new ThalovantError(
      "Browser sign-in listens on a loopback port, which a web page cannot do. " +
        "Sign in with loginWithBrowser() (a device login) instead.",
    );
  }

  async wait(_timeoutMs: number, _signal?: AbortSignal): Promise<LoopbackCallback | null> {
    throw new Error("The loopback listener was not started.");
  }

  finish(_signedIn: boolean): void {}

  async close(): Promise<void> {}
}

/** A web page cannot read the machine's name. */
export function hostName(): string {
  return "";
}
