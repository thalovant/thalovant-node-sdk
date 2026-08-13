/**
 * Contract implemented by both `./node.js` (the `ws` package) and
 * `./browser.js` (the global `WebSocket`). Transports only depend on this
 * shape, never on a concrete WebSocket implementation.
 */
export interface PlatformWebSocket {
  readonly url: string;
  readonly isOpen: boolean;
  onOpen(handler: () => void): void;
  onMessage(handler: (data: string | Uint8Array) => void): void;
  onClose(handler: (code: number, reason: string) => void): void;
  onError(handler: (error: Error) => void): void;
  send(data: string | Uint8Array): Promise<void>;
  close(): void;
  terminate(): void;
}
