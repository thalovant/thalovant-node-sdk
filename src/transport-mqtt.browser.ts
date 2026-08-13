/**
 * Browser stand-in for `./transport-mqtt.js`, wired up by the `browser` map in
 * package.json. The mqtt transport depends on the `mqtt` package and
 * `node:crypto`, so in browsers every entry point throws a descriptive
 * error instead of breaking the bundle. Use the "wss" or "https" protocol
 * from browsers.
 */
import { ThalovantUnsupportedProtocolError } from "./errors.js";
import type { ThalovantIdentity } from "./identity.js";
import type { MqttTopicSet } from "./transport-mqtt.js";

const MQTT_BROWSER_ERROR =
  'The mqtt transport is not available in browsers. Use the "wss" or "https" protocol instead.';

export class HiveMindMqttTransport {
  constructor(_identity: ThalovantIdentity, _options: { userAgent?: string; pollIntervalMs?: number } = {}) {
    throw new ThalovantUnsupportedProtocolError(MQTT_BROWSER_ERROR);
  }
}

export function mqttTopicsForIdentity(_identity: ThalovantIdentity): MqttTopicSet {
  throw new ThalovantUnsupportedProtocolError(MQTT_BROWSER_ERROR);
}

export function mqttConnectionEndpoint(_credentials: { endpoint: string; tls?: boolean }): string {
  throw new ThalovantUnsupportedProtocolError(MQTT_BROWSER_ERROR);
}
