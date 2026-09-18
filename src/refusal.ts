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
}): boolean {
  if (options.requestId) return options.requestId === options.ownRequestId;
  return options.deniedType === EVENT_RECOGNIZER_LOOP_UTTERANCE && options.asksInFlight === 1 && options.queriesInFlight === 0;
}

/**
 * The typed error an ask raises for the failure event it ended on: a refusal,
 * a question the hub has nothing for, and a fault need three different
 * sentences, and a bare runtime error allowed only one.
 */
export function failureError(event: ThalovantEvent): ThalovantRuntimeError {
  if (event.name === EVENT_POLICY_DENIED) return ThalovantPolicyDeniedError.fromEvent(event);
  if (event.name === EVENT_INTENT_UNMATCHED || event.name === EVENT_INTENT_FAILURE) {
    const said = event.data.reason ?? event.data.error;
    return new ThalovantUnansweredError(typeof said === "string" ? said.trim() : "");
  }
  return new ThalovantRuntimeError(event.text || `Hub reported ${event.name}.`);
}
