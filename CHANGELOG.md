# Changelog

## 0.2.25

- Add `controlPlane.loginWithBrowser(options)`: sign in through the browser device flow (`POST /v1/auth/device/authorize` plus `POST /v1/auth/device/token`), the sign-in path for accounts without a password such as Google sign-in. It prints `To sign in, visit <verification_uri> and enter the code <user_code>` (override with `prompt`), makes a best-effort attempt to open the default browser at `verification_uri_complete` (disable with `openBrowser: false`), and polls with `authorization_pending` and `slow_down` handling until the request is approved, denied, expired, or `timeoutMs` (default 15 minutes) elapses. On approval the returned durable scoped API token is stored on `accessToken` exactly like `login()`; `access_denied`, `expired_token`, and timeout reject with clear errors.
- Add `controlPlane.pollDeviceToken(deviceCode, options)` with injectable `sleep`/`now` for advanced integrations and tests.
- Browser opening is dependency-free and never fails the sign-in: Node spawns the platform opener (`open`, `start`, or `xdg-open`), web bundles use `window.open`, and any failure falls back to the printed URL.
- Document token authentication for CI and automation: pass a dashboard-minted API token to `new ThalovantControlPlane(url, { accessToken })` (for example from a `THALOVANT_API_TOKEN` environment variable); no login call is needed.

## 0.2.24

- Browser support: the SDK now runs in browsers behind a bundler. The control plane (`login`, `listPublicHubs`, `createClientIdentity`, memory, analytics) and `ThalovantClient` over the `wss` and `https` protocols work in web bundles using the global `fetch`, the global `WebSocket`, and Web Crypto (AES-128-GCM via `crypto.subtle`).
- Add a `browser` map plus a `browser` export condition to package.json so bundlers (esbuild, webpack, Vite, Rollup) substitute browser-safe platform modules and never pull `ws`, `mqtt`, `yaml`, or `node:` builtins into web bundles. The Node entry point and runtime behavior are unchanged.
- The `mqtt` transport stays Node-only: constructing `HiveMindMqttTransport` (or calling `mqttTopicsForIdentity`/`mqttConnectionEndpoint`) in a browser throws `ThalovantUnsupportedProtocolError` with a clear message instead of breaking bundling.
- Identity file helpers stay Node-only: `ThalovantIdentity.fromFile()`, `fromConfig()`, and `defaultConfigPath()` throw a descriptive `ThalovantIdentityError` in browsers; construct identities from in-memory objects there.
- Add async crypto helpers `encryptAsJsonAsync`, `decryptFromJsonAsync`, `encryptAsBinaryAsync`, and `decryptBinaryAsync` that work on Node and browsers; transports now use them. The existing synchronous helpers keep working on Node and throw a descriptive error in browsers. Byte-oriented APIs (`runtimeCryptoKey`, `encryptAsBinary`, `decryptBinary`, `encodeHiveBinaryFrame`) are typed as `Uint8Array` but still return `Buffer` instances on Node.
- Add a browser bundling smoke test (`test/browser-smoke.test.ts`, part of `npm test` and CI) that bundles the SDK with esbuild in `platform: "browser"` mode, asserts no Node builtins/`ws`/`mqtt` leak into the bundle, and executes the control-plane and WSS connect paths in a DOM-less sandbox with stubbed `fetch`/`WebSocket` and no real network. Adds `esbuild` as a devDependency.

## 0.2.23

- Add optional `otpCode` and `recoveryCode` options to `controlPlane.login(email, password, options)` for MFA-enabled accounts. They are sent to `POST /v1/auth/token` as `otp_code` and `recovery_code` only when provided; accounts with MFA enabled receive HTTP 401 `mfa_required` without one.

## 0.2.22

- Update the locked transitive dependency `ws` from 8.21.1 to 8.21.2. No SDK code changes.

## 0.2.21

- Update the locked transitive dependency `ip-address` from 10.3.1 to 10.4.0. No SDK code changes.

## 0.2.20

- Update locked dependencies: `mqtt` 5.15.1 to 5.15.2, `ws` 8.21.0 to 8.21.1, `@types/node` 24.13.0 to 24.13.3, `@types/readable-stream` 4.0.23 to 4.0.24, `broker-factory` 3.1.14 to 3.1.15, `ip-address` 10.2.0 to 10.3.1, and `worker-timers` 8.0.31 to 8.0.34. No SDK code changes.
- Add a regression test proving concurrent `ask()` calls on one transport correlate replies by request id.
- Repository automation: schedule dependabot dependency updates limited to minor and patch, dispatch npm publication explicitly, and support npm 12 pack metadata.

## 0.2.19

- Publish the exact npm tarball with a durable CycloneDX SBOM and GitHub provenance and SBOM attestations.

## 0.2.18

- Add the typed `OperationResource` contract and `getOperation()` control-plane method.
