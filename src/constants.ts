export const EVENT_RECOGNIZER_LOOP_UTTERANCE = "recognizer_loop:utterance";
export const EVENT_SPEAK = "speak";
export const EVENT_UTTERANCE_HANDLED = "ovos.utterance.handled";
export const EVENT_INTENT_FAILURE = "complete_intent_failure";
export const EVENT_POLICY_DENIED = "hive.policy.denied";

export const FAILURE_EVENTS = new Set([
  EVENT_INTENT_FAILURE,
  EVENT_POLICY_DENIED,
]);

export const DEFAULT_USER_AGENT = "ThalovantNodeSDK/0.2.11";
