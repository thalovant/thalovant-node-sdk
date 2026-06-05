import { DEFAULT_USER_AGENT } from "./constants.js";
import { ThalovantConnectionError, ThalovantRuntimeError } from "./errors.js";
import { decryptFromJson, encryptAsJson, runtimeCryptoKey } from "./crypto.js";
import { BusPayload, EventContext } from "./events.js";
import { ThalovantIdentity } from "./identity.js";

export interface HiveMessage {
  msg_type: string;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  route?: unknown[];
  node?: string | null;
  target_site_id?: string | null;
  target_pubkey?: string | null;
  source_peer?: string | null;
}

export interface TransportHealth {
  connected: boolean;
  handshakeComplete: boolean;
  transportAlive: boolean;
  lastError?: string;
}

export class HiveMindHttpTransport extends EventTarget {
  readonly identity: ThalovantIdentity;
  readonly userAgent: string;
  readonly pollIntervalMs: number;
  private connected = false;
  private handshakeComplete = false;
  private pollTimer?: NodeJS.Timeout;
  private lastError?: Error;

  constructor(identity: ThalovantIdentity, options: { userAgent?: string; pollIntervalMs?: number } = {}) {
    super();
    this.identity = identity;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
  }

  get baseUrl(): string {
    return this.identity.endpointBase();
  }

  get authorization(): string {
    return Buffer.from(`${this.userAgent}:${this.identity.accessKey}`, "utf8").toString("base64");
  }

  async connect(timeoutMs = 6000): Promise<void> {
    const response = await fetch(`${this.baseUrl}/connect?authorization=${encodeURIComponent(this.authorization)}`, {
      method: "POST",
    });
    if (!response.ok) {
      throw new ThalovantConnectionError(`HiveMind HTTP connect failed: ${await response.text()}`);
    }
    this.connected = true;
    const deadline = Date.now() + timeoutMs;
    while (!this.handshakeComplete && Date.now() < deadline) {
      await this.pollOnce();
      if (!this.handshakeComplete) {
        await sleep(100);
      }
    }
    if (!this.handshakeComplete) {
      throw new ThalovantConnectionError("HiveMind HTTP handshake timed out.");
    }
    this.startPolling();
  }

  async disconnect(): Promise<void> {
    this.stopPolling();
    if (!this.connected) return;
    await fetch(`${this.baseUrl}/disconnect?authorization=${encodeURIComponent(this.authorization)}`, {
      method: "POST",
    }).catch(() => undefined);
    this.connected = false;
    this.handshakeComplete = false;
  }

  healthcheck(): TransportHealth {
    return {
      connected: this.connected,
      handshakeComplete: this.handshakeComplete,
      transportAlive: this.connected && Boolean(this.pollTimer),
      lastError: this.lastError?.message,
    };
  }

  async emitBus(eventType: string, data: Record<string, unknown>, context: EventContext): Promise<void> {
    await this.sendHiveMessage({
      msg_type: "bus",
      payload: { type: eventType, data, context },
      metadata: {},
      route: [],
      node: null,
      target_site_id: null,
      target_pubkey: null,
      source_peer: null,
    });
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      this.pollOnce().catch((error: Error) => {
        this.lastError = error;
        this.connected = false;
      });
    }, this.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async pollOnce(): Promise<void> {
    if (!this.connected) return;
    const response = await fetch(`${this.baseUrl}/get_messages?authorization=${encodeURIComponent(this.authorization)}`);
    const body = await response.json() as { error?: string; messages?: unknown[] };
    if (body.error) {
      throw new ThalovantRuntimeError(body.error);
    }
    for (const raw of body.messages ?? []) {
      await this.handleRawMessage(raw);
    }
  }

  private async handleRawMessage(raw: unknown): Promise<void> {
    let decoded = raw;
    if (typeof raw === "string") {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      decoded = "ciphertext" in parsed && this.identity.cryptoKey
        ? JSON.parse(decryptFromJson(this.identity.cryptoKey, parsed))
        : parsed;
    } else if (typeof raw === "object" && raw && "ciphertext" in raw && this.identity.cryptoKey) {
      decoded = JSON.parse(decryptFromJson(this.identity.cryptoKey, raw as Record<string, unknown>));
    }
    const message = decoded as HiveMessage;
    if (message.msg_type === "handshake") {
      await this.handleHandshake(message.payload);
    } else if (message.msg_type === "bus") {
      this.dispatchEvent(new CustomEvent<BusPayload>("bus", { detail: message.payload as unknown as BusPayload }));
    }
  }

  private async handleHandshake(payload: Record<string, unknown>): Promise<void> {
    if (payload.preshared_key && !payload.handshake && !payload.envelope) {
      if (!runtimeCryptoKey(this.identity.cryptoKey)) {
        throw new ThalovantConnectionError("HiveMind requested a preshared key, but identity.crypto_key is missing.");
      }
      await this.sendHiveMessage({
        msg_type: "hello",
        payload: {
          pubkey: this.identity.publicKey ?? "",
          session: { session_id: `thalovant-node-${crypto.randomUUID()}` },
          site_id: this.identity.siteId,
        },
        metadata: {},
        route: [],
        node: null,
        target_site_id: null,
        target_pubkey: null,
        source_peer: null,
      }, false);
      this.handshakeComplete = true;
      return;
    }
    throw new ThalovantConnectionError("Only HiveMind preshared-key HTTP handshakes are supported in this alpha.");
  }

  private async sendHiveMessage(message: HiveMessage, encrypt = true): Promise<void> {
    const serialized = JSON.stringify(message);
    const payload = encrypt && this.handshakeComplete && this.identity.cryptoKey
      ? encryptAsJson(this.identity.cryptoKey, serialized)
      : serialized;
    const response = await fetch(`${this.baseUrl}/send_message?authorization=${encodeURIComponent(this.authorization)}`, {
      method: "POST",
      body: new URLSearchParams({ message: payload }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    if (!response.ok) {
      throw new ThalovantConnectionError(`HiveMind HTTP send failed: ${await response.text()}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
