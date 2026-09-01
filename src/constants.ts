import { USER_AGENT } from "./version.js";

export const EVENT_RECOGNIZER_LOOP_UTTERANCE = "recognizer_loop:utterance";
export const EVENT_SPEAK = "speak";
export const EVENT_OVOS_UTTERANCE_SPEAK = "ovos.utterance.speak";
export const EVENT_UTTERANCE_HANDLED = "ovos.utterance.handled";
/** Current OVOS name for "no intent matched the utterance". */
export const EVENT_INTENT_UNMATCHED = "ovos.intent.unmatched";
/** Legacy Mycroft name for the same failure; kept for older runtimes. */
export const EVENT_INTENT_FAILURE = "complete_intent_failure";
export const EVENT_POLICY_DENIED = "hive.policy.denied";
export const EVENT_QUERY_TIMEOUT = "hive.query.timeout";

export const FAILURE_EVENTS = new Set([
  EVENT_INTENT_UNMATCHED,
  EVENT_INTENT_FAILURE,
  EVENT_POLICY_DENIED,
  EVENT_QUERY_TIMEOUT,
]);

/** Data-plane user agent. Derived from the one version constant, never pinned. */
export const DEFAULT_USER_AGENT = USER_AGENT;
