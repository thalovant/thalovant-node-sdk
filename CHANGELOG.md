# Changelog

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
