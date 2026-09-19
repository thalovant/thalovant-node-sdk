import {
  EVENT_INTENT_FAILURE,
  EVENT_INTENT_UNMATCHED,
  EVENT_POLICY_DENIED,
  EVENT_RECOGNIZER_LOOP_UTTERANCE,
} from "./constants.js";
import type { ThalovantEvent } from "./events.js";
import { ThalovantPolicyDeniedError, ThalovantRuntimeError, ThalovantUnansweredError } from "./errors.js";

/**
 * Whether a `hive.policy.denied` is this ask's to raise.
 *
 * A denial that carries a request id is judged by it, like any reply. The hub
 * builds its denials with source and destination context only (hivemind-core
 * `_send_policy_denied`), so the usual one carries none and names the refused
 * type instead. That is enough when this ask is the only utterance the client
 * has out; with a second ask, or a query, it is a guess, and a wrong guess ends
 * a question the hub never refused. The shared refusal vectors pin every case.
 */
export function refusalBelongsToAsk(options: {
  requestId: string | undefined;
  ownRequestId: string;
  deniedType: string | undefined;
  asksInFlight: number;
  queriesInFlight: number;
  /** Fire-and-forget utterances still inside UNTRACKED_UTTERANCE_GRACE_MS. */
  sendsInFlight?: number;
}): boolean {
  if (options.requestId) return options.requestId === options.ownRequestId;
  return (
    options.deniedType === EVENT_RECOGNIZER_LOOP_UTTERANCE &&
    options.asksInFlight === 1 &&
    options.queriesInFlight === 0 &&
    (options.sendsInFlight ?? 0) === 0
  );
}

/**
 * How long a fire-and-forget utterance counts as possibly still being refused.
 *
 * Denials come back as fast as the hub admits a message -- milliseconds -- so
 * this is generous on purpose: a wrong "in flight" only costs an ask the
 * deadline it always had, where a wrong "not in flight" ends a question the hub
 * never refused. The shared refusal vectors name it (`untracked_grace_seconds`),
 * so every SDK uses the same window.
 */
export const UNTRACKED_UTTERANCE_GRACE_MS = 10_000;

/**
 * The typed error an ask raises for the failure event it ended on: a refusal,
 * a question the hub has nothing for, and a fault need three different
 * sentences, and a bare runtime error allowed only one.
 */
export function failureError(event: ThalovantEvent): ThalovantRuntimeError {
  if (event.name === EVENT_POLICY_DENIED) return ThalovantPolicyDeniedError.fromEvent(event);
  if (event.name === EVENT_INTENT_UNMATCHED || event.name === EVENT_INTENT_FAILURE) {
    // What the person said: both names carry the input, and that is what a
    // caller shows. `reason` is not on these events at all, so reading it left
    // `said` empty.
    return new ThalovantUnansweredError(event.text.trim());
  }
  return new ThalovantRuntimeError(event.text || `Hub reported ${event.name}.`);
}
